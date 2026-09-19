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
interface OrderView {
  id: number;
  dish: string;
  points?: number;
  secondsLeft?: number;
  components?: Array<{ label: string; status: string }>;
  assemblyReady?: number;
  totalComponents?: number;
}
interface StateView {
  orders?: OrderView[];
  carrying?: { ingredient: string; stage: string } | null;
  workingOrderId?: number | null;
  workingSecondsLeft?: number | null;
  fireCount?: number;
  distances?: Record<string, number>; // option id → tiles away (approx)
  teammates?: Array<{ chef: number; plan?: string; workingOrderId?: number | null; deciding?: boolean }>;
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

  if (id.startsWith('assemble:')) {
    // Finishing a fully-prepped dish banks points — finishing beats starting.
    const oid = Number(id.slice('assemble:'.length));
    const order = state.orders?.find((o) => o.id === oid);
    const left = order?.secondsLeft ?? 30;
    const urgency = Math.max(0, 40 - left); // more urgent as deadline nears
    return 80 + urgency + proximity * 0.4;
  }

  if (id.startsWith('rescue:')) return 70 + proximity * 0.5; // burn prevention

  if (id === 'trash') {
    // Clear burnt/orphaned food so hands are free; only urgent for burnt carry.
    return state.carrying?.stage === 'burnt' ? 55 : 12;
  }

  if (id.startsWith('prep:')) {
    // prep:<orderId>:<compIdx>
    const parts = id.split(':');
    const oid = Number(parts[1]);
    const order = state.orders?.find((o) => o.id === oid);
    const points = order?.points ?? 20;
    const left = order?.secondsLeft ?? 60;
    // urgency ramps as the deadline nears (but don't chase near-dead orders)
    const urgency = left < 6 ? -8 : Math.max(0, 40 - left) * 0.5;
    // finish what's started: +8 per already-ready component of this order
    const ready = order?.assemblyReady ?? 0;
    const progressBonus = ready * 8;
    // slight penalty if teammates already work this order (spread the line)
    const crowd = (state.teammates ?? []).filter((tm) => tm.workingOrderId === oid).length;
    const crowdPenalty = crowd * 6;
    return 45 + points * 0.35 + urgency + progressBonus - proximity * 0.5 - crowdPenalty;
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
  const critical =
    topId.startsWith('extinguish:') ||
    topId.startsWith('rescue:') ||
    topId.startsWith('assemble:');

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

// Shared circuit breaker across all four chefs' RemoteJevBrain instances:
// after consecutive failures we stop paying the failed round trip and run
// local for a cooldown, then probe again. LLM benchmark brains get a much
// softer breaker — the fair penalty for a slow model is idle chefs, not
// silent substitution by the local heuristic (which poisons the benchmark).
const breaker = { failures: 0, openUntil: 0 };

export class RemoteJevBrain implements JevBrain {
  readonly name: string;
  private fallback = new LocalJevBrain();

  constructor(
    private endpoint: string,
    private apiKey: string,
    private brainModel: string = 'jev',
    // pure mode: NO fallback and NO breaker — a failed call throws, the chef
    // idles and retries. Every logged decision is genuinely the model's.
    private pure: boolean = false,
  ) {
    this.name = brainModel === 'jev' ? 'typesafe-ai/jev' : brainModel;
  }

  private get breakerThreshold() {
    return this.brainModel === 'jev' ? 3 : 8;
  }
  private get breakerCooldownMs() {
    return this.brainModel === 'jev' ? 20_000 : 4_000;
  }

  async decide(req: DecisionRequest): Promise<JevDecision> {
    if (!this.pure && Date.now() < breaker.openUntil) return this.fallback.decide(req);
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
          brainModel: this.brainModel,
        }),
      });
      const latencyMs = Date.now() - start;
      if (!res.ok) return this.failover(req, `http ${res.status}`);

      const data: unknown = await res.json();
      const decision = this.parse(req, data, latencyMs);
      if (!decision) return this.failover(req, 'unparseable decision');
      breaker.failures = 0;
      return Object.assign(decision, { source: 'live' });
    } catch (err) {
      return this.failover(req, err instanceof Error ? err.message : 'fetch failed');
    }
  }

  private failover(req: DecisionRequest, reason: string): Promise<JevDecision> {
    if (this.pure) {
      // No substitute in pure mode — reject; the sim idles the chef briefly
      // and re-requests, so the model pays its own penalty in the score.
      return Promise.reject(new Error(reason));
    }
    breaker.failures++;
    if (breaker.failures >= this.breakerThreshold) {
      breaker.openUntil = Date.now() + this.breakerCooldownMs;
      breaker.failures = 0;
    }
    return this.fallback
      .decide(req)
      .then((d) => Object.assign(d, { source: 'fallback' }));
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
  cfg: { endpoint?: string; apiKey?: string; brainModel?: string; pure?: boolean } | null,
): (chefId: number) => JevBrain {
  if (cfg && cfg.endpoint) {
    const { endpoint, apiKey, brainModel, pure } = cfg;
    return () =>
      new RemoteJevBrain(endpoint, apiKey ?? '', brainModel ?? 'jev', pure ?? false);
  }
  return () => new LocalJevBrain();
}
