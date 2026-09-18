// ─────────────────────────────────────────────────────────────
// JEV'S KITCHEN CHAOS 3D — shared contract
// Every module (sim, brain, 3D scene, HUD) codes against this
// file only. Do not import across modules except through here.
// ─────────────────────────────────────────────────────────────

export interface Point { x: number; y: number }

// ── Grid / layout ────────────────────────────────────────────
// Tile legend:
// 0 floor · 1 counter · 2 stove · 3 cutting board · 4 tomato crate
// 5 meat crate · 6 pasta crate · 7 plate stack · 8 serving window · 9 trash
export const T = {
  FLOOR: 0, COUNTER: 1, STOVE: 2, BOARD: 3,
  CRATE_TOMATO: 4, CRATE_MEAT: 5, CRATE_PASTA: 6,
  PLATES: 7, SERVE: 8, TRASH: 9,
} as const;
export type TileKind = (typeof T)[keyof typeof T];

export const GRID_W = 15;
export const GRID_H = 8;

// Overcooked-style: counter ring + two center islands with boards.
export const KITCHEN_LAYOUT: number[][] = [
  [1,1,2,2,1,1,1,8,8,1,1,1,2,2,1],
  [4,0,0,0,0,0,0,0,0,0,0,0,0,0,7],
  [5,0,0,0,0,0,0,0,0,0,0,0,0,0,7],
  [6,0,0,1,3,3,1,0,0,1,3,3,1,0,1],
  [1,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
  [1,0,0,1,1,1,1,0,0,1,1,1,1,0,9],
  [1,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
  [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
];

export const isWalkable = (t: number) => t === T.FLOOR;
export const isStation = (t: number) => t !== T.FLOOR && t !== T.COUNTER;

// ── Food ─────────────────────────────────────────────────────
export type Ingredient = 'tomato' | 'meat' | 'pasta';
export type ItemStage = 'raw' | 'chopped' | 'cooked' | 'burnt' | 'plated';

export interface Item {
  ingredient: Ingredient;
  stage: ItemStage;
  dish?: DishId; // set once plated
}

export type DishId = 'salad' | 'soup' | 'burger' | 'steak' | 'pasta';

export interface Recipe {
  id: DishId;
  name: string;
  ingredient: Ingredient;
  needsChop: boolean;
  needsCook: boolean;
  chopTime: number;   // seconds of work
  cookTime: number;   // seconds on stove
  burnTime: number;   // seconds AFTER cooked until it burns
  points: number;
  orderTime: number;  // seconds customer will wait
}

export const RECIPES: Record<DishId, Recipe> = {
  salad:  { id: 'salad',  name: 'Salad',  ingredient: 'tomato', needsChop: true,  needsCook: false, chopTime: 2.6, cookTime: 0,   burnTime: 0,  points: 15, orderTime: 45 },
  soup:   { id: 'soup',   name: 'Soup',   ingredient: 'tomato', needsChop: true,  needsCook: true,  chopTime: 2.6, cookTime: 5,   burnTime: 10, points: 25, orderTime: 60 },
  burger: { id: 'burger', name: 'Burger', ingredient: 'meat',   needsChop: true,  needsCook: true,  chopTime: 2.2, cookTime: 4.5, burnTime: 9,  points: 30, orderTime: 60 },
  steak:  { id: 'steak',  name: 'Steak',  ingredient: 'meat',   needsChop: false, needsCook: true,  chopTime: 0,   cookTime: 6,   burnTime: 8,  points: 35, orderTime: 55 },
  pasta:  { id: 'pasta',  name: 'Pasta',  ingredient: 'pasta',  needsChop: false, needsCook: true,  chopTime: 0,   cookTime: 5,   burnTime: 11, points: 40, orderTime: 70 },
};

export const DISH_EMOJI: Record<DishId, string> = {
  salad: '🥗', soup: '🍲', burger: '🍔', steak: '🥩', pasta: '🍝',
};

// ── Stations ─────────────────────────────────────────────────
export interface Station {
  id: number;
  kind: TileKind;      // STOVE | BOARD | CRATE_* | PLATES | SERVE | TRASH
  x: number; y: number; // grid tile
  item: Item | null;    // what's sitting on it (stove pot contents / board contents)
  progress: number;     // 0..1 chop or cook progress
  onFire: boolean;
  fireHp: number;       // extinguish work remaining 0..1
  inUseBy: number | null; // chef id actively working here
}

// ── Orders ───────────────────────────────────────────────────
export interface Order {
  id: number;
  dish: DishId;
  createdAt: number;
  expiresAt: number;
  claimedBy: number | null; // chef id
  status: 'open' | 'done' | 'failed';
}

// ── Chefs ────────────────────────────────────────────────────
export type ChefAction =
  | 'idle' | 'walking' | 'chopping' | 'stirring' | 'grabbing'
  | 'plating' | 'delivering' | 'extinguishing' | 'celebrating' | 'panicking';

export interface Chef {
  id: number;              // 0..3 → P1..P4
  name: string;            // "P1 / JEV" style handled by HUD; this is "Chef Jev" etc
  accent: string;          // hex accent color
  x: number; y: number;    // grid coords, float, interpolated by sim
  facing: Point;           // unit-ish direction
  carrying: Item | null;
  action: ChefAction;
  actionProgress: number;  // 0..1 while working
  path: Point[];           // remaining waypoints (tile centers)
  dishesServed: number;    // lifetime dishes this chef delivered
  planLabel: string;       // human plan e.g. "Soup: chop tomato"
  moveLabel: string;       // micro move e.g. "Chop", "Walk → Stove 2"
  targetStationId: number | null;
  // live "controller" state for the HUD input viz
  inputDir: Point;         // -1..1 each axis, 0,0 when still
  inputBtn: 'A' | 'B' | null; // A = interact/work, B = pickup/place
}

export const CHEF_DEFS = [
  { name: 'Chef Jev', accent: '#ff4d5e' },  // P1 red
  { name: 'Sous Jev', accent: '#3da5ff' },  // P2 blue
  { name: 'Line Jev', accent: '#ffc14d' },  // P3 amber
  { name: 'Prep Jev', accent: '#31d97c' },  // P4 green
] as const;

// ── Jev decision protocol (mirrors the Jev decisions API) ────
export interface ActionOption {
  id: string;     // machine id e.g. "claim:3" "fetch:tomato" "chop:12" "cook:2" "collect:2" "plate" "deliver" "trash" "extinguish:2" "wait"
  label: string;  // short human label e.g. "Chop Tomato" (used in policy bars)
}

export interface DecisionRequest {
  chefId: number;
  gameTime: number;
  options: ActionOption[];        // ALWAYS non-empty; "wait" is always present
  state: Record<string, unknown>; // compact serializable game view (for remote API)
}

export interface PolicyEntry { id: string; label: string; prob: number }

export interface JevDecision {
  chosenId: string;
  policy: PolicyEntry[];  // sorted desc by prob, up to 5
  confidence: number;     // 0..1
  latencyMs: number;
  tokens: number;
  costUsd: number;
}

export interface JevBrain {
  readonly name: string;  // "jev-local" | "jev-1.13"
  decide(req: DecisionRequest): Promise<JevDecision>;
}

// ── Telemetry (per chef, consumed by HUD) ────────────────────
export interface ChefTelemetry {
  chefId: number;
  decisions: number;
  lastDecision: JevDecision | null;
  latencyHistory: number[]; // capped at 48, newest last
  totalTokens: number;
  totalCostUsd: number;
  inFlight: boolean;        // decision request currently pending
}

// ── Events ticker ────────────────────────────────────────────
export interface SimEvent {
  t: number;
  kind: 'serve' | 'fail' | 'fire' | 'burn' | 'rush' | 'info';
  text: string; // e.g. "P3 served Steak (+35)"
}

// ── Whole sim state (scene reads per-frame; HUD snapshots ~10Hz)
export interface SimState {
  t: number;
  running: boolean;
  chefs: Chef[];
  stations: Station[];
  orders: Order[];
  score: number;
  served: number;
  failed: number;
  fires: number;
  rushUntil: number;      // t until which rush hour is active
  events: SimEvent[];     // most recent last, capped ~30
  telemetry: ChefTelemetry[];
}

// Sim implementation contract (game/sim.ts):
//   export class KitchenSim {
//     readonly state: SimState;
//     constructor(makeBrain: (chefId: number) => JevBrain);
//     tick(dt: number): void;        // fixed-ish dt from rAF, seconds
//     triggerRush(): void;           // flood orders for 30s
//     triggerFire(): void;           // ignite a random busy stove
//     setBrains(makeBrain: (chefId: number) => JevBrain): void; // hot-swap local→remote
//   }
//
// Scene contract (components/three/KitchenScene.tsx):
//   export function KitchenScene({ getState }: { getState: () => SimState }): JSX.Element
//   Mounted inside <Canvas> by page.tsx. Reads getState() inside useFrame.
//
// HUD contract (components/hud/*):
//   export function TelemetryPanel({ chef, telemetry, side }: { chef: Chef; telemetry: ChefTelemetry; side: 'left'|'right' }): JSX.Element
//   export function TopBar({ state }: { state: SimState }): JSX.Element        // title + aggregate stats
//   export function BottomBar({ state, onRush, onFire, onApiKey }: { state: SimState; onRush(): void; onFire(): void; onApiKey(key: string): void }): JSX.Element
//   Styles live in src/components/hud/hud.css using the design tokens below.

// ── Design tokens (defined in globals.css, referenced by HUD css)
// --bg: #0a0a0f          page background
// --panel: #111118       panel background
// --panel-edge: #23232e  1px panel borders
// --text: #e8e8f0        primary text
// --dim: #6b6b7a         secondary text
// --p1: #ff4d5e  --p2: #3da5ff  --p3: #ffc14d  --p4: #31d97c
// fonts: var(--font-display) Archivo caps · var(--font-mono) IBM Plex Mono
