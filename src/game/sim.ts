import {
  SimState, Chef, Station, Order, Item, Recipe, DishId, Ingredient,
  JevBrain, JevDecision, DecisionRequest, ActionOption, ChefTelemetry,
  SimEvent, ChefAction, Point,
  T, TileKind, KITCHEN_LAYOUT, GRID_W, GRID_H, RECIPES, CHEF_DEFS,
} from './types';
// GRID_W / GRID_H are re-exported for consumers importing layout dims via sim.
export { GRID_W, GRID_H };
import { findPath, pathToStation, isFloor } from './pathfinding';

// ─────────────────────────────────────────────────────────────
// KitchenSim: headless Overcooked-style simulation. Chefs do NOT plan
// for themselves — whenever a chef runs out of task steps the sim asks
// its JevBrain to pick a high-level action, then compiles that action
// into an internal step chain (walk → work → place …). See types.ts for
// the authoritative contract.
// ─────────────────────────────────────────────────────────────

const CHEF_SPEED = 2.6;      // tiles / second
const B_HOLD = 0.25;         // seconds to hold the 'B' button for the HUD
const DECISION_MIN_GAP = 0.25;
const IDLE_REDECIDE = 2.0;   // re-request if idle this long with a stale plan

// Internal step representation. A chef executes these in order; when the
// list empties, the sim asks the brain for the next high-level action.
type Step =
  | { kind: 'walkTo'; stand: Point; label: string }
  | { kind: 'work'; stationId: number; action: ChefAction; duration: number; label: string; onDone: (sim: KitchenSim, c: ChefRt) => void }
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
}

let nextOrderId = 1;

export class KitchenSim {
  readonly state: SimState;
  private rt: ChefRt[] = [];
  private makeBrain: (chefId: number) => JevBrain;
  private nextOrderAt = 0;
  // stationId → chefId currently assigned to extinguish it (one chef per fire)
  private fireAssign = new Map<number, number>();

  constructor(makeBrain: (chefId: number) => JevBrain) {
    this.makeBrain = makeBrain;
    this.state = {
      t: 0,
      running: true,
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
    };
    this.buildStations();
    this.buildChefs();
    this.nextOrderAt = 6 + Math.random() * 4;
    // Seed opening orders so all four chefs have work from the first frame.
    const openers: DishId[] = ['soup', 'steak', 'salad'];
    for (let i = 0; i < openers.length; i++) {
      const recipe = RECIPES[openers[i]];
      this.state.orders.push({
        id: nextOrderId++,
        dish: openers[i],
        createdAt: 0,
        expiresAt: recipe.orderTime + i * 8,
        claimedBy: null,
        status: 'open',
      });
    }
  }

  // ── setup ──────────────────────────────────────────────────
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
        action: 'idle',
        actionProgress: 0,
        path: [],
        planLabel: 'Idle',
        moveLabel: '',
        targetStationId: null,
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
        lastDecisionAt: -999,
        idleSince: 0,
        wobble: (i - 1.5) * 0.12,
        telemetry,
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
    const cooking = stoves.filter((s) => s.item && s.item.stage === 'raw');
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
    this.state.t += dt;
    const now = this.state.t;

    this.spawnOrders(now);
    this.expireOrders(now);
    this.updateStations(dt, now);
    this.reconcileFireAssignments();

    for (const r of this.rt) {
      this.advanceChef(r, dt, now);
    }
  }

  // ── orders ─────────────────────────────────────────────────
  private spawnOrders(now: number) {
    const rush = now < this.state.rushUntil;
    const maxOpen = rush ? 8 : 5;
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
    const order: Order = {
      id: nextOrderId++,
      dish,
      createdAt: now,
      expiresAt: now + recipe.orderTime,
      claimedBy: null,
      status: 'open',
    };
    this.state.orders.push(order);
    const gap = rush ? 3 + Math.random() * 2 : 9 + Math.random() * 5;
    this.nextOrderAt = now + gap;
  }

  private expireOrders(now: number) {
    for (const o of this.state.orders) {
      if (o.status !== 'open') continue;
      if (now >= o.expiresAt) {
        o.status = 'failed';
        this.state.failed++;
        this.pushEvent('fail', `${RECIPES[o.dish].name} #${o.id} expired`);
        // free any chef working this order
        if (o.claimedBy !== null) {
          const r = this.rt[o.claimedBy];
          if (r) this.abandonTask(r, true);
        }
      }
    }
    // prune old resolved orders occasionally to keep the array bounded
    if (this.state.orders.length > 40) {
      this.state.orders = this.state.orders.filter(
        (o) => o.status === 'open' || now - o.expiresAt < 10,
      );
    }
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

      if (item.stage === 'raw' || item.stage === 'chopped') {
        // cooking runs unattended
        s.progress = Math.min(1, s.progress + dt / recipe.cookTime);
        if (s.progress >= 1) {
          item.stage = 'cooked';
          s.progress = 0; // reuse progress as the "sitting cooked" timer
        }
      } else if (item.stage === 'cooked') {
        // burn timer: progress climbs toward burnTime
        s.progress += dt;
        if (s.progress >= recipe.burnTime) {
          item.stage = 'burnt';
          this.pushEvent('burn', `${recipe.name} burnt on Stove ${this.stoveLabel(s)}`);
          this.igniteStove(s);
        }
      }
    }
  }

  // Recipe whose cook path matches an item sitting on a stove.
  private recipeForStoveItem(item: Item): Recipe | null {
    // Prefer the dish that needs cook and matches the ingredient + stage.
    const dishes = Object.values(RECIPES).filter(
      (r) => r.needsCook && r.ingredient === item.ingredient,
    );
    if (dishes.length === 0) return null;
    // If chopped, prefer a recipe that needsChop; if raw, one that doesn't.
    const wantChop = item.stage === 'chopped';
    return (
      dishes.find((r) => r.needsChop === wantChop) ?? dishes[0]
    );
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
      // celebrating is played out inside a work step, so it never lands here.
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

  private applyUrgencyFlavor(r: ChefRt, now: number) {
    const c = r.chef;
    // near a fire?
    const nearFire = this.state.stations.some(
      (s) => s.onFire && Math.abs(s.x - c.x) <= 1.6 && Math.abs(s.y - c.y) <= 1.6,
    );
    const order = this.claimedOrder(c.id);
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

    // If we're mid-order but out of steps and idle too long, force a re-decide.
    if (r.idleSince === 0) r.idleSince = now;

    const options = this.buildOptions(r);
    // deadlock guard: if the only option is wait and we've idled a while, still
    // ask (the brain returns wait), but keep the loop alive by resetting timer.
    const req = this.buildRequest(r, now, options);
    r.lastDecisionAt = now;
    r.telemetry.inFlight = true;

    r.brain
      .decide(req)
      .then((decision) => {
        r.telemetry.inFlight = false;
        this.recordDecision(r, decision);
        this.applyDecision(r, decision, options);
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

  // Build the set of currently-valid high-level options for this chef.
  private buildOptions(r: ChefRt): ActionOption[] {
    const c = r.chef;
    const opts: ActionOption[] = [];
    const carrying = c.carrying;

    // extinguish takes priority when fires exist — but exactly one chef is
    // assigned per fire so all four don't stampede the same stove.
    for (const s of this.state.stations) {
      if (!s.onFire) continue;
      const assigned = this.fireAssign.get(s.id);
      if (assigned === c.id) {
        opts.push({ id: `extinguish:${s.id}`, label: 'Extinguish!' });
      } else if (assigned === undefined && !c.carrying) {
        // offer to the nearest currently-unassigned chef only
        if (this.nearestFreeChefFor(s) === c.id) {
          opts.push({ id: `extinguish:${s.id}`, label: 'Extinguish!' });
        }
      }
    }

    if (carrying && carrying.stage === 'burnt') {
      const trash = this.station(T.TRASH);
      if (trash) opts.push({ id: 'trash', label: 'Trash' });
    }

    let order = this.claimedOrder(c.id);

    if (carrying && carrying.stage === 'plated') {
      opts.push({ id: 'deliver', label: 'Deliver' });
    }

    // If we're carrying a workable item but lost our order (it expired), try to
    // adopt an open order this item can still fulfill so the work isn't wasted.
    if (!order && carrying && carrying.stage !== 'plated' && carrying.stage !== 'burnt') {
      order = this.adoptableOrderFor(carrying, c.id);
    }

    if (order && carrying && carrying.stage !== 'burnt' && carrying.stage !== 'plated') {
      const recipe = RECIPES[order.dish];
      const compatible = recipe.ingredient === carrying.ingredient;
      const complete = compatible && this.itemComplete(carrying, recipe);
      if (complete) {
        opts.push({ id: 'plate', label: 'Plate' });
      } else if (compatible) {
        // needs chop?
        if (recipe.needsChop && carrying.stage === 'raw') {
          for (const b of this.freeStations(T.BOARD)) {
            opts.push({ id: `chop:${b.id}`, label: `Chop @ ${this.stationLabel(b)}` });
          }
        }
        // needs cook?
        const cookStage = carrying.stage === (recipe.needsChop ? 'chopped' : 'raw');
        if (recipe.needsCook && cookStage) {
          for (const st of this.freeStations(T.STOVE)) {
            if (st.onFire) continue;
            opts.push({ id: `cook:${st.id}`, label: `Cook @ ${this.stoveLabel(st)}` });
          }
        }
      }
    }

    // Carrying a non-burnt item we can't do anything useful with (no matching
    // order to make or adopt) → trashing it frees our hands. Always offer it as
    // an escape hatch so a chef never deadlocks holding orphaned food.
    if (carrying && carrying.stage !== 'burnt' && carrying.stage !== 'plated') {
      const canUse = opts.some(
        (o) => o.id === 'plate' || o.id.startsWith('chop:') || o.id.startsWith('cook:'),
      );
      if (!canUse) {
        const trash = this.station(T.TRASH);
        if (trash) opts.push({ id: 'trash', label: 'Trash' });
      }
    }

    // Collect a cooked item from a stove if we're empty-handed and it can serve
    // an open order — ours, or one we could adopt. Rescuing orphaned cooked food
    // before it burns is what keeps stoves from catching fire.
    if (!carrying) {
      for (const st of this.state.stations) {
        if (st.kind !== T.STOVE || st.onFire) continue;
        const item = st.item;
        if (!item || item.stage !== 'cooked') continue;
        const forMine = order && RECIPES[order.dish].ingredient === item.ingredient;
        const adoptable = !order && this.adoptableOrderFor(item, c.id) !== null;
        if (forMine || adoptable) {
          opts.push({ id: `collect:${st.id}`, label: `Collect @ ${this.stoveLabel(st)}` });
        }
      }
    }

    // fetch raw ingredient for the claimed order
    if (order && !carrying) {
      const recipe = RECIPES[order.dish];
      // only fetch if there's no cooked item already waiting to collect
      const hasCollectable = opts.some((o) => o.id.startsWith('collect:'));
      if (!hasCollectable) {
        const crate = this.crateFor(recipe.ingredient);
        if (crate) opts.push({ id: `fetch:${recipe.ingredient}`, label: `Fetch ${cap(recipe.ingredient)}` });
      }
    }

    // if no claimed order and hands free, claim an open unclaimed order
    if (!order && (!carrying || carrying.stage === 'burnt')) {
      if (!carrying) {
        for (const o of this.state.orders) {
          if (o.status === 'open' && o.claimedBy === null) {
            opts.push({ id: `claim:${o.id}`, label: `Claim ${RECIPES[o.dish].name} #${o.id}` });
          }
        }
      }
    }

    opts.push({ id: 'wait', label: 'Hold' });
    return opts;
  }

  private buildRequest(r: ChefRt, now: number, options: ActionOption[]): DecisionRequest {
    const c = r.chef;
    const order = this.claimedOrder(c.id);
    const distances: Record<string, number> = {};
    for (const o of options) {
      distances[o.id] = this.optionDistance(c, o.id);
    }
    const state: Record<string, unknown> = {
      orders: this.state.orders
        .filter((o) => o.status === 'open')
        .slice(0, 10)
        .map((o) => ({
          id: o.id,
          dish: o.dish,
          points: RECIPES[o.dish].points,
          secondsLeft: Math.max(0, Math.round(o.expiresAt - now)),
          claimedBy: o.claimedBy,
        })),
      carrying: c.carrying ? { ingredient: c.carrying.ingredient, stage: c.carrying.stage } : null,
      claimedOrderId: order?.id ?? null,
      claimedSecondsLeft: order ? Math.max(0, Math.round(order.expiresAt - now)) : null,
      fireCount: this.state.stations.filter((s) => s.onFire).length,
      pos: { x: Math.round(c.x * 10) / 10, y: Math.round(c.y * 10) / 10 },
      distances,
      stations: this.stationSummary(),
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

  private applyDecision(r: ChefRt, d: JevDecision, options: ActionOption[]) {
    const valid = options.find((o) => o.id === d.chosenId);
    // if the chosen action is no longer valid (state moved on), skip; the loop
    // will re-request next tick.
    if (!valid) return;
    this.compile(r, d.chosenId);
  }

  // ── compile a chosen action id into internal steps ─────────
  private compile(r: ChefRt, id: string) {
    const c = r.chef;

    if (id === 'wait') {
      c.planLabel = c.carrying ? c.planLabel : 'Waiting for orders';
      c.moveLabel = 'Hold';
      return;
    }

    if (id.startsWith('claim:')) {
      const oid = Number(id.slice(6));
      const order = this.state.orders.find((o) => o.id === oid);
      if (!order || order.status !== 'open' || order.claimedBy !== null) return;
      order.claimedBy = c.id;
      c.planLabel = `${RECIPES[order.dish].name} #${order.id}`;
      c.moveLabel = 'Claimed';
      // immediately continue: next decision (fetch) happens next idle tick
      return;
    }

    if (id.startsWith('extinguish:')) {
      const sid = Number(id.slice('extinguish:'.length));
      const s = this.state.stations.find((st) => st.id === sid);
      if (!s || !s.onFire) return;
      const assigned = this.fireAssign.get(sid);
      if (assigned !== undefined && assigned !== c.id) return; // someone else has it
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
      return;
    }

    if (id.startsWith('fetch:')) {
      const ing = id.slice(6) as Ingredient;
      const crate = this.crateFor(ing);
      if (!crate) return;
      this.walkThen(r, crate, {
        action: 'grabbing', duration: 0.4, label: `Grab ${cap(ing)}`,
        onDone: (_sim, rr) => {
          rr.chef.carrying = { ingredient: ing, stage: 'raw' };
          this.pressB(rr);
        },
      });
      const order = this.claimedOrder(c.id);
      c.planLabel = order ? `${RECIPES[order.dish].name} · fetch ${ing}` : `Fetch ${ing}`;
      return;
    }

    if (id.startsWith('chop:')) {
      const sid = Number(id.slice(5));
      const s = this.state.stations.find((st) => st.id === sid);
      if (!s || s.kind !== T.BOARD || s.inUseBy !== null || s.item !== null) return;
      const carried = c.carrying;
      if (!carried || carried.stage !== 'raw') return;
      this.ensureClaimForCarry(c);
      // place then chop
      this.walkThen(r, s, {
        action: 'chopping', duration: RECIPES[this.dishForItem(carried)]?.chopTime ?? 2.4,
        label: 'Chop',
        onDone: (sim, rr) => {
          if (rr.chef.carrying) rr.chef.carrying.stage = 'chopped';
          s.item = null;
          s.inUseBy = null;
          this.pressB(rr);
          void sim;
        },
      }, /*placeItemOnStation*/ true);
      const order = this.claimedOrder(c.id);
      c.planLabel = order ? `${RECIPES[order.dish].name} · chop` : 'Chop';
      return;
    }

    if (id.startsWith('cook:')) {
      const sid = Number(id.slice(5));
      const s = this.state.stations.find((st) => st.id === sid);
      if (!s || s.kind !== T.STOVE || s.onFire || s.inUseBy !== null || s.item !== null) return;
      const carried = c.carrying;
      if (!carried) return;
      this.ensureClaimForCarry(c);
      this.walkThen(r, s, {
        action: 'stirring', duration: 0.4, label: `Cook @ ${this.stoveLabel(s)}`,
        onDone: (_sim, rr) => {
          // hand the item to the stove; cooking proceeds unattended
          if (rr.chef.carrying) {
            s.item = rr.chef.carrying;
            s.progress = 0;
            rr.chef.carrying = null;
          }
          this.pressB(rr);
        },
      });
      const order = this.claimedOrder(c.id);
      c.planLabel = order ? `${RECIPES[order.dish].name} · cook` : 'Cook';
      return;
    }

    if (id.startsWith('collect:')) {
      const sid = Number(id.slice('collect:'.length));
      const s = this.state.stations.find((st) => st.id === sid);
      if (!s || !s.item || s.item.stage !== 'cooked') return;
      this.walkThen(r, s, {
        action: 'grabbing', duration: 0.4, label: `Collect @ ${this.stoveLabel(s)}`,
        onDone: (sim, rr) => {
          if (s.item) {
            rr.chef.carrying = s.item;
            s.item = null;
            s.progress = 0;
          }
          sim.ensureClaimForCarry(rr.chef);
          this.pressB(rr);
        },
      });
      c.planLabel = 'Collect dish';
      return;
    }

    if (id === 'plate') {
      const plates = this.station(T.PLATES);
      if (!plates) return;
      this.ensureClaimForCarry(c);
      const order = this.claimedOrder(c.id);
      this.walkThen(r, plates, {
        action: 'plating', duration: 1.0, label: 'Plate',
        onDone: (_sim, rr) => {
          if (rr.chef.carrying) {
            rr.chef.carrying = {
              ingredient: rr.chef.carrying.ingredient,
              stage: 'plated',
              dish: order?.dish,
            };
          }
          this.pressB(rr);
        },
      });
      c.planLabel = order ? `${RECIPES[order.dish].name} · plate` : 'Plate';
      return;
    }

    if (id === 'deliver') {
      const serve = this.station(T.SERVE);
      if (!serve) return;
      this.walkThen(r, serve, {
        action: 'delivering', duration: 0.6, label: 'Deliver',
        onDone: (sim, rr) => {
          sim.deliverAt(rr);
        },
      });
      const order = this.claimedOrder(c.id);
      c.planLabel = order ? `${RECIPES[order.dish].name} · deliver` : 'Deliver';
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
      c.planLabel = 'Dump burnt food';
      return;
    }
  }

  // helper: build [walkTo stand, work] steps for a station action.
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
      // put the raw item onto the board when we arrive (chop path)
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

  private deliverAt(r: ChefRt) {
    const c = r.chef;
    const plated = c.carrying;
    if (!plated || plated.stage !== 'plated') { c.carrying = null; return; }
    const dish = plated.dish;
    // find a matching open order — prefer this chef's claimed one
    let order = this.claimedOrder(c.id);
    if (!order || order.dish !== dish || order.status !== 'open') {
      order = this.state.orders.find((o) => o.status === 'open' && o.dish === dish) ?? null;
    }
    c.carrying = null;
    if (order) {
      order.status = 'done';
      order.claimedBy = c.id;
      const pts = RECIPES[order.dish].points;
      this.state.score += pts;
      this.state.served++;
      this.pushEvent('serve', `${c.name} served ${RECIPES[order.dish].name} (+${pts})`);
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
    } else {
      this.pushEvent('info', `${c.name} had no taker for ${dish}`);
    }
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
    r.steps = [];
    r.stepTime = 0;
    c.path = [];
    c.action = 'idle';
    c.actionProgress = 0;
    // if carrying a non-plated item and our order died, we'll trash/redeal via
    // the option builder; leave carrying as-is so 'trash' becomes an option.
    if (orderFailed) {
      c.planLabel = 'Order lost — regrouping';
    }
    r.idleSince = 0;
  }

  // ── small helpers ──────────────────────────────────────────
  private pressB(r: ChefRt) {
    r.chef.inputBtn = 'B';
    r.bHoldUntil = this.state.t + B_HOLD;
  }

  // If the chef holds a workable item but has no claimed order, adopt (claim) an
  // open order it can fulfill so plate/cook/chop deliver against a real order.
  private ensureClaimForCarry(c: Chef) {
    if (this.claimedOrder(c.id)) return;
    if (!c.carrying || c.carrying.stage === 'burnt' || c.carrying.stage === 'plated') return;
    const adopt = this.adoptableOrderFor(c.carrying, c.id);
    if (adopt) {
      adopt.claimedBy = c.id;
      c.planLabel = `${RECIPES[adopt.dish].name} #${adopt.id}`;
    }
  }

  private claimedOrder(chefId: number): Order | null {
    return this.state.orders.find(
      (o) => o.status === 'open' && o.claimedBy === chefId,
    ) ?? null;
  }

  private itemComplete(item: Item, recipe: Recipe): boolean {
    if (recipe.needsCook) return item.stage === 'cooked';
    if (recipe.needsChop) return item.stage === 'chopped';
    return item.stage === 'raw';
  }

  private dishForItem(item: Item): DishId {
    // best-effort dish for an ingredient (used only for chop duration)
    const r = Object.values(RECIPES).find((x) => x.ingredient === item.ingredient && x.needsChop);
    return (r ?? Object.values(RECIPES).find((x) => x.ingredient === item.ingredient))!.id;
  }

  private freeStations(kind: TileKind): Station[] {
    return this.state.stations.filter(
      (s) => s.kind === kind && s.inUseBy === null && s.item === null && !s.onFire,
    );
  }

  private station(kind: TileKind): Station | null {
    return this.state.stations.find((s) => s.kind === kind) ?? null;
  }

  // Pick the closest chef who is free to fight a fire (empty-handed, no order
  // that's mid-cook, not already assigned to another fire). Deterministic by id
  // on ties so all chefs agree who takes it.
  private nearestFreeChefFor(s: Station): number {
    let bestId = -1;
    let bestDist = Infinity;
    for (const r of this.rt) {
      const c = r.chef;
      if (c.carrying) continue;
      // don't yank a chef whose claimed order has food cooking/cooked on a
      // stove — they need to stay to collect it before it burns.
      const order = this.claimedOrder(c.id);
      if (order && this.hasFoodOnStoveFor(c.id, order)) continue;
      // already assigned to a (different, still-burning) fire?
      let busyElsewhere = false;
      this.fireAssign.forEach((cid, sid) => {
        if (cid === c.id && sid !== s.id) {
          const st = this.state.stations.find((x) => x.id === sid);
          if (st && st.onFire) busyElsewhere = true;
        }
      });
      if (busyElsewhere) continue;
      const d = Math.abs(c.x - s.x) + Math.abs(c.y - s.y);
      if (d < bestDist - 1e-6 || (Math.abs(d - bestDist) <= 1e-6 && c.id < bestId)) {
        bestDist = d;
        bestId = c.id;
      }
    }
    return bestId;
  }

  // An open order the carried item can still fulfill — either already claimed by
  // this chef, or unclaimed (adoptable). Prefers unclaimed; used to salvage work
  // when a chef's original order expired mid-prep.
  private adoptableOrderFor(item: Item, chefId: number): Order | null {
    let best: Order | null = null;
    for (const o of this.state.orders) {
      if (o.status !== 'open') continue;
      if (o.claimedBy !== null && o.claimedBy !== chefId) continue;
      const recipe = RECIPES[o.dish];
      if (recipe.ingredient !== item.ingredient) continue;
      // item must not have overshot this recipe (e.g. chopped item can't become
      // an un-chop recipe's raw requirement — but chopped works for cook recipes)
      if (item.stage === 'chopped' && !recipe.needsChop && !recipe.needsCook) continue;
      if (!best || o.expiresAt < best.expiresAt) best = o;
    }
    return best;
  }

  // Does this chef have an item on a stove (cooking or cooked) for its order?
  private hasFoodOnStoveFor(_chefId: number, order: Order): boolean {
    const recipe = RECIPES[order.dish];
    if (!recipe.needsCook) return false;
    return this.state.stations.some(
      (s) =>
        s.kind === T.STOVE &&
        !s.onFire &&
        s.item !== null &&
        s.item.ingredient === recipe.ingredient &&
        (s.item.stage === 'raw' || s.item.stage === 'chopped' || s.item.stage === 'cooked'),
    );
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
    const kind = ing === 'tomato' ? T.CRATE_TOMATO : ing === 'meat' ? T.CRATE_MEAT : T.CRATE_PASTA;
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
    if (id.startsWith('extinguish:') || id.startsWith('chop:') || id.startsWith('cook:') || id.startsWith('collect:')) {
      const sid = Number(id.slice(id.indexOf(':') + 1));
      target = this.state.stations.find((s) => s.id === sid) ?? null;
    } else if (id.startsWith('fetch:')) {
      target = this.crateFor(id.slice(6) as Ingredient);
    } else if (id === 'plate') target = this.station(T.PLATES);
    else if (id === 'deliver') target = this.station(T.SERVE);
    else if (id === 'trash') target = this.station(T.TRASH);
    else if (id.startsWith('claim:')) return 3;
    else return 0;
    if (!target) return 6;
    return Math.abs(c.x - target.x) + Math.abs(c.y - target.y);
  }

  private stoveLabel(s: Station): string {
    const stoves = this.state.stations.filter((x) => x.kind === T.STOVE);
    return String(stoves.indexOf(s) + 1);
  }

  private stationLabel(s: Station): string {
    if (s.kind === T.BOARD) {
      const boards = this.state.stations.filter((x) => x.kind === T.BOARD);
      return `Board ${boards.indexOf(s) + 1}`;
    }
    if (s.kind === T.STOVE) return `Stove ${this.stoveLabel(s)}`;
    return 'Station';
  }

  private pushEvent(kind: SimEvent['kind'], text: string) {
    this.state.events.push({ t: Math.round(this.state.t * 100) / 100, kind, text });
    if (this.state.events.length > 30) this.state.events.shift();
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
