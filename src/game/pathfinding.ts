import { Point, GRID_W, GRID_H, KITCHEN_LAYOUT, T } from './types';

// A* over the kitchen grid. Only T.FLOOR tiles are walkable. Chefs never
// stand on a station tile; instead they stand on a floor tile adjacent to it.

interface Node {
  x: number;
  y: number;
  g: number;
  h: number;
  f: number;
  parent: Node | null;
}

function heuristic(ax: number, ay: number, bx: number, by: number): number {
  return Math.abs(ax - bx) + Math.abs(ay - by);
}

const DIRS: Point[] = [
  { x: 0, y: -1 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 1, y: 0 },
];

export function tileAt(x: number, y: number): number {
  if (x < 0 || x >= GRID_W || y < 0 || y >= GRID_H) return -1;
  return KITCHEN_LAYOUT[y][x];
}

export function isFloor(x: number, y: number): boolean {
  return tileAt(x, y) === T.FLOOR;
}

// Floor tiles orthogonally adjacent to (sx,sy) — where a chef can stand to
// use the station at (sx,sy).
export function adjacentFloors(sx: number, sy: number): Point[] {
  const out: Point[] = [];
  for (const d of DIRS) {
    const nx = sx + d.x;
    const ny = sy + d.y;
    if (isFloor(nx, ny)) out.push({ x: nx, y: ny });
  }
  return out;
}

// Find a path from start (floor tile) to end (floor tile), returning tile
// waypoints INCLUDING start and end. Empty array if unreachable.
export function findPath(
  start: Point,
  end: Point,
  agentPositions?: Point[],
): Point[] {
  const sx = Math.round(start.x);
  const sy = Math.round(start.y);
  const ex = Math.round(end.x);
  const ey = Math.round(end.y);

  if (sx === ex && sy === ey) return [{ x: ex, y: ey }];
  if (!isFloor(ex, ey)) return [];

  const open: Node[] = [];
  const closed = new Set<string>();
  const key = (x: number, y: number) => `${x},${y}`;

  const agentSet = new Set<string>();
  if (agentPositions) {
    for (const p of agentPositions) {
      const px = Math.round(p.x);
      const py = Math.round(p.y);
      if (!(px === ex && py === ey)) agentSet.add(key(px, py));
    }
  }

  const startNode: Node = {
    x: sx, y: sy,
    g: 0, h: heuristic(sx, sy, ex, ey), f: heuristic(sx, sy, ex, ey),
    parent: null,
  };
  open.push(startNode);

  let iterations = 0;
  const maxIterations = 2000;

  while (open.length > 0 && iterations < maxIterations) {
    iterations++;
    let bestIdx = 0;
    for (let i = 1; i < open.length; i++) {
      if (open[i].f < open[bestIdx].f) bestIdx = i;
    }
    const current = open.splice(bestIdx, 1)[0];

    if (current.x === ex && current.y === ey) {
      const path: Point[] = [];
      let node: Node | null = current;
      while (node) {
        path.unshift({ x: node.x, y: node.y });
        node = node.parent;
      }
      return path;
    }

    closed.add(key(current.x, current.y));

    for (const dir of DIRS) {
      const nx = current.x + dir.x;
      const ny = current.y + dir.y;
      const nk = key(nx, ny);

      if (closed.has(nk)) continue;
      if (!isFloor(nx, ny)) continue;

      const g = current.g + 1 + (agentSet.has(nk) ? 3 : 0);
      const h = heuristic(nx, ny, ex, ey);
      const f = g + h;

      const existing = open.find(n => n.x === nx && n.y === ny);
      if (existing) {
        if (g < existing.g) {
          existing.g = g;
          existing.f = f;
          existing.parent = current;
        }
      } else {
        open.push({ x: nx, y: ny, g, h, f, parent: current });
      }
    }
  }

  return [];
}

// Choose the best reachable standing tile adjacent to a station, given a start.
// Returns { stand, path } or null if none reachable.
export function pathToStation(
  start: Point,
  stationX: number,
  stationY: number,
  agentPositions?: Point[],
): { stand: Point; path: Point[] } | null {
  const stands = adjacentFloors(stationX, stationY);
  let best: { stand: Point; path: Point[] } | null = null;
  for (const s of stands) {
    const path = findPath(start, s, agentPositions);
    if (path.length === 0) continue;
    if (!best || path.length < best.path.length) {
      best = { stand: s, path };
    }
  }
  return best;
}
