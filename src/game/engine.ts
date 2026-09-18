import {
  Agent, AgentState, Station, TileType, Order, DishType, FoodItem, ItemState,
  Spill, Particle, GameStats, Point, TaskStep, AgentTask,
  GRID_W, GRID_H, TILE_SIZE, RECIPES, KITCHEN_LAYOUT, AGENT_COLORS, AGENT_NAMES,
} from './types';
import { findPath } from './pathfinding';

export class GameEngine {
  grid: number[][];
  agents: Agent[] = [];
  stations: Station[] = [];
  orders: Order[] = [];
  spills: Spill[] = [];
  particles: Particle[] = [];
  stats: GameStats = { dishesServed: 0, dishesFailed: 0, firesCaused: 0, jevsFired: 0, jevsHired: 0, totalScore: 0 };

  nextAgentId = 0;
  nextOrderId = 0;
  orderTimer = 2;
  degradeTimer = 15;
  gameTime = 0;
  shiftDuration = 180;

  possessedId: number | null = null;
  keysDown = new Set<string>();
  rushHour = false;
  rushHourTimer = 0;
  shiftEnded = false;
  paused = false;

  onUpdate: (() => void) | null = null;
  onShiftEnd: (() => void) | null = null;

  constructor() {
    this.grid = KITCHEN_LAYOUT.map(row => [...row]);
    this.initStations();
    for (let i = 0; i < 5; i++) this.spawnAgent(false);
  }

  private initStations() {
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const t = this.grid[y][x];
        if (t >= 2) {
          this.stations.push({
            type: t as TileType, pos: { x, y },
            item: null, progress: 0, grease: 0,
            onFire: false, fireTimer: 0, inUse: false, usedBy: null,
          });
        }
      }
    }
  }

  isWalkable(x: number, y: number): boolean {
    if (x < 0 || x >= GRID_W || y < 0 || y >= GRID_H) return false;
    return this.grid[y][x] === TileType.FLOOR;
  }

  getStationAt(p: Point): Station | null {
    return this.stations.find(s => s.pos.x === p.x && s.pos.y === p.y) || null;
  }

  getAdjacentFloor(p: Point): Point[] {
    const dirs: Point[] = [{ x: 0, y: -1 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 1, y: 0 }];
    return dirs.map(d => ({ x: p.x + d.x, y: p.y + d.y })).filter(pp => this.isWalkable(pp.x, pp.y));
  }

  findAvailableStation(agentPos: Point, type: TileType): { station: Station; accessPoint: Point } | null {
    const candidates = this.stations.filter(s => s.type === type && !s.inUse);
    if (candidates.length === 0) return null;

    let best: { station: Station; accessPoint: Point; dist: number } | null = null;
    for (const s of candidates) {
      const floors = this.getAdjacentFloor(s.pos);
      for (const f of floors) {
        const dist = Math.abs(f.x - agentPos.x) + Math.abs(f.y - agentPos.y);
        if (!best || dist < best.dist) {
          best = { station: s, accessPoint: f, dist };
        }
      }
    }
    return best ? { station: best.station, accessPoint: best.accessPoint } : null;
  }

  spawnAgent(panicked: boolean): Agent {
    const floors: Point[] = [];
    for (let y = 2; y < GRID_H - 1; y++) {
      for (let x = 1; x < GRID_W - 1; x++) {
        if (this.isWalkable(x, y) && !this.agents.some(a => Math.abs(a.x - x) < 1.5 && Math.abs(a.y - y) < 1.5)) {
          floors.push({ x, y });
        }
      }
    }
    const pos = floors.length > 0 ? floors[Math.floor(Math.random() * floors.length)] : { x: 3, y: 6 };
    const idx = this.nextAgentId;
    const agent: Agent = {
      id: this.nextAgentId++,
      x: pos.x, y: pos.y,
      state: panicked ? AgentState.PANICKING : AgentState.IDLE,
      prevState: AgentState.IDLE,
      path: [], pathIndex: 0,
      carrying: null, task: null,
      stateTimer: panicked ? 3 : 0,
      workTimer: 0, workDuration: 0,
      color: AGENT_COLORS[idx % AGENT_COLORS.length],
      name: AGENT_NAMES[idx % AGENT_NAMES.length],
      expression: panicked ? 'panicking' : 'normal',
      speed: 2.8 + Math.random() * 0.4,
      facingDir: { x: 0, y: 1 },
      targetStation: null,
      idleTimer: 0,
      bobOffset: Math.random() * Math.PI * 2,
    };
    this.agents.push(agent);
    return agent;
  }

  // ── Main loop ──────────────────────────────────────────

  update(dt: number) {
    if (this.paused) return;
    if (this.shiftEnded) return;

    dt = Math.min(dt, 0.1);
    this.gameTime += dt;

    if (this.gameTime >= this.shiftDuration) {
      this.shiftEnded = true;
      this.onShiftEnd?.();
      return;
    }

    if (this.rushHour) {
      this.rushHourTimer -= dt;
      if (this.rushHourTimer <= 0) this.rushHour = false;
    }

    this.updateOrders(dt);
    this.updateStations(dt);
    for (const agent of [...this.agents]) this.updateAgent(agent, dt);
    this.agents = this.agents.filter(a => !(a.state === AgentState.RAGE_QUITTING && a.stateTimer <= 0));
    this.resolveCollisions();
    this.updateSpills(dt);
    this.updateParticles(dt);
    this.updateDegradation(dt);

    this.orderTimer -= dt;
    if (this.orderTimer <= 0) {
      this.generateOrder();
      this.orderTimer = this.rushHour ? 2 + Math.random() * 2 : 6 + Math.random() * 4;
    }

    this.onUpdate?.();
  }

  // ── Orders ─────────────────────────────────────────────

  updateOrders(dt: number) {
    for (const o of this.orders) {
      if (o.completed || o.failed) continue;
      o.timeLeft -= dt;
      if (o.timeLeft <= 0) this.failOrder(o.id);
    }
    this.orders = this.orders.filter(o => !o.failed || o.timeLeft > -2);
  }

  generateOrder() {
    const dishes = [DishType.BURGER, DishType.SOUP, DishType.SALAD, DishType.STEAK, DishType.PASTA];
    const dish = dishes[Math.floor(Math.random() * dishes.length)];
    const recipe = RECIPES[dish];
    this.orders.push({
      id: this.nextOrderId++,
      dish, timeLeft: recipe.orderTime, maxTime: recipe.orderTime,
      claimed: false, claimedBy: null, completed: false, failed: false,
    });
  }

  completeOrder(orderId: number) {
    const o = this.orders.find(o => o.id === orderId);
    if (!o || o.completed || o.failed) return;
    o.completed = true;
    const recipe = RECIPES[o.dish];
    const timeBonus = Math.floor((o.timeLeft / o.maxTime) * 10);
    this.stats.totalScore += recipe.points + timeBonus;
    this.stats.dishesServed++;
    this.spawnCelebrationParticles(16 * TILE_SIZE, 1 * TILE_SIZE);
  }

  failOrder(orderId: number) {
    const o = this.orders.find(o => o.id === orderId);
    if (!o || o.completed || o.failed) return;
    o.failed = true;
    this.stats.dishesFailed++;
    this.stats.totalScore = Math.max(0, this.stats.totalScore - 5);
    // Unclaim from agent
    const agent = this.agents.find(a => a.task?.orderId === orderId);
    if (agent) { agent.task = null; agent.state = AgentState.IDLE; agent.targetStation = null; }
  }

  // ── Stations ───────────────────────────────────────────

  updateStations(dt: number) {
    for (const s of this.stations) {
      if (s.type === TileType.STOVE) {
        if (s.item && s.inUse && s.item.state === ItemState.RAW) {
          // cooking handled by agent work timer
        }
        if (s.item && !s.inUse && s.item.state === ItemState.COOKED) {
          // unattended cooked food can burn
          s.progress += dt * 0.05;
          if (s.progress >= 1) {
            s.item.state = ItemState.BURNT;
            s.progress = 0;
            this.spawnSmokeParticles(s.pos.x * TILE_SIZE + TILE_SIZE / 2, s.pos.y * TILE_SIZE);
          }
        }
        // Grease accumulation
        if (s.item) s.grease = Math.min(1, s.grease + dt * 0.01);
        // Fire from grease
        if (!s.onFire && s.grease > 0.7 && Math.random() < dt * 0.02 * s.grease) {
          this.startFire(s);
        }
        if (s.onFire) {
          s.fireTimer += dt;
          if (s.item) s.item.state = ItemState.BURNT;
          this.spawnFireParticles(s.pos.x * TILE_SIZE + TILE_SIZE / 2, s.pos.y * TILE_SIZE);
          // panic nearby agents
          for (const a of this.agents) {
            if (a.state !== AgentState.PANICKING && a.state !== AgentState.POSSESSED && a.state !== AgentState.RAGE_QUITTING) {
              const dist = Math.abs(a.x - s.pos.x) + Math.abs(a.y - s.pos.y);
              if (dist < 2.5 && Math.random() < dt * 0.3) {
                a.prevState = a.state;
                a.state = AgentState.PANICKING;
                a.stateTimer = 1.5 + Math.random();
                a.expression = 'panicking';
              }
            }
          }
          // Auto-extinguish after a while
          if (s.fireTimer > 12) { s.onFire = false; s.fireTimer = 0; s.grease = 0.2; }
        }
      }
    }
  }

  startFire(station: Station) {
    station.onFire = true;
    station.fireTimer = 0;
    this.stats.firesCaused++;
  }

  extinguishFire(station: Station) {
    station.onFire = false;
    station.fireTimer = 0;
    station.grease *= 0.3;
  }

  // ── Agent AI ───────────────────────────────────────────

  updateAgent(agent: Agent, dt: number) {
    agent.bobOffset += dt * 4;
    switch (agent.state) {
      case AgentState.IDLE: this.agentIdle(agent, dt); break;
      case AgentState.WALKING: this.agentWalk(agent, dt); break;
      case AgentState.WORKING: this.agentWork(agent, dt); break;
      case AgentState.PANICKING: this.agentPanic(agent, dt); break;
      case AgentState.RAGE_QUITTING: this.agentRageQuit(agent, dt); break;
      case AgentState.POSSESSED: this.agentPossessed(agent, dt); break;
      case AgentState.SLIPPING: this.agentSlip(agent, dt); break;
    }
  }

  agentIdle(agent: Agent, dt: number) {
    agent.expression = 'normal';
    agent.idleTimer += dt;

    // Check for fires to extinguish
    const fire = this.stations.find(s => s.onFire && !s.inUse);
    if (fire && agent.idleTimer > 0.5) {
      const sinkResult = this.findAvailableStation({ x: Math.round(agent.x), y: Math.round(agent.y) }, TileType.SINK);
      if (sinkResult) {
        // Simplified: just go extinguish the fire directly
        const adj = this.getAdjacentFloor(fire.pos);
        if (adj.length > 0) {
          const target = adj[0];
          const path = findPath(
            { x: Math.round(agent.x), y: Math.round(agent.y) },
            target,
            (x, y) => this.isWalkable(x, y)
          );
          if (path.length > 0) {
            agent.path = path;
            agent.pathIndex = 0;
            agent.state = AgentState.WALKING;
            agent.targetStation = fire;
            agent.task = null;
            agent.idleTimer = 0;
            fire.inUse = true;
            fire.usedBy = agent.id;
            return;
          }
        }
      }
    }

    // Find unclaimed order
    const unclaimed = this.orders.filter(o => !o.claimed && !o.completed && !o.failed && o.timeLeft > 10);
    if (unclaimed.length > 0 && agent.idleTimer > 0.3) {
      const order = unclaimed[0];
      const recipe = RECIPES[order.dish];
      const steps = this.generateSteps(order.dish);
      agent.task = { orderId: order.id, dish: order.dish, steps, currentStep: 0 };
      order.claimed = true;
      order.claimedBy = agent.id;
      agent.idleTimer = 0;
      this.executeCurrentStep(agent);
      return;
    }

    // Wander
    if (agent.idleTimer > 2) {
      agent.idleTimer = 0;
      const gx = Math.round(agent.x);
      const gy = Math.round(agent.y);
      const wx = gx + Math.floor(Math.random() * 7) - 3;
      const wy = gy + Math.floor(Math.random() * 5) - 2;
      if (this.isWalkable(wx, wy)) {
        const path = findPath({ x: gx, y: gy }, { x: wx, y: wy }, (x, y) => this.isWalkable(x, y));
        if (path.length > 1) {
          agent.path = path;
          agent.pathIndex = 0;
          agent.state = AgentState.WALKING;
        }
      }
    }
  }

  agentWalk(agent: Agent, dt: number) {
    if (agent.path.length === 0 || agent.pathIndex >= agent.path.length) {
      this.arriveAtDestination(agent);
      return;
    }

    const target = agent.path[agent.pathIndex];
    const dx = target.x - agent.x;
    const dy = target.y - agent.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < 0.1) {
      agent.x = target.x;
      agent.y = target.y;
      agent.pathIndex++;
      if (agent.pathIndex >= agent.path.length) {
        this.arriveAtDestination(agent);
      }
      return;
    }

    const speed = agent.speed * (this.rushHour ? 1.3 : 1);
    const move = Math.min(speed * dt, dist);
    agent.x += (dx / dist) * move;
    agent.y += (dy / dist) * move;
    if (Math.abs(dx) > Math.abs(dy)) agent.facingDir = { x: dx > 0 ? 1 : -1, y: 0 };
    else agent.facingDir = { x: 0, y: dy > 0 ? 1 : -1 };

    agent.expression = this.rushHour ? 'stressed' : 'normal';

    // Check spill collision
    const gx = Math.round(agent.x);
    const gy = Math.round(agent.y);
    const spill = this.spills.find(s => s.x === gx && s.y === gy);
    if (spill && Math.random() < 0.15 * dt) {
      agent.prevState = agent.state;
      agent.state = AgentState.SLIPPING;
      agent.stateTimer = 0.8;
      agent.expression = 'panicking';
      if (agent.carrying) {
        this.createSpill(gx + (Math.random() > 0.5 ? 1 : -1), gy);
        agent.carrying = null;
      }
    }
  }

  arriveAtDestination(agent: Agent) {
    // If going to extinguish fire
    if (agent.targetStation?.onFire && !agent.task) {
      this.extinguishFire(agent.targetStation);
      agent.targetStation.inUse = false;
      agent.targetStation.usedBy = null;
      agent.targetStation = null;
      agent.state = AgentState.IDLE;
      agent.expression = 'happy';
      return;
    }

    // If no task, go idle
    if (!agent.task) {
      agent.state = AgentState.IDLE;
      return;
    }

    // Advance to next step (the walk_to step is done, now do the action)
    this.advanceStep(agent);
  }

  agentWork(agent: Agent, dt: number) {
    agent.workTimer += dt;
    agent.expression = 'stressed';
    if (agent.workTimer >= agent.workDuration) {
      agent.workTimer = 0;
      // Work done, advance step
      if (agent.targetStation) {
        if (agent.targetStation.item) {
          if (agent.targetStation.type === TileType.CUTTING_BOARD) {
            agent.targetStation.item.state = ItemState.CHOPPED;
          } else if (agent.targetStation.type === TileType.STOVE) {
            agent.targetStation.item.state = ItemState.COOKED;
          } else if (agent.targetStation.type === TileType.PLATING) {
            agent.targetStation.item.state = ItemState.PLATED;
          }
        }
        agent.targetStation.progress = 0;
      }
      this.advanceStep(agent);
    } else if (agent.targetStation) {
      agent.targetStation.progress = agent.workTimer / agent.workDuration;
    }
  }

  agentPanic(agent: Agent, dt: number) {
    agent.stateTimer -= dt;
    agent.expression = 'panicking';
    // Random movement
    const speed = agent.speed * 1.5;
    agent.x += (Math.random() - 0.5) * speed * dt * 2;
    agent.y += (Math.random() - 0.5) * speed * dt * 2;
    // Clamp to walkable area
    agent.x = Math.max(1.2, Math.min(GRID_W - 2.2, agent.x));
    agent.y = Math.max(1.2, Math.min(GRID_H - 2.2, agent.y));
    // Ensure on walkable tile
    const gx = Math.round(agent.x);
    const gy = Math.round(agent.y);
    if (!this.isWalkable(gx, gy)) {
      agent.x = Math.round(agent.x - agent.facingDir.x * 0.5);
      agent.y = Math.round(agent.y - agent.facingDir.y * 0.5);
    }
    if (agent.stateTimer <= 0) {
      agent.state = AgentState.IDLE;
      agent.expression = 'normal';
      agent.idleTimer = 0;
    }
  }

  agentRageQuit(agent: Agent, dt: number) {
    agent.expression = 'angry';
    agent.stateTimer -= dt;
    // Move toward bottom exit
    const targetY = GRID_H + 1;
    const dy = targetY - agent.y;
    const dx = (Math.sin(agent.bobOffset * 2) * 0.5);
    agent.y += Math.min(agent.speed * dt, Math.abs(dy)) * Math.sign(dy);
    agent.x += dx * dt;
    agent.x = Math.max(1, Math.min(GRID_W - 2, agent.x));
    // Knock items off nearby stations as we pass
    if (Math.random() < dt * 0.5) {
      const nearby = this.stations.filter(s => Math.abs(s.pos.x - agent.x) < 2 && Math.abs(s.pos.y - agent.y) < 2 && s.item);
      if (nearby.length > 0) {
        const s = nearby[0];
        s.item = null;
        s.progress = 0;
        this.createSpill(s.pos.x, s.pos.y + 1);
      }
    }
    if (agent.y > GRID_H) agent.stateTimer = 0;
  }

  agentPossessed(agent: Agent, dt: number) {
    agent.expression = 'happy';
    const speed = agent.speed;
    let mx = 0, my = 0;
    if (this.keysDown.has('w') || this.keysDown.has('arrowup')) my = -1;
    if (this.keysDown.has('s') || this.keysDown.has('arrowdown')) my = 1;
    if (this.keysDown.has('a') || this.keysDown.has('arrowleft')) mx = -1;
    if (this.keysDown.has('d') || this.keysDown.has('arrowright')) mx = 1;

    if (mx !== 0 || my !== 0) {
      const len = Math.sqrt(mx * mx + my * my);
      const nx = agent.x + (mx / len) * speed * dt;
      const ny = agent.y + (my / len) * speed * dt;
      const gx = Math.round(nx);
      const gy = Math.round(ny);
      if (this.isWalkable(gx, Math.round(agent.y))) agent.x = nx;
      if (this.isWalkable(Math.round(agent.x), gy)) agent.y = ny;
      agent.facingDir = { x: mx, y: my };
    }

    if (this.keysDown.has(' ')) {
      this.keysDown.delete(' ');
      this.playerInteract(agent);
    }
  }

  agentSlip(agent: Agent, dt: number) {
    agent.stateTimer -= dt;
    agent.expression = 'panicking';
    agent.bobOffset += dt * 20;
    if (agent.stateTimer <= 0) {
      agent.state = agent.task ? AgentState.IDLE : AgentState.IDLE;
      agent.expression = 'normal';
      agent.idleTimer = 0;
      // Rebuild task path if needed
      if (agent.task) {
        this.executeCurrentStep(agent);
      }
    }
  }

  // ── Task execution ─────────────────────────────────────

  generateSteps(dish: DishType): TaskStep[] {
    const recipe = RECIPES[dish];
    const steps: TaskStep[] = [];
    steps.push({ action: 'walk_to', stationType: TileType.INGREDIENT });
    steps.push({ action: 'pickup' });
    if (recipe.needsCut) {
      steps.push({ action: 'walk_to', stationType: TileType.CUTTING_BOARD });
      steps.push({ action: 'place_item' });
      steps.push({ action: 'work', duration: recipe.cutTime });
      steps.push({ action: 'pickup' });
    }
    if (recipe.needsCook) {
      steps.push({ action: 'walk_to', stationType: TileType.STOVE });
      steps.push({ action: 'place_item' });
      steps.push({ action: 'work', duration: recipe.cookTime });
      steps.push({ action: 'pickup' });
    }
    steps.push({ action: 'walk_to', stationType: TileType.PLATING });
    steps.push({ action: 'place_item' });
    steps.push({ action: 'work', duration: 1.5 });
    steps.push({ action: 'pickup' });
    steps.push({ action: 'walk_to', stationType: TileType.DELIVERY });
    steps.push({ action: 'deliver' });
    return steps;
  }

  executeCurrentStep(agent: Agent) {
    if (!agent.task || agent.task.currentStep >= agent.task.steps.length) {
      agent.state = AgentState.IDLE;
      agent.task = null;
      agent.targetStation = null;
      return;
    }

    const step = agent.task.steps[agent.task.currentStep];

    switch (step.action) {
      case 'walk_to': {
        const result = this.findAvailableStation(
          { x: Math.round(agent.x), y: Math.round(agent.y) },
          step.stationType!
        );
        if (!result) {
          // Can't find station, wait and retry
          agent.state = AgentState.IDLE;
          agent.idleTimer = -1;
          return;
        }
        const path = findPath(
          { x: Math.round(agent.x), y: Math.round(agent.y) },
          result.accessPoint,
          (x, y) => this.isWalkable(x, y)
        );
        if (path.length === 0) {
          agent.state = AgentState.IDLE;
          agent.idleTimer = -1;
          return;
        }
        agent.path = path;
        agent.pathIndex = 0;
        agent.state = AgentState.WALKING;
        agent.targetStation = result.station;
        result.station.inUse = true;
        result.station.usedBy = agent.id;
        break;
      }
      case 'pickup': {
        if (agent.targetStation?.item) {
          agent.carrying = agent.targetStation.item;
          agent.targetStation.item = null;
          agent.targetStation.progress = 0;
          agent.targetStation.inUse = false;
          agent.targetStation.usedBy = null;
        } else if (agent.targetStation?.type === TileType.INGREDIENT) {
          // Create ingredient based on recipe
          const recipe = RECIPES[agent.task!.dish];
          agent.carrying = { type: recipe.ingredient, state: ItemState.RAW, dishTarget: agent.task!.dish };
          agent.targetStation.inUse = false;
          agent.targetStation.usedBy = null;
        }
        agent.task!.currentStep++;
        this.executeCurrentStep(agent);
        break;
      }
      case 'place_item': {
        if (agent.carrying && agent.targetStation) {
          agent.targetStation.item = agent.carrying;
          agent.carrying = null;
        }
        agent.task!.currentStep++;
        this.executeCurrentStep(agent);
        break;
      }
      case 'work': {
        agent.state = AgentState.WORKING;
        agent.workTimer = 0;
        agent.workDuration = step.duration || 3;
        agent.task!.currentStep++;
        break;
      }
      case 'deliver': {
        if (agent.task) {
          this.completeOrder(agent.task.orderId);
          if (agent.targetStation) {
            agent.targetStation.inUse = false;
            agent.targetStation.usedBy = null;
          }
        }
        agent.carrying = null;
        agent.task = null;
        agent.targetStation = null;
        agent.state = AgentState.IDLE;
        agent.expression = 'happy';
        agent.idleTimer = 0;
        break;
      }
    }
  }

  advanceStep(agent: Agent) {
    if (!agent.task) { agent.state = AgentState.IDLE; return; }
    agent.task.currentStep++;
    this.executeCurrentStep(agent);
  }

  // ── Collisions ─────────────────────────────────────────

  resolveCollisions() {
    for (let i = 0; i < this.agents.length; i++) {
      for (let j = i + 1; j < this.agents.length; j++) {
        const a = this.agents[i], b = this.agents[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 0.7 && dist > 0.01) {
          const push = (0.7 - dist) * 0.3;
          const nx = dx / dist, ny = dy / dist;
          if (a.state !== AgentState.WORKING && a.state !== AgentState.POSSESSED) {
            a.x -= nx * push; a.y -= ny * push;
          }
          if (b.state !== AgentState.WORKING && b.state !== AgentState.POSSESSED) {
            b.x += nx * push; b.y += ny * push;
          }
        }
      }
    }
  }

  // ── Degradation ────────────────────────────────────────

  updateDegradation(dt: number) {
    this.degradeTimer -= dt;
    if (this.degradeTimer <= 0) {
      this.degradeTimer = 8 + Math.random() * 12;
      // Random grease splash near stoves
      const stoves = this.stations.filter(s => s.type === TileType.STOVE);
      if (stoves.length > 0) {
        const s = stoves[Math.floor(Math.random() * stoves.length)];
        s.grease = Math.min(1, s.grease + 0.15 + Math.random() * 0.1);
      }
      // Random spill near sink
      if (Math.random() < 0.3) {
        const sinks = this.stations.filter(s => s.type === TileType.SINK);
        if (sinks.length > 0) {
          const sink = sinks[0];
          const adj = this.getAdjacentFloor(sink.pos);
          if (adj.length > 0) {
            const p = adj[Math.floor(Math.random() * adj.length)];
            this.createSpill(p.x, p.y);
          }
        }
      }
    }
  }

  createSpill(x: number, y: number) {
    const gx = Math.round(x), gy = Math.round(y);
    if (!this.isWalkable(gx, gy)) return;
    if (this.spills.some(s => s.x === gx && s.y === gy)) return;
    this.spills.push({ x: gx, y: gy, timer: 15 + Math.random() * 10, maxTimer: 20 });
  }

  updateSpills(dt: number) {
    for (const s of this.spills) s.timer -= dt;
    this.spills = this.spills.filter(s => s.timer > 0);
  }

  // ── Particles ──────────────────────────────────────────

  updateParticles(dt: number) {
    for (const p of this.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy -= 40 * dt;
      p.life -= dt;
    }
    this.particles = this.particles.filter(p => p.life > 0);
  }

  spawnFireParticles(x: number, y: number) {
    if (Math.random() > 0.3) return;
    this.particles.push({
      x: x + (Math.random() - 0.5) * 20, y: y - Math.random() * 10,
      vx: (Math.random() - 0.5) * 30, vy: -40 - Math.random() * 40,
      life: 0.5 + Math.random() * 0.5, maxLife: 1,
      color: Math.random() > 0.5 ? '#FF6B35' : '#FFD166', size: 3 + Math.random() * 4,
    });
  }

  spawnSmokeParticles(x: number, y: number) {
    for (let i = 0; i < 3; i++) {
      this.particles.push({
        x: x + (Math.random() - 0.5) * 15, y,
        vx: (Math.random() - 0.5) * 10, vy: -20 - Math.random() * 15,
        life: 1 + Math.random(), maxLife: 2,
        color: '#888', size: 4 + Math.random() * 3,
      });
    }
  }

  spawnCelebrationParticles(x: number, y: number) {
    const colors = ['#FF6B35', '#FFD166', '#06D6A0', '#3498DB', '#E74C3C'];
    for (let i = 0; i < 12; i++) {
      this.particles.push({
        x, y,
        vx: (Math.random() - 0.5) * 120, vy: -60 - Math.random() * 80,
        life: 1 + Math.random(), maxLife: 2,
        color: colors[Math.floor(Math.random() * colors.length)], size: 3 + Math.random() * 3,
      });
    }
  }

  // ── Player actions ─────────────────────────────────────

  handleClick(canvasX: number, canvasY: number) {
    const gx = canvasX / TILE_SIZE;
    const gy = canvasY / TILE_SIZE;

    // Check if clicked on an agent
    for (const a of this.agents) {
      const dx = a.x + 0.5 - gx;
      const dy = a.y + 0.5 - gy;
      if (Math.sqrt(dx * dx + dy * dy) < 0.8) {
        if (this.possessedId === a.id) {
          this.releaseAgent();
        } else {
          this.possessAgent(a.id);
        }
        return;
      }
    }

    // Clicked empty space: release if possessed, or do nothing
    if (this.possessedId !== null) {
      this.releaseAgent();
    }
  }

  handleKeyDown(key: string) {
    this.keysDown.add(key.toLowerCase());
    if (key.toLowerCase() === 'escape' && this.possessedId !== null) {
      this.releaseAgent();
    }
  }

  handleKeyUp(key: string) {
    this.keysDown.delete(key.toLowerCase());
  }

  possessAgent(id: number) {
    // Release current if any
    if (this.possessedId !== null) this.releaseAgent();
    const agent = this.agents.find(a => a.id === id);
    if (!agent || agent.state === AgentState.RAGE_QUITTING) return;
    this.possessedId = id;
    agent.prevState = agent.state;
    agent.state = AgentState.POSSESSED;
    agent.path = [];
    // Release station if walking to one
    if (agent.targetStation) {
      agent.targetStation.inUse = false;
      agent.targetStation.usedBy = null;
    }
  }

  releaseAgent() {
    if (this.possessedId === null) return;
    const agent = this.agents.find(a => a.id === this.possessedId);
    if (agent) {
      agent.state = AgentState.IDLE;
      agent.task = null;
      agent.targetStation = null;
      agent.idleTimer = 0;
    }
    this.possessedId = null;
  }

  playerInteract(agent: Agent) {
    const gx = Math.round(agent.x);
    const gy = Math.round(agent.y);
    const dirs: Point[] = [
      { x: agent.facingDir.x, y: agent.facingDir.y },
      { x: 0, y: -1 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 1, y: 0 },
    ];

    for (const d of dirs) {
      const sx = gx + d.x, sy = gy + d.y;
      const station = this.getStationAt({ x: sx, y: sy });
      if (!station) continue;

      // Extinguish fire
      if (station.onFire) {
        this.extinguishFire(station);
        agent.expression = 'happy';
        return;
      }

      // Pick up item from station
      if (!agent.carrying && station.item) {
        agent.carrying = station.item;
        station.item = null;
        station.progress = 0;
        station.inUse = false;
        station.usedBy = null;
        return;
      }

      // Place item on station
      if (agent.carrying && !station.item && station.type !== TileType.INGREDIENT && station.type !== TileType.WALL) {
        if (station.type === TileType.DELIVERY && agent.carrying.state === ItemState.PLATED) {
          // Deliver!
          agent.carrying = null;
          // Find the matching order
          const order = this.orders.find(o => !o.completed && !o.failed);
          if (order) this.completeOrder(order.id);
          return;
        }
        if (station.type === TileType.TRASH) {
          agent.carrying = null;
          return;
        }
        station.item = agent.carrying;
        agent.carrying = null;
        return;
      }

      // Pick up from ingredient shelf
      if (!agent.carrying && station.type === TileType.INGREDIENT) {
        const types: Array<'meat' | 'veggies' | 'grain'> = ['meat', 'veggies', 'grain'];
        agent.carrying = { type: types[Math.floor(Math.random() * types.length)], state: ItemState.RAW };
        return;
      }
    }
  }

  hireJev() {
    if (this.agents.length >= 8) return;
    this.spawnAgent(true);
    this.stats.jevsHired++;
  }

  fireJev() {
    let target: Agent | undefined;
    if (this.possessedId !== null) {
      target = this.agents.find(a => a.id === this.possessedId);
      this.possessedId = null;
    } else {
      // Fire the most idle agent
      target = this.agents.find(a => a.state === AgentState.IDLE);
      if (!target) target = this.agents[this.agents.length - 1];
    }
    if (target && this.agents.length > 1) {
      // Release station if any
      if (target.targetStation) {
        target.targetStation.inUse = false;
        target.targetStation.usedBy = null;
      }
      // Unclaim order
      if (target.task) {
        const order = this.orders.find(o => o.id === target!.task!.orderId);
        if (order) { order.claimed = false; order.claimedBy = null; }
      }
      target.state = AgentState.RAGE_QUITTING;
      target.stateTimer = 5;
      target.task = null;
      target.carrying = null;
      target.targetStation = null;
      this.stats.jevsFired++;
    }
  }

  triggerRushHour() {
    if (this.rushHour) return;
    this.rushHour = true;
    this.rushHourTimer = 30;
    // Immediately spawn several orders
    for (let i = 0; i < 4; i++) this.generateOrder();
    // Stress all agents
    for (const a of this.agents) {
      if (a.state !== AgentState.POSSESSED && a.state !== AgentState.RAGE_QUITTING) {
        a.expression = 'stressed';
      }
    }
  }

  continueShift() {
    this.shiftEnded = false;
    this.shiftDuration += 180;
  }
}
