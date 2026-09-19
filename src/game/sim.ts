import {
  SimState, Chef, Station, Order, OrderComponent, Item, Recipe, RecipeComponent,
  DishId, Ingredient, JevBrain, JevDecision, DecisionRequest, ActionOption,
  ChefTelemetry, SimEvent, ChefAction, Point, DecisionLogEntry, ShiftLog, Assembly,
  T, TileKind, KITCHEN_LAYOUT, GRID_W, GRID_H, RECIPES, CHEF_DEFS, SHIFT_LENGTH,
} from './types';
// GRID_W / GRID_H are re-exported for consumers importing layout dims via sim.
export { GRID_W, GRID_H };
import { findPath, pathToStation, isFloor } from './pathfinding';

// ─────────────────────────────────────────────────────────────
// KitchenSim: headless Overcooked-style simulation with a task-market
// decision model. Orders spawn with a component checklist; ANY chef can
// prep ANY 'todo' component of ANY open order. When all components are
// 'ready' at the order's assembly station, a chef assembles + delivers.
// Chefs do NOT plan for themselves — whenever a chef runs out of task
// steps the sim asks its JevBrain to pick a high-level action, then
// compiles that action into an internal step chain. See types.ts for the
// authoritative contract.
// ─────────────────────────────────────────────────────────────

const CHEF_SPEED = 2.6;      // tiles / second
const B_HOLD = 0.25;         // seconds to hold the 'B' button for the HUD
const DECISION_MIN_GAP = 0.25;

// Internal step representation. A chef executes these in order; when the
// list empties, the sim asks the brain for the next high-level action.
type Step =
  | { kind: 'walkTo'; stand: Point; label: string }
  | { kind: 'work'; stationId: number; action: ChefAction; duration: number; label: string; onDone: (sim: KitchenSim, c: ChefRt) => void }
  | { kind: 'awaitCook'; stationId: number; label: string; onDone: (sim: KitchenSim, c: ChefRt) => void }
  | { kind: 'instant'; label: string; run: (sim: KitchenSim, c: ChefRt) => void };

// Runtime chef bundle: public Chef state + internal scheduling fields.
interface ChefRt {
  chef: Chef;
  brain: JevBrain;
  steps: Step[];
  stepTime: number;          // elapsed time inside the current work step
  bHoldUntil: number;        // sim time until which to show 'B'
  lastDecisionAt: number;
  idleSince: number;         // sim time chef became idle with no steps
  wobble: number;            // perpendicular visual offset seed
  telemetry: ChefTelemetry;
  // component this chef is currently prepping, resolved so onDone callbacks can
  // update the right OrderComponent even as orders/components shift around.
  prep: { orderId: number; compIdx: number } | null;
}

let nextOrderId = 1;

export class KitchenSim {
  readonly state: SimState;
  private rt: ChefRt[] = [];
  private makeBrain: (chefId: number) => JevBrain;
  private nextOrderAt = 0;
  // stationId → chefId currently assigned to extinguish it (one chef per fire)
  private fireAssign = new Map<number, number>();
  private decisionLog: DecisionLogEntry[] = [];
  private fullEvents: SimEvent[] = [];
  private shiftOverAnnounced = false;
  private assemblyRR = 0; // round-robin cursor over PLATES stations

  constructor(makeBrain: (chefId: number) => JevBrain, opts?: { shiftLength?: number }) {
    this.makeBrain = makeBrain;
    this.state = {
      t: 0,
      running: true,
      shiftEndsAt: opts?.shiftLength ?? SHIFT_LENGTH,
      chefs: [],
      stations: [],
      orders: [],
      score: 0,
      served: 0,
      failed: 0,
      fires: 0,
      rushUntil: 0,
      events: [],
      telemetry: [],
      assemblies: [],
    };
    this.buildStations();
    this.buildChefs();
    this.nextOrderAt = 6 + Math.random() * 4;
    // Seed opening orders so all four chefs have work from the first frame.
    // burger's 100s window keeps the flagship multi-component dish visible early.
    const openers: DishId[] = ['salad', 'steak', 'burger'];
    for (let i = 0; i < openers.length; i++) {
      this.state.orders.push(this.makeOrder(openers[i], 0, RECIPES[openers[i]].orderTime + i * 10));
    }
  }

  // ── setup ──────────────────────────────────────────────────
  private makeOrder(dish: DishId, createdAt: number, expiresAt: number): Order {
    const recipe = RECIPES[dish];
    return {
      id: nextOrderId++,
      dish,
      createdAt,
      expiresAt,
      status: 'open',
      components: recipe.components.map((rc) => ({
        label: rc.label,
        ingredient: rc.ingredient,
        status: 'todo' as const,
        by: null,
      })),
      assemblyStationId: null,
      assemblerId: null,
    };
  }

  private buildStations() {
    let id = 0;
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const t = KITCHEN_LAYOUT[y][x] as number;
        if (t === T.FLOOR || t === T.COUNTER) continue;
        this.state.stations.push({
          id: id++,
          kind: t as TileKind,
          x, y,
          item: null,
          progress: 0,
          onFire: false,
          fireHp: 0,
          inUseBy: null,
        });
      }
    }
  }

  private buildChefs() {
    // distinct floor spawn tiles near the center
    const spawns: Point[] = [];
    for (let y = 0; y < GRID_H && spawns.length < 4; y++) {
      for (let x = 0; x < GRID_W && spawns.length < 4; x++) {
        if (isFloor(x, y) && !spawns.some((s) => s.x === x && s.y === y)) {
          spawns.push({ x, y });
        }
      }
    }
    for (let i = 0; i < 4; i++) {
      const def = CHEF_DEFS[i];
      const spawn = spawns[i] ?? { x: 1 + i, y: 1 };
      const chef: Chef = {
        id: i,
        name: def.name,
        accent: def.accent,
        x: spawn.x, y: spawn.y,
        facing: { x: 0, y: 1 },
        carrying: null,
        dishesServed: 0,
        action: 'idle',
        actionProgress: 0,
        path: [],
        planLabel: 'Idle',
        moveLabel: '',
        targetStationId: null,
        workingOrderId: null,
        inputDir: { x: 0, y: 0 },
        inputBtn: null,
      };
      const telemetry: ChefTelemetry = {
        chefId: i,
        decisions: 0,
        lastDecision: null,
        latencyHistory: [],
        totalTokens: 0,
        totalCostUsd: 0,
        inFlight: false,
      };
      this.state.chefs.push(chef);
      this.state.telemetry.push(telemetry);
      this.rt.push({
        chef,
        brain: this.makeBrain(i),
        steps: [],
        stepTime: 0,
        bHoldUntil: 0,
        // Stagger the opening decisions (chef i waits i*0.35s) so four
        // identical states don't hit a deterministic brain simultaneously
        // and all grab the same component.
        lastDecisionAt: i * 0.35 - DECISION_MIN_GAP,
        idleSince: 0,
        wobble: (i - 1.5) * 0.12,
        telemetry,
        prep: null,
      });
    }
  }

  setBrains(makeBrain: (chefId: number) => JevBrain) {
    this.makeBrain = makeBrain;
    for (const r of this.rt) {
      r.brain = makeBrain(r.chef.id);
    }
  }

  // ── public triggers ────────────────────────────────────────
  triggerRush() {
    this.state.rushUntil = this.state.t + 30;
    this.pushEvent('rush', 'RUSH HOUR — orders incoming!');
    this.nextOrderAt = this.state.t + 0.5;
  }

  triggerFire() {
    const stoves = this.state.stations.filter(
      (s) => s.kind === T.STOVE && !s.onFire,
    );
    if (stoves.length === 0) return;
    const cooking = stoves.filter((s) => s.item && s.item.stage !== 'burnt');
    const pool = cooking.length > 0 ? cooking : stoves;
    const target = pool[Math.floor(Math.random() * pool.length)];
    this.igniteStove(target);
  }

  private igniteStove(s: Station) {
    s.onFire = true;
    s.fireHp = 1;
    s.inUseBy = null;
    if (s.item) s.item = null; // fire destroys the pot contents
    s.progress = 0;
    this.state.fires++;
    this.pushEvent('fire', `Stove ${this.stoveLabel(s)} caught fire!`);
  }

  // ── main tick ──────────────────────────────────────────────
  tick(dt: number) {
    if (!this.state.running) return;
    if (dt <= 0) return;
    if (this.state.t >= this.state.shiftEndsAt) {
      if (!this.shiftOverAnnounced) {
        this.shiftOverAnnounced = true;
        this.pushEvent('info', `SHIFT OVER — final score ${this.state.score}`);
        this.state.running = false;
      }
      return;
    }
    this.state.t += dt;
    const now = this.state.t;

    this.spawnOrders(now);
    this.expireOrders(now);
    this.updateStations(dt, now);
    this.reconcileFireAssignments();

    for (const r of this.rt) {
      this.advanceChef(r, dt, now);
    }

    this.recomputeAssemblies();
  }

  // ── orders ─────────────────────────────────────────────────
  private spawnOrders(now: number) {
    const rush = now < this.state.rushUntil;
    const maxOpen = rush ? 6 : 4;
    const open = this.state.orders.filter((o) => o.status === 'open');
    if (now < this.nextOrderAt) return;
    if (open.length >= maxOpen) {
      // defer; retry soon
      this.nextOrderAt = now + (rush ? 1 : 2);
      return;
    }
    const dishes = Object.keys(RECIPES) as DishId[];
    const dish = dishes[Math.floor(Math.random() * dishes.length)];
    const recipe = RECIPES[dish];
    this.state.orders.push(this.makeOrder(dish, now, now + recipe.orderTime));
    const gap = rush ? 4 + Math.random() * 2 : 12 + Math.random() * 6;
    this.nextOrderAt = now + gap;
  }

  private expireOrders(now: number) {
    for (const o of this.state.orders) {
      if (o.status !== 'open') continue;
      if (now >= o.expiresAt) {
        this.failOrder(o);
      }
    }
    // prune old resolved orders occasionally to keep the array bounded
    if (this.state.orders.length > 40) {
      this.state.orders = this.state.orders.filter(
        (o) => o.status === 'open' || now - o.expiresAt < 10,
      );
    }
  }

  // Fail an order: mark failed, free every chef working any of its components or
  // its assembly, and discard its deposited ready parts. Stove items for it
  // become orphans (rescue targets) automatically since no open order needs them.
  private failOrder(o: Order) {
    o.status = 'failed';
    this.state.failed++;
    this.pushEvent('fail', `${RECIPES[o.dish].name} #${o.id} expired`);
    for (const r of this.rt) {
      if (r.chef.workingOrderId === o.id) {
        this.abandonTask(r, true);
      }
    }
    o.assemblyStationId = null;
    o.assemblerId = null;
  }

  // ── stations (cooking, burning, fire) ──────────────────────
  private updateStations(dt: number, now: number) {
    for (const s of this.state.stations) {
      if (s.kind !== T.STOVE) continue;
      if (s.onFire) continue;
      const item = s.item;
      if (!item) continue;
      const recipe = this.recipeForStoveItem(item);
      if (!recipe) continue;
      const rc = this.cookCompFor(item, recipe);
      if (!rc) continue;

      if (item.stage === 'raw' || item.stage === 'chopped') {
        // cooking runs unattended
        s.progress = Math.min(1, s.progress + dt / rc.cookTime);
        if (s.progress >= 1) {
          item.stage = 'cooked';
          s.progress = 0; // reuse progress as the "sitting cooked" timer
        }
      } else if (item.stage === 'cooked') {
        // burn timer: progress climbs toward burnTime
        s.progress += dt;
        if (s.progress >= rc.burnTime) {
          item.stage = 'burnt';
          this.pushEvent('burn', `${recipe.name} burnt on Stove ${this.stoveLabel(s)}`);
          // revert any component that was awaiting this cooked item so it can be
          // re-prepped if time remains, then the fire destroys the pot.
          this.revertComponentForStoveItem(item);
          this.igniteStove(s);
        }
      }
    }
    void now;
  }

  // Recipe whose cook path matches an item sitting on a stove (best-effort;
  // used only for labels + cook/burn timing).
  private recipeForStoveItem(item: Item): Recipe | null {
    const dishes = Object.values(RECIPES).filter((r) =>
      r.components.some(
        (rc) => rc.needsCook && rc.ingredient === item.ingredient,
      ),
    );
    if (dishes.length === 0) return null;
    const wantChop = item.stage === 'chopped' || item.stage === 'cooked';
    return (
      dishes.find((r) =>
        r.components.some((rc) => rc.needsCook && rc.ingredient === item.ingredient && rc.needsChop === wantChop),
      ) ?? dishes[0]
    );
  }

  // The cook component (timing source) matching an item on a stove.
  private cookCompFor(item: Item, recipe: Recipe): RecipeComponent | null {
    const wantChop = item.stage === 'chopped' || item.stage === 'cooked';
    return (
      recipe.components.find(
        (rc) => rc.needsCook && rc.ingredient === item.ingredient && rc.needsChop === wantChop,
      ) ??
      recipe.components.find((rc) => rc.needsCook && rc.ingredient === item.ingredient) ??
      null
    );
  }

  // When a cooked item burns, whichever prepping chef was awaiting it is freed by
  // abandonTask elsewhere; here we revert an open order's component that this item
  // was destined for (its prepper died / it orphaned) back to 'todo'.
  private revertComponentForStoveItem(item: Item) {
    for (const o of this.state.orders) {
      if (o.status !== 'open') continue;
      for (let i = 0; i < o.components.length; i++) {
        const comp = o.components[i];
        if (comp.status !== 'prepping') continue;
        if (comp.ingredient !== item.ingredient) continue;
        const rc = RECIPES[o.dish].components[i];
        if (!rc.needsCook) continue;
        // is the chef prepping this component actually still awaiting a stove?
        const prepper = comp.by !== null ? this.rt[comp.by] : null;
        const stillLive = prepper && prepper.prep && prepper.prep.orderId === o.id && prepper.prep.compIdx === i;
        if (!stillLive) {
          comp.status = 'todo';
          comp.by = null;
          return;
        }
      }
    }
  }

  // ── chef stepping ──────────────────────────────────────────
  private advanceChef(r: ChefRt, dt: number, now: number) {
    const c = r.chef;

    // clear B button after its hold window
    if (c.inputBtn === 'B' && now >= r.bHoldUntil) {
      c.inputBtn = null;
    }

    if (r.steps.length === 0) {
      // no steps queued → idle, and (throttled) ask the brain what to do next.
      c.action = 'idle';
      c.inputDir = { x: 0, y: 0 };
      if (c.inputBtn === 'A') c.inputBtn = null;
      c.moveLabel = c.carrying ? 'Deciding…' : 'Idle';
      this.maybeDecide(r, now);
      return;
    }

    const step = r.steps[0];
    if (step.kind === 'walkTo') {
      this.doWalk(r, step, dt, now);
    } else if (step.kind === 'work') {
      this.doWork(r, step, dt, now);
    } else if (step.kind === 'awaitCook') {
      this.doAwaitCook(r, step, dt, now);
    } else {
      // instant
      step.run(this, r);
      r.steps.shift();
    }
  }

  private doWalk(r: ChefRt, step: Extract<Step, { kind: 'walkTo' }>, dt: number, now: number) {
    const c = r.chef;
    c.action = 'walking';
    c.inputBtn = c.inputBtn === 'B' ? 'B' : null;
    c.moveLabel = step.label;

    if (c.path.length === 0) {
      const others = this.rt.filter((o) => o !== r).map((o) => ({ x: o.chef.x, y: o.chef.y }));
      const path = findPath({ x: c.x, y: c.y }, step.stand, others);
      if (path.length === 0) {
        // can't route — treat as arrived if already adjacent-ish, else bail
        if (Math.abs(c.x - step.stand.x) < 0.6 && Math.abs(c.y - step.stand.y) < 0.6) {
          r.steps.shift();
          return;
        }
        // unreachable: drop the whole task and re-decide
        this.abandonTask(r, false);
        return;
      }
      // drop the starting tile if we're already on it
      c.path = path;
      if (c.path.length > 0 && Math.abs(c.path[0].x - c.x) < 0.05 && Math.abs(c.path[0].y - c.y) < 0.05) {
        c.path.shift();
      }
    }

    if (c.path.length === 0) {
      c.inputDir = { x: 0, y: 0 };
      r.steps.shift();
      return;
    }

    // Aim at the tile center plus a tiny perpendicular wobble so overlapping
    // chefs don't render exactly on top of each other. The wobble shrinks as
    // we approach the final standing tile so arrivals still snap clean.
    const target = c.path[0];
    const isFinal = c.path.length === 1;
    const wob = isFinal ? 0 : r.wobble;
    const dx = target.x - c.x;
    const dy = target.y - c.y;
    const dist = Math.hypot(dx, dy);
    const move = CHEF_SPEED * dt;

    if (dist <= move || dist < 1e-4) {
      c.x = target.x;
      c.y = target.y;
      c.path.shift();
      if (c.path.length === 0) {
        c.inputDir = { x: 0, y: 0 };
        r.steps.shift();
      }
    } else {
      const ux = dx / dist;
      const uy = dy / dist;
      // perpendicular = (-uy, ux)
      c.x += ux * move + -uy * wob * move;
      c.y += uy * move + ux * wob * move;
      c.facing = { x: ux, y: uy };
      c.inputDir = { x: Math.abs(ux) > 0.3 ? Math.sign(ux) : 0, y: Math.abs(uy) > 0.3 ? Math.sign(uy) : 0 };
    }

    // urgency flavor
    this.applyUrgencyFlavor(r, now);
  }

  private doWork(r: ChefRt, step: Extract<Step, { kind: 'work' }>, dt: number, now: number) {
    const c = r.chef;
    const s = this.state.stations.find((st) => st.id === step.stationId);
    if (!s) { this.abandonTask(r, false); return; }

    // must remain adjacent
    if (!this.adjacentTo(c, s)) {
      // walk back adjacent
      const stand = this.nearestStand(c, s);
      if (!stand) { this.abandonTask(r, false); return; }
      r.steps.unshift({ kind: 'walkTo', stand, label: step.label });
      return;
    }

    c.action = step.action;
    c.inputBtn = c.inputBtn === 'B' && now < r.bHoldUntil ? 'B' : 'A';
    c.inputDir = { x: 0, y: 0 };
    c.facing = { x: Math.sign(s.x - c.x) || c.facing.x, y: Math.sign(s.y - c.y) || c.facing.y };
    c.moveLabel = step.label;
    s.inUseBy = c.id;

    r.stepTime += dt;
    const prog = Math.min(1, r.stepTime / step.duration);
    c.actionProgress = prog;
    // surface work progress on the station for chop/extinguish
    if (step.action === 'chopping') s.progress = prog;
    if (step.action === 'extinguishing') s.fireHp = Math.max(0, 1 - prog);

    this.applyUrgencyFlavor(r, now);

    if (prog >= 1) {
      r.stepTime = 0;
      c.actionProgress = 0;
      s.inUseBy = null;
      if (step.action !== 'extinguishing') s.progress = 0;
      const done = step.onDone;
      r.steps.shift();
      done(this, r);
    }
  }

  // Wait ADJACENT to a stove for its item to finish cooking, then continue the
  // prep chain. Standing next to a cooking stove counts as making progress (the
  // chef is committed work, not deadlocked). If the item burns / vanishes /
  // catches fire the chain bails and the chef re-decides.
  private doAwaitCook(r: ChefRt, step: Extract<Step, { kind: 'awaitCook' }>, dt: number, now: number) {
    const c = r.chef;
    const s = this.state.stations.find((st) => st.id === step.stationId);
    if (!s) { this.abandonTask(r, false); return; }

    // stay adjacent while it cooks
    if (!this.adjacentTo(c, s)) {
      const stand = this.nearestStand(c, s);
      if (!stand) { this.abandonTask(r, false); return; }
      r.steps.unshift({ kind: 'walkTo', stand, label: step.label });
      return;
    }

    // our item gone / burnt / stove on fire → the cooked good is lost; bail so we
    // re-decide (the component was reverted or will be rescued elsewhere).
    if (s.onFire || !s.item || s.item.stage === 'burnt') {
      // free the component so it can be re-prepped
      if (r.prep) {
        const o = this.orderById(r.prep.orderId);
        if (o && o.status === 'open') {
          const comp = o.components[r.prep.compIdx];
          if (comp && comp.status === 'prepping' && comp.by === c.id) {
            comp.status = 'todo';
            comp.by = null;
          }
        }
      }
      this.abandonTask(r, false);
      return;
    }

    // "watching the pot" — a committed, in-progress state (NOT idle) so the HUD
    // and harness both read it as active work while the cook runs unattended.
    c.action = 'stirring';
    c.inputDir = { x: 0, y: 0 };
    c.inputBtn = null;
    c.moveLabel = step.label;
    c.actionProgress = Math.min(1, s.progress);
    c.facing = { x: Math.sign(s.x - c.x) || c.facing.x, y: Math.sign(s.y - c.y) || c.facing.y };
    this.applyUrgencyFlavor(r, now);

    if (s.item.stage === 'cooked') {
      // collect it and continue
      const done = step.onDone;
      r.steps.shift();
      done(this, r);
    }
    void dt;
  }

  private applyUrgencyFlavor(r: ChefRt, now: number) {
    const c = r.chef;
    // near a fire?
    const nearFire = this.state.stations.some(
      (s) => s.onFire && Math.abs(s.x - c.x) <= 1.6 && Math.abs(s.y - c.y) <= 1.6,
    );
    const order = this.workingOrder(c.id);
    const timePressure = order ? order.expiresAt - now : Infinity;
    if ((nearFire || timePressure < 8) && (c.action === 'walking' || c.action === 'idle')) {
      if (c.action === 'walking') c.action = 'panicking';
      c.moveLabel = timePressure < 8 && order ? `HURRY ${RECIPES[order.dish].name}!` : c.moveLabel;
    }
  }

  // ── decision loop ──────────────────────────────────────────
  private maybeDecide(r: ChefRt, now: number) {
    if (r.telemetry.inFlight) return;
    if (now - r.lastDecisionAt < DECISION_MIN_GAP) return;

    if (r.idleSince === 0) r.idleSince = now;

    const options = this.buildOptions(r);
    const req = this.buildRequest(r, now, options);
    r.lastDecisionAt = now;
    r.telemetry.inFlight = true;

    r.brain
      .decide(req)
      .then((decision) => {
        r.telemetry.inFlight = false;
        this.recordDecision(r, decision);
        const applied = this.applyDecision(r, decision, options);
        this.decisionLog.push({
          t: Math.round(now * 100) / 100,
          chefId: r.chef.id,
          chef: r.chef.name,
          brain: r.brain.name,
          options,
          state: req.state,
          decision,
          applied,
        });
        r.idleSince = 0;
      })
      .catch(() => {
        r.telemetry.inFlight = false;
        r.idleSince = 0;
      });
  }

  private recordDecision(r: ChefRt, d: JevDecision) {
    const tel = r.telemetry;
    tel.decisions++;
    tel.lastDecision = d;
    tel.latencyHistory.push(d.latencyMs);
    if (tel.latencyHistory.length > 48) tel.latencyHistory.shift();
    tel.totalTokens += d.tokens;
    tel.totalCostUsd += d.costUsd;
  }

  // ── option builder (the task market) ───────────────────────
  // A chef is "free" for new prep/assemble work when not carrying and has no
  // steps queued (the option builder only runs when steps are empty, so the
  // latter is implied). Extinguish/rescue/trash are the carrying-aware valves.
  private buildOptions(r: ChefRt): ActionOption[] {
    const c = r.chef;
    const opts: ActionOption[] = [];
    const carrying = c.carrying;

    // extinguish takes priority when fires exist — exactly one chef is assigned
    // per fire so all four don't stampede the same stove.
    for (const s of this.state.stations) {
      if (!s.onFire) continue;
      const assigned = this.fireAssign.get(s.id);
      if (assigned === c.id) {
        opts.push({ id: `extinguish:${s.id}`, label: 'Extinguish!' });
      } else if (assigned === undefined && !carrying) {
        if (this.nearestFreeChefFor(s) === c.id) {
          opts.push({ id: `extinguish:${s.id}`, label: 'Extinguish!' });
        }
      }
    }

    // carrying something? the only sensible moves are trash (burnt/orphan). All
    // useful carrying is transient inside a prep chain and never lands here.
    if (carrying) {
      if (this.station(T.TRASH)) opts.push({ id: 'trash', label: 'Trash' });
      opts.push({ id: 'wait', label: 'Hold' });
      return opts;
    }

    // rescue: a cooked item on a stove no open order still needs (orphaned, or
    // its prepper died). Free chef collects and either re-homes or trashes it —
    // the burn-prevention valve.
    for (const s of this.state.stations) {
      if (s.kind !== T.STOVE || s.onFire) continue;
      const item = s.item;
      if (!item || item.stage !== 'cooked') continue;
      if (this.stoveItemIsOrphan(s, item)) {
        opts.push({ id: `rescue:${s.id}`, label: `Rescue Stove ${this.stoveLabel(s)}` });
      }
    }

    // assemble: all components ready and nobody assembling yet.
    for (const o of this.state.orders) {
      if (o.status !== 'open') continue;
      if (o.assemblerId !== null) continue;
      if (o.components.every((comp) => comp.status === 'ready')) {
        opts.push({ id: `assemble:${o.id}`, label: `Serve ${RECIPES[o.dish].name} #${o.id}` });
      }
    }

    // prep: every 'todo' component of every open order is up for grabs.
    for (const o of this.state.orders) {
      if (o.status !== 'open') continue;
      for (let i = 0; i < o.components.length; i++) {
        const comp = o.components[i];
        if (comp.status !== 'todo') continue;
        opts.push({
          id: `prep:${o.id}:${i}`,
          label: `${comp.label} · ${RECIPES[o.dish].name} #${o.id}`,
        });
      }
    }

    opts.push({ id: 'wait', label: 'Hold' });
    return opts;
  }

  // A cooked stove item is an orphan if no OPEN order has a 'prepping' component
  // (of the right ingredient + cook path) whose prepper is still live and
  // awaiting it. Anything cooked with nobody coming for it is a rescue target.
  private stoveItemIsOrphan(s: Station, item: Item): boolean {
    for (const o of this.state.orders) {
      if (o.status !== 'open') continue;
      for (let i = 0; i < o.components.length; i++) {
        const comp = o.components[i];
        if (comp.status !== 'prepping') continue;
        if (comp.ingredient !== item.ingredient) continue;
        const rc = RECIPES[o.dish].components[i];
        if (!rc.needsCook) continue;
        const prepper = comp.by !== null ? this.rt[comp.by] : null;
        if (!prepper) continue;
        // is the prepper live and awaiting THIS stove?
        const awaiting = prepper.prep &&
          prepper.prep.orderId === o.id &&
          prepper.prep.compIdx === i &&
          prepper.steps.some((st) => st.kind === 'awaitCook' && st.stationId === s.id);
        if (awaiting) return false;
      }
    }
    return true;
  }

  private buildRequest(r: ChefRt, now: number, options: ActionOption[]): DecisionRequest {
    const c = r.chef;
    const order = this.workingOrder(c.id);
    const distances: Record<string, number> = {};
    for (const o of options) distances[o.id] = this.optionDistance(c, o.id);

    const state: Record<string, unknown> = {
      orders: this.state.orders
        .filter((o) => o.status === 'open')
        .slice(0, 10)
        .map((o) => ({
          id: o.id,
          dish: o.dish,
          points: RECIPES[o.dish].points,
          secondsLeft: Math.max(0, Math.round(o.expiresAt - now)),
          components: o.components.map((comp) => ({ label: comp.label, status: comp.status })),
          assemblyReady: o.components.filter((comp) => comp.status === 'ready').length,
          totalComponents: o.components.length,
        })),
      carrying: c.carrying ? { ingredient: c.carrying.ingredient, stage: c.carrying.stage } : null,
      workingOrderId: order?.id ?? null,
      workingSecondsLeft: order ? Math.max(0, Math.round(order.expiresAt - now)) : null,
      fireCount: this.state.stations.filter((s) => s.onFire).length,
      pos: { x: Math.round(c.x * 10) / 10, y: Math.round(c.y * 10) / 10 },
      distances,
      stations: this.stationSummary(),
      teammates: this.rt
        .filter((o) => o.chef.id !== c.id)
        .map((o) => ({
          chef: o.chef.id,
          plan: o.chef.planLabel,
          workingOrderId: o.chef.workingOrderId,
          deciding: o.telemetry.inFlight,
        })),
    };
    return { chefId: c.id, gameTime: Math.round(now * 100) / 100, options, state };
  }

  private stationSummary() {
    return this.state.stations
      .filter((s) => s.kind === T.STOVE || s.kind === T.BOARD)
      .map((s) => ({
        id: s.id,
        kind: s.kind === T.STOVE ? 'stove' : 'board',
        busy: s.inUseBy !== null || s.item !== null,
        onFire: s.onFire,
      }));
  }

  private applyDecision(r: ChefRt, d: JevDecision, options: ActionOption[]): boolean {
    const valid = options.find((o) => o.id === d.chosenId);
    if (!valid) return false;
    this.compile(r, d.chosenId);
    return true;
  }

  // ── compile a chosen action id into internal steps ─────────
  private compile(r: ChefRt, id: string) {
    const c = r.chef;

    if (id === 'wait') {
      c.planLabel = c.carrying ? c.planLabel : 'Waiting for orders';
      c.moveLabel = 'Hold';
      return;
    }

    if (id.startsWith('extinguish:')) {
      this.compileExtinguish(r, id);
      return;
    }

    if (id.startsWith('rescue:')) {
      this.compileRescue(r, id);
      return;
    }

    if (id.startsWith('assemble:')) {
      this.compileAssemble(r, id);
      return;
    }

    if (id.startsWith('prep:')) {
      this.compilePrep(r, id);
      return;
    }

    if (id === 'trash') {
      const trash = this.station(T.TRASH);
      if (!trash) return;
      this.walkThen(r, trash, {
        action: 'grabbing', duration: 0.5, label: 'Trash',
        onDone: (_sim, rr) => {
          rr.chef.carrying = null;
          this.pressB(rr);
        },
      });
      c.planLabel = 'Dump food';
      return;
    }
  }

  private compileExtinguish(r: ChefRt, id: string) {
    const c = r.chef;
    const sid = Number(id.slice('extinguish:'.length));
    const s = this.state.stations.find((st) => st.id === sid);
    if (!s || !s.onFire) return;
    const assigned = this.fireAssign.get(sid);
    if (assigned !== undefined && assigned !== c.id) return;
    this.fireAssign.set(sid, c.id);
    this.walkThen(r, s, {
      action: 'extinguishing', duration: 2.5, label: `Extinguish ${this.stoveLabel(s)}`,
      onDone: (sim, rr) => {
        s.onFire = false;
        s.fireHp = 0;
        sim.fireAssign.delete(sid);
        sim.pushEvent('info', `${rr.chef.name} put out Stove ${sim.stoveLabel(s)}`);
      },
    });
    c.planLabel = 'FIRE! Extinguishing';
  }

  private compileRescue(r: ChefRt, id: string) {
    const c = r.chef;
    const sid = Number(id.slice('rescue:'.length));
    const s = this.state.stations.find((st) => st.id === sid);
    if (!s || s.onFire || !s.item || s.item.stage !== 'cooked') return;
    this.walkThen(r, s, {
      action: 'grabbing', duration: 0.4, label: `Rescue Stove ${this.stoveLabel(s)}`,
      onDone: (sim, rr) => {
        const item = s.item;
        s.item = null;
        s.progress = 0;
        if (!item) return;
        // try to re-home into a matching 'todo' cook component of an open order.
        const homed = sim.rehomeCookedItem(rr, item);
        if (homed) {
          sim.pressB(rr);
          return;
        }
        // otherwise carry to trash
        rr.chef.carrying = item;
        sim.pressB(rr);
        const trash = sim.station(T.TRASH);
        if (trash) {
          sim.walkThen(rr, trash, {
            action: 'grabbing', duration: 0.5, label: 'Trash rescued',
            onDone: (_s2, r2) => { r2.chef.carrying = null; sim.pressB(r2); },
          });
        } else {
          rr.chef.carrying = null;
        }
      },
    });
    c.planLabel = 'Rescue stove';
  }

  // Deposit a rescued cooked item directly into an order that needs it (same
  // ingredient + needsCook, currently 'todo'), marking that component ready and
  // depositing at the order's assembly station. Returns true if re-homed.
  private rehomeCookedItem(r: ChefRt, item: Item): boolean {
    for (const o of this.state.orders) {
      if (o.status !== 'open') continue;
      for (let i = 0; i < o.components.length; i++) {
        const comp = o.components[i];
        if (comp.status !== 'todo') continue;
        if (comp.ingredient !== item.ingredient) continue;
        const rc = RECIPES[o.dish].components[i];
        if (!rc.needsCook) continue;
        // matching chop requirement (a chopped-then-cooked patty vs plain steak)
        const wasChopped = item.stage === 'cooked'; // stage collapses; accept either
        void wasChopped;
        const stationId = this.ensureAssemblyStation(o);
        comp.status = 'ready';
        comp.by = r.chef.id;
        void stationId;
        this.pushEvent('info', `Rescued ${comp.label} for ${RECIPES[o.dish].name} #${o.id}`);
        return true;
      }
    }
    return false;
  }

  private compileAssemble(r: ChefRt, id: string) {
    const c = r.chef;
    const oid = Number(id.slice('assemble:'.length));
    const o = this.orderById(oid);
    if (!o || o.status !== 'open' || o.assemblerId !== null) return;
    if (!o.components.every((comp) => comp.status === 'ready')) return;
    const stationId = this.ensureAssemblyStation(o);
    const plates = this.state.stations.find((st) => st.id === stationId);
    if (!plates) return;
    o.assemblerId = c.id;
    c.workingOrderId = o.id;
    const firstIng = o.components[0]?.ingredient ?? 'tomato';
    this.walkThen(r, plates, {
      action: 'plating', duration: RECIPES[o.dish].assembleTime, label: `Assemble ${RECIPES[o.dish].name}`,
      onDone: (sim, rr) => {
        rr.chef.carrying = { ingredient: firstIng, stage: 'plated', dish: o.dish };
        sim.pressB(rr);
        // clear the assembly entry — parts have been picked up onto the plate
        o.assemblyStationId = null;
        const serve = sim.station(T.SERVE);
        if (!serve) return;
        sim.walkThen(rr, serve, {
          action: 'delivering', duration: 0.6, label: `Deliver ${RECIPES[o.dish].name}`,
          onDone: (s2, r2) => { s2.serveOrder(r2, o); },
        });
      },
    });
    c.planLabel = `${RECIPES[o.dish].name} #${o.id} · assemble`;
  }

  private serveOrder(r: ChefRt, o: Order) {
    const c = r.chef;
    c.carrying = null;
    if (o.status !== 'open') {
      // Wrong serve: the order died before the dish reached the pass.
      // Wasted food costs half the dish's points.
      const penalty = Math.floor(RECIPES[o.dish].points / 2);
      this.state.score -= penalty;
      c.workingOrderId = null;
      this.pushEvent('fail', `${c.name} served ${RECIPES[o.dish].name} nobody wanted (−${penalty})`);
      r.steps = [{
        kind: 'work',
        stationId: this.station(T.SERVE)!.id,
        action: 'panicking',
        duration: 1.0,
        label: 'Oops…',
        onDone: () => {},
      }];
      r.stepTime = 0;
      c.planLabel = 'Wrong serve!';
      return;
    }
    o.status = 'done';
    const pts = RECIPES[o.dish].points;
    this.state.score += pts;
    this.state.served++;
    c.dishesServed++;
    c.workingOrderId = null;
    o.assemblerId = null;
    o.assemblyStationId = null;
    this.pushEvent('serve', `${c.name} served ${RECIPES[o.dish].name} (+${pts})`);
    // celebrate
    r.steps = [{
      kind: 'work',
      stationId: this.station(T.SERVE)!.id,
      action: 'celebrating',
      duration: 1.2,
      label: 'Nice!',
      onDone: () => {},
    }];
    r.stepTime = 0;
    c.planLabel = 'Served!';
  }

  // ── prep chain: fetch → [chop] → [cook + await + collect] → deposit ────
  private compilePrep(r: ChefRt, id: string) {
    const c = r.chef;
    const [, oidStr, idxStr] = id.split(':');
    const oid = Number(oidStr);
    const compIdx = Number(idxStr);
    const o = this.orderById(oid);
    if (!o || o.status !== 'open') return;
    const comp = o.components[compIdx];
    if (!comp || comp.status !== 'todo') return;
    const rc = RECIPES[o.dish].components[compIdx];

    comp.status = 'prepping';
    comp.by = c.id;
    c.workingOrderId = o.id;
    r.prep = { orderId: oid, compIdx };
    c.planLabel = `${comp.label} · ${RECIPES[o.dish].name} #${o.id}`;

    const crate = this.crateFor(rc.ingredient);
    if (!crate) { this.abandonTask(r, false); return; }

    // Step 1: fetch raw ingredient.
    this.walkThen(r, crate, {
      action: 'grabbing', duration: 0.4, label: `Grab ${cap(rc.ingredient)}`,
      onDone: (sim, rr) => {
        rr.chef.carrying = { ingredient: rc.ingredient, stage: 'raw' };
        sim.pressB(rr);
        sim.prepAfterFetch(rr, oid, compIdx);
      },
    });
  }

  // After fetching raw: chop if needed, else move to cook/deposit.
  private prepAfterFetch(r: ChefRt, oid: number, compIdx: number) {
    const o = this.orderById(oid);
    if (!o || o.status !== 'open') { this.abandonTask(r, false); return; }
    const rc = RECIPES[o.dish].components[compIdx];

    if (rc.needsChop) {
      const board = this.freeStations(T.BOARD)[0];
      if (!board) {
        // all boards busy — briefly wait then re-decide (never deadlock). Drop
        // the raw item back conceptually by trashing; simplest robust recovery:
        // hold the chain, retry next idle by clearing steps (chef re-decides,
        // component stays 'prepping' with this chef still assigned).
        this.retryPrepSoon(r);
        return;
      }
      this.walkThen(r, board, {
        action: 'chopping', duration: rc.chopTime, label: `Chop ${cap(rc.ingredient)}`,
        onDone: (sim, rr) => {
          if (rr.chef.carrying) rr.chef.carrying.stage = 'chopped';
          board.item = null;
          board.inUseBy = null;
          sim.pressB(rr);
          sim.prepAfterChop(rr, oid, compIdx);
        },
      }, /*placeItemOnStation*/ true);
    } else {
      this.prepAfterChop(r, oid, compIdx);
    }
  }

  // After chop (or if no chop): cook if needed, else deposit directly.
  private prepAfterChop(r: ChefRt, oid: number, compIdx: number) {
    const o = this.orderById(oid);
    if (!o || o.status !== 'open') { this.abandonTask(r, false); return; }
    const rc = RECIPES[o.dish].components[compIdx];

    if (rc.needsCook) {
      const stove = this.freeStations(T.STOVE).find((s) => !s.onFire);
      if (!stove) { this.retryPrepSoon(r); return; }
      this.walkThen(r, stove, {
        action: 'stirring', duration: 0.4, label: `Cook @ Stove ${this.stoveLabel(stove)}`,
        onDone: (sim, rr) => {
          if (rr.chef.carrying) {
            stove.item = rr.chef.carrying;
            stove.progress = 0;
            rr.chef.carrying = null;
          }
          sim.pressB(rr);
          // keep the chain alive: wait adjacent until cooked, then collect.
          rr.steps.push({
            kind: 'awaitCook', stationId: stove.id, label: `Await ${cap(rc.ingredient)}`,
            onDone: (s2, r2) => {
              const item = stove.item;
              if (item && item.stage === 'cooked') {
                r2.chef.carrying = item;
                stove.item = null;
                stove.progress = 0;
                s2.pressB(r2);
                s2.prepDeposit(r2, oid, compIdx);
              } else {
                s2.abandonTask(r2, false);
              }
            },
          });
        },
      });
    } else {
      this.prepDeposit(r, oid, compIdx);
    }
  }

  // Final step of a prep chain: carry the finished component to the order's
  // assembly station and deposit it → component 'ready', chef freed.
  private prepDeposit(r: ChefRt, oid: number, compIdx: number) {
    const c = r.chef;
    const o = this.orderById(oid);
    if (!o || o.status !== 'open') { this.abandonTask(r, false); return; }
    const comp = o.components[compIdx];
    if (!comp || comp.status !== 'prepping' || comp.by !== c.id) {
      // component was reverted/taken — drop what we carry and re-decide
      this.abandonTask(r, false);
      return;
    }
    const stationId = this.ensureAssemblyStation(o);
    const plates = this.state.stations.find((s) => s.id === stationId);
    if (!plates) { this.abandonTask(r, false); return; }

    this.walkThen(r, plates, {
      action: 'plating', duration: 0.5, label: `Deposit ${comp.label}`,
      onDone: (sim, rr) => {
        rr.chef.carrying = null;
        comp.status = 'ready';
        comp.by = rr.chef.id;
        rr.chef.workingOrderId = null;
        rr.prep = null;
        sim.pressB(rr);
        // sparse milestone event (cap noise: only for multi-component dishes)
        if (o.components.length > 1) {
          sim.pushEvent('info', `${comp.label} ready for ${RECIPES[o.dish].name} #${o.id}`);
        }
        rr.chef.planLabel = `${comp.label} ready`;
      },
    });
  }

  // Board/stove all busy: pause the chain briefly and let the chef re-decide.
  // The component stays 'prepping' with this chef assigned. We clear steps and
  // trash any raw carry so the chef's hands are free to re-decide; the component
  // is reverted to 'todo' so anyone (incl. this chef) can pick it up again.
  private retryPrepSoon(r: ChefRt) {
    const c = r.chef;
    if (r.prep) {
      const o = this.orderById(r.prep.orderId);
      if (o && o.status === 'open') {
        const comp = o.components[r.prep.compIdx];
        if (comp && comp.status === 'prepping' && comp.by === c.id) {
          comp.status = 'todo';
          comp.by = null;
        }
      }
    }
    r.prep = null;
    c.workingOrderId = null;
    // discard any raw/in-progress carry so we don't strand an item
    if (c.carrying && c.carrying.stage !== 'plated') c.carrying = null;
    r.steps = [];
    r.stepTime = 0;
    c.path = [];
    c.action = 'idle';
    c.planLabel = 'Stations busy — regrouping';
    // small artificial delay before re-deciding so we don't spin hot
    r.lastDecisionAt = this.state.t + 0.6 - DECISION_MIN_GAP;
    r.idleSince = 0;
  }

  // Assign (or reuse) a PLATES station for an order, round-robin over the two.
  private ensureAssemblyStation(o: Order): number {
    if (o.assemblyStationId !== null) return o.assemblyStationId;
    const plates = this.state.stations.filter((s) => s.kind === T.PLATES);
    if (plates.length === 0) return -1;
    const chosen = plates[this.assemblyRR % plates.length];
    this.assemblyRR++;
    o.assemblyStationId = chosen.id;
    return chosen.id;
  }

  // ── build [walkTo, work] steps for a station action ────────
  private walkThen(
    r: ChefRt,
    s: Station,
    work: { action: ChefAction; duration: number; label: string; onDone: (sim: KitchenSim, c: ChefRt) => void },
    placeItemOnStation = false,
  ) {
    const c = r.chef;
    const others = this.rt.filter((o) => o !== r).map((o) => ({ x: o.chef.x, y: o.chef.y }));
    const res = pathToStation({ x: c.x, y: c.y }, s.x, s.y, others);
    const stand = res?.stand ?? this.nearestStand(c, s);
    if (!stand) { this.abandonTask(r, false); return; }

    r.steps = [];
    r.steps.push({ kind: 'walkTo', stand, label: `→ ${work.label}` });
    if (placeItemOnStation) {
      r.steps.push({
        kind: 'instant', label: 'place',
        run: (_sim, rr) => {
          if (rr.chef.carrying) s.item = rr.chef.carrying;
        },
      });
    }
    r.steps.push({
      kind: 'work',
      stationId: s.id,
      action: work.action,
      duration: work.duration,
      label: work.label,
      onDone: work.onDone,
    });
    r.stepTime = 0;
  }

  // ── task abandonment ───────────────────────────────────────
  private abandonTask(r: ChefRt, orderFailed: boolean) {
    const c = r.chef;
    // free any board/stove we were using + any fire we were assigned
    for (const s of this.state.stations) {
      if (s.inUseBy === c.id) s.inUseBy = null;
    }
    this.fireAssign.forEach((cid, sid) => {
      if (cid === c.id) this.fireAssign.delete(sid);
    });
    // release our prepping component (if the order still lives & we owned it)
    if (r.prep) {
      const o = this.orderById(r.prep.orderId);
      if (o && o.status === 'open') {
        const comp = o.components[r.prep.compIdx];
        if (comp && comp.status === 'prepping' && comp.by === c.id) {
          comp.status = 'todo';
          comp.by = null;
        }
      }
    }
    // release an assembly we owned
    if (c.workingOrderId !== null) {
      const o = this.orderById(c.workingOrderId);
      if (o && o.status === 'open' && o.assemblerId === c.id) o.assemblerId = null;
    }
    r.prep = null;
    c.workingOrderId = null;
    r.steps = [];
    r.stepTime = 0;
    c.path = [];
    c.action = 'idle';
    c.actionProgress = 0;
    // drop any non-plated carry so it doesn't strand; a burnt/orphan carry will
    // surface a 'trash' option instead if we keep it, but for a lost order the
    // clean move is to free hands.
    if (c.carrying && c.carrying.stage !== 'burnt') c.carrying = null;
    if (orderFailed) c.planLabel = 'Order lost — regrouping';
    r.idleSince = 0;
  }

  // ── assemblies view (recomputed each tick) ─────────────────
  private recomputeAssemblies() {
    const out: Assembly[] = [];
    for (const o of this.state.orders) {
      if (o.status !== 'open') continue;
      if (o.assemblyStationId === null) continue;
      const readyItems = o.components
        .filter((comp) => comp.status === 'ready')
        .map((comp) => ({ ingredient: comp.ingredient, stage: 'plated' as const }));
      if (readyItems.length === 0) continue;
      out.push({ orderId: o.id, dish: o.dish, stationId: o.assemblyStationId, readyItems });
    }
    this.state.assemblies = out;
  }

  // ── small helpers ──────────────────────────────────────────
  private pressB(r: ChefRt) {
    r.chef.inputBtn = 'B';
    r.bHoldUntil = this.state.t + B_HOLD;
  }

  private orderById(id: number): Order | null {
    return this.state.orders.find((o) => o.id === id) ?? null;
  }

  private workingOrder(chefId: number): Order | null {
    const id = this.state.chefs[chefId]?.workingOrderId ?? null;
    if (id === null) return null;
    const o = this.orderById(id);
    return o && o.status === 'open' ? o : null;
  }

  private freeStations(kind: TileKind): Station[] {
    return this.state.stations.filter(
      (s) => s.kind === kind && s.inUseBy === null && s.item === null && !s.onFire,
    );
  }

  private station(kind: TileKind): Station | null {
    return this.state.stations.find((s) => s.kind === kind) ?? null;
  }

  // Pick the closest chef free to fight a fire (empty-handed, not already
  // assigned to another fire). Deterministic by id on ties.
  private nearestFreeChefFor(s: Station): number {
    let bestId = -1;
    let bestDist = Infinity;
    for (const r of this.rt) {
      const c = r.chef;
      if (c.carrying) continue;
      let busyElsewhere = false;
      this.fireAssign.forEach((cid, sid) => {
        if (cid === c.id && sid !== s.id) {
          const st = this.state.stations.find((x) => x.id === sid);
          if (st && st.onFire) busyElsewhere = true;
        }
      });
      if (busyElsewhere) continue;
      const d = Math.abs(c.x - s.x) + Math.abs(c.y - s.y);
      if (d < bestDist - 1e-6 || (Math.abs(d - bestDist) <= 1e-6 && (bestId < 0 || c.id < bestId))) {
        bestDist = d;
        bestId = c.id;
      }
    }
    return bestId;
  }

  // Drop assignments whose fire is out or whose chef wandered off.
  private reconcileFireAssignments() {
    const entries: Array<[number, number]> = [];
    this.fireAssign.forEach((cid, sid) => entries.push([sid, cid]));
    for (const [sid, cid] of entries) {
      const st = this.state.stations.find((x) => x.id === sid);
      if (!st || !st.onFire) {
        this.fireAssign.delete(sid);
        continue;
      }
      const r = this.rt[cid];
      const targetingIt =
        r &&
        r.steps.some(
          (step) =>
            (step.kind === 'work' && step.stationId === sid && step.action === 'extinguishing') ||
            step.kind === 'walkTo',
        );
      if (!targetingIt) this.fireAssign.delete(sid);
    }
  }

  private crateFor(ing: Ingredient): Station | null {
    const kind =
      ing === 'tomato' ? T.CRATE_TOMATO :
      ing === 'meat' ? T.CRATE_MEAT :
      ing === 'pasta' ? T.CRATE_PASTA :
      T.CRATE_BUN;
    return this.station(kind);
  }

  private adjacentTo(c: Chef, s: Station): boolean {
    const dx = Math.abs(Math.round(c.x) - s.x);
    const dy = Math.abs(Math.round(c.y) - s.y);
    const close = Math.abs(c.x - Math.round(c.x)) < 0.3 && Math.abs(c.y - Math.round(c.y)) < 0.3;
    return close && ((dx === 1 && dy === 0) || (dx === 0 && dy === 1));
  }

  private nearestStand(c: Chef, s: Station): Point | null {
    const res = pathToStation({ x: c.x, y: c.y }, s.x, s.y);
    return res?.stand ?? null;
  }

  private optionDistance(c: Chef, id: string): number {
    let target: Station | null = null;
    if (id.startsWith('extinguish:') || id.startsWith('rescue:')) {
      const sid = Number(id.slice(id.indexOf(':') + 1));
      target = this.state.stations.find((s) => s.id === sid) ?? null;
    } else if (id.startsWith('assemble:')) {
      const oid = Number(id.slice('assemble:'.length));
      const o = this.orderById(oid);
      if (o?.assemblyStationId != null) {
        target = this.state.stations.find((s) => s.id === o.assemblyStationId) ?? null;
      } else {
        target = this.station(T.PLATES);
      }
    } else if (id.startsWith('prep:')) {
      // distance to the crate the component starts at
      const [, oidStr, idxStr] = id.split(':');
      const o = this.orderById(Number(oidStr));
      if (o) {
        const rc = RECIPES[o.dish].components[Number(idxStr)];
        if (rc) target = this.crateFor(rc.ingredient);
      }
    } else if (id === 'trash') target = this.station(T.TRASH);
    else return 0;
    if (!target) return 6;
    return Math.abs(c.x - target.x) + Math.abs(c.y - target.y);
  }

  private stoveLabel(s: Station): string {
    const stoves = this.state.stations.filter((x) => x.kind === T.STOVE);
    return String(stoves.indexOf(s) + 1);
  }

  private pushEvent(kind: SimEvent['kind'], text: string) {
    const ev = { t: Math.round(this.state.t * 100) / 100, kind, text };
    this.state.events.push(ev);
    this.fullEvents.push(ev);
    if (this.state.events.length > 30) this.state.events.shift();
  }

  // Full shift log for offline analysis of how well the brain played.
  getShiftLog(): ShiftLog {
    const lats = this.decisionLog.map((d) => d.decision.latencyMs).sort((a, b) => a - b);
    const pct = (p: number) => (lats.length ? lats[Math.min(lats.length - 1, Math.floor(lats.length * p))] : 0);
    const totalTokens = this.decisionLog.reduce((a, d) => a + d.decision.tokens, 0);
    const totalCostUsd = this.decisionLog.reduce((a, d) => a + d.decision.costUsd, 0);
    const minutes = Math.max(1e-6, this.state.t / 60);
    const metrics = {
      decisions: this.decisionLog.length,
      totalTokens,
      totalCostUsd,
      latencyMs: {
        mean: lats.length ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length) : 0,
        p50: Math.round(pct(0.5)),
        p95: Math.round(pct(0.95)),
        max: Math.round(lats[lats.length - 1] ?? 0),
      },
      decisionsPerMinute: Math.round((this.decisionLog.length / minutes) * 10) / 10,
      costPerPoint: this.state.score > 0 ? totalCostUsd / this.state.score : null,
      costPerServe: this.state.served > 0 ? totalCostUsd / this.state.served : null,
      applied: this.decisionLog.filter((d) => d.applied).length,
    };
    return {
      metrics,
      model: this.rt[0]?.brain.name ?? 'unknown',
      shiftLength: this.state.shiftEndsAt,
      endedAtGameTime: Math.round(this.state.t * 100) / 100,
      score: this.state.score,
      served: this.state.served,
      failed: this.state.failed,
      fires: this.state.fires,
      chefs: this.rt.map((r) => ({
        id: r.chef.id,
        name: r.chef.name,
        served: r.chef.dishesServed,
        decisions: r.telemetry.decisions,
        avgLatencyMs: r.telemetry.latencyHistory.length
          ? Math.round(r.telemetry.latencyHistory.reduce((a, b) => a + b, 0) / r.telemetry.latencyHistory.length)
          : 0,
        tokens: r.telemetry.totalTokens,
        costUsd: r.telemetry.totalCostUsd,
      })),
      decisions: this.decisionLog,
      events: this.fullEvents,
    };
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
