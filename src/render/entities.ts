// Entity presentation: low-poly machines (§14), interpolated between sim
// ticks, fog-culled from player 0's perspective, with last-known building
// ghosts, HP bars, rally lines and capture-point beacons.

import * as THREE from 'three';
import {
  type AttackEvent,
  BUILDING_STATS,
  type BuildingEnt,
  type BuildingType,
  CAPTURE_RADIUS,
  type CommanderEnt,
  type Entity,
  FP,
  type Game,
  type UnitType,
  posToCell,
} from '../sim';
import { type Terrain } from './terrain';
import { VISUAL_TUNING } from '../tuning';

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
    case 'kumo':
      return new THREE.BoxGeometry(0.9, 0.5, 1.2); // unused — kumo builds a rigged group
  }
}

/**
 * Hit-flash helper: boost emissive on a mesh or every Lambert mesh in a group,
 * or restore each material's own baseline (userData.baseEmissive, default 0.85).
 */
function setEmissive(obj: THREE.Object3D, boost: number | null): void {
  obj.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      const m = o.material as THREE.MeshLambertMaterial;
      if (m.emissive !== undefined) {
        m.emissiveIntensity = boost ?? ((m.userData.baseEmissive as number) ?? 0.85);
      }
    }
  });
}

interface KumoRig {
  root: THREE.Group;
  legs: { hip: THREE.Group; side: number; parity: number }[];
  body: THREE.Mesh;
  head: THREE.Group;
  muzzles: THREE.Object3D[];
  yaw: number;
  phase: number;
  amp: number; // gait blend 0..1 (eases in/out of walking)
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

const HOVER: Record<UnitType, number> = { ronin: 0.6, oni: 0.55, mantis: 1.0, wasp: 1.5, kumo: 0.02 };

// shared projectile resources (one geometry, one material per team)
const SHOT_GEO = new THREE.SphereGeometry(0.16, 6, 4);
const SHOT_MAT = TEAM.map((c) => new THREE.MeshBasicMaterial({ color: c }));

export class EntityLayer {
  readonly group = new THREE.Group();
  private meshes = new Map<number, THREE.Object3D>();
  private kumoRigs = new Map<number, KumoRig>();
  private hitFlash = new Map<number, number>(); // entity id -> frames of impact glow left
  private bars = new Map<number, THREE.Sprite>();
  private progress = new Map<number, { bg: THREE.Sprite; fill: THREE.Sprite }>();
  private beams = new Map<number, THREE.Line>();
  private ghosts = new Map<number, THREE.Mesh>();
  private cpRings: { ring: THREE.Mesh; beacon: THREE.Mesh }[] = [];
  private rallyLines: THREE.LineSegments;
  private selRing: THREE.Mesh; // ring under the selected building
  private cmdrRing: THREE.Mesh; // always under your Commander
  private shots: {
    mesh: THREE.Mesh;
    from: THREE.Vector3;
    to: THREE.Vector3;
    age: number;
    life: number;
    delay: number; // frames before launch (burst spacing)
    targetId: number;
    muzzle?: THREE.Object3D; // launch from this nozzle's live world position
    impact: number; // impact flash size
  }[] = [];
  private flashes: { spr: THREE.Sprite; age: number; life: number; size: number }[] = [];
  private lastAttackTick = -1;
  private terrain: Terrain;
  private frame = 0; // presentation-only clock for pulses/flicker

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

    this.selRing = new THREE.Mesh(
      new THREE.RingGeometry(0.86, 1.0, 36),
      new THREE.MeshBasicMaterial({
        color: '#e8f6ff',
        transparent: true,
        opacity: 0.85,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    this.selRing.rotation.x = -Math.PI / 2;
    this.selRing.renderOrder = 3;
    this.selRing.visible = false;
    this.cmdrRing = new THREE.Mesh(
      new THREE.RingGeometry(0.78, 0.95, 28),
      new THREE.MeshBasicMaterial({
        color: TEAM[0],
        transparent: true,
        opacity: 0.55,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    this.cmdrRing.rotation.x = -Math.PI / 2;
    this.cmdrRing.renderOrder = 3;
    this.cmdrRing.visible = false;
    this.group.add(this.selRing, this.cmdrRing);
  }

  private makeMesh(e: Entity): THREE.Object3D {
    let mesh: THREE.Object3D;
    if (e.kind === 'unit') {
      if (e.type === 'kumo') {
        mesh = this.buildKumo(e.id, e.player);
      } else {
        mesh = new THREE.Mesh(
          unitGeometry(e.type),
          new THREE.MeshLambertMaterial({ color: BODY, emissive: TEAM[e.player], emissiveIntensity: 0.85 }),
        );
      }
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

  /** Light spider tank: hull + turret head (twin MGs) + six two-segment legs. */
  private buildKumo(id: number, player: number): THREE.Group {
    const mat = (color: THREE.ColorRepresentation = BODY, glow = 0.85): THREE.MeshLambertMaterial => {
      const m = new THREE.MeshLambertMaterial({ color, emissive: TEAM[player], emissiveIntensity: glow });
      m.userData.baseEmissive = glow; // hit-flash restores to this
      return m;
    };
    const root = new THREE.Group();

    const body = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.42, 1.25), mat());
    body.position.y = 0.78;
    root.add(body);

    // head: bright dome up front with two gunmetal MG barrels; muzzles marked for flashes
    const head = new THREE.Group();
    head.position.set(0, 1.02, 0.42);
    head.add(new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 6), mat('#8b96a5', 1.25)));
    const muzzles: THREE.Object3D[] = [];
    for (const side of [-1, 1]) {
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.06, 0.55, 5), mat('#1b1f24', 0.25));
      barrel.rotation.x = Math.PI / 2; // point along +z (facing)
      barrel.position.set(side * 0.17, 0.12, 0.3);
      head.add(barrel);
      const muzzle = new THREE.Object3D();
      muzzle.position.set(side * 0.17, 0.12, 0.6);
      head.add(muzzle);
      muzzles.push(muzzle);
    }
    root.add(head);

    // six legs, arched spider-style: upper segment out+up, lower down to the ground
    const legs: KumoRig['legs'] = [];
    for (let i = 0; i < 6; i++) {
      const side = i < 3 ? -1 : 1;
      const row = i % 3;
      const hip = new THREE.Group();
      hip.position.set(side * 0.45, 0.72, (row - 1) * 0.48);
      const upper = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.5, 0.085), mat());
      upper.position.set(side * 0.21, 0.12, 0);
      upper.rotation.z = -side * 1.05;
      hip.add(upper);
      const lower = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.95, 0.055), mat());
      lower.position.set(side * 0.5, -0.22, 0);
      lower.rotation.z = -side * 0.16;
      hip.add(lower);
      root.add(hip);
      // tripod gait: front+back of one side step with the middle of the other
      legs.push({ hip, side, parity: (row + (side === 1 ? 1 : 0)) % 2 });
    }

    this.kumoRigs.set(id, { root, legs, body, head, muzzles, yaw: 0, phase: (id % 7) * 0.9, amp: 0 });
    return root;
  }

  /** Tripod-gait walk cycle + facing; idles with a head scan. */
  private animateKumo(id: number, dx: number, dy: number): void {
    const rig = this.kumoRigs.get(id);
    if (!rig) return;
    const moving = dx !== 0 || dy !== 0;
    rig.amp += ((moving ? 1 : 0) - rig.amp) * 0.18;
    if (moving) {
      rig.phase += 0.4;
      const target = Math.atan2(dx, dy); // world x/z — sim y maps to z
      const d = target - rig.yaw;
      rig.yaw += Math.atan2(Math.sin(d), Math.cos(d)) * 0.25;
    }
    rig.root.rotation.y = rig.yaw;
    for (const leg of rig.legs) {
      const ph = rig.phase + leg.parity * Math.PI;
      leg.hip.rotation.y = 0.4 * Math.sin(ph) * rig.amp; // fore-aft swing
      leg.hip.rotation.z = -leg.side * Math.max(0, Math.cos(ph)) * 0.3 * rig.amp; // step lift
    }
    rig.body.position.y = 0.78 + 0.04 * Math.sin(2 * rig.phase) * rig.amp; // scuttle bob
    rig.head.rotation.y = 0.45 * Math.sin(this.frame * 0.045) * (1 - rig.amp); // idle scan
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

  update(game: Game, prevPos: Map<number, { x: number; y: number }>, alpha: number, selectedId: number | null = null): void {
    this.frame++;
    const seen = new Set<number>();
    this.cmdrRing.visible = false;

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

      const mat = (mesh as THREE.Mesh).material as THREE.MeshLambertMaterial;
      if (e.kind === 'unit') {
        mesh.position.set(x, gy + HOVER[e.type], z);
        if (e.type === 'wasp') mesh.rotation.y += 0.05;
        if (e.type === 'kumo') this.animateKumo(e.id, e.pos.x - prev.x, e.pos.y - prev.y);
        setEmissive(mesh, this.hitFlash.has(e.id) ? 2.6 : null); // impact glow
      } else if (e.kind === 'commander') {
        mesh.position.set(x, gy + 1.3, z);
        mat.opacity = game.isCommanderCloaked(e) ? 0.35 : 1.0;
        if (e.player === 0) {
          // your Commander is always "selected" — pulsing team-color ring
          const s = 1 + 0.08 * Math.sin(this.frame * 0.12);
          this.cmdrRing.position.set(x, gy + 0.07, z);
          this.cmdrRing.scale.set(s, s, 1);
          this.cmdrRing.visible = true;
        }
        const task = e.tasks[0];
        const target = e.channeling && task && task.kind !== 'move' ? game.entities.get(task.building) : undefined;
        if (target && target.kind === 'building' && !(target.player === 1 && !game.canTarget(0, target))) {
          // channeling build/repair: spin fast, pulse, arc a work beam to the site
          mesh.rotation.y += 0.15;
          mat.emissiveIntensity = 0.9 + 0.45 * Math.sin(this.frame * 0.4);
          this.workBeam(
            e.id,
            mesh.position,
            new THREE.Vector3(
              target.pos.x / FP,
              this.terrain.heightAtMu(target.pos.x, target.pos.y) + this.buildingLift(target.type),
              target.pos.y / FP,
            ),
            TEAM[e.player],
          );
        } else {
          mesh.rotation.y += 0.01;
          mat.emissiveIntensity = 0.9;
          this.dropBeam(e.id);
        }
        if (this.hitFlash.has(e.id)) mat.emissiveIntensity = 2.4; // impact glow
      } else {
        const lift = this.buildingLift(e.type);
        // blueprint / under construction: wireframe that rises out of the ground
        if (e.done) {
          mesh.scale.y = 1;
          mesh.position.set(x, gy + lift, z);
          mat.opacity = 1.0;
          mat.wireframe = false;
          mat.emissiveIntensity = this.hitFlash.has(e.id) ? 1.3 : 0.35; // impact glow
          this.dropProgress(e.id);
        } else {
          const frac = e.buildTicksNeeded > 0 ? Math.min(1, e.buildTicks / e.buildTicksNeeded) : 1;
          mesh.scale.y = 0.15 + 0.85 * frac;
          mesh.position.set(x, gy + lift * mesh.scale.y, z);
          mat.opacity = 0.35;
          mat.wireframe = true;
          this.progressBar(e.id, frac, x, gy + lift + 2.7, z, TEAM[e.player]);
        }
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
        mesh.traverse((o) => {
          if (o instanceof THREE.Mesh) o.geometry.dispose();
        });
        this.kumoRigs.delete(id);
        this.meshes.delete(id);
        const s = this.bars.get(id);
        if (s) {
          this.group.remove(s);
          this.bars.delete(id);
        }
        this.dropProgress(id);
        this.dropBeam(id);
      }
    }

    // selection ring under the selected building/commander, sized to footprint
    const sel = selectedId !== null ? game.entities.get(selectedId) : undefined;
    if (sel && (sel.kind === 'building' || sel.kind === 'commander')) {
      const pulse = 0.06 * Math.sin(this.frame * 0.12);
      const r = sel.kind === 'building' ? BUILDING_STATS[sel.type].footprint / 2 + 0.7 + pulse : 1.4 + pulse;
      if (sel.kind === 'commander') {
        // track the interpolated commander position (cmdrRing already follows it)
        this.selRing.position.copy(this.cmdrRing.position);
        this.selRing.position.y += 0.02;
      } else {
        this.selRing.position.set(
          sel.pos.x / FP,
          this.terrain.heightAtMu(sel.pos.x, sel.pos.y) + 0.08,
          sel.pos.y / FP,
        );
      }
      this.selRing.scale.set(r, r, 1);
      this.selRing.visible = true;
    } else {
      this.selRing.visible = false;
    }

    // attack tracers: consume the sim's per-tick attack log once per tick
    if (game.tick !== this.lastAttackTick) {
      this.lastAttackTick = game.tick;
      for (const a of game.attackLog) this.spawnShot(a);
    }
    this.animateShots();

    this.updateGhosts(game);
    this.updateCapturePoints(game);
    this.updateRallyLines(game);
  }

  private spawnShot(a: AttackEvent): void {
    // fog: show only if either endpoint is in player 0's view
    const ca = posToCell(a.from);
    const cb = posToCell(a.to);
    if (!this.terrain.isVisible(ca.cx, ca.cy) && !this.terrain.isVisible(cb.cx, cb.cy)) return;
    const muzzleH = a.attackerType === 'watchtower' ? 3.6 : 1.0;
    const from = new THREE.Vector3(
      a.from.x / FP,
      this.terrain.heightAtMu(a.from.x, a.from.y) + muzzleH,
      a.from.y / FP,
    );
    const to = new THREE.Vector3(a.to.x / FP, this.terrain.heightAtMu(a.to.x, a.to.y) + 0.9, a.to.y / FP);

    if (a.attackerType === 'kumo') {
      // twin-MG burst: alternating nozzles with slight spread (knobs in VISUAL_TUNING)
      const rounds = Math.max(1, Math.round(VISUAL_TUNING.kumoBurstRounds));
      const spacing = Math.max(1, Math.round(VISUAL_TUNING.kumoBurstSpacing));
      const rig = this.kumoRigs.get(a.attackerId);
      for (let j = 0; j < rounds; j++) {
        const spread = to.clone();
        spread.x += (Math.random() - 0.5) * 0.5;
        spread.z += (Math.random() - 0.5) * 0.5;
        const mesh = new THREE.Mesh(SHOT_GEO, SHOT_MAT[a.player]);
        mesh.visible = false; // launches when its delay runs out
        mesh.scale.set(0.45, 0.45, 1.6); // tracer streak
        this.group.add(mesh);
        this.shots.push({
          mesh,
          from: from.clone(),
          to: spread,
          age: 0,
          life: Math.max(3, Math.round(from.distanceTo(spread) / 3.2)),
          delay: j * spacing,
          targetId: a.targetId,
          muzzle: rig?.muzzles[j % 2],
          impact: 0.3,
        });
      }
      return;
    }

    const mesh = new THREE.Mesh(SHOT_GEO, SHOT_MAT[a.player]);
    mesh.position.copy(from);
    this.group.add(mesh);
    this.shots.push({
      mesh,
      from,
      to,
      age: 0,
      life: Math.max(3, Math.round(from.distanceTo(to) / 2.2)),
      delay: 0,
      targetId: a.targetId,
      impact: 0.5,
    });
  }

  private spawnFlash(pos: THREE.Vector3, life: number, size: number, color: string): void {
    const spr = new THREE.Sprite(
      new THREE.SpriteMaterial({ color, transparent: true, opacity: 0.95, depthTest: false }),
    );
    spr.position.copy(pos);
    spr.scale.set(size, size, 1);
    spr.renderOrder = 6;
    this.group.add(spr);
    this.flashes.push({ spr, age: 0, life, size });
  }

  private animateShots(): void {
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i];
      if (s.delay > 0) {
        s.delay--;
        continue;
      }
      if (!s.mesh.visible) {
        // launch: fire from the nozzle's live position with a muzzle flash
        if (s.muzzle) s.muzzle.getWorldPosition(s.from);
        this.spawnFlash(s.from, 3, 0.32, '#ffe9a0');
        s.mesh.position.copy(s.from);
        s.mesh.lookAt(s.to);
        s.mesh.visible = true;
      }
      s.age++;
      const t = s.age / s.life;
      if (t >= 1) {
        this.spawnFlash(s.to, 8, s.impact, '#fff1c2'); // impact flash
        this.hitFlash.set(s.targetId, 4); // and the target itself glows
        this.group.remove(s.mesh); // geometry/material are shared — no dispose
        this.shots.splice(i, 1);
        continue;
      }
      s.mesh.position.lerpVectors(s.from, s.to, t);
      s.mesh.position.y += Math.sin(Math.PI * t) * (s.muzzle ? 0.08 : 0.5); // MG rounds fly flat
    }
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.age++;
      const t = f.age / f.life;
      if (t >= 1) {
        this.group.remove(f.spr);
        f.spr.material.dispose();
        this.flashes.splice(i, 1);
        continue;
      }
      const sc = f.size * (0.8 + 2.2 * t);
      f.spr.scale.set(sc, sc, 1);
      f.spr.material.opacity = 0.95 * (1 - t);
    }
    for (const [id, n] of this.hitFlash) {
      if (n <= 1) this.hitFlash.delete(id);
      else this.hitFlash.set(id, n - 1);
    }
  }

  /** Construction progress bar: dark backing + team-colored fill, above the blueprint. */
  private progressBar(id: number, frac: number, x: number, y: number, z: number, color: THREE.Color): void {
    let p = this.progress.get(id);
    if (!p) {
      const bg = new THREE.Sprite(
        new THREE.SpriteMaterial({ color: '#10181f', transparent: true, opacity: 0.75, depthTest: false }),
      );
      const fill = new THREE.Sprite(new THREE.SpriteMaterial({ color, depthTest: false }));
      bg.renderOrder = 5;
      fill.renderOrder = 6;
      this.group.add(bg, fill);
      p = { bg, fill };
      this.progress.set(id, p);
    }
    p.bg.position.set(x, y, z);
    p.fill.position.set(x, y, z);
    p.bg.scale.set(2.6, 0.3, 1);
    p.fill.scale.set(Math.max(0.001, 2.4 * frac), 0.18, 1);
  }

  private dropProgress(id: number): void {
    const p = this.progress.get(id);
    if (!p) return;
    this.group.remove(p.bg, p.fill);
    this.progress.delete(id);
  }

  /** Crackling energy beam from a channeling Commander to its work site. */
  private workBeam(id: number, from: THREE.Vector3, to: THREE.Vector3, color: THREE.Color): void {
    let line = this.beams.get(id);
    if (!line) {
      line = new THREE.Line(
        new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({ color, transparent: true, depthWrite: false }),
      );
      line.renderOrder = 4;
      this.group.add(line);
      this.beams.set(id, line);
    }
    const verts: number[] = [];
    const SEG = 6;
    for (let i = 0; i <= SEG; i++) {
      const t = i / SEG;
      const j = i === 0 || i === SEG ? 0 : 0.2; // endpoints stay pinned
      verts.push(
        from.x + (to.x - from.x) * t + (Math.random() - 0.5) * j * 2,
        from.y + (to.y - from.y) * t + (Math.random() - 0.5) * j * 2,
        from.z + (to.z - from.z) * t + (Math.random() - 0.5) * j * 2,
      );
    }
    line.geometry.dispose();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    line.geometry = geo;
    (line.material as THREE.LineBasicMaterial).opacity = 0.55 + 0.35 * Math.sin(this.frame * 0.9);
  }

  private dropBeam(id: number): void {
    const line = this.beams.get(id);
    if (!line) return;
    this.group.remove(line);
    line.geometry.dispose();
    this.beams.delete(id);
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

  /** Building or Commander under the pointer (own only), for panel opening. */
  pick(raycaster: THREE.Raycaster, game: Game): BuildingEnt | CommanderEnt | null {
    const hits = raycaster.intersectObjects([...this.meshes.values()]);
    for (const hit of hits) {
      for (const [id, mesh] of this.meshes) {
        if (mesh === hit.object) {
          const e = game.entities.get(id);
          if (e && (e.kind === 'building' || e.kind === 'commander') && e.player === 0) return e;
        }
      }
    }
    return null;
  }
}
