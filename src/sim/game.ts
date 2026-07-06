// GHOSTLINE deterministic sim core. Pure TS — no DOM, no Three.
// Fixed tick (10 Hz). All state is plain data; all randomness via seeded PRNG.

import {
  AEGIS_DAMAGE_TAKEN,
  BALLISTIC_MANTIS_RANGE,
  BALLISTIC_WATCHTOWER_RANGE,
  BLUEPRINT_HP_FRACTION,
  BUILDING_STATS,
  type Behavior,
  type BuildingType,
  CANCEL_REFUND,
  CAPTURE_AURA_RADIUS,
  CAPTURE_BASE_SECONDS,
  CAPTURE_BUFF_POOL,
  CAPTURE_MAX_RATE,
  CAPTURE_METER_MAX,
  CAPTURE_POINT_VISION,
  CAPTURE_RADIUS,
  CAPTURE_UPLINK_VISION,
  COHESION_BREAK_RANGE,
  COHESION_RADIUS,
  COHESION_SLACK,
  COMMANDER,
  COUNTER,
  type CaptureBuff,
  DRIVE_AURA_SPEED,
  FOCUSED_OPTICS_DAMAGE,
  FP,
  GRID_TAP_CAPTURE_RATE,
  GUARD_CHASE_LEASH,
  GUARD_ENGAGE_RADIUS,
  HARDENED_FRAMES_HP,
  HIGH_GROUND_DAMAGE,
  INCOME,
  KITE_CORRIDOR,
  KITE_LANE_BACKSTEP,
  NANOWEAVE_DELAY_SECONDS,
  NANOWEAVE_REGEN,
  type OverrideStance,
  SERVO_BUILD_RATE,
  SERVO_COMMANDER_SPEED,
  SHIELD_AURA_DAMAGE_TAKEN,
  SLOW_ZONE_SPEED,
  STARTING_ENERGY,
  TARGETING_AURA_DAMAGE,
  TECHS,
  TICKS_PER_SECOND,
  type TechId,
  UNIT_STATS,
  WAVE_INTERVAL,
  type UnitType,
  VEIL_STILL_SECONDS,
  VISION_INTERVAL,
} from './constants';
import { cellCenter, cellIndex, inBounds, junction9, posToCell, type GameMap } from './map';
import { clamp, dist, dist2, isqrt, pm, stepToward, within, type Vec } from './math';
import { findPath } from './path';
import { Prng } from './prng';

export type PlayerId = 0 | 1;

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

interface PathState {
  path: { cx: number; cy: number }[];
  pathIdx: number;
  pathGoal: Vec | null;
}

export interface UnitEnt extends PathState {
  kind: 'unit';
  id: number;
  player: PlayerId;
  type: UnitType;
  pos: Vec;
  hp: number; // mHP
  maxHp: number;
  sourceBuilding: number;
  rally: Vec; // inherited, refreshed from live source fabricator
  behavior: Behavior;
  targetId: number; // 0 = none
  // Vehicle state (units with stats.accel; inert for walkers):
  heading: Vec; // unit vector x1000
  speedMu: number; // current speed, mu/tick
  // Artillery state (units with stats.windupTicks; inert otherwise):
  windup: number; // barrel-raise progress in ticks; must reach windupTicks to fire
}

export type InteractAction =
  | { kind: 'set_rally'; pos: Vec }
  | { kind: 'set_behavior'; behavior: Behavior }
  | { kind: 'set_production'; unit?: UnitType; on?: boolean }
  | { kind: 'research'; tech: TechId }
  | { kind: 'global_override'; stance: OverrideStance };

export type CommanderTask =
  | { kind: 'move'; pos: Vec }
  | { kind: 'build'; building: number }
  | { kind: 'repair'; building: number }
  | { kind: 'interact'; building: number; action: InteractAction };

export interface CommanderEnt extends PathState {
  kind: 'commander';
  id: number;
  player: PlayerId;
  pos: Vec;
  hp: number;
  maxHp: number;
  tasks: CommanderTask[];
  channeling: boolean; // was channeling build/repair this tick
  stillTicks: number;
  lastDamageTick: number;
}

export interface BuildingEnt {
  kind: 'building';
  id: number;
  player: PlayerId;
  type: BuildingType;
  pos: Vec; // footprint center
  hp: number;
  maxHp: number; // final (completed) max
  done: boolean;
  buildTicks: number; // channel progress, per-mille ticks (1000 = one tick of work)
  buildTicksNeeded: number; // buildTime * TPS * 1000
  // Fabricator state (unused for other types):
  production: UnitType;
  on: boolean;
  rally: Vec;
  behavior: Behavior;
  starved: boolean; // couldn't afford its unit at the last wave
  targetId: number; // watchtower current target
}

export type Entity = UnitEnt | CommanderEnt | BuildingEnt;

export interface CapturePointState {
  id: string;
  pos: Vec;
  buffs: CaptureBuff[];
  owner: -1 | PlayerId;
  meterSide: -1 | PlayerId; // whose progress the meter currently holds
  meter: number; // 0..CAPTURE_METER_MAX
  contested: boolean;
}

export interface LastKnownBuilding {
  type: BuildingType;
  pos: Vec;
  tick: number; // last seen
  done: boolean;
}

export interface PlayerState {
  energy: number; // me
  techs: Set<TechId>;
  research: { tech: TechId; ticksLeft: number } | null;
  override: 'fall_back' | 'defend' | null;
  visible: Uint8Array;
  lastKnown: Map<number, LastKnownBuilding>;
  events: string[];
  invalid: { cmd: string; reason: string }[];
  underAttackTick: number;
}

// ---------------------------------------------------------------------------
// Commands (§13.3 — one pipeline for human and Claude)
// ---------------------------------------------------------------------------

export type Command =
  | { cmd: 'move'; pos: [number, number]; replace?: boolean }
  | { cmd: 'stop' }
  | { cmd: 'build'; type: BuildingType; pos: [number, number] }
  | { cmd: 'resume_build'; building: number }
  | { cmd: 'cancel_build'; building: number }
  | { cmd: 'repair'; building: number }
  | { cmd: 'set_rally'; building: number; pos: [number, number] }
  | { cmd: 'set_behavior'; building: number; behavior: Behavior }
  | { cmd: 'set_production'; building: number; unit?: UnitType; on?: boolean }
  | { cmd: 'research'; tech: TechId }
  | { cmd: 'global_override'; stance: OverrideStance };

interface Attack {
  targetId: number;
  dmg: number; // mHP
  attackerDesc: string; // for kill events, e.g. "enemy oni"
  attackerPos: Vec;
  attackerType: UnitType | 'watchtower';
  attackerPlayer: PlayerId;
  attackerId: number;
}

/** One resolved attack, for presentation (tracers/impact flashes). Not part of the hash. */
export interface AttackEvent {
  from: Vec;
  to: Vec;
  targetId: number;
  attackerId: number;
  attackerType: UnitType | 'watchtower';
  player: PlayerId;
}

/**
 * An artillery shell in flight. Aimed at the target's position AT FIRE TIME —
 * it never tracks. On arrival it airbursts: every enemy entity within the
 * splash radius takes the stored damage (cloak is no defense against area fire).
 */
export interface ShellState {
  player: PlayerId;
  type: UnitType; // attacker unit type, for counter multipliers + kill events
  from: Vec;
  to: Vec;
  ticksLeft: number;
  ticksTotal: number;
  dmg: number; // mHP per target before counter/defense multipliers (tech/auras baked in at fire time)
  splashMu: number;
  attackerId: number;
}

/** Shell fired this tick (presentation: muzzle flash + recoil). Not part of the hash. */
export interface ShellEvent {
  from: Vec;
  to: Vec;
  ticks: number;
  attackerId: number;
  player: PlayerId;
}

/** Airburst resolved this tick (presentation: explosion + flak). Not part of the hash. */
export interface BurstEvent {
  pos: Vec;
  splashMu: number;
  player: PlayerId;
}

const INTERACT_RANGE_MU = Math.floor(COMMANDER.interactRange * FP);
const ARRIVE_TOLERANCE_MU = 300;

// ---------------------------------------------------------------------------

export class Game {
  readonly map: GameMap;
  readonly seed: number;
  tick = 0;
  prng: Prng;
  entities = new Map<number, Entity>();
  nextId = 1;
  blocked: Uint8Array; // building footprints (incl. blueprints)
  players: [PlayerState, PlayerState];
  capturePoints: CapturePointState[];
  winner: -1 | PlayerId | null = null; // -1 = draw, null = ongoing
  winReason: string | null = null; // what killed the losing commander (balance metrics)
  /** Every accepted command with its tick — deterministic replay = seed + this log. */
  commandLog: { tick: number; player: PlayerId; cmd: Command }[] = [];
  /** Attacks resolved in the most recent step; rewritten each tick (presentation only). */
  attackLog: AttackEvent[] = [];
  /** Artillery shells currently in flight (sim state — part of the hash). */
  shells: ShellState[] = [];
  /** Shells fired / airbursts resolved in the most recent step (presentation only). */
  shellLog: ShellEvent[] = [];
  burstLog: BurstEvent[] = [];
  /** Debug cheat: placed buildings complete instantly. Toggling mid-match breaks replay parity. */
  debugInstantBuild = false;
  /** Debug war-game: per-player comps spawned free at each wave, rallied at the enemy base. */
  debugWaveComp: [Partial<Record<UnitType, number>> | null, Partial<Record<UnitType, number>> | null] = [null, null];

  constructor(seed: number, map?: GameMap) {
    this.seed = seed;
    this.map = map ?? junction9();
    this.prng = new Prng(seed);
    this.blocked = new Uint8Array(this.map.size * this.map.size);
    this.players = [this.newPlayer(), this.newPlayer()];

    this.capturePoints = this.map.capturePoints.map((cp) => ({
      id: cp.id,
      pos: cp.pos,
      buffs: this.prng.sample(CAPTURE_BUFF_POOL, 2),
      owner: -1 as const,
      meterSide: -1 as const,
      meter: 0,
      contested: false,
    }));

    for (const player of [0, 1] as PlayerId[]) {
      const spawn = this.map.spawns[player];
      const bastion = this.addBuilding(player, 'bastion', spawn.bastion);
      bastion.done = true;
      bastion.hp = bastion.maxHp;
      this.addCommander(player, spawn.commander);
    }
    this.recomputeVision();
  }

  private newPlayer(): PlayerState {
    return {
      energy: STARTING_ENERGY,
      techs: new Set(),
      research: null,
      override: null,
      visible: new Uint8Array(this.map.size * this.map.size),
      lastKnown: new Map(),
      events: [],
      invalid: [],
      underAttackTick: -1000,
    };
  }

  // -- entity access ---------------------------------------------------------

  commander(player: PlayerId): CommanderEnt | null {
    for (const e of this.entities.values()) {
      if (e.kind === 'commander' && e.player === player) return e;
    }
    return null;
  }

  bastion(player: PlayerId): BuildingEnt | null {
    for (const e of this.entities.values()) {
      if (e.kind === 'building' && e.type === 'bastion' && e.player === player) return e;
    }
    return null;
  }

  building(id: number): BuildingEnt | null {
    const e = this.entities.get(id);
    return e && e.kind === 'building' ? e : null;
  }

  *units(player?: PlayerId): Generator<UnitEnt> {
    for (const e of this.entities.values()) {
      if (e.kind === 'unit' && (player === undefined || e.player === player)) yield e;
    }
  }

  *buildings(player?: PlayerId): Generator<BuildingEnt> {
    for (const e of this.entities.values()) {
      if (e.kind === 'building' && (player === undefined || e.player === player)) yield e;
    }
  }

  // -- spawning --------------------------------------------------------------

  private addBuilding(player: PlayerId, type: BuildingType, pos: Vec): BuildingEnt {
    const stats = BUILDING_STATS[type];
    const b: BuildingEnt = {
      kind: 'building',
      id: this.nextId++,
      player,
      type,
      pos,
      hp: pm(stats.hp * FP, BLUEPRINT_HP_FRACTION),
      maxHp: stats.hp * FP,
      done: false,
      buildTicks: 0,
      buildTicksNeeded: stats.buildTime * TICKS_PER_SECOND * 1000,
      production: 'ronin',
      on: true,
      rally: { ...pos },
      behavior: 'guard',
      starved: false,
      targetId: 0,
    };
    this.entities.set(b.id, b);
    this.setFootprint(b, 1);
    return b;
  }

  private addCommander(player: PlayerId, pos: Vec): CommanderEnt {
    const c: CommanderEnt = {
      kind: 'commander',
      id: this.nextId++,
      player,
      pos: { ...pos },
      hp: COMMANDER.hp * FP,
      maxHp: COMMANDER.hp * FP,
      tasks: [],
      channeling: false,
      stillTicks: 0,
      lastDamageTick: -10000,
      path: [],
      pathIdx: 0,
      pathGoal: null,
    };
    this.entities.set(c.id, c);
    return c;
  }

  private spawnUnit(player: PlayerId, type: UnitType, fab: BuildingEnt): UnitEnt | null {
    const spot = this.freeCellNear(fab);
    if (!spot) return null;
    const maxHp = this.unitMaxHp(player, type);
    const u: UnitEnt = {
      kind: 'unit',
      id: this.nextId++,
      player,
      type,
      pos: cellCenter(spot.cx, spot.cy),
      hp: maxHp,
      maxHp,
      sourceBuilding: fab.id,
      rally: { ...fab.rally },
      behavior: fab.behavior,
      targetId: 0,
      heading: { x: player === 0 ? 1000 : -1000, y: 0 },
      speedMu: 0,
      windup: 0,
      path: [],
      pathIdx: 0,
      pathGoal: null,
    };
    this.entities.set(u.id, u);
    return u;
  }

  // -- footprints ------------------------------------------------------------

  footprintCells(b: BuildingEnt): { cx0: number; cy0: number; f: number } {
    const f = BUILDING_STATS[b.type].footprint;
    return {
      cx0: Math.round(b.pos.x / FP - f / 2),
      cy0: Math.round(b.pos.y / FP - f / 2),
      f,
    };
  }

  private setFootprint(b: BuildingEnt, val: 0 | 1): void {
    const { cx0, cy0, f } = this.footprintCells(b);
    for (let cy = cy0; cy < cy0 + f; cy++) {
      for (let cx = cx0; cx < cx0 + f; cx++) {
        if (inBounds(this.map, cx, cy)) this.blocked[cellIndex(this.map, cx, cy)] = val;
      }
    }
  }

  /** Squared distance (mu²) from a point to a building's footprint rect. */
  dist2ToBuilding(p: Vec, b: BuildingEnt): number {
    const half = Math.floor((BUILDING_STATS[b.type].footprint * FP) / 2);
    const dx = Math.max(b.pos.x - half - p.x, 0, p.x - (b.pos.x + half));
    const dy = Math.max(b.pos.y - half - p.y, 0, p.y - (b.pos.y + half));
    return dx * dx + dy * dy;
  }

  isAdjacent(p: Vec, b: BuildingEnt): boolean {
    return this.dist2ToBuilding(p, b) <= INTERACT_RANGE_MU * INTERACT_RANGE_MU;
  }

  private freeCellNear(b: BuildingEnt): { cx: number; cy: number } | null {
    const { cx0, cy0, f } = this.footprintCells(b);
    for (let ring = 1; ring <= 6; ring++) {
      for (let cy = cy0 - ring; cy < cy0 + f + ring; cy++) {
        for (let cx = cx0 - ring; cx < cx0 + f + ring; cx++) {
          const onRing =
            cy < cy0 - ring + 1 || cy >= cy0 + f + ring - 1 || cx < cx0 - ring + 1 || cx >= cx0 + f + ring - 1;
          if (!onRing || !inBounds(this.map, cx, cy)) continue;
          if (!this.blocked[cellIndex(this.map, cx, cy)]) return { cx, cy };
        }
      }
    }
    return null;
  }

  /** Nearest non-blocked cell adjacent to the building's footprint. */
  private approachPoint(from: Vec, b: BuildingEnt): Vec {
    const { cx0, cy0, f } = this.footprintCells(b);
    let best: Vec | null = null;
    let bestD = Infinity;
    for (let cy = cy0 - 1; cy < cy0 + f + 1; cy++) {
      for (let cx = cx0 - 1; cx < cx0 + f + 1; cx++) {
        const onRing = cy === cy0 - 1 || cy === cy0 + f || cx === cx0 - 1 || cx === cx0 + f;
        if (!onRing || !inBounds(this.map, cx, cy)) continue;
        if (this.blocked[cellIndex(this.map, cx, cy)]) continue;
        const c = cellCenter(cx, cy);
        const d = dist2(from, c);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
    }
    return best ?? { ...b.pos };
  }

  // -- tech-modified stats -----------------------------------------------------

  private unitMaxHp(player: PlayerId, type: UnitType): number {
    const base = UNIT_STATS[type].hp * FP;
    return this.players[player].techs.has('mil1') ? pm(base, HARDENED_FRAMES_HP) : base;
  }

  private unitRangeMu(player: PlayerId, type: UnitType): number {
    if (type === 'mantis' && this.players[player].techs.has('mil3')) return BALLISTIC_MANTIS_RANGE * FP;
    return UNIT_STATS[type].range * FP;
  }

  private towerRangeMu(player: PlayerId): number {
    return (this.players[player].techs.has('mil3') ? BALLISTIC_WATCHTOWER_RANGE : BUILDING_STATS.watchtower.range!) * FP;
  }

  private speedMuPerTick(e: UnitEnt | CommanderEnt): number {
    let base: number;
    if (e.kind === 'commander') {
      base = (this.players[e.player].techs.has('cmd1') ? SERVO_COMMANDER_SPEED : COMMANDER.speed) * 100;
    } else {
      base = Math.floor(UNIT_STATS[e.type].speed * 100);
    }
    const { cx, cy } = posToCell(e.pos);
    if (this.map.slow[cellIndex(this.map, cx, cy)]) base = pm(base, SLOW_ZONE_SPEED);
    if (this.hasPointAura(e.player, e.pos, 'drive_aura')) base = pm(base, DRIVE_AURA_SPEED);
    return base;
  }

  private hasPointAura(player: PlayerId, pos: Vec, buff: CaptureBuff): boolean {
    for (const cp of this.capturePoints) {
      if (cp.owner === player && cp.buffs.includes(buff) && within(pos, cp.pos, CAPTURE_AURA_RADIUS * FP)) {
        return true;
      }
    }
    return false;
  }

  /** Damage-taken multiplier for a defending unit/commander (auras don't stack; strongest wins). */
  private damageTakenMult(def: UnitEnt | CommanderEnt): number {
    let mult = 1000;
    for (const b of this.buildings(def.player)) {
      if (b.type === 'aegis_projector' && b.done && within(def.pos, b.pos, BUILDING_STATS.aegis_projector.auraRadius! * FP)) {
        mult = Math.min(mult, AEGIS_DAMAGE_TAKEN);
        break;
      }
    }
    if (this.hasPointAura(def.player, def.pos, 'shield_aura')) {
      mult = Math.min(mult, SHIELD_AURA_DAMAGE_TAKEN);
    }
    return mult;
  }

  private elevAt(p: Vec): number {
    const { cx, cy } = posToCell(p);
    return this.map.elevation[cellIndex(this.map, cx, cy)];
  }

  isCommanderCloaked(c: CommanderEnt): boolean {
    if (!this.players[c.player].techs.has('cmd3')) return false;
    if (c.channeling) return false;
    if (c.stillTicks < VEIL_STILL_SECONDS * TICKS_PER_SECOND) return false;
    // Enemy Sensor Spires reveal.
    const enemy = (1 - c.player) as PlayerId;
    for (const b of this.buildings(enemy)) {
      if (b.type === 'sensor_spire' && b.done && within(c.pos, b.pos, BUILDING_STATS.sensor_spire.vision * FP)) {
        return false;
      }
    }
    return true;
  }

  private cellVisible(player: PlayerId, pos: Vec): boolean {
    const { cx, cy } = posToCell(pos);
    return this.players[player].visible[cellIndex(this.map, cx, cy)] === 1;
  }

  /** Public visibility query for snapshots/rendering. */
  cellVisibleForSnapshot(player: PlayerId, pos: Vec): boolean {
    return this.cellVisible(player, pos);
  }

  /** Can `player`'s combat systems see/target this entity right now? */
  canTarget(player: PlayerId, e: Entity): boolean {
    if (!this.cellVisible(player, e.pos)) return false;
    if (e.kind === 'commander' && this.isCommanderCloaked(e)) return false;
    return true;
  }

  // -- command application -----------------------------------------------------

  applyCommands(player: PlayerId, cmds: Command[]): void {
    for (const c of cmds) this.applyCommand(player, c);
  }

  applyCommand(player: PlayerId, c: Command): void {
    const p = this.players[player];
    const cmdr = this.commander(player);
    const fail = (reason: string): void => {
      p.invalid.push({ cmd: c.cmd, reason });
    };
    if (!cmdr) return fail('commander is dead');
    this.commandLog.push({ tick: this.tick, player, cmd: c });

    switch (c.cmd) {
      case 'move': {
        const pos = this.toMapPos(c.pos);
        if (c.replace) cmdr.tasks = [];
        cmdr.tasks.push({ kind: 'move', pos });
        return;
      }
      case 'stop':
        cmdr.tasks = [];
        return;
      case 'build': {
        if (c.type === 'bastion') return fail('cannot build additional bastions');
        if (!BUILDING_STATS[c.type]) return fail('unknown building type');
        const pos = this.snapBuildingPos(c.type, this.toMapPos(c.pos));
        const err = this.placementError(c.type, pos);
        if (err) return fail(err);
        const cost = BUILDING_STATS[c.type].cost * FP;
        if (p.energy < cost) return fail('insufficient energy');
        p.energy -= cost;
        const b = this.addBuilding(player, c.type, pos);
        if (this.debugInstantBuild) {
          b.buildTicks = b.buildTicksNeeded;
          b.done = true;
          b.hp = b.maxHp;
          return;
        }
        cmdr.tasks.push({ kind: 'build', building: b.id });
        return;
      }
      case 'resume_build': {
        const b = this.building(c.building);
        if (!b || b.player !== player) return fail('no such building');
        if (b.done) return fail('already complete');
        cmdr.tasks.push({ kind: 'build', building: b.id });
        return;
      }
      case 'cancel_build': {
        const b = this.building(c.building);
        if (!b || b.player !== player) return fail('no such building');
        if (b.done) return fail('already complete');
        p.energy += pm(BUILDING_STATS[b.type].cost * FP, CANCEL_REFUND);
        this.removeEntity(b.id);
        cmdr.tasks = cmdr.tasks.filter((t) => !('building' in t) || t.building !== b.id);
        return;
      }
      case 'repair': {
        const b = this.building(c.building);
        if (!b || b.player !== player) return fail('no such building');
        if (!b.done) return fail('building not complete (resume_build instead)');
        cmdr.tasks.push({ kind: 'repair', building: b.id });
        return;
      }
      case 'set_rally':
      case 'set_behavior':
      case 'set_production': {
        const b = this.building(c.building);
        if (!b || b.player !== player) return fail('no such building');
        if (b.type !== 'fabricator') return fail('not a fabricator');
        let action: InteractAction;
        if (c.cmd === 'set_rally') action = { kind: 'set_rally', pos: this.toMapPos(c.pos) };
        else if (c.cmd === 'set_behavior') action = { kind: 'set_behavior', behavior: c.behavior };
        else action = { kind: 'set_production', unit: c.unit, on: c.on };
        cmdr.tasks.push({ kind: 'interact', building: b.id, action });
        return;
      }
      case 'research': {
        if (!TECHS[c.tech]) return fail('unknown tech');
        const bastion = this.bastion(player);
        if (!bastion || !bastion.done) return fail('no bastion');
        cmdr.tasks.push({ kind: 'interact', building: bastion.id, action: { kind: 'research', tech: c.tech } });
        return;
      }
      case 'global_override': {
        const bastion = this.bastion(player);
        if (!bastion || !bastion.done) return fail('no bastion');
        cmdr.tasks.push({
          kind: 'interact',
          building: bastion.id,
          action: { kind: 'global_override', stance: c.stance },
        });
        return;
      }
    }
  }

  private toMapPos(p: [number, number]): Vec {
    const max = this.map.size * FP - 1;
    return {
      x: clamp(Math.round(p[0] * FP), 0, max),
      y: clamp(Math.round(p[1] * FP), 0, max),
    };
  }

  private snapBuildingPos(type: BuildingType, pos: Vec): Vec {
    const f = BUILDING_STATS[type].footprint;
    // Even footprints center on cell corners, odd on cell centers.
    if (f % 2 === 0) {
      return { x: Math.round(pos.x / FP) * FP, y: Math.round(pos.y / FP) * FP };
    }
    return {
      x: Math.floor(pos.x / FP) * FP + FP / 2,
      y: Math.floor(pos.y / FP) * FP + FP / 2,
    };
  }

  placementError(type: BuildingType, pos: Vec): string | null {
    const f = BUILDING_STATS[type].footprint;
    const cx0 = Math.round(pos.x / FP - f / 2);
    const cy0 = Math.round(pos.y / FP - f / 2);
    if (cx0 < 0 || cy0 < 0 || cx0 + f > this.map.size || cy0 + f > this.map.size) return 'out of bounds';

    let elev = -1;
    for (let cy = cy0; cy < cy0 + f; cy++) {
      for (let cx = cx0; cx < cx0 + f; cx++) {
        const idx = cellIndex(this.map, cx, cy);
        if (this.blocked[idx]) return 'overlaps another building';
        if (elev === -1) elev = this.map.elevation[idx];
        else if (this.map.elevation[idx] !== elev) return 'ground not flat';
      }
    }

    const onNode = this.map.nodes.some((n) => n.x === pos.x && n.y === pos.y);
    if (type === 'extractor') {
      if (!onNode) return 'extractor must be placed on a resource node';
      for (const b of this.buildings()) {
        if (b.type === 'extractor' && b.pos.x === pos.x && b.pos.y === pos.y) return 'node occupied';
      }
    } else {
      // Keep nodes clear so extractors stay buildable.
      for (const n of this.map.nodes) {
        const nHalf = 1.5 * FP;
        const half = (f * FP) / 2;
        if (Math.abs(n.x - pos.x) < nHalf + half && Math.abs(n.y - pos.y) < nHalf + half) {
          return 'overlaps a resource node';
        }
      }
    }
    return null;
  }

  /** Debug (war-game): wipe every unit on the field, both players. */
  debugKillAllUnits(): void {
    for (const u of [...this.units()]) this.removeEntity(u.id);
  }

  private removeEntity(id: number): void {
    const e = this.entities.get(id);
    if (!e) return;
    if (e.kind === 'building') this.setFootprint(e, 0);
    this.entities.delete(id);
  }

  // -- events ------------------------------------------------------------------

  private event(player: PlayerId, msg: string): void {
    const ev = this.players[player].events;
    ev.push(msg);
    if (ev.length > 50) ev.shift();
  }

  private fmtPos(p: Vec): string {
    return `[${Math.round(p.x / FP)},${Math.round(p.y / FP)}]`;
  }

  // ---------------------------------------------------------------------------
  // Tick
  // ---------------------------------------------------------------------------

  step(): void {
    if (this.winner !== null) return;
    this.tick++;
    this.tickIncome();
    this.tickResearch();
    this.tickCommanders();
    this.tickProduction();
    const attacks: Attack[] = [];
    this.shellLog = [];
    this.burstLog = [];
    this.tickShells(attacks); // before tickUnits: shells fired this tick fly their full time
    this.tickUnits(attacks);
    this.separateUnits();
    this.tickTowers(attacks);
    this.applyAttacks(attacks);
    this.tickRegen();
    this.tickCapturePoints();
    if (this.tick % VISION_INTERVAL === 0) this.recomputeVision();
    this.checkWinner();
  }

  /** Advance n ticks (or until game over). */
  run(n: number): void {
    for (let i = 0; i < n && this.winner === null; i++) this.step();
  }

  get gameTime(): number {
    return this.tick / TICKS_PER_SECOND;
  }

  // -- economy -----------------------------------------------------------------

  incomeRate(player: PlayerId): number {
    const p = this.players[player];
    let rate = 0;
    const bastion = this.bastion(player);
    if (bastion && bastion.done) {
      rate += p.techs.has('eco3') ? INCOME.bastionTrickleDeepCycle : INCOME.bastionTrickle;
    }
    for (const b of this.buildings(player)) {
      if (b.type === 'extractor' && b.done) {
        rate += p.techs.has('eco1') ? INCOME.extractorOverclocked : INCOME.extractor;
      }
    }
    for (const cp of this.capturePoints) {
      if (cp.owner === player && cp.buffs.includes('grid_feed')) {
        rate += p.techs.has('eco2') ? INCOME.gridFeedTapped : INCOME.gridFeed;
      }
    }
    return rate;
  }

  private tickIncome(): void {
    for (const player of [0, 1] as PlayerId[]) {
      this.players[player].energy += this.incomeRate(player) * 100;
    }
  }

  private tickResearch(): void {
    for (const player of [0, 1] as PlayerId[]) {
      const p = this.players[player];
      if (!p.research) continue;
      const bastion = this.bastion(player);
      if (!bastion) {
        // Research site destroyed: research is lost.
        p.research = null;
        continue;
      }
      p.research.ticksLeft--;
      if (p.research.ticksLeft <= 0) {
        const tech = p.research.tech;
        p.techs.add(tech);
        p.research = null;
        this.event(player, `research complete: ${TECHS[tech].name}`);
        if (tech === 'mil1') {
          for (const u of this.units(player)) {
            u.maxHp = pm(u.maxHp, HARDENED_FRAMES_HP);
            u.hp = pm(u.hp, HARDENED_FRAMES_HP);
          }
        }
      }
    }
  }

  // -- commander ---------------------------------------------------------------

  private tickCommanders(): void {
    for (const player of [0, 1] as PlayerId[]) {
      const c = this.commander(player);
      if (!c) continue;
      const before = { ...c.pos };
      c.channeling = false;
      this.runCommanderTask(c);
      if (c.pos.x === before.x && c.pos.y === before.y) c.stillTicks++;
      else c.stillTicks = 0;
    }
  }

  private runCommanderTask(c: CommanderEnt): void {
    const task = c.tasks[0];
    if (!task) return;
    const p = this.players[c.player];
    const done = () => c.tasks.shift();

    if (task.kind === 'move') {
      if (within(c.pos, task.pos, ARRIVE_TOLERANCE_MU)) return void done();
      const arrived = this.moveEntityToward(c, task.pos);
      if (arrived === 'stuck') done();
      return;
    }

    const b = this.building(task.building);
    if (!b || b.player !== c.player) {
      p.invalid.push({ cmd: task.kind, reason: 'target building no longer exists' });
      return void done();
    }

    if (!this.isAdjacent(c.pos, b)) {
      const goal = this.approachPoint(c.pos, b);
      const arrived = this.moveEntityToward(c, goal);
      if (arrived === 'stuck' && !this.isAdjacent(c.pos, b)) {
        p.invalid.push({ cmd: task.kind, reason: 'cannot reach building' });
        done();
      }
      return;
    }

    switch (task.kind) {
      case 'build': {
        if (b.done) return void done();
        c.channeling = true;
        const rate = this.debugInstantBuild
          ? b.buildTicksNeeded // debug cheat: one channel tick finishes anything
          : p.techs.has('cmd1')
            ? SERVO_BUILD_RATE
            : 1000;
        b.buildTicks += rate;
        if (b.buildTicks >= b.buildTicksNeeded) {
          b.done = true;
          b.hp += b.maxHp - pm(b.maxHp, BLUEPRINT_HP_FRACTION); // damage taken as blueprint persists
          b.hp = Math.min(b.hp, b.maxHp);
          this.event(c.player, `${b.type} complete at ${this.fmtPos(b.pos)}`);
          done();
        }
        return;
      }
      case 'repair': {
        if (!b.done) return void done();
        if (b.hp >= b.maxHp) return void done();
        const free = p.techs.has('eco3');
        const healPerTick = Math.floor((COMMANDER.repairHpPerSecond * FP) / TICKS_PER_SECOND);
        const heal = Math.min(healPerTick, b.maxHp - b.hp);
        const cost = free ? 0 : Math.floor((heal * COMMANDER.repairEnergyPerHp * FP) / FP);
        if (p.energy < cost) return; // wait for energy
        p.energy -= cost;
        b.hp += heal;
        c.channeling = true;
        if (b.hp >= b.maxHp) done();
        return;
      }
      case 'interact': {
        this.applyInteract(c, b, task.action);
        return void done();
      }
    }
  }

  private applyInteract(c: CommanderEnt, b: BuildingEnt, a: InteractAction): void {
    const p = this.players[c.player];
    const fail = (reason: string): void => {
      p.invalid.push({ cmd: a.kind, reason });
    };
    switch (a.kind) {
      case 'set_rally':
        b.rally = { ...a.pos };
        return;
      case 'set_behavior':
        b.behavior = a.behavior;
        return;
      case 'set_production':
        if (a.unit !== undefined) {
          if (!UNIT_STATS[a.unit]) return fail('unknown unit type');
          b.production = a.unit; // units insta-build at the wave; nothing in flight to refund
        }
        if (a.on !== undefined) b.on = a.on;
        return;
      case 'research': {
        if (b.type !== 'bastion') return fail('research requires the bastion');
        if (p.research) return fail('research already in progress');
        const t = TECHS[a.tech];
        if (p.techs.has(t.id)) return fail('already researched');
        if (t.requires && !p.techs.has(t.requires)) return fail(`requires ${t.requires}`);
        if (p.energy < t.cost * FP) return fail('insufficient energy');
        p.energy -= t.cost * FP;
        p.research = { tech: t.id, ticksLeft: t.time * TICKS_PER_SECOND };
        return;
      }
      case 'global_override': {
        if (b.type !== 'bastion') return fail('override console is at the bastion');
        p.override = a.stance === 'release' ? null : a.stance;
        return;
      }
    }
  }

  // -- movement ----------------------------------------------------------------

  /**
   * Move an entity toward a goal along an A* path.
   * Returns 'moving' | 'arrived' | 'stuck'.
   */
  private moveEntityToward(e: UnitEnt | CommanderEnt, goal: Vec, capMu?: number): 'moving' | 'arrived' | 'stuck' {
    if (within(e.pos, goal, ARRIVE_TOLERANCE_MU)) return 'arrived';
    if (!e.pathGoal || dist2(e.pathGoal, goal) > FP * FP) {
      this.computePath(e, goal);
    }
    let step = Math.min(this.speedMuPerTick(e), capMu ?? Infinity);
    while (step > 0) {
      if (e.pathIdx >= e.path.length) {
        // Path exhausted; final approach within the goal cell.
        const { cx, cy } = posToCell(goal);
        const cur = posToCell(e.pos);
        if (cur.cx === cx && cur.cy === cy && !this.blocked[cellIndex(this.map, cx, cy)]) {
          e.pos = stepToward(e.pos, goal, step);
          return within(e.pos, goal, ARRIVE_TOLERANCE_MU) ? 'arrived' : 'moving';
        }
        return within(e.pos, goal, ARRIVE_TOLERANCE_MU) ? 'arrived' : 'stuck';
      }
      const next = e.path[e.pathIdx];
      const nIdx = cellIndex(this.map, next.cx, next.cy);
      if (this.blocked[nIdx]) {
        // A building appeared on our path; repath once.
        this.computePath(e, goal);
        if (e.path.length === 0) return 'stuck';
        continue;
      }
      const target = cellCenter(next.cx, next.cy);
      const d = dist(e.pos, target);
      if (d <= step) {
        e.pos = target;
        step -= d;
        e.pathIdx++;
      } else {
        e.pos = stepToward(e.pos, target, step);
        step = 0;
      }
    }
    return within(e.pos, goal, ARRIVE_TOLERANCE_MU) ? 'arrived' : 'moving';
  }

  private computePath(e: UnitEnt | CommanderEnt, goal: Vec): void {
    const s = posToCell(e.pos);
    const g = posToCell(goal);
    e.path = findPath(this.map, this.blocked, s.cx, s.cy, g.cx, g.cy);
    e.pathIdx = 0;
    e.pathGoal = { ...goal };
  }

  // -- vehicle kinematics (units with stats.accel) --------------------------------
  //
  // Integer-only steering: heading is a x1000 unit vector rotated by a per-tick
  // angle budget (small-angle sin~theta, cos~1000-theta^2/2000, renormalized via
  // isqrt), so no float trig enters the sim. Turn budget shrinks with speed.

  /** Steer toward `dir` (any magnitude) and integrate. throttle=false brakes to 0. */
  private steerVehicle(u: UnitEnt, dir: Vec | null, throttle: boolean, capMu?: number): void {
    const s = UNIT_STATS[u.type];
    const maxSpd = Math.min(this.speedMuPerTick(u), capMu ?? Infinity);
    const tps2 = TICKS_PER_SECOND * TICKS_PER_SECOND;
    const accel = Math.max(1, Math.floor(((s.accel ?? 4) * FP) / tps2));
    const decel = Math.max(1, Math.floor(((s.decel ?? 8) * FP) / tps2));

    let aligned = 1000;
    if (dir) {
      const dlen = isqrt(dir.x * dir.x + dir.y * dir.y);
      if (dlen > 0) {
        const dx = Math.floor((dir.x * 1000) / dlen);
        const dy = Math.floor((dir.y * 1000) / dlen);
        // turn budget in mrad/tick, interpolated standstill -> max speed
        const maxT = Math.min(600, Math.floor(((s.turnRate ?? 180) * 17453) / (1000 * TICKS_PER_SECOND)));
        const minT = Math.min(maxT, Math.floor(((s.turnRateMin ?? s.turnRate ?? 180) * 17453) / (1000 * TICKS_PER_SECOND)));
        const frac = maxSpd > 0 ? Math.min(1000, Math.floor((1000 * u.speedMu) / maxSpd)) : 0;
        const turn = Math.max(30, maxT - Math.floor(((maxT - minT) * frac) / 1000));
        const cross = Math.floor((u.heading.x * dy - u.heading.y * dx) / 1000); // ~1000*sin(delta)
        const dot = Math.floor((u.heading.x * dx + u.heading.y * dy) / 1000); // ~1000*cos(delta)
        if (dot > 0 && Math.abs(cross) <= turn) {
          u.heading = { x: dx, y: dy }; // within budget: snap
        } else {
          const sign = cross > 0 ? 1 : cross < 0 ? -1 : 1;
          const sin = turn * sign;
          const cos = 1000 - Math.floor((turn * turn) / 2000);
          const hx = Math.floor((u.heading.x * cos - u.heading.y * sin) / 1000);
          const hy = Math.floor((u.heading.x * sin + u.heading.y * cos) / 1000);
          const hl = isqrt(hx * hx + hy * hy) || 1;
          u.heading = { x: Math.floor((hx * 1000) / hl), y: Math.floor((hy * 1000) / hl) };
        }
        aligned = Math.floor((u.heading.x * dx + u.heading.y * dy) / 1000);
      }
    }

    if (!dir || !throttle) {
      u.speedMu = Math.max(0, u.speedMu - decel);
    } else if (aligned > 500) {
      u.speedMu = Math.min(maxSpd, u.speedMu + accel); // roughly on line: open up
    } else if (aligned < 0) {
      u.speedMu = Math.max(Math.floor(maxSpd / 4), u.speedMu - decel); // way off: brake into the turn
    } else {
      u.speedMu = Math.max(Math.floor(maxSpd / 3), u.speedMu - Math.floor(decel / 2)); // carving
    }
    u.speedMu = Math.min(u.speedMu, maxSpd); // slow zones cap immediately

    if (u.speedMu > 0) {
      const nx = u.pos.x + Math.floor((u.heading.x * u.speedMu) / 1000);
      const ny = u.pos.y + Math.floor((u.heading.y * u.speedMu) / 1000);
      const c = posToCell({ x: nx, y: ny });
      if (inBounds(this.map, c.cx, c.cy) && !this.blocked[cellIndex(this.map, c.cx, c.cy)]) {
        u.pos = { x: nx, y: ny };
      } else {
        u.speedMu = 0; // wall/building: stall and force a repath
        u.pathGoal = null;
      }
    }
  }

  /** Path-following analog of moveEntityToward for vehicles. */
  private vehicleMoveToward(u: UnitEnt, goal: Vec, capMu?: number): 'moving' | 'arrived' {
    if (within(u.pos, goal, ARRIVE_TOLERANCE_MU * 2)) {
      this.steerVehicle(u, null, false); // brake
      return 'arrived';
    }
    if (!u.pathGoal || dist2(u.pathGoal, goal) > FP * FP) this.computePath(u, goal);
    // advance waypoints as we sweep near them (vehicles cut corners)
    while (
      u.pathIdx < u.path.length &&
      within(u.pos, cellCenter(u.path[u.pathIdx].cx, u.path[u.pathIdx].cy), 800)
    ) {
      u.pathIdx++;
    }
    let wp = goal;
    if (u.pathIdx < u.path.length) {
      const next = u.path[u.pathIdx];
      if (this.blocked[cellIndex(this.map, next.cx, next.cy)]) {
        this.computePath(u, goal);
        if (u.pathIdx < u.path.length) wp = cellCenter(u.path[u.pathIdx].cx, u.path[u.pathIdx].cy);
      } else {
        wp = cellCenter(next.cx, next.cy);
      }
    }
    // ease off when the remaining distance is inside braking range
    const s = UNIT_STATS[u.type];
    const decel = Math.max(1, Math.floor(((s.decel ?? 8) * FP) / (TICKS_PER_SECOND * TICKS_PER_SECOND)));
    const stopDist = Math.floor((u.speedMu * u.speedMu) / (2 * decel));
    const throttle = dist2(u.pos, goal) > stopDist * stopDist;
    this.steerVehicle(u, { x: wp.x - u.pos.x, y: wp.y - u.pos.y }, throttle, capMu);
    return 'moving';
  }

  /** Skirmish: orbit the target at ~75% weapon range, always moving, guns free. */
  private skirmish(u: UnitEnt, target: Entity, rangeMu: number): void {
    const rel = { x: u.pos.x - target.pos.x, y: u.pos.y - target.pos.y };
    const r = isqrt(rel.x * rel.x + rel.y * rel.y) || 1;
    if (r > rangeMu * 2) {
      this.vehicleMoveToward(u, target.pos); // too far: path in properly
      return;
    }
    const rad = { x: Math.floor((rel.x * 1000) / r), y: Math.floor((rel.y * 1000) / r) };
    const side = u.id % 2 === 0 ? 1 : -1; // stable orbit direction per unit
    const tan = { x: -rad.y * side, y: rad.x * side };
    const prefR = pm(rangeMu, 750);
    // blend tangent with a radial correction toward the preferred ring
    let radW = 0;
    if (r > rangeMu) radW = -700; // outside gun range: cut in
    else if (r < prefR) radW = 700; // too close: flare out
    const dir = {
      x: tan.x + Math.floor((rad.x * radW) / 1000),
      y: tan.y + Math.floor((rad.y * radW) / 1000),
    };
    this.steerVehicle(u, dir, true);
  }

  // -- production ----------------------------------------------------------------

  private tickProduction(): void {
    // Wave production: every WAVE_INTERVAL, each ON fabricator that can afford
    // its unit insta-builds and deploys it. When energy runs short, priority is
    // deterministic — oldest fabricator first (entity id order), greedy, so a
    // cheaper unit later in line can still release. Starved bays are flagged.
    if (this.tick % (WAVE_INTERVAL * TICKS_PER_SECOND) !== 0) return;
    const starvedCount: [number, number] = [0, 0];
    for (const b of [...this.buildings()]) {
      if (b.type !== 'fabricator' || !b.done) continue;
      if (!b.on) {
        b.starved = false;
        continue;
      }
      const p = this.players[b.player];
      const cost = UNIT_STATS[b.production].cost * FP;
      if (p.energy >= cost) {
        p.energy -= cost;
        b.starved = false;
        this.spawnUnit(b.player, b.production, b);
      } else {
        b.starved = true;
        starvedCount[b.player]++;
      }
    }
    for (const player of [0, 1] as PlayerId[]) {
      if (starvedCount[player] > 0) {
        this.event(player, `${starvedCount[player]} fabricator(s) skipped the wave — insufficient energy`);
      }
    }
    this.debugSpawnWave();
  }

  /**
   * War-game sandbox: free comps spawned in a battle formation facing the
   * enemy base — ranks perpendicular to the march axis, tanky units (hp) in
   * front, artillery behind — attack-moving to the enemy base.
   */
  private debugSpawnWave(): void {
    for (const player of [0, 1] as PlayerId[]) {
      const comp = this.debugWaveComp[player];
      if (!comp) continue;
      const home = this.bastion(player);
      if (!home) continue;
      const enemy = (1 - player) as PlayerId;
      const enemyBase = this.bastion(enemy)?.pos ?? this.map.spawns[enemy].bastion;

      // march axis d (x1000 unit vector) and its perpendicular p (rank axis)
      const ax = enemyBase.x - home.pos.x;
      const ay = enemyBase.y - home.pos.y;
      const alen = isqrt(ax * ax + ay * ay) || 1;
      const d = { x: Math.floor((ax * 1000) / alen), y: Math.floor((ay * 1000) / alen) };
      const p = { x: -d.y, y: d.x };

      // roster sorted tankiest-first (stable: hp desc, then name) -> front ranks
      const roster: UnitType[] = [];
      for (const [type, count] of Object.entries(comp) as [UnitType, number][]) {
        if (!UNIT_STATS[type]) continue;
        for (let i = 0; i < Math.min(count, 50); i++) roster.push(type);
      }
      roster.sort((a, b) => UNIT_STATS[b].hp - UNIT_STATS[a].hp || (a < b ? -1 : a > b ? 1 : 0));

      const cols = Math.max(2, Math.ceil(Math.sqrt(roster.length * 2))); // wide, shallow ranks
      const COL_MU = 1600; // lateral spacing
      const ROW_MU = 1800; // rank spacing
      const FRONT_MU = 5000; // first rank this far from the bastion center

      roster.forEach((type, k) => {
        const u = this.spawnUnit(player, type, home);
        if (!u) return; // fully out of room — keep the fallback spot
        const row = Math.floor(k / cols);
        const lateral = Math.floor(((2 * (k % cols) - (cols - 1)) * COL_MU) / 2);
        const forward = FRONT_MU + row * ROW_MU;
        const slot = {
          x: home.pos.x + Math.floor((d.x * forward + p.x * lateral) / 1000),
          y: home.pos.y + Math.floor((d.y * forward + p.y * lateral) / 1000),
        };
        const cell = posToCell(slot);
        if (inBounds(this.map, cell.cx, cell.cy) && !this.blocked[cellIndex(this.map, cell.cx, cell.cy)]) {
          u.pos = slot;
        }
        u.heading = { ...d }; // vehicles roll out already facing the enemy
        u.rally = { ...enemyBase };
        u.behavior = 'assault';
      });
    }
  }

  // -- unit AI ---------------------------------------------------------------------

  private effectiveOrders(u: UnitEnt): { behavior: Behavior; rally: Vec } {
    const p = this.players[u.player];
    const src = this.building(u.sourceBuilding);
    if (src && src.type === 'fabricator') {
      u.behavior = src.behavior;
      u.rally = { ...src.rally };
    }
    if (p.override) {
      const bastion = this.bastion(u.player);
      const home = bastion ? bastion.pos : this.map.spawns[u.player].bastion;
      if (p.override === 'fall_back') return { behavior: 'hold', rally: home }; // move-only handled below
      return { behavior: 'guard', rally: home };
    }
    return { behavior: u.behavior, rally: u.rally };
  }

  private enemiesOf(player: PlayerId): Entity[] {
    const out: Entity[] = [];
    const enemy = (1 - player) as PlayerId;
    for (const e of this.entities.values()) {
      if (e.player !== enemy) continue;
      if (!this.canTarget(player, e)) continue;
      out.push(e);
    }
    return out;
  }

  private counterMult(attacker: UnitType, target: Entity): number {
    if (target.kind === 'unit') return COUNTER[attacker][target.type];
    if (target.kind === 'commander') return COUNTER[attacker].commander;
    return COUNTER[attacker].building;
  }

  private tickUnits(attacks: Attack[]): void {
    for (const u of [...this.units()]) {
      this.tickUnit(u, attacks);
    }
  }

  private tickUnit(u: UnitEnt, attacks: Attack[]): void {
    const p = this.players[u.player];
    const { behavior, rally } = this.effectiveOrders(u);
    const vehicle = UNIT_STATS[u.type].accel !== undefined;
    // Artillery is a stationary siege platform when engaged: it never kites
    // and never skirmish-orbits — even if runtime tuning gives it vehicle
    // kinematics (accel), those only apply to travel.
    const artillery = UNIT_STATS[u.type].windupTicks !== undefined;

    // Artillery barrel drifts back down unless actively aiming (the aim branch
    // below raises it +2/tick, so raising nets +1/tick and lowering -1/tick).
    if (u.windup > 0) u.windup--;

    // FALL BACK: retreat, ignore everything.
    if (p.override === 'fall_back') {
      u.targetId = 0;
      if (vehicle) this.vehicleMoveToward(u, rally);
      else this.moveEntityToward(u, rally);
      return;
    }

    const enemies = this.enemiesOf(u.player);
    const rangeMu = this.unitRangeMu(u.player, u.type);
    const minRangeMu = UNIT_STATS[u.type].minRange * FP;

    // Kite: if a visible enemy sits inside our minimum range, back away.
    if (minRangeMu > 0) {
      let nearest: Entity | null = null;
      let nearestD = Infinity;
      for (const e of enemies) {
        const d = dist2(u.pos, e.pos);
        if (d < minRangeMu * minRangeMu && d < nearestD) {
          nearestD = d;
          nearest = e;
        }
      }
      if (nearest) {
        if (artillery) {
          // Artillery never kites — it can't outrun anything that dives it.
          // With a target left in its firing band it digs in and shells over
          // the diver's head; otherwise it halts and waits for the dead zone
          // to clear (the barrel drifts back down meanwhile).
          const hasStandoff = enemies.some((e) => {
            const d = dist2(u.pos, e.pos);
            return d >= minRangeMu * minRangeMu && d <= rangeMu * rangeMu;
          });
          if (!hasStandoff) {
            u.targetId = 0;
            if (vehicle) this.steerVehicle(u, null, false); // roll to a stop
            return;
          }
          // fall through: acquire a band target and keep firing
        } else {
          u.targetId = 0;
          this.kiteAway(u, nearest.pos, rally);
          return;
        }
      }
    }

    // Validate current target.
    let target = u.targetId ? (this.entities.get(u.targetId) ?? null) : null;
    if (target && !this.canTarget(u.player, target)) target = null;
    if (target && behavior === 'guard' && dist(u.pos, rally) > (GUARD_ENGAGE_RADIUS + GUARD_CHASE_LEASH) * FP) {
      target = null; // leash: break off and return
    }
    if (target && behavior === 'hold' && dist2(u.pos, target.pos) > rangeMu * rangeMu) {
      target = null; // hold never chases
    }
    if (target && minRangeMu > 0 && dist2(u.pos, target.pos) < minRangeMu * minRangeMu) {
      target = null; // inside the dead zone: pick something we can actually hit
    }

    // Acquire a new target if needed.
    if (!target) {
      target = this.acquireTarget(u, behavior, rally, enemies, rangeMu);
    }
    u.targetId = target ? target.id : 0;

    if (target) {
      const d2 = dist2(u.pos, target.pos);
      if (d2 <= rangeMu * rangeMu) {
        // burst weapons volley every burstTicks (staggered per unit id), dps preserved
        const cycle = Math.max(1, Math.round(UNIT_STATS[u.type].burstTicks ?? 1));
        const windupTicks = UNIT_STATS[u.type].windupTicks;
        if (windupTicks && UNIT_STATS[u.type].splashRadius) {
          // artillery: raise the barrel first, then lob shells on the burst cycle
          u.windup = Math.min(windupTicks, u.windup + 2);
          if (u.windup >= windupTicks && (this.tick + u.id) % cycle === 0) {
            this.fireShell(u, target, cycle);
          }
        } else if ((this.tick + u.id) % cycle === 0) {
          attacks.push({
            targetId: target.id,
            dmg: this.computeDamage(u, target) * cycle,
            attackerDesc: `enemy ${u.type}`,
            attackerPos: u.pos,
            attackerType: u.type,
            attackerPlayer: u.player,
            attackerId: u.id,
          });
        }
      } else if (behavior !== 'hold' && !vehicle) {
        // Chase (repath periodically or when the target strays from our path goal).
        if (!u.pathGoal || dist2(u.pathGoal, target.pos) > 4 * FP * FP || (this.tick + u.id) % 10 === 0) {
          this.computePath(u, target.pos);
        }
        this.moveEntityToward(u, target.pos);
      }
      // Vehicles never stand and shoot: keep circling the target, guns free.
      // Except artillery — a siege platform brakes and fires from standstill
      // (vehicle kinematics, if tuned on, only govern its travel).
      if (vehicle) {
        if (!artillery) this.skirmish(u, target, rangeMu);
        else if (behavior !== 'hold' && d2 > rangeMu * rangeMu) this.vehicleMoveToward(u, target.pos);
        else this.steerVehicle(u, null, false);
      }
      return;
    }

    // No target: behavior movement.
    if (behavior === 'hunt') {
      const known = this.nearestKnownEnemy(u);
      if (vehicle) this.vehicleMoveToward(u, known);
      else this.moveEntityToward(u, known);
      return;
    }
    // Assault formations hold cohesion until contact: leaders throttle to the
    // group's slowest member so mixed comps hit the line together.
    let cap: number | undefined;
    if (behavior === 'assault' && !this.enemyNear(u, enemies)) {
      cap = this.cohesionCap(u, rally) ?? undefined;
    }
    if (!within(u.pos, rally, FP)) {
      if (vehicle) this.vehicleMoveToward(u, rally, cap);
      else this.moveEntityToward(u, rally, cap);
    } else if (vehicle) {
      this.steerVehicle(u, null, false); // parked: bleed off speed
    }
  }

  private enemyNear(u: UnitEnt, enemies: Entity[]): boolean {
    const r = COHESION_BREAK_RANGE * FP;
    for (const e of enemies) {
      if (within(u.pos, e.pos, r)) return true;
    }
    return false;
  }

  /**
   * Speed cap for an assault unit ahead of its marching group, or null for
   * full speed (alone, behind the pack, or a groupmate is already fighting).
   */
  private cohesionCap(u: UnitEnt, rally: Vec): number | null {
    const R = COHESION_RADIUS * FP;
    let n = 0;
    let cx = 0;
    let cy = 0;
    let slowest = UNIT_STATS[u.type].speed;
    for (const v of this.units(u.player)) {
      if (v.id === u.id || v.behavior !== 'assault') continue;
      if (!within(v.pos, u.pos, R)) continue;
      if (!within(v.rally, rally, 3 * FP)) continue; // marching somewhere else
      if (v.targetId !== 0) return null; // a groupmate engaged: charge
      n++;
      cx += v.pos.x;
      cy += v.pos.y;
      if (UNIT_STATS[v.type].speed < slowest) slowest = UNIT_STATS[v.type].speed;
    }
    if (n === 0) return null;
    const centroid = { x: Math.floor(cx / n), y: Math.floor(cy / n) };
    const aheadBy = dist(centroid, rally) - dist(u.pos, rally);
    if (aheadBy <= COHESION_SLACK * FP) return null; // in or behind the pack
    // slightly under the slowest pace, so the pack compresses rather than
    // holding whatever stretch it already has (slow zones etc. open gaps)
    return pm(Math.floor(slowest * 100), 850);
  }

  private acquireTarget(
    u: UnitEnt,
    behavior: Behavior,
    rally: Vec,
    enemies: Entity[],
    rangeMu: number,
  ): Entity | null {
    const minRangeMu = UNIT_STATS[u.type].minRange * FP;
    let zone: (e: Entity) => boolean;
    switch (behavior) {
      case 'guard':
        zone = (e) => within(e.pos, rally, GUARD_ENGAGE_RADIUS * FP);
        break;
      case 'assault':
        // Engage what's around us — or, for weapons that outrange our own
        // vision (artillery), anything the TEAM has eyes on within gun range.
        zone = (e) => within(e.pos, u.pos, Math.max(UNIT_STATS[u.type].vision * FP, rangeMu));
        break;
      case 'hold':
        zone = (e) => dist2(u.pos, e.pos) <= rangeMu * rangeMu;
        break;
      case 'hunt':
        zone = () => true;
        break;
    }
    // Never pick anything inside the weapon's dead zone.
    const candidates = enemies.filter((e) => zone(e) && dist2(u.pos, e.pos) >= minRangeMu * minRangeMu);
    if (candidates.length === 0) return null;

    // Prefer countered targets among those already in weapon range; otherwise nearest.
    let best: Entity | null = null;
    let bestKey: [number, number, number] | null = null; // [-inRange, -counterMult, dist]
    for (const e of candidates) {
      const d = dist2(u.pos, e.pos);
      const inRange = d <= rangeMu * rangeMu ? 1 : 0;
      const mult = inRange ? this.counterMult(u.type, e) : 0;
      const key: [number, number, number] = [-inRange, -mult, d];
      if (
        !bestKey ||
        key[0] < bestKey[0] ||
        (key[0] === bestKey[0] && (key[1] < bestKey[1] || (key[1] === bestKey[1] && key[2] < bestKey[2])))
      ) {
        bestKey = key;
        best = e;
      }
    }
    return best;
  }

  /**
   * Retreat from a threat without abandoning the advance corridor. The lane
   * is the segment home anchor -> rally (anchor = source fabricator, else
   * bastion, else spawn). Retreat pulls toward a point KITE_LANE_BACKSTEP
   * down the lane from the unit's projection onto it — which both backs it
   * up AND reels lateral drift back in — bent by the threat. Any step that
   * would widen the lateral offset past KITE_CORRIDOR is replaced by a move
   * straight back to the lane, so orbiting chasers can't herd units to the
   * map edge.
   */
  private kiteAway(u: UnitEnt, threat: Vec, rally: Vec): void {
    const step = this.speedMuPerTick(u);
    // Away from the threat, x1000 unit vector.
    const ad = Math.max(1, dist(u.pos, threat));
    const ax = Math.floor(((u.pos.x - threat.x) * 1000) / ad);
    const ay = Math.floor(((u.pos.y - threat.y) * 1000) / ad);
    let dx = ax;
    let dy = ay;

    const src = this.building(u.sourceBuilding);
    const bastion = this.bastion(u.player);
    const anchor = (src ?? bastion)?.pos ?? this.map.spawns[u.player].bastion;
    const lx = rally.x - anchor.x;
    const ly = rally.y - anchor.y;
    const len2 = lx * lx + ly * ly;
    let laneReturn: Vec | null = null;
    if (len2 > 0) {
      // Unit's projection onto the lane (t per-mille), stepped back toward home.
      const t = clamp(Math.floor((((u.pos.x - anchor.x) * lx + (u.pos.y - anchor.y) * ly) * 1000) / len2), 0, 1000);
      const laneLen = Math.max(1, isqrt(len2));
      const rt = Math.max(0, t - Math.floor((KITE_LANE_BACKSTEP * FP * 1000) / laneLen));
      laneReturn = { x: anchor.x + Math.floor((lx * rt) / 1000), y: anchor.y + Math.floor((ly * rt) / 1000) };
      const rd = dist(u.pos, laneReturn);
      if (rd > FP) {
        const rx = Math.floor(((laneReturn.x - u.pos.x) * 1000) / rd);
        const ry = Math.floor(((laneReturn.y - u.pos.y) * 1000) / rd);
        // Blend lane-return with threat avoidance — unless they strongly
        // oppose (threat sits down-lane), then dodge away instead.
        const dot = Math.floor((ax * rx + ay * ry) / 1000);
        if (dot > -500) {
          dx = Math.floor((ax * 400 + rx * 600) / 1000);
          dy = Math.floor((ay * 400 + ry * 600) / 1000);
        }
      }
    }

    const d = isqrt(dx * dx + dy * dy);
    if (d === 0) return;
    let target = { x: u.pos.x + Math.floor((dx * step) / d), y: u.pos.y + Math.floor((dy * step) / d) };

    // Hard corridor limit: never widen the gap past KITE_CORRIDOR.
    if (laneReturn && len2 > 0) {
      const latNow = this.laneOffset(u.pos, anchor, lx, ly, len2);
      const latNew = this.laneOffset(target, anchor, lx, ly, len2);
      if (latNew > KITE_CORRIDOR * FP && latNew > latNow) {
        target = stepToward(u.pos, laneReturn, step);
      }
    }
    const cell = posToCell(target);
    if (!inBounds(this.map, cell.cx, cell.cy)) return;
    const fromIdx = cellIndex(this.map, posToCell(u.pos).cx, posToCell(u.pos).cy);
    const toIdx = cellIndex(this.map, cell.cx, cell.cy);
    if (this.blocked[toIdx]) return;
    if (fromIdx !== toIdx) {
      const ea = this.map.elevation[fromIdx];
      const eb = this.map.elevation[toIdx];
      const ok = ea === eb || ((this.map.ramp[fromIdx] || this.map.ramp[toIdx]) && Math.abs(ea - eb) <= 1);
      if (!ok) return;
    }
    u.pos = target;
    u.path = [];
    u.pathIdx = 0;
    u.pathGoal = null;
  }

  /** Lateral distance (mu) from p to the anchor->rally lane segment. */
  private laneOffset(p: Vec, anchor: Vec, lx: number, ly: number, len2: number): number {
    const t = clamp(Math.floor((((p.x - anchor.x) * lx + (p.y - anchor.y) * ly) * 1000) / len2), 0, 1000);
    const c = { x: anchor.x + Math.floor((lx * t) / 1000), y: anchor.y + Math.floor((ly * t) / 1000) };
    return dist(p, c);
  }

  private nearestKnownEnemy(u: UnitEnt): Vec {
    let best: Vec | null = null;
    let bestD = Infinity;
    for (const lk of this.players[u.player].lastKnown.values()) {
      const d = dist2(u.pos, lk.pos);
      if (d < bestD) {
        bestD = d;
        best = lk.pos;
      }
    }
    return best ?? this.map.spawns[(1 - u.player) as PlayerId].bastion;
  }

  private computeDamage(u: UnitEnt, target: Entity): number {
    let dmg = UNIT_STATS[u.type].dps * 100; // mHP per tick
    dmg = pm(dmg, this.counterMult(u.type, target));
    if (this.elevAt(u.pos) > this.elevAt(target.pos)) dmg = pm(dmg, HIGH_GROUND_DAMAGE);
    if (this.players[u.player].techs.has('mil2')) dmg = pm(dmg, FOCUSED_OPTICS_DAMAGE);
    if (this.hasPointAura(u.player, u.pos, 'targeting_aura')) dmg = pm(dmg, TARGETING_AURA_DAMAGE);
    if (target.kind !== 'building') dmg = pm(dmg, this.damageTakenMult(target));
    return dmg;
  }

  // -- artillery shells -----------------------------------------------------------

  /** Lob an airburst shell at the target's CURRENT position; it will not track. */
  private fireShell(u: UnitEnt, target: Entity, cycle: number): void {
    const s = UNIT_STATS[u.type];
    // Per-shell base damage (dps preserved over the burst cycle). Attacker-side
    // bonuses are baked in at fire time; per-target multipliers apply at burst.
    let dmg = s.dps * 100 * cycle;
    if (this.players[u.player].techs.has('mil2')) dmg = pm(dmg, FOCUSED_OPTICS_DAMAGE);
    if (this.hasPointAura(u.player, u.pos, 'targeting_aura')) dmg = pm(dmg, TARGETING_AURA_DAMAGE);
    const muPerTick = Math.max(1, Math.floor((s.shellSpeed! * FP) / TICKS_PER_SECOND));
    const ticks = Math.max(1, Math.ceil(dist(u.pos, target.pos) / muPerTick));
    this.shells.push({
      player: u.player,
      type: u.type,
      from: { ...u.pos },
      to: { ...target.pos },
      ticksLeft: ticks,
      ticksTotal: ticks,
      dmg,
      splashMu: Math.floor((s.splashRadius ?? 1) * FP),
      attackerId: u.id,
    });
    this.shellLog.push({ from: { ...u.pos }, to: { ...target.pos }, ticks, attackerId: u.id, player: u.player });
  }

  /** Advance in-flight shells; on arrival, airburst: flak every enemy in the splash. */
  private tickShells(attacks: Attack[]): void {
    if (this.shells.length === 0) return;
    const inFlight: ShellState[] = [];
    for (const sh of this.shells) {
      sh.ticksLeft--;
      if (sh.ticksLeft > 0) {
        inFlight.push(sh);
        continue;
      }
      this.burstLog.push({ pos: { ...sh.to }, splashMu: sh.splashMu, player: sh.player });
      for (const e of this.entities.values()) {
        if (e.player === sh.player) continue;
        const hit =
          e.kind === 'building'
            ? this.dist2ToBuilding(sh.to, e) <= sh.splashMu * sh.splashMu
            : within(e.pos, sh.to, sh.splashMu);
        if (!hit) continue;
        // No high-ground or cloak checks: lobbed area fire hits whatever is under the burst.
        let dmg = pm(sh.dmg, this.counterMult(sh.type, e));
        if (e.kind !== 'building') dmg = pm(dmg, this.damageTakenMult(e));
        attacks.push({
          targetId: e.id,
          dmg,
          attackerDesc: `enemy ${sh.type}`,
          attackerPos: sh.to,
          attackerType: sh.type,
          attackerPlayer: sh.player,
          attackerId: sh.attackerId,
        });
      }
    }
    this.shells = inFlight;
  }

  /**
   * Soft flocking (§7): friendly units repel each other slightly so groups
   * clump loosely instead of stacking on one point. Deterministic: pairs in
   * id order, integer displacement, capped per tick.
   */
  private separateUnits(): void {
    const units = [...this.units()];
    const MAX_PUSH = 120; // mu per tick
    for (let i = 0; i < units.length; i++) {
      for (let j = i + 1; j < units.length; j++) {
        const a = units[i];
        const b = units[j];
        if (a.player !== b.player) continue;
        // desired spacing = sum of body radii (big hulls like kumo/oni need room)
        const R = Math.floor(((UNIT_STATS[a.type].radius ?? 0.4) + (UNIT_STATS[b.type].radius ?? 0.4)) * FP);
        const d2 = dist2(a.pos, b.pos);
        if (d2 >= R * R) continue;
        const d = isqrt(d2);
        let dx: number;
        let dy: number;
        if (d === 0) {
          // Perfectly stacked: deterministic axis from ids.
          dx = (a.id + b.id) % 2 === 0 ? 1 : 0;
          dy = 1 - dx;
        } else {
          dx = (b.pos.x - a.pos.x) / d;
          dy = (b.pos.y - a.pos.y) / d;
        }
        const push = Math.min(MAX_PUSH, (R - d) >> 1);
        this.nudge(a, Math.floor(-dx * push), Math.floor(-dy * push));
        this.nudge(b, Math.floor(dx * push), Math.floor(dy * push));
      }
    }
  }

  private nudge(u: UnitEnt, dx: number, dy: number): void {
    const target = { x: u.pos.x + dx, y: u.pos.y + dy };
    const cell = posToCell(target);
    if (!inBounds(this.map, cell.cx, cell.cy)) return;
    const toIdx = cellIndex(this.map, cell.cx, cell.cy);
    if (this.blocked[toIdx]) return;
    const from = posToCell(u.pos);
    const fromIdx = cellIndex(this.map, from.cx, from.cy);
    if (fromIdx !== toIdx) {
      const ea = this.map.elevation[fromIdx];
      const eb = this.map.elevation[toIdx];
      const ok = ea === eb || ((this.map.ramp[fromIdx] || this.map.ramp[toIdx]) && Math.abs(ea - eb) <= 1);
      if (!ok) return;
    }
    u.pos = target;
  }

  // -- watchtowers --------------------------------------------------------------

  private tickTowers(attacks: Attack[]): void {
    for (const b of this.buildings()) {
      if (b.type !== 'watchtower' || !b.done) continue;
      const rangeMu = this.towerRangeMu(b.player);
      let target = b.targetId ? (this.entities.get(b.targetId) ?? null) : null;
      if (target && (target.kind === 'building' || !this.canTarget(b.player, target) || !within(target.pos, b.pos, rangeMu))) {
        target = null;
      }
      if (!target) {
        let bestD = Infinity;
        for (const e of this.enemiesOf(b.player)) {
          if (e.kind === 'building') continue; // towers shoot units/commanders
          const d = dist2(b.pos, e.pos);
          if (d <= rangeMu * rangeMu && d < bestD) {
            bestD = d;
            target = e;
          }
        }
      }
      b.targetId = target ? target.id : 0;
      if (target) {
        let dmg = BUILDING_STATS.watchtower.dps! * 100;
        if (this.elevAt(b.pos) > this.elevAt(target.pos)) dmg = pm(dmg, HIGH_GROUND_DAMAGE);
        dmg = pm(dmg, this.damageTakenMult(target));
        attacks.push({
          targetId: target.id,
          dmg,
          attackerDesc: 'enemy watchtower',
          attackerPos: b.pos,
          attackerType: 'watchtower',
          attackerPlayer: b.player,
          attackerId: b.id,
        });
      }
    }
  }

  // -- damage -------------------------------------------------------------------

  private applyAttacks(attacks: Attack[]): void {
    this.attackLog = [];
    for (const a of attacks) {
      const t = this.entities.get(a.targetId);
      if (!t) continue;
      this.attackLog.push({
        from: { ...a.attackerPos },
        to: { ...t.pos },
        targetId: t.id,
        attackerId: a.attackerId,
        attackerType: a.attackerType,
        player: a.attackerPlayer,
      });
      t.hp -= a.dmg;
      if (t.kind === 'commander') {
        t.lastDamageTick = this.tick;
        this.notifyUnderAttack(t.player, `Commander under attack at ${this.fmtPos(t.pos)}`);
      } else if (t.kind === 'building' && t.type === 'bastion') {
        this.notifyUnderAttack(t.player, `Bastion under attack`);
      }
      if (t.hp <= 0 && this.entities.has(t.id)) {
        this.handleDeath(t, a);
      }
    }
  }

  private notifyUnderAttack(player: PlayerId, msg: string): void {
    const p = this.players[player];
    if (this.tick - p.underAttackTick > 10 * TICKS_PER_SECOND) {
      p.underAttackTick = this.tick;
      this.event(player, msg);
    }
  }

  private handleDeath(t: Entity, cause: Attack): void {
    const owner = t.player;
    const enemy = (1 - owner) as PlayerId;
    if (t.kind === 'unit') {
      this.event(owner, `unit ${t.id} (${t.type}) destroyed by ${cause.attackerDesc} at ${this.fmtPos(t.pos)}`);
    } else if (t.kind === 'building') {
      this.event(owner, `${t.type} destroyed at ${this.fmtPos(t.pos)}`);
      this.event(enemy, `destroyed enemy ${t.type} at ${this.fmtPos(t.pos)}`);
    } else {
      this.event(owner, `COMMANDER DESTROYED`);
      this.event(enemy, `enemy commander destroyed at ${this.fmtPos(t.pos)}`);
      if (this.winReason === null) this.winReason = cause.attackerDesc;
    }
    this.removeEntity(t.id);
  }

  private tickRegen(): void {
    for (const player of [0, 1] as PlayerId[]) {
      const c = this.commander(player);
      if (!c || !this.players[player].techs.has('cmd2')) continue;
      if (this.tick - c.lastDamageTick >= NANOWEAVE_DELAY_SECONDS * TICKS_PER_SECOND) {
        c.hp = Math.min(c.maxHp, c.hp + Math.floor((NANOWEAVE_REGEN * FP) / TICKS_PER_SECOND));
      }
    }
  }

  // -- capture points -------------------------------------------------------------

  private tickCapturePoints(): void {
    for (const cp of this.capturePoints) {
      const weights: [number, number] = [0, 0];
      for (const e of this.entities.values()) {
        if (e.kind === 'building') continue;
        if (!within(e.pos, cp.pos, CAPTURE_RADIUS * FP)) continue;
        weights[e.player] += e.kind === 'commander' ? 2 : 1;
      }
      cp.contested = weights[0] > 0 && weights[1] > 0;
      if (cp.contested || (weights[0] === 0 && weights[1] === 0)) continue;

      const side: PlayerId = weights[0] > 0 ? 0 : 1;
      const w = Math.min(CAPTURE_MAX_RATE, weights[side]);
      let rate = Math.floor((w * CAPTURE_METER_MAX) / (CAPTURE_BASE_SECONDS * TICKS_PER_SECOND));
      if (this.players[side].techs.has('eco2')) rate = pm(rate, GRID_TAP_CAPTURE_RATE);

      if (cp.owner === side) {
        cp.meter = Math.min(CAPTURE_METER_MAX, cp.meter + rate);
      } else if (cp.owner !== -1 || (cp.meterSide !== -1 && cp.meterSide !== side && cp.meter > 0)) {
        // Neutralize the other side's progress/ownership.
        cp.meter -= rate;
        if (cp.meter <= 0) {
          if (cp.owner !== -1) {
            this.event(cp.owner, `capture point '${cp.id}' lost`);
            this.event(side, `capture point '${cp.id}' neutralized`);
          }
          cp.owner = -1;
          cp.meterSide = side;
          cp.meter = 0;
        }
      } else {
        cp.meterSide = side;
        cp.meter += rate;
        if (cp.meter >= CAPTURE_METER_MAX) {
          cp.meter = CAPTURE_METER_MAX;
          cp.owner = side;
          this.event(side, `capture point '${cp.id}' captured`);
          this.event((1 - side) as PlayerId, `enemy captured point '${cp.id}'`);
        }
      }
    }
  }

  // -- vision ----------------------------------------------------------------------

  private recomputeVision(): void {
    for (const player of [0, 1] as PlayerId[]) {
      const p = this.players[player];
      p.visible.fill(0);
      for (const e of this.entities.values()) {
        if (e.player !== player) continue;
        if (e.kind === 'unit') {
          this.stampVision(p.visible, e.pos, UNIT_STATS[e.type].vision, false);
        } else if (e.kind === 'commander') {
          this.stampVision(p.visible, e.pos, COMMANDER.vision, false);
        } else if (e.done) {
          const seeAll = e.type === 'sensor_spire';
          this.stampVision(p.visible, e.pos, BUILDING_STATS[e.type].vision, seeAll);
        }
      }
      for (const cp of this.capturePoints) {
        if (cp.owner !== player) continue;
        const r = cp.buffs.includes('uplink') ? CAPTURE_UPLINK_VISION : CAPTURE_POINT_VISION;
        this.stampVision(p.visible, cp.pos, r, false);
      }
    }
    this.updateLastKnown();
  }

  private stampVision(grid: Uint8Array, pos: Vec, radiusU: number, seeAllElevations: boolean): void {
    const { cx, cy } = posToCell(pos);
    const srcElev = this.map.elevation[cellIndex(this.map, cx, cy)];
    const r = radiusU;
    for (let dy = -r; dy <= r; dy++) {
      const ny = cy + dy;
      if (ny < 0 || ny >= this.map.size) continue;
      for (let dx = -r; dx <= r; dx++) {
        const nx = cx + dx;
        if (nx < 0 || nx >= this.map.size) continue;
        if (dx * dx + dy * dy > r * r) continue;
        const idx = ny * this.map.size + nx;
        if (!seeAllElevations && this.map.elevation[idx] > srcElev) continue; // no vision up cliffs
        grid[idx] = 1;
      }
    }
  }

  private updateLastKnown(): void {
    for (const player of [0, 1] as PlayerId[]) {
      const p = this.players[player];
      const enemy = (1 - player) as PlayerId;
      for (const b of this.buildings(enemy)) {
        if (this.cellVisible(player, b.pos)) {
          p.lastKnown.set(b.id, { type: b.type, pos: { ...b.pos }, tick: this.tick, done: b.done });
        }
      }
      for (const [id, lk] of [...p.lastKnown]) {
        if (this.cellVisible(player, lk.pos)) {
          const e = this.entities.get(id);
          if (!e) p.lastKnown.delete(id);
          else p.lastKnown.set(id, { type: lk.type, pos: lk.pos, tick: this.tick, done: (e as BuildingEnt).done });
        }
      }
    }
  }

  // -- win ----------------------------------------------------------------------------

  private checkWinner(): void {
    const c0 = this.commander(0);
    const c1 = this.commander(1);
    if (c0 && c1) return;
    if (!c0 && !c1) this.winner = -1;
    else if (!c0) this.winner = 1;
    else this.winner = 0;
  }

  // -- serialization -------------------------------------------------------------------

  /** Full deterministic state digest (for tests/replay verification). */
  stateHash(): string {
    const ents = [...this.entities.values()].map((e) => {
      if (e.kind === 'unit') {
        return ['u', e.id, e.player, e.type, e.pos.x, e.pos.y, e.hp, e.targetId, e.behavior, e.heading.x, e.heading.y, e.speedMu, e.windup];
      }
      if (e.kind === 'commander') {
        return ['c', e.id, e.player, e.pos.x, e.pos.y, e.hp, e.tasks.length, e.stillTicks];
      }
      return ['b', e.id, e.player, e.type, e.pos.x, e.pos.y, e.hp, e.done ? 1 : 0, e.buildTicks, e.starved ? 1 : 0, e.on ? 1 : 0];
    });
    const players = this.players.map((p) => [
      p.energy,
      [...p.techs].sort(),
      p.research ? [p.research.tech, p.research.ticksLeft] : null,
      p.override,
    ]);
    const cps = this.capturePoints.map((cp) => [cp.id, cp.owner, cp.meterSide, cp.meter, cp.buffs]);
    const shells = this.shells.map((s) => [s.player, s.type, s.from.x, s.from.y, s.to.x, s.to.y, s.ticksLeft, s.dmg, s.splashMu]);
    return JSON.stringify([this.tick, players, cps, ents, shells, this.prng.serialize()]);
  }
}
