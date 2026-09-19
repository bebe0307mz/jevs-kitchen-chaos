// ─────────────────────────────────────────────────────────────
// Jev decision proxy — BYOK (bring your own key), dual provider.
// The browser POSTs the game's DecisionRequest with the visitor's
// key in x-gateway-key; we reformulate it as a single TypeSafe Jev
// `choice` question and evaluate it through:
//   vck_…   → Vercel AI Gateway (AI SDK evaluate, typesafe-ai/jev)
//   sk-or-… → OpenRouter Decisions API (typesafe/jev-1.13)
// The key is used per-request only — never stored, never in env.
// GET with a key validates it and returns its credit balance.
// ─────────────────────────────────────────────────────────────
import { NextRequest, NextResponse } from 'next/server';
import { experimental_evaluate as evaluate } from 'ai';
import { createGateway } from '@ai-sdk/gateway';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const MODEL = 'typesafe-ai/jev';
const OR_MODEL = 'typesafe/jev-1.13';
const OR_DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
const PRICE_PER_TOKEN = 0.042 / 1_000_000; // $0.042 / 1M input tokens (same list price on both providers)

type Provider = 'openrouter' | 'gateway';
const providerFor = (key: string): Provider =>
  key.startsWith('sk-or-') ? 'openrouter' : 'gateway';
// Jev choice criteria keys must be plain identifiers; game ids contain ':'.
const safeKey = (id: string) => id.replace(/[^a-zA-Z0-9_]/g, '_');

interface GameOption {
  id: string;
  label: string;
}

function readKey(req: NextRequest): string | null {
  const k = req.headers.get('x-gateway-key') ?? req.headers.get('x-api-key');
  return k && k.trim().length > 0 ? k.trim() : null;
}

export async function GET(req: NextRequest) {
  const key = readKey(req);
  if (!key) {
    return NextResponse.json({ byok: true, configured: false, model: MODEL });
  }
  const provider = providerFor(key);
  try {
    if (provider === 'openrouter') {
      const res = await fetch('https://openrouter.ai/api/v1/credits', {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`http ${res.status}`);
      const j = (await res.json()) as {
        data?: { total_credits?: number; total_usage?: number };
      };
      const total = Number(j.data?.total_credits ?? 0);
      const used = Number(j.data?.total_usage ?? 0);
      return NextResponse.json({
        valid: true,
        provider,
        model: OR_MODEL,
        balance: Math.max(0, total - used),
        totalUsed: used,
      });
    }
    const gw = createGateway({ apiKey: key });
    const credits = (await gw.getCredits()) as {
      balance?: unknown;
      totalUsed?: unknown;
      total_used?: unknown;
    };
    return NextResponse.json({
      valid: true,
      provider,
      model: MODEL,
      balance: Number(credits.balance ?? 0),
      totalUsed: Number(credits.totalUsed ?? credits.total_used ?? 0),
    });
  } catch {
    return NextResponse.json({ valid: false, provider, model: MODEL }, { status: 401 });
  }
}

export async function POST(req: NextRequest) {
  const t0 = Date.now();

  let body: {
    chefId?: number;
    gameTime?: number;
    options?: GameOption[];
    state?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 422 });
  }

  const options = (body.options ?? []).filter(
    (o): o is GameOption => !!o && typeof o.id === 'string' && typeof o.label === 'string',
  );
  if (options.length === 0) {
    return NextResponse.json({ error: 'no options' }, { status: 422 });
  }

  const key = readKey(req);
  if (!key) {
    return NextResponse.json(
      { error: 'byok: send your Vercel AI Gateway or OpenRouter key in x-gateway-key' },
      { status: 401 },
    );
  }
  const provider = providerFor(key);

  const idBySafe = new Map<string, string>();
  const criteria: Record<string, string> = {};
  for (const o of options) {
    const k = safeKey(o.id);
    idBySafe.set(k, o.id);
    criteria[k] = o.label;
  }

  const stateForModel = JSON.parse(
    JSON.stringify({
      role: `You are chef ${body.chefId ?? 0} (one of four AI chefs) in an Overcooked-style kitchen. Maximize dishes served before their order deadlines; never let cooked food burn; fires are emergencies.`,
      gameTime: body.gameTime ?? 0,
      kitchen: body.state ?? {},
    }),
  );
  const questions = {
    next_action: {
      type: 'choice' as const,
      instructions:
        'Pick the single best next action for this chef right now, weighing order deadlines, distances, what the chef is carrying, and any fires.',
      criteria,
    },
  };

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let result: any;
    if (provider === 'openrouter') {
      const res = await fetch(OR_DECISIONS_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: OR_MODEL, state: stateForModel, questions }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const text = (await res.text()).slice(0, 200);
        throw new Error(`openrouter ${res.status}: ${text}`);
      }
      result = await res.json();
    } else {
      const gw = createGateway({ apiKey: key });
      result = await evaluate({
        // Fail fast: the game has a local fallback brain, so a rate-limited
        // call must return quickly instead of stalling the chef ~7s in retries.
        maxRetries: 0,
        model: gw.evaluationModel(MODEL),
        state: stateForModel,
        questions,
      });
    }

    const answer = result?.answers?.next_action ?? {};
    const chosenSafe: string | undefined =
      typeof answer.choice === 'string' ? answer.choice : undefined;
    const chosenId = (chosenSafe && idBySafe.get(chosenSafe)) ?? options[0].id;

    const probsRaw: Record<string, number> =
      answer.probabilities && typeof answer.probabilities === 'object'
        ? answer.probabilities
        : { [safeKey(chosenId)]: 1 };
    const policy = Object.entries(probsRaw)
      .map(([k, p]) => {
        const id = idBySafe.get(k) ?? k;
        return {
          id,
          label: options.find((o) => o.id === id)?.label ?? id,
          prob: typeof p === 'number' ? p : 0,
        };
      })
      .sort((a, b) => b.prob - a.prob)
      .slice(0, 5);

    const confidence: number =
      typeof answer.confidence === 'number'
        ? answer.confidence
        : typeof result?.providerMetadata?.typesafe?.confidence?.next_action === 'number'
          ? result.providerMetadata.typesafe.confidence.next_action
          : (policy[0]?.prob ?? 0.6);

    const tokens: number =
      typeof result?.usage?.inputTokens === 'number'
        ? result.usage.inputTokens
        : typeof result?.usage?.input_tokens === 'number'
          ? result.usage.input_tokens
          : 400;

    // The gateway reports exact spend per call; prefer it over estimation.
    const gatewayCost = parseFloat(result?.providerMetadata?.gateway?.cost ?? '');
    const costUsd = Number.isFinite(gatewayCost) ? gatewayCost : tokens * PRICE_PER_TOKEN;

    return NextResponse.json({
      chosenId,
      policy,
      confidence,
      latencyMs: Date.now() - t0,
      tokens,
      costUsd,
      provider,
      model: provider === 'openrouter' ? OR_MODEL : MODEL,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'evaluate failed';
    return NextResponse.json(
      { error: message, latencyMs: Date.now() - t0 },
      { status: 502 },
    );
  }
}
