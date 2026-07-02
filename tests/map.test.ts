import { describe, expect, it } from 'vitest';
import { junction9, cellIndex, posToCell } from '../src/sim/map';
import { findPath } from '../src/sim/path';
import { FP, MAP_SIZE } from '../src/sim/constants';

describe('junction9', () => {
  const map = junction9();

  it('is the right size', () => {
    expect(map.size).toBe(MAP_SIZE);
    expect(map.elevation.length).toBe(MAP_SIZE * MAP_SIZE);
  });

  it('is point-symmetric in elevation and slow zones', () => {
    for (let cy = 0; cy < map.size; cy++) {
      for (let cx = 0; cx < map.size; cx++) {
        const a = cellIndex(map, cx, cy);
        const b = cellIndex(map, map.size - 1 - cx, map.size - 1 - cy);
        expect(map.elevation[a]).toBe(map.elevation[b]);
        expect(map.slow[a]).toBe(map.slow[b]);
        expect(map.ramp[a]).toBe(map.ramp[b]);
      }
    }
  });

  it('has 6 nodes and 3 capture points', () => {
    expect(map.nodes.length).toBe(6);
    expect(map.capturePoints.length).toBe(3);
  });

  it('bastions sit on flat highground', () => {
    for (const spawn of map.spawns) {
      const { cx, cy } = posToCell(spawn.bastion);
      for (let dy = -3; dy < 3; dy++) {
        for (let dx = -3; dx < 3; dx++) {
          expect(map.elevation[cellIndex(map, cx + dx, cy + dy)]).toBe(2);
        }
      }
    }
  });

  it('bases are mutually reachable (main route)', () => {
    const blocked = new Uint8Array(map.size * map.size);
    const a = posToCell(map.spawns[0].commander);
    const b = posToCell(map.spawns[1].commander);
    const path = findPath(map, blocked, a.cx, a.cy, b.cx, b.cy);
    expect(path.length).toBeGreaterThan(100);
    const last = path[path.length - 1];
    expect(last.cx).toBe(b.cx);
    expect(last.cy).toBe(b.cy);
  });

  it('flank capture points are reachable from both bases', () => {
    const blocked = new Uint8Array(map.size * map.size);
    for (const cp of map.capturePoints) {
      const goal = posToCell(cp.pos);
      for (const spawn of map.spawns) {
        const start = posToCell(spawn.commander);
        const path = findPath(map, blocked, start.cx, start.cy, goal.cx, goal.cy);
        const last = path[path.length - 1];
        expect(last.cx).toBe(goal.cx);
        expect(last.cy).toBe(goal.cy);
      }
    }
  });

  it('every resource node is reachable and on flat ground', () => {
    const blocked = new Uint8Array(map.size * map.size);
    const start = posToCell(map.spawns[0].commander);
    for (const n of map.nodes) {
      const goal = posToCell(n);
      const elev = map.elevation[cellIndex(map, goal.cx, goal.cy)];
      // 3x3 extractor footprint must be flat
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          expect(map.elevation[cellIndex(map, goal.cx + dx, goal.cy + dy)]).toBe(elev);
        }
      }
      const path = findPath(map, blocked, start.cx, start.cy, goal.cx, goal.cy);
      const last = path[path.length - 1];
      expect(last.cx).toBe(goal.cx);
      expect(last.cy).toBe(goal.cy);
    }
  });

  it('cliffs block: straight line from valley onto base plateau requires a ramp detour', () => {
    const blocked = new Uint8Array(map.size * map.size);
    // From directly north of P0's plateau (valley) to the bastion: the direct
    // line crosses a cliff, so the path must be much longer than the crow flies.
    const start = { cx: 25, cy: 70 };
    expect(map.elevation[cellIndex(map, start.cx, start.cy)]).toBe(0);
    const goal = posToCell(map.spawns[0].bastion);
    const path = findPath(map, blocked, start.cx, start.cy, goal.cx, goal.cy);
    expect(path.length).toBeGreaterThan(0);
    // Path must pass through at least one ramp cell.
    const usesRamp = path.some((c) => map.ramp[cellIndex(map, c.cx, c.cy)] === 1);
    expect(usesRamp).toBe(true);
  });

  it('slow zone covers the center point', () => {
    const { cx, cy } = posToCell(map.capturePoints[0].pos);
    expect(map.slow[cellIndex(map, cx, cy)]).toBe(1);
  });
});

describe('nodes vs FP', () => {
  it('node positions are cell-centered so extractors snap onto them', () => {
    const map = junction9();
    for (const n of map.nodes) {
      expect((n.x - FP / 2) % FP).toBe(0);
      expect((n.y - FP / 2) % FP).toBe(0);
    }
  });
});
