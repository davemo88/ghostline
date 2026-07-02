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
  prodTicksLeft: number; // -1 = idle (waiting for energy)
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
      prodTicksLeft: -1,
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
        const rate = p.techs.has('cmd1') ? SERVO_BUILD_RATE : 1000;
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
          if (b.production !== a.unit && b.prodTicksLeft >= 0) {
            // Changing type cancels in-progress unit, refunding its cost.
            p.energy += UNIT_STATS[b.production].cost * FP;
            b.prodTicksLeft = -1;
          }
          b.production = a.unit;
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
  private moveEntityToward(e: UnitEnt | CommanderEnt, goal: Vec): 'moving' | 'arrived' | 'stuck' {
    if (within(e.pos, goal, ARRIVE_TOLERANCE_MU)) return 'arrived';
    if (!e.pathGoal || dist2(e.pathGoal, goal) > FP * FP) {
      this.computePath(e, goal);
    }
    let step = this.speedMuPerTick(e);
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

  // -- production ----------------------------------------------------------------

  private tickProduction(): void {
    for (const b of [...this.buildings()]) {
      if (b.type !== 'fabricator' || !b.done || !b.on) continue;
      const p = this.players[b.player];
      if (b.prodTicksLeft < 0) {
        const cost = UNIT_STATS[b.production].cost * FP;
        if (p.energy >= cost) {
          p.energy -= cost;
          b.prodTicksLeft = UNIT_STATS[b.production].buildTime * TICKS_PER_SECOND;
        }
      } else if (--b.prodTicksLeft <= 0) {
        b.prodTicksLeft = -1;
        this.spawnUnit(b.player, b.production, b);
      }
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

    // FALL BACK: retreat, ignore everything.
    if (p.override === 'fall_back') {
      u.targetId = 0;
      this.moveEntityToward(u, rally);
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
        u.targetId = 0;
        this.kiteAway(u, nearest.pos);
        return;
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

    // Acquire a new target if needed.
    if (!target) {
      target = this.acquireTarget(u, behavior, rally, enemies, rangeMu);
    }
    u.targetId = target ? target.id : 0;

    if (target) {
      const d2 = dist2(u.pos, target.pos);
      if (d2 <= rangeMu * rangeMu) {
        attacks.push({
          targetId: target.id,
          dmg: this.computeDamage(u, target),
          attackerDesc: `enemy ${u.type}`,
          attackerPos: u.pos,
        });
      } else if (behavior !== 'hold') {
        // Chase (repath periodically or when the target strays from our path goal).
        if (!u.pathGoal || dist2(u.pathGoal, target.pos) > 4 * FP * FP || (this.tick + u.id) % 10 === 0) {
          this.computePath(u, target.pos);
        }
        this.moveEntityToward(u, target.pos);
      }
      return;
    }

    // No target: behavior movement.
    if (behavior === 'hunt') {
      const known = this.nearestKnownEnemy(u);
      this.moveEntityToward(u, known);
      return;
    }
    if (!within(u.pos, rally, FP)) {
      this.moveEntityToward(u, rally);
    }
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
        zone = (e) => within(e.pos, u.pos, UNIT_STATS[u.type].vision * FP);
        break;
      case 'hold':
        zone = (e) => {
          const d = dist2(u.pos, e.pos);
          return d <= rangeMu * rangeMu && d >= minRangeMu * minRangeMu;
        };
        break;
      case 'hunt':
        zone = () => true;
        break;
    }
    const candidates = enemies.filter(zone);
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

  private kiteAway(u: UnitEnt, threat: Vec): void {
    const dx = u.pos.x - threat.x;
    const dy = u.pos.y - threat.y;
    const d = Math.max(1, dist(u.pos, threat));
    const step = this.speedMuPerTick(u);
    const target = { x: u.pos.x + Math.floor((dx * step) / d), y: u.pos.y + Math.floor((dy * step) / d) };
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

  /**
   * Soft flocking (§7): friendly units repel each other slightly so groups
   * clump loosely instead of stacking on one point. Deterministic: pairs in
   * id order, integer displacement, capped per tick.
   */
  private separateUnits(): void {
    const units = [...this.units()];
    const R = 800; // mu — desired minimum spacing
    const MAX_PUSH = 120; // mu per tick
    for (let i = 0; i < units.length; i++) {
      for (let j = i + 1; j < units.length; j++) {
        const a = units[i];
        const b = units[j];
        if (a.player !== b.player) continue;
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
        attacks.push({ targetId: target.id, dmg, attackerDesc: 'enemy watchtower', attackerPos: b.pos });
      }
    }
  }

  // -- damage -------------------------------------------------------------------

  private applyAttacks(attacks: Attack[]): void {
    for (const a of attacks) {
      const t = this.entities.get(a.targetId);
      if (!t) continue;
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
        return ['u', e.id, e.player, e.type, e.pos.x, e.pos.y, e.hp, e.targetId, e.behavior];
      }
      if (e.kind === 'commander') {
        return ['c', e.id, e.player, e.pos.x, e.pos.y, e.hp, e.tasks.length, e.stillTicks];
      }
      return ['b', e.id, e.player, e.type, e.pos.x, e.pos.y, e.hp, e.done ? 1 : 0, e.buildTicks, e.prodTicksLeft, e.on ? 1 : 0];
    });
    const players = this.players.map((p) => [
      p.energy,
      [...p.techs].sort(),
      p.research ? [p.research.tech, p.research.ticksLeft] : null,
      p.override,
    ]);
    const cps = this.capturePoints.map((cp) => [cp.id, cp.owner, cp.meterSide, cp.meter, cp.buffs]);
    return JSON.stringify([this.tick, players, cps, ents, this.prng.serialize()]);
  }
}
