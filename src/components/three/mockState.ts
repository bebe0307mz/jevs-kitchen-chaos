'use client';
// ─────────────────────────────────────────────────────────────
// A hand-built, believable frozen SimState so the scene can render
// (and be QA'd) without the live sim. Exercises every visual path:
// chefs mid-walk / chopping / carrying / celebrating / panicking,
// one stove cooking, one on fire, cooked-and-waiting steam, orders.
// ─────────────────────────────────────────────────────────────
import {
  KITCHEN_LAYOUT, GRID_W, GRID_H, T,
  CHEF_DEFS, RECIPES,
  type SimState, type Station, type Chef, type Order, type OrderComponent,
  type Assembly, type ChefTelemetry, type TileKind, type JevDecision, type DishId,
} from '@/game/types';

// Build the OrderComponent list for a dish from its recipe, with an optional
// per-component status override so the mock can show mixed prep progress.
function orderComponents(dish: DishId, overrides: Partial<OrderComponent>[] = []): OrderComponent[] {
  return RECIPES[dish].components.map((c, i) => ({
    label: c.label,
    ingredient: c.ingredient,
    status: 'todo',
    by: null,
    ...overrides[i],
  }));
}

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
      dishesServed: 0,
      x: board0 ? board0.x : 4, y: board0 ? board0.y + 1 : 4,
      facing: { x: 0, y: -1 },
      carrying: null,
      action: 'chopping', actionProgress: 0.4,
      path: [], planLabel: 'Salad: chop tomato', moveLabel: 'Chop',
      targetStationId: board0?.id ?? null, workingOrderId: 3,
      inputDir: { x: 0, y: 0 }, inputBtn: 'A',
    },
    // P2 — walking, carrying a chopped tomato toward a stove
    {
      id: 1, name: defs[1].name, accent: defs[1].accent,
      dishesServed: 0,
      x: 6.4, y: 2.2,
      facing: { x: 0.6, y: -0.8 },
      carrying: { ingredient: 'tomato', stage: 'chopped' },
      action: 'walking', actionProgress: 0,
      path: [{ x: 2, y: 0 }], planLabel: 'Soup: to Stove 1', moveLabel: 'Walk -> Stove',
      targetStationId: stove0?.id ?? null, workingOrderId: 1,
      inputDir: { x: 0.7, y: -0.7 }, inputBtn: null,
    },
    // P3 — celebrating a delivery, carrying a plated dish
    {
      id: 2, name: defs[2].name, accent: defs[2].accent,
      dishesServed: 0,
      x: 8.5, y: 1.6,
      facing: { x: 0, y: -1 },
      carrying: { ingredient: 'bun', stage: 'plated', dish: 'burger' },
      action: 'celebrating', actionProgress: 0.8,
      path: [], planLabel: 'Served Burger!', moveLabel: 'Deliver',
      targetStationId: findStation(stations, T.SERVE, 0)?.id ?? null, workingOrderId: 2,
      inputDir: { x: 0, y: 0 }, inputBtn: 'B',
    },
    // P4 — panicking next to the fire
    {
      id: 3, name: defs[3].name, accent: defs[3].accent,
      dishesServed: 0,
      x: stove2 ? stove2.x : 12, y: stove2 ? stove2.y + 1.3 : 1.3,
      facing: { x: 0, y: -1 },
      carrying: null,
      action: 'panicking', actionProgress: 0.3,
      path: [], planLabel: 'FIRE! panic', moveLabel: 'Panic',
      targetStationId: stove2?.id ?? null, workingOrderId: null,
      inputDir: { x: 0.2, y: -0.1 }, inputBtn: null,
    },
  ];

  const now = 42;

  // Two PLATES stations double as assembly benches.
  const plates0 = findStation(stations, T.PLATES, 0);
  const plates1 = findStation(stations, T.PLATES, 1);

  const orders: Order[] = [
    // Soup #1 — P2 prepping the base (walking a chopped tomato to a stove).
    {
      id: 1, dish: 'soup', createdAt: now - 12, expiresAt: now + 48, status: 'open',
      components: orderComponents('soup', [{ status: 'prepping', by: 1 }, { status: 'todo' }]),
      assemblyStationId: plates0?.id ?? null, assemblerId: null,
    },
    // Burger #2 — bun + patty already parked at plates0, tomato still to do.
    {
      id: 2, dish: 'burger', createdAt: now - 30, expiresAt: now + 8, status: 'open',
      components: orderComponents('burger', [
        { status: 'ready' },                 // bun
        { status: 'ready' },                 // grilled patty
        { status: 'prepping', by: 2 },       // chopped tomato
      ]),
      assemblyStationId: plates0?.id ?? null, assemblerId: 2,
    },
    // Salad #3 — P1 chopping the tomato.
    {
      id: 3, dish: 'salad', createdAt: now - 5, expiresAt: now + 40, status: 'open',
      components: orderComponents('salad', [{ status: 'prepping', by: 0 }]),
      assemblyStationId: plates1?.id ?? null, assemblerId: null,
    },
    // Steak #4 — untouched.
    {
      id: 4, dish: 'steak', createdAt: now - 2, expiresAt: now + 53, status: 'open',
      components: orderComponents('steak'),
      assemblyStationId: null, assemblerId: null,
    },
  ];

  // Parts physically waiting at assembly benches (what the 3D scene draws).
  const assemblies: Assembly[] = [];
  if (plates0) {
    // Burger #2: bun + grilled patty ready, tomato not yet.
    assemblies.push({
      orderId: 2, dish: 'burger', stationId: plates0.id,
      readyItems: [
        { ingredient: 'bun', stage: 'raw' },
        { ingredient: 'meat', stage: 'chopped' },
      ],
    });
    // Soup #1: tomato base simmering elsewhere, garnish already chopped here.
    assemblies.push({
      orderId: 1, dish: 'soup', stationId: plates0.id,
      readyItems: [{ ingredient: 'tomato', stage: 'chopped' }],
    });
  }

  return {
    t: now,
    running: true,
    shiftEndsAt: 180,
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
    assemblies,
  };
}
