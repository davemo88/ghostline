// Terrain mesh: one non-indexed geometry — a top quad per cell at its
// elevation plus vertical skirts along cliff edges. Flat-shaded, vertex
// colors carry both the material palette (§14) and the fog of war (§11):
// unexplored cells render near-black with faint relief, explored-but-unseen
// dimmed, visible at full brightness. Fog updates rewrite the color buffer
// (cheap: one Float32Array pass on the 0.5 s vision cadence).

import * as THREE from 'three';
import { FP, type GameMap, cellIndex } from '../sim';

export const ELEV_H = 2.4; // world-units of height per elevation level

const PALETTE = {
  elev: [
    [0.15, 0.17, 0.19],
    [0.21, 0.24, 0.27],
    [0.28, 0.31, 0.35],
  ],
  cliff: [0.11, 0.12, 0.14],
  rampTint: [0.045, 0.04, 0.02],
  slowTint: [-0.01, 0.0, 0.07],
};

const FOG_UNSEEN = 0.16;
const FOG_EXPLORED = 0.5;

export class Terrain {
  readonly mesh: THREE.Mesh;
  readonly map: GameMap;
  private base: Float32Array; // unlit palette colors
  private colors: THREE.BufferAttribute;
  private cellRange: Int32Array; // per cell: [startVertex, vertexCount]
  private explored: Uint8Array;
  private lastVisible: Uint8Array;

  constructor(map: GameMap) {
    this.map = map;
    this.explored = new Uint8Array(map.size * map.size);
    this.lastVisible = new Uint8Array(map.size * map.size);
    this.cellRange = new Int32Array(map.size * map.size * 2);

    const pos: number[] = [];
    const col: number[] = [];

    const h = (cx: number, cy: number): number =>
      cx < 0 || cy < 0 || cx >= map.size || cy >= map.size
        ? 0
        : map.elevation[cellIndex(map, cx, cy)] * ELEV_H;

    const pushQuad = (
      a: [number, number, number],
      b: [number, number, number],
      c: [number, number, number],
      d: [number, number, number],
      color: [number, number, number],
    ): void => {
      // two tris: a-b-c, a-c-d
      pos.push(...a, ...b, ...c, ...a, ...c, ...d);
      for (let i = 0; i < 6; i++) col.push(...color);
    };

    for (let cy = 0; cy < map.size; cy++) {
      for (let cx = 0; cx < map.size; cx++) {
        const idx = cellIndex(map, cx, cy);
        const start = pos.length / 3;
        const e = map.elevation[idx];
        const y = e * ELEV_H;

        const c: [number, number, number] = [...PALETTE.elev[e]] as [number, number, number];
        if (map.ramp[idx]) {
          c[0] += PALETTE.rampTint[0];
          c[1] += PALETTE.rampTint[1];
          c[2] += PALETTE.rampTint[2];
        }
        if (map.slow[idx]) {
          c[0] += PALETTE.slowTint[0];
          c[2] += PALETTE.slowTint[2];
        }
        const checker = (cx + cy) % 2 === 0 ? 1.0 : 0.94;
        const cc: [number, number, number] = [c[0] * checker, c[1] * checker, c[2] * checker];

        // top face (y up; sim y maps to world z)
        pushQuad([cx, y, cy], [cx, y, cy + 1], [cx + 1, y, cy + 1], [cx + 1, y, cy], cc);

        // skirts where this cell is higher than a neighbor
        const cliff: [number, number, number] = [...PALETTE.cliff] as [number, number, number];
        const hw = h(cx - 1, cy);
        if (hw < y) pushQuad([cx, y, cy], [cx, hw, cy], [cx, hw, cy + 1], [cx, y, cy + 1], cliff);
        const he = h(cx + 1, cy);
        if (he < y) pushQuad([cx + 1, y, cy + 1], [cx + 1, he, cy + 1], [cx + 1, he, cy], [cx + 1, y, cy], cliff);
        const hn = h(cx, cy - 1);
        if (hn < y) pushQuad([cx + 1, y, cy], [cx + 1, hn, cy], [cx, hn, cy], [cx, y, cy], cliff);
        const hs = h(cx, cy + 1);
        if (hs < y) pushQuad([cx, y, cy + 1], [cx, hs, cy + 1], [cx + 1, hs, cy + 1], [cx + 1, y, cy + 1], cliff);

        this.cellRange[idx * 2] = start;
        this.cellRange[idx * 2 + 1] = pos.length / 3 - start;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    this.base = new Float32Array(col);
    // start fully fogged
    const fogged = new Float32Array(this.base.length);
    for (let i = 0; i < fogged.length; i++) fogged[i] = this.base[i] * FOG_UNSEEN;
    this.colors = new THREE.BufferAttribute(fogged, 3);
    geo.setAttribute('color', this.colors);
    geo.computeVertexNormals();

    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.mesh = new THREE.Mesh(geo, mat);
  }

  /** Re-shade for the given visibility grid (player 0's view). */
  updateFog(visible: Uint8Array): void {
    const arr = this.colors.array as Float32Array;
    for (let idx = 0; idx < visible.length; idx++) {
      const vis = visible[idx];
      if (vis) this.explored[idx] = 1;
      const f = vis ? 1.0 : this.explored[idx] ? FOG_EXPLORED : FOG_UNSEEN;
      const start = this.cellRange[idx * 2] * 3;
      const count = this.cellRange[idx * 2 + 1] * 3;
      for (let i = 0; i < count; i++) arr[start + i] = this.base[start + i] * f;
    }
    this.lastVisible.set(visible);
    this.colors.needsUpdate = true;
  }

  isVisible(cx: number, cy: number): boolean {
    return this.lastVisible[cellIndex(this.map, cx, cy)] === 1;
  }

  isExplored(cx: number, cy: number): boolean {
    return this.explored[cellIndex(this.map, cx, cy)] === 1;
  }

  /** Ground height (world y) at a sim position (mu). */
  heightAtMu(x: number, y: number): number {
    const cx = Math.min(this.map.size - 1, Math.max(0, Math.floor(x / FP)));
    const cy = Math.min(this.map.size - 1, Math.max(0, Math.floor(y / FP)));
    return this.map.elevation[cellIndex(this.map, cx, cy)] * ELEV_H;
  }
}
