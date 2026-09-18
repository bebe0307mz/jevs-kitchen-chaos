# HUD — integration notes

Everything visual for the broadcast chrome lives under `src/components/hud/`.
`hud.css` is imported by each component, so importing the components is enough —
you do not need to import the stylesheet yourself.

## Components (exact signatures, from the contract in `types.ts`)

```ts
import { TelemetryPanel, TopBar, BottomBar } from '@/components/hud';

// TelemetryPanel({ chef, telemetry, side })
<TelemetryPanel chef={state.chefs[0]} telemetry={state.telemetry[0]} side="left" />

// TopBar({ state })
<TopBar state={state} />

// BottomBar({ state, onRush, onFire, onApiKey, brainName? })
<BottomBar
  state={state}
  onRush={() => sim.triggerRush()}
  onFire={() => sim.triggerFire()}
  onApiKey={(key) => connectRemoteBrain(key)}
  brainName="jev-local (emulated)" // optional; default shown
/>
```

- All three are `"use client"` and wrapped in `React.memo`. Pass fresh
  `chef` / `telemetry` / `state` object references from your ~10Hz snapshot so
  memo can skip unchanged panels. If you mutate the same objects in place, memo
  will suppress updates — snapshot with new references each tick.
- The sparkline is memoized on `telemetry.latencyHistory` **by reference**.
  Push a new/replaced array when a decision lands (a fresh array each snapshot is
  fine); mutating the same array in place will not re-draw the sparkline.

## Page grid (build this layout in `page.tsx`)

Class names owned by the HUD stylesheet:

```
.broadcast            full-viewport grid: [left 312px] [center 1fr] [right 312px]
  .col-left           2 rows → P1 panel (top), P3 panel (bottom)
    <TelemetryPanel chef={chefs[0]} telemetry={telemetry[0]} side="left" />
    <TelemetryPanel chef={chefs[2]} telemetry={telemetry[2]} side="left" />
  .center-stack       3 rows → TopBar / .stage / BottomBar
    <TopBar state={state} />
    .stage            ← absolutely-position the <Canvas> in here
    <BottomBar ... />
  .col-right          2 rows → P2 panel (top), P4 panel (bottom)
    <TelemetryPanel chef={chefs[1]} telemetry={telemetry[1]} side="right" />
    <TelemetryPanel chef={chefs[3]} telemetry={telemetry[3]} side="right" />
```

Suggested placement of the four panels: **P1 + P3 left, P2 + P4 right** (matches
the P1/P2/P3/P4 accent order). `side` is cosmetic (`data-side` attr) — the panel
renders the same either way; pass `"left"` for the left column and `"right"` for
the right.

### The `.stage` cell

`.stage` is `position: relative` with a rounded inset border and a warm radial
"spotlight" glow backdrop. Drop your canvas in absolutely:

```tsx
<div className="stage">
  <Canvas style={{ position: 'absolute', inset: 0 }}>
    <KitchenScene getState={getState} />
  </Canvas>
</div>
```

## Fonts

The stylesheet references `var(--font-display)` (Archivo) and
`var(--font-mono)` (IBM Plex Mono). Provide both via `next/font` on the
`<body>` (or a wrapper) as the contract specifies. Fallbacks are baked in
(`'Archivo'`, `'IBM Plex Mono'`, generic families) so nothing breaks if the vars
are absent.

## Tokens consumed

From `globals.css`: `--bg --panel --panel-edge --text --dim --p1 --p2 --p3 --p4`
(plus `--live` / `--good` if present; they fall back visually). The HUD sets a
local `--accent` inline per panel/chip from `chef.accent`.

## Responsive behavior

Designed for 1440×900 down to 1280×800. `.broadcast` has `min-width: 1100px`;
below that the page scrolls horizontally by design (this is a showcase).

## Contract ambiguities + resolutions

1. **`brainName` is not in the contract.** Added as an optional prop on
   `BottomBar` (`brainName?: string`, default `'jev-local (emulated)'`), shown in
   the API popover under a "MODEL" label. Override it when a remote brain
   connects (e.g. pass `sim`'s active brain `.name`).
2. **Chip `%` semantics.** The brief says "% = claimed order time remaining".
   Computed as the remaining fraction of the claimed open order's
   `createdAt→expiresAt` window at `state.t`. When a chef has no claimed open
   order, the chip shows `IDLE` and omits the `%`.
3. **AVG LATENCY** in `TopBar` = mean of each chef's most recent latency sample
   (last element of `latencyHistory`, falling back to `lastDecision.latencyMs`),
   ignoring chefs with no samples yet.
4. **Role tags** (EXPEDITER / SOUS / LINE COOK / PREP) are cosmetic broadcast
   flavor keyed by chef id; not in the contract, purely presentational.
5. **Cost formatting** uses 5 decimals under $0.001 so micro-costs render
   non-zero, per the brief's "2,015 tok · $0.00008" example.
