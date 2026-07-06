// Entity presentation: low-poly machines (§14), interpolated between sim
// ticks, fog-culled from player 0's perspective, with last-known building
// ghosts, HP bars, rally lines and capture-point beacons.

import * as THREE from 'three';
import {
  type AttackEvent,
  BUILDING_STATS,
  type BuildingEnt,
  type BuildingType,
  type BurstEvent,
  CAPTURE_RADIUS,
  type CommanderEnt,
  type Entity,
  FP,
  type Game,
  type ShellEvent,
  type ShellState,
  UNIT_STATS,
  type UnitEnt,
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
    case 'kaze':
      return new THREE.BoxGeometry(0.3, 0.5, 1.2); // unused — kaze builds a rigged group
    case 'taiko':
      return new THREE.BoxGeometry(1.1, 0.6, 1.6); // unused — taiko builds a rigged group
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
  legs: { hip: THREE.Group; side: number; parity: number; baseYaw: number }[];
  body: THREE.Mesh;
  head: THREE.Group;
  muzzles: THREE.Object3D[];
  yaw: number;
  phase: number;
  amp: number; // gait blend 0..1 (eases in/out of walking)
}

interface KazeRig {
  root: THREE.Group;
  frame: THREE.Group; // everything leans (rolls) with this
  axles: THREE.Group[]; // wheel spin
  yaw: number;
  lean: number;
}

interface TaikoRig {
  root: THREE.Group;
  turret: THREE.Group; // yaws toward the target
  barrel: THREE.Group; // pitches up with the sim's windup counter
  barrelMesh: THREE.Mesh; // slides back on recoil
  muzzle: THREE.Object3D;
  yaw: number; // hull facing
  pitch: number; // smoothed barrel elevation
  recoil: number; // barrel kickback, decays per frame
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

const HOVER: Record<UnitType, number> = { ronin: 0.6, oni: 0.55, mantis: 1.0, wasp: 1.5, kumo: 0.02, kaze: 0.02, taiko: 0.02 };

// shared projectile resources (one geometry, one material per team)
const SHOT_GEO = new THREE.SphereGeometry(0.16, 6, 4);
const SHOT_MAT = TEAM.map((c) => new THREE.MeshBasicMaterial({ color: c }));

// artillery shell + airburst
const SHELL_GEO = new THREE.SphereGeometry(0.2, 6, 4);
const SHELL_MAT = new THREE.MeshBasicMaterial({ color: '#ffd27f' });
const BURST_H = 4.0; // airburst height above the ground (world units)
const BARREL_PITCH_MIN = 0.1; // rad, stowed
const BARREL_PITCH_MAX = 1.05; // rad, fully raised

export class EntityLayer {
  readonly group = new THREE.Group();
  private meshes = new Map<number, THREE.Object3D>();
  private kumoRigs = new Map<number, KumoRig>();
  private kazeRigs = new Map<number, KazeRig>();
  private taikoRigs = new Map<number, TaikoRig>();
  private shellMeshes = new Map<ShellState, THREE.Mesh>(); // live sim shells -> arcing meshes
  private hitFlash = new Map<number, number>(); // entity id -> frames of impact glow left
  private bars = new Map<number, THREE.Sprite>();
  private progress = new Map<number, { bg: THREE.Sprite; fill: THREE.Sprite }>();
  private starveMarks = new Map<number, THREE.Sprite>(); // red pulse over starved fabricators
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
      } else if (e.type === 'kaze') {
        mesh = this.buildKaze(e.id, e.player);
      } else if (e.type === 'taiko') {
        mesh = this.buildTaiko(e.id, e.player);
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

    // head: pod slung below the hull's front lip on an articulated neck; the whole
    // group yaws around the neck pivot so the pod swings when tracking targets
    const head = new THREE.Group();
    head.position.set(0, 0.62, 0.55); // neck pivot at the front-bottom edge of the hull
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.075, 0.36, 6), mat('#1b1f24', 0.35));
    neck.position.set(0, -0.13, 0.09);
    neck.rotation.x = 0.55; // rakes down and forward
    head.add(neck);
    const pod = new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 6), mat('#8b96a5', 1.25));
    pod.position.set(0, -0.26, 0.2);
    head.add(pod);
    const muzzles: THREE.Object3D[] = [];
    for (const side of [-1, 1]) {
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.06, 0.55, 5), mat('#1b1f24', 0.25));
      barrel.rotation.x = Math.PI / 2; // point along +z (facing)
      barrel.position.set(side * 0.17, -0.18, 0.48);
      head.add(barrel);
      const muzzle = new THREE.Object3D();
      muzzle.position.set(side * 0.17, -0.18, 0.78);
      head.add(muzzle);
      muzzles.push(muzzle);
    }
    root.add(head);

    // six legs, two segments: short upper straight out from the hull parallel to the
    // ground, lower at an obtuse knee angle splaying out+down to the ground. Rest
    // yaw splays front legs forward and rear legs back (that splay is also the
    // stride's yaw limit); middle legs sit dead perpendicular.
    const legSplay = 0.35; // rad, front/rear rest yaw about y
    const kneeTilt = 0.4; // rad from vertical, keeps the knee angle obtuse
    const legs: KumoRig['legs'] = [];
    for (let i = 0; i < 6; i++) {
      const side = i < 3 ? -1 : 1;
      const row = i % 3; // 0 rear, 1 middle, 2 front
      const hip = new THREE.Group();
      hip.position.set(side * 0.45, 0.62, (row - 1) * 0.48);
      const baseYaw = -side * legSplay * (row - 1);
      hip.rotation.y = baseYaw;
      const upper = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.14, 0.14), mat());
      upper.position.set(side * 0.19, 0, 0);
      hip.add(upper);
      const lower = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.68, 0.11), mat());
      lower.position.set(side * (0.38 + 0.34 * Math.sin(kneeTilt)), -0.34 * Math.cos(kneeTilt), 0);
      lower.rotation.z = side * kneeTilt;
      hip.add(lower);
      root.add(hip);
      // tripod gait: front+back of one side step with the middle of the other
      legs.push({ hip, side, parity: (row + (side === 1 ? 1 : 0)) % 2, baseYaw });
    }

    this.kumoRigs.set(id, { root, legs, body, head, muzzles, yaw: 0, phase: (id % 7) * 0.9, amp: 0 });
    return root;
  }

  /** Skirmish bike: low frame between two wheels, tucked rider, bright tank. */
  private buildKaze(id: number, player: number): THREE.Group {
    const mat = (color: THREE.ColorRepresentation = BODY, glow = 0.85): THREE.MeshLambertMaterial => {
      const m = new THREE.MeshLambertMaterial({ color, emissive: TEAM[player], emissiveIntensity: glow });
      m.userData.baseEmissive = glow;
      return m;
    };
    const root = new THREE.Group();
    const frame = new THREE.Group(); // leans as one piece
    root.add(frame);

    const body = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.24, 1.15), mat());
    body.position.y = 0.52;
    const tank = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.18, 0.4), mat('#8b96a5', 1.25));
    tank.position.set(0, 0.68, 0.15);
    const rider = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.34, 0.42), mat('#1b1f24', 0.35));
    rider.position.set(0, 0.82, -0.15);
    rider.rotation.x = 0.35; // tucked forward
    const bars = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.05, 0.05), mat('#1b1f24', 0.35));
    bars.position.set(0, 0.76, 0.42);
    frame.add(body, tank, rider, bars);

    const axles: THREE.Group[] = [];
    for (const z of [0.55, -0.48]) {
      const axle = new THREE.Group();
      axle.position.set(0, 0.3, z);
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.09, 10), mat('#1b1f24', 0.3));
      wheel.rotation.z = Math.PI / 2; // axle along x
      axle.add(wheel);
      frame.add(axle);
      axles.push(axle);
    }

    this.kazeRigs.set(id, { root, frame, axles, yaw: 0, lean: 0 });
    return root;
  }

  /** Artillery tank: low tracked hull, turret, one oversized barrel on a rear pivot. */
  private buildTaiko(id: number, player: number): THREE.Group {
    const mat = (color: THREE.ColorRepresentation = BODY, glow = 0.85): THREE.MeshLambertMaterial => {
      const m = new THREE.MeshLambertMaterial({ color, emissive: TEAM[player], emissiveIntensity: glow });
      m.userData.baseEmissive = glow;
      return m;
    };
    const root = new THREE.Group();

    // hull between two dark track blocks
    const hull = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.4, 1.5), mat());
    hull.position.y = 0.48;
    root.add(hull);
    for (const side of [-1, 1]) {
      const track = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.34, 1.7), mat('#1b1f24', 0.3));
      track.position.set(side * 0.55, 0.24, 0);
      root.add(track);
    }

    // turret: bright block, yaws to face the target
    const turret = new THREE.Group();
    turret.position.set(0, 0.78, -0.15);
    turret.add(new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.34, 0.7), mat('#8b96a5', 1.15)));

    // barrel group pivots at the turret front; the big gun lifts before firing
    const barrel = new THREE.Group();
    barrel.position.set(0, 0.16, 0.2);
    const barrelMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, 1.7, 6), mat('#1b1f24', 0.25));
    barrelMesh.rotation.x = Math.PI / 2; // point along +z
    barrelMesh.position.z = 0.75;
    barrel.add(barrelMesh);
    const counterweight = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.22, 0.3), mat('#1b1f24', 0.35));
    counterweight.position.z = -0.2;
    barrel.add(counterweight);
    const muzzle = new THREE.Object3D();
    muzzle.position.z = 1.6;
    barrel.add(muzzle);
    barrel.rotation.x = -BARREL_PITCH_MIN;
    turret.add(barrel);
    root.add(turret);

    this.taikoRigs.set(id, { root, turret, barrel, barrelMesh, muzzle, yaw: 0, pitch: BARREL_PITCH_MIN, recoil: 0 });
    return root;
  }

  /** Hull faces the move direction; turret tracks the target; barrel pitch follows sim windup. */
  private animateTaiko(e: UnitEnt, game: Game, dx: number, dy: number): void {
    const rig = this.taikoRigs.get(e.id);
    if (!rig) return;
    if (dx !== 0 || dy !== 0) {
      const want = Math.atan2(dx, dy);
      const d = Math.atan2(Math.sin(want - rig.yaw), Math.cos(want - rig.yaw));
      rig.yaw += d * 0.12; // heavy vehicle: slow hull slew
    }
    rig.root.rotation.y = rig.yaw;

    // turret: track the live target, else eyes front
    const tgt = e.targetId ? game.entities.get(e.targetId) : undefined;
    const want = tgt ? Math.atan2(tgt.pos.x - e.pos.x, tgt.pos.y - e.pos.y) - rig.yaw : 0;
    const dt = Math.atan2(Math.sin(want - rig.turret.rotation.y), Math.cos(want - rig.turret.rotation.y));
    rig.turret.rotation.y += dt * 0.15;

    // barrel elevation is authoritative from the sim: windup 0 = stowed, full = raised
    const wt = UNIT_STATS[e.type].windupTicks ?? 1;
    const target = BARREL_PITCH_MIN + (BARREL_PITCH_MAX - BARREL_PITCH_MIN) * Math.min(1, e.windup / wt);
    rig.pitch += (target - rig.pitch) * 0.15;
    rig.barrel.rotation.x = -rig.pitch;
    rig.recoil *= 0.82;
    rig.barrelMesh.position.z = 0.75 - rig.recoil;
  }

  /** Orient to the sim heading, lean into turns, spin wheels with speed. */
  private animateKaze(e: UnitEnt): void {
    const rig = this.kazeRigs.get(e.id);
    if (!rig) return;
    const want = Math.atan2(e.heading.x, e.heading.y);
    const d = Math.atan2(Math.sin(want - rig.yaw), Math.cos(want - rig.yaw));
    rig.yaw += d * 0.35;
    rig.root.rotation.y = rig.yaw;
    // lean into the turn, harder at speed
    const maxSpd = Math.max(1, UNIT_STATS.kaze.speed * 100);
    const speedFrac = Math.min(1, e.speedMu / maxSpd);
    const targetLean = THREE.MathUtils.clamp(-d * 9 * (0.25 + speedFrac), -0.6, 0.6);
    rig.lean += (targetLean - rig.lean) * 0.2;
    rig.frame.rotation.z = rig.lean;
    for (const a of rig.axles) a.rotation.x += e.speedMu / 350; // wheel spin
  }

  /** Tripod-gait walk cycle + facing; head tracks the current target. */
  private animateKumo(e: UnitEnt, game: Game, dx: number, dy: number): void {
    const rig = this.kumoRigs.get(e.id);
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
      if (leg.baseYaw === 0) {
        leg.hip.rotation.y = 0.3 * Math.sin(ph) * rig.amp; // middle legs: symmetric fore-aft swing
      } else {
        // splayed rest pose is the yaw limit — the stride folds in from it, never past
        leg.hip.rotation.y = leg.baseYaw - Math.sign(leg.baseYaw) * 0.3 * (0.5 + 0.5 * Math.sin(ph)) * rig.amp;
      }
      leg.hip.rotation.z = leg.side * Math.max(0, Math.cos(ph)) * 0.25 * rig.amp; // step lift
    }
    rig.body.position.y = 0.78 + 0.04 * Math.sin(2 * rig.phase) * rig.amp; // scuttle bob

    // head: turrets track the live target; otherwise scan when idle, eyes front when moving
    const tgt = e.targetId ? game.entities.get(e.targetId) : undefined;
    const want = tgt
      ? Math.atan2(tgt.pos.x - e.pos.x, tgt.pos.y - e.pos.y) - rig.yaw
      : moving
        ? 0
        : 0.45 * Math.sin(this.frame * 0.045);
    const dh = Math.atan2(Math.sin(want - rig.head.rotation.y), Math.cos(want - rig.head.rotation.y));
    rig.head.rotation.y += dh * 0.25;
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
        if (e.type === 'kumo') this.animateKumo(e, game, e.pos.x - prev.x, e.pos.y - prev.y);
        if (e.type === 'kaze') this.animateKaze(e);
        if (e.type === 'taiko') this.animateTaiko(e, game, e.pos.x - prev.x, e.pos.y - prev.y);
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
          // starved fabricator: red pulse overhead until it releases again
          if (e.type === 'fabricator' && e.starved && e.player === 0) {
            let s = this.starveMarks.get(e.id);
            if (!s) {
              s = new THREE.Sprite(new THREE.SpriteMaterial({ color: '#ff5050', transparent: true, depthTest: false }));
              s.renderOrder = 6;
              this.group.add(s);
              this.starveMarks.set(e.id, s);
            }
            s.position.set(x, gy + lift + 2.6, z);
            const pulse = 0.55 + 0.45 * Math.sin(this.frame * 0.18);
            s.scale.set(0.55, 0.55, 1);
            (s.material as THREE.SpriteMaterial).opacity = pulse;
          } else {
            this.dropStarveMark(e.id);
          }
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
        this.kazeRigs.delete(id);
        this.taikoRigs.delete(id);
        this.meshes.delete(id);
        const s = this.bars.get(id);
        if (s) {
          this.group.remove(s);
          this.bars.delete(id);
        }
        this.dropProgress(id);
        this.dropStarveMark(id);
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

    // attack tracers + artillery events: consume the sim's per-tick logs once per tick
    if (game.tick !== this.lastAttackTick) {
      this.lastAttackTick = game.tick;
      for (const a of game.attackLog) this.spawnShot(a);
      for (const s of game.shellLog) this.onShellFired(s);
      for (const b of game.burstLog) this.onAirburst(b);
    }
    this.updateShells(game, alpha);
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
    // artillery attacks originate at the airburst, not a muzzle: fast flak shards down to each victim
    const arty = a.attackerType !== 'watchtower' && UNIT_STATS[a.attackerType].windupTicks !== undefined;
    const muzzleH = a.attackerType === 'watchtower' ? 3.6 : arty ? BURST_H : 1.0;
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

    const mesh = new THREE.Mesh(SHOT_GEO, arty ? SHELL_MAT : SHOT_MAT[a.player]);
    if (arty) mesh.scale.set(0.4, 0.4, 0.9);
    mesh.position.copy(from);
    this.group.add(mesh);
    this.shots.push({
      mesh,
      from,
      to,
      age: 0,
      life: arty ? Math.max(2, Math.round(from.distanceTo(to) / 6)) : Math.max(3, Math.round(from.distanceTo(to) / 2.2)),
      delay: 0,
      targetId: a.targetId,
      impact: arty ? 0.3 : 0.5,
    });
  }

  /** Muzzle flash + recoil kick on the firing taiko (the shell itself renders from game.shells). */
  private onShellFired(s: ShellEvent): void {
    const c = posToCell(s.from);
    if (!this.terrain.isVisible(c.cx, c.cy)) return;
    const rig = this.taikoRigs.get(s.attackerId);
    if (rig) {
      rig.recoil = 0.4;
      const p = new THREE.Vector3();
      rig.muzzle.getWorldPosition(p);
      this.spawnFlash(p, 5, 0.6, '#ffe9a0');
    } else {
      // firer's mesh is fog-culled: flash where the shot left the ground anyway
      this.spawnFlash(
        new THREE.Vector3(s.from.x / FP, this.terrain.heightAtMu(s.from.x, s.from.y) + 1.6, s.from.y / FP),
        5,
        0.6,
        '#ffe9a0',
      );
    }
  }

  /** Airburst: flash well above the impact point, flak streaking down into the area. */
  private onAirburst(b: BurstEvent): void {
    const c = posToCell(b.pos);
    if (!this.terrain.isVisible(c.cx, c.cy)) return;
    const gy = this.terrain.heightAtMu(b.pos.x, b.pos.y);
    const center = new THREE.Vector3(b.pos.x / FP, gy + BURST_H, b.pos.y / FP);
    this.spawnFlash(center, 10, 1.9, '#ffd9a0');
    this.spawnFlash(center, 5, 1.0, '#ffffff');
    // cosmetic flak shower: short tracers from the burst to random ground points in the splash
    const r = b.splashMu / FP;
    for (let i = 0; i < 10; i++) {
      const ang = Math.random() * Math.PI * 2;
      const rad = r * Math.sqrt(Math.random());
      const to = new THREE.Vector3(
        b.pos.x / FP + Math.cos(ang) * rad,
        gy + 0.15,
        b.pos.y / FP + Math.sin(ang) * rad,
      );
      const mesh = new THREE.Mesh(SHOT_GEO, SHELL_MAT);
      mesh.scale.set(0.3, 0.3, 0.8);
      mesh.position.copy(center);
      this.group.add(mesh);
      this.shots.push({
        mesh,
        from: center.clone(),
        to,
        age: 0,
        life: 4 + Math.floor(Math.random() * 4),
        delay: 0,
        targetId: 0, // no entity: just an impact spark where it lands
        impact: 0.18,
      });
    }
  }

  /** Arcing shell meshes driven directly by live sim projectiles — always lands in sync with the burst. */
  private updateShells(game: Game, alpha: number): void {
    const live = new Set<ShellState>(game.shells);
    for (const sh of game.shells) {
      const ca = posToCell(sh.from);
      const cb = posToCell(sh.to);
      let mesh = this.shellMeshes.get(sh);
      if (!mesh) {
        mesh = new THREE.Mesh(SHELL_GEO, SHELL_MAT);
        this.group.add(mesh);
        this.shellMeshes.set(sh, mesh);
      }
      mesh.visible = this.terrain.isVisible(ca.cx, ca.cy) || this.terrain.isVisible(cb.cx, cb.cy);
      if (!mesh.visible) continue;
      const t = Math.min(1, (sh.ticksTotal - sh.ticksLeft + alpha) / sh.ticksTotal);
      const x0 = sh.from.x / FP;
      const z0 = sh.from.y / FP;
      const x1 = sh.to.x / FP;
      const z1 = sh.to.y / FP;
      const y0 = this.terrain.heightAtMu(sh.from.x, sh.from.y) + 1.1;
      const y1 = this.terrain.heightAtMu(sh.to.x, sh.to.y) + BURST_H;
      const arc = Math.min(14, Math.max(2.5, Math.hypot(x1 - x0, z1 - z0) * 0.35));
      mesh.position.set(
        x0 + (x1 - x0) * t,
        y0 + (y1 - y0) * t + arc * 4 * t * (1 - t),
        z0 + (z1 - z0) * t,
      );
    }
    for (const [sh, mesh] of this.shellMeshes) {
      if (!live.has(sh)) {
        this.group.remove(mesh); // geometry/material shared — no dispose
        this.shellMeshes.delete(sh);
      }
    }
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

  private dropStarveMark(id: number): void {
    const s = this.starveMarks.get(id);
    if (!s) return;
    this.group.remove(s);
    s.material.dispose();
    this.starveMarks.delete(id);
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
