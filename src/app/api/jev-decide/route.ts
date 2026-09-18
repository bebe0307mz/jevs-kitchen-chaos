// ─────────────────────────────────────────────────────────────
// Jev decision proxy. The browser POSTs the game's DecisionRequest
// here; we reformulate it as a single TypeSafe Jev `choice` question
// and evaluate it through Vercel AI Gateway (model typesafe-ai/jev).
// The gateway key stays server-side: env AI_GATEWAY_API_KEY, or an
// x-gateway-key header pasted via the in-app API button.
// ─────────────────────────────────────────────────────────────
import { NextRequest, NextResponse } from 'next/server';
import { experimental_evaluate as evaluate } from 'ai';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const MODEL = 'typesafe-ai/jev';
const PRICE_PER_TOKEN = 0.042 / 1_000_000; // $0.042 / 1M input tokens
// Jev choice criteria keys must be plain identifiers; game ids contain ':'.
const safeKey = (id: string) => id.replace(/[^a-zA-Z0-9_]/g, '_');

interface GameOption {
  id: string;
  label: string;
}

export async function GET() {
  return NextResponse.json({
    configured: Boolean(process.env.AI_GATEWAY_API_KEY),
    model: MODEL,
  });
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

  const headerKey = req.headers.get('x-gateway-key') ?? req.headers.get('x-api-key');
  if (headerKey && !process.env.AI_GATEWAY_API_KEY) {
    // Single-tenant showcase: adopt the pasted key for this runtime so the
    // AI SDK's gateway provider picks it up.
    process.env.AI_GATEWAY_API_KEY = headerKey;
  }
  if (!process.env.AI_GATEWAY_API_KEY) {
    return NextResponse.json(
      { error: 'AI_GATEWAY_API_KEY not configured' },
      { status: 401 },
    );
  }

  const idBySafe = new Map<string, string>();
  const criteria: Record<string, string> = {};
  for (const o of options) {
    const k = safeKey(o.id);
    idBySafe.set(k, o.id);
    criteria[k] = o.label;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await evaluate({
      model: MODEL,
      state: JSON.parse(
        JSON.stringify({
          role: `You are chef ${body.chefId ?? 0} (one of four AI chefs) in an Overcooked-style kitchen. Maximize dishes served before their order deadlines; never let cooked food burn; fires are emergencies.`,
          gameTime: body.gameTime ?? 0,
          kitchen: body.state ?? {},
        }),
      ),
      questions: {
        next_action: {
          type: 'choice',
          instructions:
            'Pick the single best next action for this chef right now, weighing order deadlines, distances, what the chef is carrying, and any fires.',
          criteria,
        },
      },
    });

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
      model: MODEL,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'evaluate failed';
    return NextResponse.json(
      { error: message, latencyMs: Date.now() - t0 },
      { status: 502 },
    );
  }
}
