// Map model + the launch map "Junction 9" (DESIGN_2.md §10).
//
// Terrain is a 1u-cell grid. Three elevation levels (0 valley, 1 plateau,
// 2 base highground). Cliffs are implicit: moving between adjacent cells is
// legal only at equal elevation, or across a ramp cell with an elevation
// difference of at most 1. Ramp corridors are painted with a rounded linear
// elevation gradient so they read 2→1→0 along their length.

import { FP, MAP_SIZE } from './constants';
import type { Vec } from './math';

export interface CapturePointDef {
  id: string;
  pos: Vec; // mu
}

export interface PlayerSpawn {
  bastion: Vec; // mu, building center
  commander: Vec; // mu
}

export interface GameMap {
  size: number; // cells per side
  elevation: Uint8Array;
  ramp: Uint8Array;
  slow: Uint8Array;
  nodes: Vec[]; // resource node centers, mu
  capturePoints: CapturePointDef[];
  spawns: [PlayerSpawn, PlayerSpawn];
}

export function cellIndex(map: GameMap, cx: number, cy: number): number {
  return cy * map.size + cx;
}

export function posToCell(p: Vec): { cx: number; cy: number } {
  return { cx: Math.floor(p.x / FP), cy: Math.floor(p.y / FP) };
}

export function cellCenter(cx: number, cy: number): Vec {
  return { x: cx * FP + FP / 2, y: cy * FP + FP / 2 };
}

export function inBounds(map: GameMap, cx: number, cy: number): boolean {
  return cx >= 0 && cy >= 0 && cx < map.size && cy < map.size;
}

export function elevationAt(map: GameMap, p: Vec): number {
  const { cx, cy } = posToCell(p);
  return map.elevation[cellIndex(map, cx, cy)];
}

/** May a ground entity step between two adjacent cells? */
export function canStep(map: GameMap, fromIdx: number, toIdx: number): boolean {
  const ea = map.elevation[fromIdx];
  const eb = map.elevation[toIdx];
  if (ea === eb) return true;
  if (map.ramp[fromIdx] || map.ramp[toIdx]) return Math.abs(ea - eb) <= 1;
  return false;
}

// ---------------------------------------------------------------------------
// Junction 9
// ---------------------------------------------------------------------------

interface Circle { cx: number; cy: number; r: number; elev: number }

// Ramp rectangle with a linear elevation gradient along one axis.
interface RampRect {
  x0: number; x1: number; y0: number; y1: number; // world units, inclusive of x0/y0, exclusive of x1/y1
  axis: 'x' | 'y';
  from: number; // elevation at axis start (x0 or y0)
  to: number; // elevation at axis end
}

const PLATEAUS: Circle[] = [
  { cx: 25, cy: 25, r: 27, elev: 2 }, // main base highground
  { cx: 30, cy: 150, r: 20, elev: 1 }, // flank plateau
];

const RAMPS: RampRect[] = [
  // North ramp: base highground down toward the west flank route.
  { x0: 20, x1: 29, y0: 48, y1: 65, axis: 'y', from: 2, to: 0 },
  // East ramp: base highground down toward the east flank route.
  { x0: 48, x1: 65, y0: 20, y1: 29, axis: 'x', from: 2, to: 0 },
  // Flank plateau south entry (from own base side).
  { x0: 26, x1: 35, y0: 126, y1: 141, axis: 'y', from: 0, to: 1 },
  // Flank plateau east exit (toward map center / enemy side).
  { x0: 46, x1: 61, y0: 146, y1: 155, axis: 'x', from: 1, to: 0 },
];

// Main diagonal ramp: |x - y| <= 5, (x + y) in [80, 112], elevation 2 -> 0.
const MAIN_RAMP = { halfWidth: 5, sumLo: 80, sumHi: 112 };

const SLOW_ZONE = { cx: 90, cy: 90, r: 18 };

// P0-side features; everything is mirrored through the map center.
const NODES_P0: [number, number][] = [
  [33, 17], // in-base node (highground)
  [55, 55], // natural, at main ramp exit
  [78, 102], // contested center node
];

const FLANK_POINT: [number, number] = [30, 150];
const CENTER_POINT: [number, number] = [90, 90];

const BASTION_P0: [number, number] = [24, 24];
const COMMANDER_P0: [number, number] = [29, 30];

function mirror(px: number, py: number): [number, number] {
  return [MAP_SIZE - px, MAP_SIZE - py];
}

function evalFeatures(px: number, py: number): { elev: number; ramp: boolean; slow: boolean } {
  let elev = 0;
  let ramp = false;
  let slow = false;

  for (const c of PLATEAUS) {
    const dx = px - c.cx;
    const dy = py - c.cy;
    if (dx * dx + dy * dy <= c.r * c.r) elev = Math.max(elev, c.elev);
  }

  const sum = px + py;
  if (Math.abs(px - py) <= MAIN_RAMP.halfWidth && sum >= MAIN_RAMP.sumLo && sum <= MAIN_RAMP.sumHi) {
    ramp = true;
    elev = Math.round((2 * (MAIN_RAMP.sumHi - sum)) / (MAIN_RAMP.sumHi - MAIN_RAMP.sumLo));
  }

  for (const r of RAMPS) {
    if (px >= r.x0 && px < r.x1 && py >= r.y0 && py < r.y1) {
      ramp = true;
      const t = r.axis === 'x' ? (px - r.x0) / (r.x1 - r.x0) : (py - r.y0) / (r.y1 - r.y0);
      elev = Math.round(r.from + (r.to - r.from) * t);
    }
  }

  const sdx = px - SLOW_ZONE.cx;
  const sdy = py - SLOW_ZONE.cy;
  if (sdx * sdx + sdy * sdy <= SLOW_ZONE.r * SLOW_ZONE.r) slow = true;

  return { elev, ramp, slow };
}

export function junction9(): GameMap {
  const size = MAP_SIZE;
  const elevation = new Uint8Array(size * size);
  const ramp = new Uint8Array(size * size);
  const slow = new Uint8Array(size * size);

  for (let cy = 0; cy < size; cy++) {
    for (let cx = 0; cx < size; cx++) {
      const px = cx + 0.5;
      const py = cy + 0.5;
      const [mx, my] = mirror(px, py);
      const a = evalFeatures(px, py);
      const b = evalFeatures(mx, my);
      // Point-symmetric union of P0-side features. Ramps win elevation so
      // gradients cut through plateau edges.
      const idx = cy * size + cx;
      const pick = a.ramp || (!b.ramp && a.elev >= b.elev) ? a : b;
      elevation[idx] = pick.elev;
      ramp[idx] = a.ramp || b.ramp ? 1 : 0;
      slow[idx] = a.slow || b.slow ? 1 : 0;
    }
  }

  const toMu = ([x, y]: [number, number]): Vec => ({ x: x * FP, y: y * FP });
  // Nodes sit on cell centers so the 3x3 extractor footprint aligns to the grid.
  const toMuCenter = ([x, y]: [number, number]): Vec => ({
    x: x * FP + FP / 2,
    y: y * FP + FP / 2,
  });

  const nodes: Vec[] = [];
  for (const n of NODES_P0) {
    nodes.push(toMuCenter(n));
    const [mx, my] = mirror(n[0] + 0.5, n[1] + 0.5);
    nodes.push({ x: Math.round(mx * FP), y: Math.round(my * FP) });
  }

  const capturePoints: CapturePointDef[] = [
    { id: 'center', pos: toMu(CENTER_POINT) },
    { id: 'west', pos: toMu(FLANK_POINT) },
    { id: 'east', pos: toMu(mirror(FLANK_POINT[0], FLANK_POINT[1])) },
  ];

  const spawns: [PlayerSpawn, PlayerSpawn] = [
    { bastion: toMu(BASTION_P0), commander: toMu(COMMANDER_P0) },
    {
      bastion: toMu(mirror(BASTION_P0[0], BASTION_P0[1])),
      commander: toMu(mirror(COMMANDER_P0[0], COMMANDER_P0[1])),
    },
  ];

  return { size, elevation, ramp, slow, nodes, capturePoints, spawns };
}
