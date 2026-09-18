'use client';
// ─────────────────────────────────────────────────────────────
// A hand-built, believable frozen SimState so the scene can render
// (and be QA'd) without the live sim. Exercises every visual path:
// chefs mid-walk / chopping / carrying / celebrating / panicking,
// one stove cooking, one on fire, cooked-and-waiting steam, orders.
// ─────────────────────────────────────────────────────────────
import {
  KITCHEN_LAYOUT, GRID_W, GRID_H, T,
  CHEF_DEFS,
  type SimState, type Station, type Chef, type Order,
  type ChefTelemetry, type TileKind, type JevDecision,
} from '@/game/types';

// Build a station for every non-floor, non-counter tile (matches how a
// real sim would enumerate interactable stations), then override a few
// to show cooking / fire / chopping.
function buildStations(): Station[] {
  const out: Station[] = [];
  let id = 0;
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      const kind = KITCHEN_LAYOUT[y][x] as TileKind;
      if (kind === T.FLOOR || kind === T.COUNTER) continue;
      out.push({
        id: id++,
        kind,
        x, y,
        item: null,
        progress: 0,
        onFire: false,
        fireHp: 0,
        inUseBy: null,
      });
    }
  }
  return out;
}

function findStation(stations: Station[], kind: TileKind, nth = 0): Station | undefined {
  return stations.filter((s) => s.kind === kind)[nth];
}

function makeTelemetry(chefId: number): ChefTelemetry {
  const last: JevDecision = {
    chosenId: chefId === 0 ? 'chop:1' : chefId === 1 ? 'cook:0' : chefId === 2 ? 'deliver' : 'extinguish:0',
    policy: [
      { id: 'chop:1', label: 'Chop Tomato', prob: 0.61 },
      { id: 'fetch:tomato', label: 'Fetch Tomato', prob: 0.2 },
      { id: 'cook:0', label: 'Cook Soup', prob: 0.11 },
      { id: 'wait', label: 'Wait', prob: 0.08 },
    ],
    confidence: 0.72 - chefId * 0.08,
    latencyMs: 340 + chefId * 55,
    tokens: 512 + chefId * 40,
    costUsd: 0.0021 + chefId * 0.0003,
  };
  return {
    chefId,
    decisions: 18 + chefId * 3,
    lastDecision: last,
    latencyHistory: Array.from({ length: 24 }, (_, i) => 300 + Math.sin(i * 0.6 + chefId) * 120 + Math.random() * 40),
    totalTokens: (512 + chefId * 40) * (18 + chefId * 3),
    totalCostUsd: (0.0021 + chefId * 0.0003) * (18 + chefId * 3),
    inFlight: chefId === 1,
  };
}

export function makeMockState(): SimState {
  const stations = buildStations();

  // Stove 0: soup cooking mid-progress
  const stove0 = findStation(stations, T.STOVE, 0);
  if (stove0) {
    stove0.item = { ingredient: 'tomato', stage: 'cooked', dish: 'soup' };
    stove0.progress = 0.54;
    stove0.inUseBy = 1;
  }
  // Stove 1: cooked & waiting (steam)
  const stove1 = findStation(stations, T.STOVE, 1);
  if (stove1) {
    stove1.item = { ingredient: 'meat', stage: 'cooked' };
    stove1.progress = 1;
  }
  // Stove 2: ON FIRE
  const stove2 = findStation(stations, T.STOVE, 2);
  if (stove2) {
    stove2.item = { ingredient: 'pasta', stage: 'burnt' };
    stove2.progress = 1;
    stove2.onFire = true;
    stove2.fireHp = 0.7;
  }
  // Board 0: someone chopping a raw tomato
  const board0 = findStation(stations, T.BOARD, 0);
  if (board0) {
    board0.item = { ingredient: 'tomato', stage: 'raw' };
    board0.progress = 0.4;
    board0.inUseBy = 0;
  }
  // Board 1: a chopped meat sitting ready
  const board1 = findStation(stations, T.BOARD, 1);
  if (board1) {
    board1.item = { ingredient: 'meat', stage: 'chopped' };
    board1.progress = 1;
  }

  const defs = CHEF_DEFS;
  const chefs: Chef[] = [
    // P1 — chopping at board 0
    {
      id: 0, name: defs[0].name, accent: defs[0].accent,
      x: board0 ? board0.x : 4, y: board0 ? board0.y + 1 : 4,
      facing: { x: 0, y: -1 },
      carrying: null,
      action: 'chopping', actionProgress: 0.4,
      path: [], planLabel: 'Salad: chop tomato', moveLabel: 'Chop',
      targetStationId: board0?.id ?? null,
      inputDir: { x: 0, y: 0 }, inputBtn: 'A',
    },
    // P2 — walking, carrying a chopped tomato toward a stove
    {
      id: 1, name: defs[1].name, accent: defs[1].accent,
      x: 6.4, y: 2.2,
      facing: { x: 0.6, y: -0.8 },
      carrying: { ingredient: 'tomato', stage: 'chopped' },
      action: 'walking', actionProgress: 0,
      path: [{ x: 2, y: 0 }], planLabel: 'Soup: to Stove 1', moveLabel: 'Walk -> Stove',
      targetStationId: stove0?.id ?? null,
      inputDir: { x: 0.7, y: -0.7 }, inputBtn: null,
    },
    // P3 — celebrating a delivery, carrying a plated dish
    {
      id: 2, name: defs[2].name, accent: defs[2].accent,
      x: 8.5, y: 1.6,
      facing: { x: 0, y: -1 },
      carrying: { ingredient: 'meat', stage: 'plated', dish: 'burger' },
      action: 'celebrating', actionProgress: 0.8,
      path: [], planLabel: 'Served Burger!', moveLabel: 'Deliver',
      targetStationId: findStation(stations, T.SERVE, 0)?.id ?? null,
      inputDir: { x: 0, y: 0 }, inputBtn: 'B',
    },
    // P4 — panicking next to the fire
    {
      id: 3, name: defs[3].name, accent: defs[3].accent,
      x: stove2 ? stove2.x : 12, y: stove2 ? stove2.y + 1.3 : 1.3,
      facing: { x: 0, y: -1 },
      carrying: null,
      action: 'panicking', actionProgress: 0.3,
      path: [], planLabel: 'FIRE! panic', moveLabel: 'Panic',
      targetStationId: stove2?.id ?? null,
      inputDir: { x: 0.2, y: -0.1 }, inputBtn: null,
    },
  ];

  const now = 42;
  const orders: Order[] = [
    { id: 1, dish: 'soup', createdAt: now - 12, expiresAt: now + 48, claimedBy: 1, status: 'open' },
    { id: 2, dish: 'burger', createdAt: now - 30, expiresAt: now + 8, claimedBy: null, status: 'open' },
    { id: 3, dish: 'salad', createdAt: now - 5, expiresAt: now + 40, claimedBy: 0, status: 'open' },
    { id: 4, dish: 'steak', createdAt: now - 2, expiresAt: now + 53, claimedBy: null, status: 'open' },
  ];

  return {
    t: now,
    running: true,
    chefs,
    stations,
    orders,
    score: 285,
    served: 11,
    failed: 2,
    fires: 1,
    rushUntil: now + 14,
    events: [
      { t: now - 1, kind: 'serve', text: 'P3 served Burger (+30)' },
      { t: now - 4, kind: 'fire', text: 'Stove 3 caught fire!' },
      { t: now - 9, kind: 'serve', text: 'P1 served Salad (+15)' },
      { t: now - 15, kind: 'rush', text: 'RUSH HOUR started' },
    ],
    telemetry: [0, 1, 2, 3].map(makeTelemetry),
  };
}
