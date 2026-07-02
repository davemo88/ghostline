// Entity presentation: low-poly machines (§14), interpolated between sim
// ticks, fog-culled from player 0's perspective, with last-known building
// ghosts, HP bars, rally lines and capture-point beacons.

import * as THREE from 'three';
import {
  type BuildingEnt,
  type BuildingType,
  CAPTURE_RADIUS,
  type Entity,
  FP,
  type Game,
  type UnitType,
  posToCell,
} from '../sim';
import { type Terrain } from './terrain';

const TEAM = [new THREE.Color('#39e0d0'), new THREE.Color('#ff8a3d')];
const NEUTRAL = new THREE.Color('#d05ce0');
const BODY = new THREE.Color('#454d57');

function unitGeometry(type: UnitType): THREE.BufferGeometry {
  switch (type) {
    case 'ronin':
      return new THREE.ConeGeometry(0.5, 1.2, 4);
    case 'oni':
      return new THREE.BoxGeometry(1.4, 1.1, 1.7);
    case 'mantis':
      return new THREE.ConeGeometry(0.34, 2.0, 5);
    case 'wasp':
      return new THREE.OctahedronGeometry(0.4);
  }
}

function buildingGeometry(type: BuildingType): THREE.BufferGeometry {
  switch (type) {
    case 'bastion':
      return new THREE.BoxGeometry(6, 3.2, 6);
    case 'extractor':
      return new THREE.CylinderGeometry(1.0, 1.5, 1.8, 6);
    case 'fabricator':
      return new THREE.BoxGeometry(4, 2.0, 4);
    case 'watchtower':
      return new THREE.CylinderGeometry(0.45, 0.8, 4.0, 6);
    case 'sensor_spire':
      return new THREE.ConeGeometry(0.5, 6.0, 4);
    case 'aegis_projector':
      return new THREE.SphereGeometry(1.6, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2);
  }
}

const HOVER: Record<UnitType, number> = { ronin: 0.6, oni: 0.55, mantis: 1.0, wasp: 1.5 };

export class EntityLayer {
  readonly group = new THREE.Group();
  private meshes = new Map<number, THREE.Mesh>();
  private bars = new Map<number, THREE.Sprite>();
  private ghosts = new Map<number, THREE.Mesh>();
  private cpRings: { ring: THREE.Mesh; beacon: THREE.Mesh }[] = [];
  private rallyLines: THREE.LineSegments;
  private terrain: Terrain;

  constructor(game: Game, terrain: Terrain) {
    this.terrain = terrain;

    // resource nodes — static emissive pads (map topology is public)
    for (const n of game.map.nodes) {
      const pad = new THREE.Mesh(
        new THREE.CylinderGeometry(1.4, 1.4, 0.2, 6),
        new THREE.MeshLambertMaterial({ color: '#2a6448', emissive: '#3fae72', emissiveIntensity: 0.5 }),
      );
      pad.position.set(n.x / FP, terrain.heightAtMu(n.x, n.y) + 0.1, n.y / FP);
      this.group.add(pad);
    }

    // capture points — ring + beacon, recolored by owner each frame
    for (const cp of game.capturePoints) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(CAPTURE_RADIUS - 0.35, CAPTURE_RADIUS, 40),
        new THREE.MeshBasicMaterial({ color: NEUTRAL, transparent: true, opacity: 0.6, side: THREE.DoubleSide }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(cp.pos.x / FP, terrain.heightAtMu(cp.pos.x, cp.pos.y) + 0.06, cp.pos.y / FP);
      const beacon = new THREE.Mesh(
        new THREE.CylinderGeometry(0.35, 0.55, 3.2, 5),
        new THREE.MeshLambertMaterial({ color: BODY, emissive: NEUTRAL, emissiveIntensity: 0.9 }),
      );
      beacon.position.set(cp.pos.x / FP, terrain.heightAtMu(cp.pos.x, cp.pos.y) + 1.6, cp.pos.y / FP);
      this.group.add(ring, beacon);
      this.cpRings.push({ ring, beacon });
    }

    this.rallyLines = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: '#39e0d0', transparent: true, opacity: 0.35 }),
    );
    this.group.add(this.rallyLines);
  }

  private makeMesh(e: Entity): THREE.Mesh {
    let mesh: THREE.Mesh;
    if (e.kind === 'unit') {
      mesh = new THREE.Mesh(
        unitGeometry(e.type),
        new THREE.MeshLambertMaterial({ color: BODY, emissive: TEAM[e.player], emissiveIntensity: 0.85 }),
      );
    } else if (e.kind === 'commander') {
      mesh = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.85),
        new THREE.MeshLambertMaterial({
          color: TEAM[e.player],
          emissive: TEAM[e.player],
          emissiveIntensity: 0.9,
          transparent: true,
        }),
      );
      mesh.scale.y = 1.5;
    } else {
      mesh = new THREE.Mesh(
        buildingGeometry(e.type),
        new THREE.MeshLambertMaterial({
          color: BODY,
          emissive: TEAM[e.player],
          emissiveIntensity: 0.35,
          transparent: true,
        }),
      );
    }
    this.group.add(mesh);
    this.meshes.set(e.id, mesh);
    return mesh;
  }

  private bar(id: number): THREE.Sprite {
    let s = this.bars.get(id);
    if (!s) {
      s = new THREE.Sprite(new THREE.SpriteMaterial({ color: '#7fff9e', depthTest: false }));
      s.renderOrder = 5;
      this.group.add(s);
      this.bars.set(id, s);
    }
    return s;
  }

  update(game: Game, prevPos: Map<number, { x: number; y: number }>, alpha: number): void {
    const seen = new Set<number>();

    for (const e of game.entities.values()) {
      // fog cull: enemy entities only when their cell is visible (and not cloaked)
      if (e.player === 1 && !game.canTarget(0, e)) continue;
      seen.add(e.id);
      const mesh = this.meshes.get(e.id) ?? this.makeMesh(e);

      const prev = prevPos.get(e.id) ?? e.pos;
      const mx = prev.x + (e.pos.x - prev.x) * alpha;
      const my = prev.y + (e.pos.y - prev.y) * alpha;
      const gy = this.terrain.heightAtMu(mx, my);
      const x = mx / FP;
      const z = my / FP;

      const mat = mesh.material as THREE.MeshLambertMaterial;
      if (e.kind === 'unit') {
        mesh.position.set(x, gy + HOVER[e.type], z);
        if (e.type === 'wasp') mesh.rotation.y += 0.05;
      } else if (e.kind === 'commander') {
        mesh.position.set(x, gy + 1.3, z);
        mesh.rotation.y += 0.01;
        mat.opacity = game.isCommanderCloaked(e) ? 0.35 : 1.0;
      } else {
        mesh.position.set(x, gy + this.buildingLift(e.type), z);
        // blueprint / under construction: wireframe look via opacity
        mat.opacity = e.done ? 1.0 : 0.35;
        mat.wireframe = !e.done;
      }

      // HP bar when damaged
      if (e.hp < e.maxHp) {
        const s = this.bar(e.id);
        const frac = Math.max(0, e.hp / e.maxHp);
        s.position.set(x, mesh.position.y + 2.2, z);
        s.scale.set(2.2 * frac, 0.22, 1);
        (s.material as THREE.SpriteMaterial).color.setHSL(frac * 0.33, 0.9, 0.55);
        s.visible = true;
      } else {
        const s = this.bars.get(e.id);
        if (s) s.visible = false;
      }
    }

    // drop meshes for dead / re-fogged entities
    for (const [id, mesh] of this.meshes) {
      if (!seen.has(id)) {
        this.group.remove(mesh);
        mesh.geometry.dispose();
        this.meshes.delete(id);
        const s = this.bars.get(id);
        if (s) {
          this.group.remove(s);
          this.bars.delete(id);
        }
      }
    }

    this.updateGhosts(game);
    this.updateCapturePoints(game);
    this.updateRallyLines(game);
  }

  private buildingLift(type: BuildingType): number {
    switch (type) {
      case 'bastion':
        return 1.6;
      case 'fabricator':
        return 1.0;
      case 'extractor':
        return 0.9;
      case 'watchtower':
        return 2.0;
      case 'sensor_spire':
        return 3.0;
      case 'aegis_projector':
        return 0.1;
    }
  }

  /** Last-known enemy buildings render as glitchy wireframe ghosts (§14). */
  private updateGhosts(game: Game): void {
    const want = new Set<number>();
    for (const [id, lk] of game.players[0].lastKnown) {
      const { cx, cy } = posToCell(lk.pos);
      if (this.terrain.isVisible(cx, cy)) continue; // live view supersedes ghost
      want.add(id);
      let g = this.ghosts.get(id);
      if (!g) {
        g = new THREE.Mesh(
          buildingGeometry(lk.type),
          new THREE.MeshBasicMaterial({ color: TEAM[1], wireframe: true, transparent: true, opacity: 0.4 }),
        );
        g.position.set(
          lk.pos.x / FP,
          this.terrain.heightAtMu(lk.pos.x, lk.pos.y) + this.buildingLift(lk.type),
          lk.pos.y / FP,
        );
        this.group.add(g);
        this.ghosts.set(id, g);
      }
    }
    for (const [id, g] of this.ghosts) {
      if (!want.has(id)) {
        this.group.remove(g);
        g.geometry.dispose();
        this.ghosts.delete(id);
      }
    }
  }

  private updateCapturePoints(game: Game): void {
    game.capturePoints.forEach((cp, i) => {
      const color = cp.owner === -1 ? NEUTRAL : TEAM[cp.owner];
      ((this.cpRings[i].ring as THREE.Mesh).material as THREE.MeshBasicMaterial).color.copy(color);
      ((this.cpRings[i].beacon as THREE.Mesh).material as THREE.MeshLambertMaterial).emissive.copy(color);
    });
  }

  private updateRallyLines(game: Game): void {
    const verts: number[] = [];
    for (const b of game.buildings(0)) {
      if (b.type !== 'fabricator' || !b.done) continue;
      const y1 = this.terrain.heightAtMu(b.pos.x, b.pos.y) + 1.2;
      const y2 = this.terrain.heightAtMu(b.rally.x, b.rally.y) + 0.4;
      verts.push(b.pos.x / FP, y1, b.pos.y / FP, b.rally.x / FP, y2, b.rally.y / FP);
    }
    this.rallyLines.geometry.dispose();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    this.rallyLines.geometry = geo;
  }

  /** Building under the pointer (own buildings only), for panel opening. */
  pick(raycaster: THREE.Raycaster, game: Game): BuildingEnt | null {
    const hits = raycaster.intersectObjects([...this.meshes.values()]);
    for (const hit of hits) {
      for (const [id, mesh] of this.meshes) {
        if (mesh === hit.object) {
          const e = game.entities.get(id);
          if (e && e.kind === 'building' && e.player === 0) return e;
        }
      }
    }
    return null;
  }
}
