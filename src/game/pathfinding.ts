import { Point, GRID_W, GRID_H } from './types';

interface Node {
  x: number;
  y: number;
  g: number;
  h: number;
  f: number;
  parent: Node | null;
}

function heuristic(a: Point, b: Point): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

const DIRS: Point[] = [
  { x: 0, y: -1 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 1, y: 0 },
];

export function findPath(
  start: Point,
  end: Point,
  isWalkable: (x: number, y: number) => boolean,
  agentPositions?: Point[]
): Point[] {
  if (start.x === end.x && start.y === end.y) return [end];
  if (!isWalkable(end.x, end.y)) return [];

  const open: Node[] = [];
  const closed = new Set<string>();
  const key = (x: number, y: number) => `${x},${y}`;

  const agentSet = new Set<string>();
  if (agentPositions) {
    for (const p of agentPositions) {
      if (!(p.x === end.x && p.y === end.y)) {
        agentSet.add(key(p.x, p.y));
      }
    }
  }

  const startNode: Node = {
    x: start.x, y: start.y,
    g: 0, h: heuristic(start, end), f: heuristic(start, end),
    parent: null,
  };
  open.push(startNode);

  let iterations = 0;
  const maxIterations = 500;

  while (open.length > 0 && iterations < maxIterations) {
    iterations++;
    let bestIdx = 0;
    for (let i = 1; i < open.length; i++) {
      if (open[i].f < open[bestIdx].f) bestIdx = i;
    }
    const current = open.splice(bestIdx, 1)[0];
    const ck = key(current.x, current.y);

    if (current.x === end.x && current.y === end.y) {
      const path: Point[] = [];
      let node: Node | null = current;
      while (node) {
        path.unshift({ x: node.x, y: node.y });
        node = node.parent;
      }
      return path;
    }

    closed.add(ck);

    for (const dir of DIRS) {
      const nx = current.x + dir.x;
      const ny = current.y + dir.y;
      const nk = key(nx, ny);

      if (nx < 0 || nx >= GRID_W || ny < 0 || ny >= GRID_H) continue;
      if (closed.has(nk)) continue;
      if (!isWalkable(nx, ny)) continue;

      const g = current.g + 1 + (agentSet.has(nk) ? 3 : 0);
      const h = heuristic({ x: nx, y: ny }, end);
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
