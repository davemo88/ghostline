// Grid A* (8-directional) over the terrain + a dynamic blocked overlay
// (building footprints). Deterministic: fixed neighbor order, integer costs,
// ties broken by insertion order via a stable binary heap.

import { canStep, cellIndex, inBounds, type GameMap } from './map';

const CARDINAL_COST = 10;
const DIAGONAL_COST = 14;
const MAX_EXPANDED = 30000;

const DIRS: [number, number, number][] = [
  [1, 0, CARDINAL_COST],
  [-1, 0, CARDINAL_COST],
  [0, 1, CARDINAL_COST],
  [0, -1, CARDINAL_COST],
  [1, 1, DIAGONAL_COST],
  [1, -1, DIAGONAL_COST],
  [-1, 1, DIAGONAL_COST],
  [-1, -1, DIAGONAL_COST],
];

class Heap {
  private keys: number[] = [];
  private vals: number[] = [];
  private seqs: number[] = [];
  private seq = 0;

  get size(): number {
    return this.vals.length;
  }

  push(key: number, val: number): void {
    this.keys.push(key);
    this.vals.push(val);
    this.seqs.push(this.seq++);
    let i = this.vals.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.less(i, p)) {
        this.swap(i, p);
        i = p;
      } else break;
    }
  }

  pop(): number {
    const top = this.vals[0];
    const last = this.vals.length - 1;
    this.swap(0, last);
    this.keys.pop();
    this.vals.pop();
    this.seqs.pop();
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < this.vals.length && this.less(l, m)) m = l;
      if (r < this.vals.length && this.less(r, m)) m = r;
      if (m === i) break;
      this.swap(i, m);
      i = m;
    }
    return top;
  }

  private less(a: number, b: number): boolean {
    if (this.keys[a] !== this.keys[b]) return this.keys[a] < this.keys[b];
    return this.seqs[a] < this.seqs[b];
  }

  private swap(a: number, b: number): void {
    [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
    [this.vals[a], this.vals[b]] = [this.vals[b], this.vals[a]];
    [this.seqs[a], this.seqs[b]] = [this.seqs[b], this.seqs[a]];
  }
}

function heuristic(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  const lo = Math.min(dx, dy);
  return DIAGONAL_COST * lo + CARDINAL_COST * (Math.max(dx, dy) - lo);
}

/**
 * A* from (sx,sy) to (gx,gy) in cell coords. `blocked` marks impassable cells
 * (building footprints). The start cell is always allowed (an entity may be
 * standing where a building just went up — it can walk out).
 *
 * Returns a list of cells (excluding start, including goal), or the path to
 * the reachable cell nearest the goal if the goal itself is unreachable.
 * Returns [] if no move is possible at all.
 */
export function findPath(
  map: GameMap,
  blocked: Uint8Array,
  sx: number,
  sy: number,
  gx: number,
  gy: number,
): { cx: number; cy: number }[] {
  const size = map.size;
  if (!inBounds(map, gx, gy)) return [];
  const start = sy * size + sx;
  const goal = gy * size + gx;
  if (start === goal) return [];

  const g = new Map<number, number>();
  const parent = new Map<number, number>();
  const open = new Heap();
  g.set(start, 0);
  open.push(heuristic(sx, sy, gx, gy), start);

  let bestIdx = start;
  let bestH = heuristic(sx, sy, gx, gy);
  let expanded = 0;
  const closed = new Set<number>();

  while (open.size > 0 && expanded < MAX_EXPANDED) {
    const cur = open.pop();
    if (closed.has(cur)) continue;
    closed.add(cur);
    expanded++;
    if (cur === goal) {
      bestIdx = goal;
      break;
    }
    const cx = cur % size;
    const cy = (cur - cx) / size;
    const h = heuristic(cx, cy, gx, gy);
    if (h < bestH) {
      bestH = h;
      bestIdx = cur;
    }
    const gCur = g.get(cur)!;
    for (const [dx, dy, cost] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!inBounds(map, nx, ny)) continue;
      const nIdx = ny * size + nx;
      if (blocked[nIdx]) continue;
      if (!canStep(map, cur, nIdx)) continue;
      // Diagonal moves must not cut a blocked/cliff corner.
      if (dx !== 0 && dy !== 0) {
        const a = cellIndex(map, cx + dx, cy);
        const b = cellIndex(map, cx, cy + dy);
        if (blocked[a] || blocked[b]) continue;
        if (!canStep(map, cur, a) || !canStep(map, cur, b)) continue;
      }
      const nG = gCur + cost;
      const old = g.get(nIdx);
      if (old === undefined || nG < old) {
        g.set(nIdx, nG);
        parent.set(nIdx, cur);
        open.push(nG + heuristic(nx, ny, gx, gy), nIdx);
      }
    }
  }

  if (bestIdx === start) return [];
  const cells: { cx: number; cy: number }[] = [];
  let cur = bestIdx;
  while (cur !== start) {
    const cx = cur % size;
    cells.push({ cx, cy: (cur - cx) / size });
    cur = parent.get(cur)!;
  }
  cells.reverse();
  return cells;
}
