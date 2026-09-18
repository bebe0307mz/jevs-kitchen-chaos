# Jev's Kitchen Chaos — Four Live Jev Chefs

An Overcooked-style 3D kitchen run entirely by four Jev decision-model agents,
presented as a live esports broadcast: the game in the center, per-chef
telemetry panels around it (current plan, policy confidence, response latency,
live controller inputs), and an aggregate latency/decisions/cost strip on top.

## How it works

- **KitchenSim** (`src/game/sim.ts`) — headless tick-based simulation: orders,
  stations, A* movement, cooking/chopping/plating, fires. Chefs never plan for
  themselves.
- **Jev decision loop** (`src/game/brain.ts`) — whenever a chef runs out of
  steps, the sim sends a compact game state + enumerated action options to its
  brain and gets back a decision: chosen action, policy distribution,
  confidence, latency, token cost. `LocalJevBrain` emulates the API shape with
  a utility+softmax policy; `RemoteJevBrain` POSTs to a live Jev API endpoint
  (`x-api-key` header) and falls back locally on any error.
- **3D scene** (`src/components/three/`) — react-three-fiber Overcooked-style
  diorama: procedural low-poly kitchen, cute chef blobs, fire/steam/confetti
  particles.
- **Broadcast HUD** (`src/components/hud/`) — the Smash-showcase-style
  telemetry chrome.

## Live Jev API

Click **API** (bottom right) and paste a key to hot-swap all four chefs from
the local emulated brain to the live Jev API. Endpoint comes from
`NEXT_PUBLIC_JEV_API_URL`, or paste `https://endpoint|key` to override.
Expected protocol: POST `{chefId, gameTime, options[], state}` → `{chosenId,
policy[], confidence, tokens, cost_usd}`.

## Dev

```bash
bun install
bun run dev        # play locally
bun scripts/simtest.ts   # headless 240s sim harness (assertions on serve rate, deadlocks, fires)
```

Buttons: **RUSH HOUR** floods orders for 30s · **START FIRE** ignites a busy
stove · click nothing and the four Jevs just run the kitchen forever.
