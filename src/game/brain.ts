import {
  JevBrain,
  JevDecision,
  DecisionRequest,
  PolicyEntry,
  ActionOption,
} from './types';

// ─────────────────────────────────────────────────────────────
// Brains decide which high-level action a chef takes next. The sim
// passes a DecisionRequest (valid options + a compact state snapshot);
// the brain returns a JevDecision (chosen id + policy distribution +
// telemetry). LocalJevBrain scores options heuristically; RemoteJevBrain
// calls an external decisions API and falls back to local on any error.
// ─────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function softmax(scores: number[], temperature: number): number[] {
  const t = Math.max(temperature, 1e-3);
  const max = Math.max(...scores);
  const exps = scores.map((s) => Math.exp((s - max) / t));
  const sum = exps.reduce((a, b) => a + b, 0) || 1;
  return exps.map((e) => e / sum);
}

// The compact state shape the sim serializes. We read defensively so the
// brain never throws on a partial snapshot.
interface StateView {
  orders?: Array<{
    id: number;
    dish: string;
    points?: number;
    secondsLeft?: number;
    claimedBy?: number | null;
  }>;
  carrying?: { ingredient: string; stage: string } | null;
  claimedOrderId?: number | null;
  claimedSecondsLeft?: number | null;
  fireCount?: number;
  distances?: Record<string, number>; // option id → tiles away (approx)
}

// Utility score for a single option given the state. Higher = more desirable.
function scoreOption(opt: ActionOption, state: StateView): number {
  const id = opt.id;
  const dist = state.distances?.[id] ?? 6;
  const proximity = Math.max(0, 8 - dist); // closer stations score higher

  if (id.startsWith('extinguish:')) {
    // Fires are emergencies — dominate everything else.
    return 100 + (state.fireCount ?? 1) * 10 + proximity;
  }

  if (id === 'deliver') {
    // Finishing a plated dish banks points; do it promptly.
    const left = state.claimedSecondsLeft ?? 30;
    return 70 + Math.max(0, 30 - left) + proximity * 0.5;
  }

  if (id === 'plate') return 60 + proximity * 0.4;
  if (id === 'trash') return 55; // clear burnt items so hands are free
  if (id.startsWith('collect:')) return 68 + proximity * 0.5;
  if (id.startsWith('cook:')) return 50 + proximity * 0.5;
  if (id.startsWith('chop:')) return 48 + proximity * 0.5;
  if (id.startsWith('fetch:')) return 40 + proximity * 0.6;

  if (id.startsWith('claim:')) {
    const oid = Number(id.slice('claim:'.length));
    const order = state.orders?.find((o) => o.id === oid);
    if (!order) return 20;
    const points = order.points ?? 20;
    const left = order.secondsLeft ?? 60;
    // Value high-point dishes; add urgency as the deadline approaches, but
    // avoid claiming orders about to expire that we can't finish.
    const urgency = left < 8 ? -10 : Math.max(0, 40 - left) * 0.6;
    return 22 + points * 0.6 + urgency - proximity * 0.1;
  }

  if (id === 'wait') return 5;

  return 10;
}

function buildDecision(
  req: DecisionRequest,
  scores: number[],
  latencyMs: number,
): JevDecision {
  const probs = softmax(scores, 0.35);
  const entries: PolicyEntry[] = req.options.map((o, i) => ({
    id: o.id,
    label: o.label,
    prob: probs[i],
  }));
  entries.sort((a, b) => b.prob - a.prob);

  // Safety-critical top choices (put out a fire, grab food before it burns) are
  // never gambled away by exploration — always commit to them.
  const topId = entries[0].id;
  const critical = topId.startsWith('extinguish:') || topId.startsWith('collect:');

  // argmax 90% of the time, otherwise sample from the distribution.
  let chosenId: string;
  if (critical || Math.random() < 0.9) {
    chosenId = entries[0].id;
  } else {
    const r = Math.random();
    let acc = 0;
    chosenId = entries[0].id;
    for (const e of entries) {
      acc += e.prob;
      if (r <= acc) {
        chosenId = e.id;
        break;
      }
    }
  }

  const top = entries.slice(0, 5);
  const norm = top.reduce((a, b) => a + b.prob, 0) || 1;
  const policy = top.map((e) => ({ ...e, prob: e.prob / norm }));

  const rawConf = policy[0]?.prob ?? 0.5;
  const confidence = Math.min(0.97, Math.max(0.3, rawConf + (Math.random() - 0.5) * 0.06));

  const tokens = Math.round(1200 + Math.random() * 1800);
  const costUsd = tokens * 4e-8;

  return { chosenId, policy, confidence, latencyMs, tokens, costUsd };
}

export class LocalJevBrain implements JevBrain {
  readonly name = 'jev-local';
  // latencyOverride lets the headless test run with zero delay.
  constructor(private latencyOverride: number | null = null) {}

  async decide(req: DecisionRequest): Promise<JevDecision> {
    const state = (req.state ?? {}) as StateView;
    const scores = req.options.map((o) => scoreOption(o, state));
    const latencyMs =
      this.latencyOverride !== null
        ? this.latencyOverride
        : 140 + Math.random() * 220;
    if (latencyMs > 0) await delay(latencyMs);
    return buildDecision(req, scores, latencyMs);
  }
}

export class RemoteJevBrain implements JevBrain {
  readonly name = 'typesafe-ai/jev';
  private fallback = new LocalJevBrain();

  constructor(private endpoint: string, private apiKey: string) {}

  async decide(req: DecisionRequest): Promise<JevDecision> {
    const start = Date.now();
    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Same-origin proxy route reads either header; empty means the
          // server is expected to hold AI_GATEWAY_API_KEY in its env.
          ...(this.apiKey ? { 'x-gateway-key': this.apiKey } : {}),
        },
        body: JSON.stringify({
          chefId: req.chefId,
          gameTime: req.gameTime,
          options: req.options,
          state: req.state,
        }),
      });
      const latencyMs = Date.now() - start;
      if (!res.ok) return this.fallback.decide(req);

      const data: unknown = await res.json();
      const decision = this.parse(req, data, latencyMs);
      if (decision) return decision;
      return this.fallback.decide(req);
    } catch {
      return this.fallback.decide(req);
    }
  }

  private parse(
    req: DecisionRequest,
    data: unknown,
    latencyMs: number,
  ): JevDecision | null {
    if (!data || typeof data !== 'object') return null;
    const d = data as Record<string, unknown>;

    const chosenRaw = d.chosenId ?? d.choice ?? d.decision;
    if (typeof chosenRaw !== 'string') return null;
    const validIds = new Set(req.options.map((o) => o.id));
    if (!validIds.has(chosenRaw)) return null;

    // Build a policy: prefer the API's, otherwise a spike on the chosen id.
    let policy: PolicyEntry[] = [];
    if (Array.isArray(d.policy)) {
      for (const raw of d.policy) {
        if (!raw || typeof raw !== 'object') continue;
        const p = raw as Record<string, unknown>;
        const id = typeof p.id === 'string' ? p.id : null;
        if (!id || !validIds.has(id)) continue;
        const label =
          req.options.find((o) => o.id === id)?.label ??
          (typeof p.label === 'string' ? p.label : id);
        const prob = typeof p.prob === 'number' ? p.prob : 0;
        policy.push({ id, label, prob });
      }
    }
    if (policy.length === 0) {
      policy = req.options.map((o) => ({
        id: o.id,
        label: o.label,
        prob: o.id === chosenRaw ? 0.85 : 0.15 / Math.max(1, req.options.length - 1),
      }));
    }
    policy.sort((a, b) => b.prob - a.prob);
    policy = policy.slice(0, 5);
    const norm = policy.reduce((a, b) => a + b.prob, 0) || 1;
    policy = policy.map((e) => ({ ...e, prob: e.prob / norm }));

    const confidence =
      typeof d.confidence === 'number'
        ? Math.min(0.97, Math.max(0.3, d.confidence))
        : Math.min(0.97, Math.max(0.3, policy[0]?.prob ?? 0.6));
    const tokens =
      typeof d.tokens === 'number' ? Math.round(d.tokens) : Math.round(1200 + Math.random() * 1800);
    const costUsd =
      typeof d.costUsd === 'number' ? d.costUsd
      : typeof d.cost_usd === 'number' ? d.cost_usd
      : tokens * 4e-8;

    return { chosenId: chosenRaw, policy, confidence, latencyMs, tokens, costUsd };
  }
}

export function makeBrainFactory(
  cfg: { endpoint?: string; apiKey?: string } | null,
): (chefId: number) => JevBrain {
  if (cfg && cfg.endpoint) {
    const { endpoint, apiKey } = cfg;
    return () => new RemoteJevBrain(endpoint, apiKey ?? '');
  }
  return () => new LocalJevBrain();
}
