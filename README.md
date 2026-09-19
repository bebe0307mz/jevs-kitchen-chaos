# Jev's Kitchen Chaos — AI models run an Overcooked kitchen

**Live: https://jevs-kitchen-chaos.vercel.app**

Four AI chefs run an Overcooked-style 3D kitchen. Every move each chef makes
is one live API decision — the panels around the stage stream each chef's
current plan, the model's policy distribution, its confidence, real response
latency, and running token cost. Esports-broadcast style.

It's also a **model benchmark arena**: swap the brain driving all four chefs
between [TypeSafe's Jev](https://typesafe.ai) (a decision model — state in,
typed choice out, no text) and frontier LLMs, and compare score, latency, and
cost-per-point on identical shifts.

## Play it

1. Open the site. No key → free demo with a built-in imitation of Jev.
2. **BYOK**: paste a [Vercel AI Gateway](https://vercel.com/ai-gateway)
   (`vck_…`) or [OpenRouter](https://openrouter.ai) (`sk-or-…`) key. It stays
   in your browser and is proxied per-request — never stored server-side.
3. Pick a brain: Jev, Claude Opus 4.8, GPT-5.6 Sol, or DeepSeek V4 Flash.
4. **START SHIFT.** 3:00 on the clock. A full game costs ~$0.01 (Jev) to
   ~$0.50 (Opus).

Buttons: **RUSH HOUR** floods orders · **START FIRE** ignites a stove ·
🔊 procedural audio (all Web Audio synthesis, zero samples) · optional shift
video recording (.webm) · end-of-shift scoreboard with a downloadable
decision log.

## The game punishes bad judgment, not just bad luck

- Multi-component recipes (burger = bun + grilled patty + chopped tomato)
  prepared task-market style — any chef preps any component, then someone
  assembles and delivers.
- Cooked food left on a stove burns and starts fires.
- Serving a dish whose order expired: **−half points**.
- The "serve incomplete" trap: assembly is offered from the first ready
  component, clearly labeled `INCOMPLETE (2/3 — penalty!)`. Rushing it fails
  the order and costs half points. Deadline pressure vs. patience — the
  models must choose.

## Benchmarking

- `/?pure=1` — pure benchmark mode: no fallback brain, no circuit breaker.
  A slow or failed call leaves the chef idle. Every logged decision is
  genuinely the model's.
- Every shift log carries per-decision state/options/policy/latency/cost
  (tagged `source: live | fallback`) plus a `metrics` rollup: latency
  p50/p95, decisions/min, total cost, cost-per-point, cost-per-serve.
- Headless runner: `JEV_KEY=<key> BRAIN_MODEL=<slug> PURE=1 bun scripts/liverun.ts live`

Early results (per-decision, live samples): Jev ~495ms / $0.00004 ·
GPT-5.6 Sol ~1.8s / $0.0018 · Claude Opus 4.8 ~1.6s / $0.006 ·
DeepSeek V4 Flash ~3.5s / $0.00006. Speed is the whole game.

## How it works

- `src/game/types.ts` — the shared contract (grid, recipes, decision protocol)
- `src/game/sim.ts` — headless kitchen sim; chefs never self-plan. When a
  chef runs out of steps the sim enumerates its legal actions and asks the
  brain: options in → `{chosenId, policy[], confidence}` out
- `src/game/brain.ts` — local heuristic brain (softmax policy) + remote brain
- `src/app/api/jev-decide/route.ts` — BYOK proxy: Jev via the gateway's
  evaluate API / OpenRouter's decisions API; LLM brains via OpenAI-compatible
  chat completions with a strict-JSON choice prompt
- `src/components/three/` — procedural three.js kitchen (no model files)
- `src/components/hud/` — the broadcast telemetry chrome
- `src/game/audio.ts` — procedural Overcooked-ish audio (Web Audio)

## Dev

```bash
bun install
bun run dev              # play locally
bun scripts/simtest.ts   # 300s headless harness with assertions
```

MIT — see LICENSE.
