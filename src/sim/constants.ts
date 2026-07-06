// GHOSTLINE sim core — tuning data. All values from DESIGN_2.md.
// Fixed-point conventions:
//   positions/distances: milli-units (mu), FP = 1000 per world unit
//   hp: milli-HP (mHP)
//   energy: milli-energy (me)
//   multipliers: per-mille (1000 = 1.0x)

export const TICKS_PER_SECOND = 10;
export const FP = 1000; // fixed-point scale for world units
export const MAP_SIZE = 180; // world units, square
export const STARTING_ENERGY = 200 * 1000; // me

export type UnitType = 'ronin' | 'oni' | 'mantis' | 'wasp' | 'kumo' | 'kaze' | 'taiko';
export type BuildingType =
  | 'bastion'
  | 'extractor'
  | 'fabricator'
  | 'watchtower'
  | 'sensor_spire'
  | 'aegis_projector';

export interface UnitStats {
  cost: number; // e — units insta-build on the wave cycle; energy is the only throttle
  hp: number; // HP
  dps: number; // HP/s
  range: number; // u
  minRange: number; // u (0 = none)
  speed: number; // u/s
  vision: number; // u
  burstTicks?: number; // fires one volley every N ticks, dps preserved (default 1 = every tick)
  radius?: number; // u — body radius for separation/flocking (default 0.4)
  // Vehicle kinematics — defining accel makes the unit drive instead of walk:
  // it accelerates/brakes, turns at a speed-limited rate, and skirmishes
  // (orbits its target while firing) instead of standing to shoot.
  accel?: number; // u/s^2
  decel?: number; // u/s^2 (braking)
  turnRate?: number; // deg/s at standstill
  turnRateMin?: number; // deg/s at max speed (faster = wider arcs)
  // Artillery — defining these makes the unit lob airburst shells instead of
  // direct fire: it must raise its barrel (windup) before it can shoot, and
  // each shell flies to where the target WAS at fire time, then bursts above
  // the ground, hitting everything in the splash radius (even cloaked).
  windupTicks?: number; // ticks of barrel-raise before the first shot (lowers at half rate)
  splashRadius?: number; // u — airburst flak radius around the impact point
  shellSpeed?: number; // u/s — projectile flight speed
}

export const UNIT_STATS: Record<UnitType, UnitStats> = {
  ronin: { cost: 50, hp: 120, dps: 12, range: 8, minRange: 0, speed: 5.5, vision: 12, radius: 0.4 },
  oni: { cost: 120, hp: 400, dps: 20, range: 10, minRange: 0, speed: 3.5, vision: 10, radius: 0.75 },
  mantis: { cost: 100, hp: 90, dps: 25, range: 22, minRange: 6, speed: 3.0, vision: 10, radius: 0.35 },
  wasp: { cost: 40, hp: 60, dps: 8, range: 6, minRange: 0, speed: 8.0, vision: 14, radius: 0.3 },
  kumo: { cost: 80, hp: 150, dps: 16, range: 12, minRange: 0, speed: 4.5, vision: 12, burstTicks: 8, radius: 0.8 },
  kaze: { cost: 60, hp: 80, dps: 10, range: 7, minRange: 0, speed: 10.0, vision: 13,
    accel: 5, decel: 12, turnRate: 300, turnRateMin: 70, radius: 0.5 },
  taiko: { cost: 140, hp: 130, dps: 14, range: 28, minRange: 9, speed: 2.2, vision: 11,
    burstTicks: 40, radius: 0.7, windupTicks: 20, splashRadius: 3.5, shellSpeed: 14 },
};

// Counter multipliers, per-mille, attacker -> defender. Buildings and the
// Commander use the 'building'/'commander' columns.
export const COUNTER: Record<UnitType, Record<UnitType | 'building' | 'commander', number>> = {
  ronin: { ronin: 1000, oni: 600, mantis: 1500, wasp: 1200, kumo: 800, kaze: 1000, taiko: 1100, building: 800, commander: 1000 },
  oni: { ronin: 1500, oni: 1000, mantis: 800, wasp: 800, kumo: 1400, kaze: 800, taiko: 700, building: 1200, commander: 1000 },
  mantis: { ronin: 800, oni: 1500, mantis: 1000, wasp: 500, kumo: 1200, kaze: 700, taiko: 800, building: 1500, commander: 1000 },
  wasp: { ronin: 700, oni: 500, mantis: 1000, wasp: 1000, kumo: 700, kaze: 1000, taiko: 1300, building: 1500, commander: 1000 },
  // light spider tank: twin LMGs shred light units, useless into armor/structures
  kumo: { ronin: 1400, oni: 600, mantis: 1100, wasp: 1400, kumo: 1000, kaze: 1400, taiko: 1200, building: 600, commander: 1000 },
  // skirmish bike: runs down artillery and raiders, melts if it drives into guns
  kaze: { ronin: 900, oni: 700, mantis: 1400, wasp: 1100, kumo: 700, kaze: 1000, taiko: 1500, building: 700, commander: 1000 },
  // siege artillery: airburst flak wrecks big slow hulls and structures; fast movers dodge the falling shells
  taiko: { ronin: 900, oni: 1300, mantis: 1200, wasp: 500, kumo: 1100, kaze: 400, taiko: 1000, building: 1600, commander: 1000 },
};

export interface BuildingStats {
  cost: number; // e
  buildTime: number; // s
  hp: number; // HP
  footprint: number; // side length in u (square, axis-aligned)
  vision: number; // u
  dps?: number;
  range?: number;
  auraRadius?: number;
}

/** All fabricators release finished units together on this shared cycle (s). */
export let WAVE_INTERVAL = 10;
/** Debug tuning hook — the sim reads WAVE_INTERVAL every tick, so this applies live. */
export function setWaveInterval(s: number): void {
  WAVE_INTERVAL = Math.max(1, Math.round(s));
}

// Assault cohesion: en route to rally, units pace themselves to the group's
// slowest member so mixed comps arrive together instead of trickling in.
export const COHESION_RADIUS = 9; // u — groupmates considered within this range
export const COHESION_SLACK = 1.5; // u — how far ahead of the pack a unit may run free
export const COHESION_BREAK_RANGE = 15; // u — a visible enemy this close releases the formation

export const BUILDING_STATS: Record<BuildingType, BuildingStats> = {
  bastion: { cost: 0, buildTime: 0, hp: 1500, footprint: 6, vision: 12 },
  extractor: { cost: 60, buildTime: 10, hp: 250, footprint: 3, vision: 12 },
  fabricator: { cost: 150, buildTime: 20, hp: 500, footprint: 4, vision: 12 },
  watchtower: { cost: 100, buildTime: 15, hp: 350, footprint: 2, vision: 12, dps: 18, range: 16 },
  sensor_spire: { cost: 80, buildTime: 12, hp: 150, footprint: 2, vision: 30 },
  aegis_projector: { cost: 140, buildTime: 15, hp: 300, footprint: 3, vision: 12, auraRadius: 14 },
};

export const COMMANDER = {
  hp: 300,
  speed: 6,
  vision: 16,
  buildRate: 1, // construction seconds per second of channeling (Servo Boost: 1.2)
  repairHpPerSecond: 20,
  repairEnergyPerHp: 0.25, // 1 e per 4 HP
  interactRange: 1.5, // u beyond building footprint edge
};

export const BLUEPRINT_HP_FRACTION = 250; // per-mille of final HP while under construction
export const CANCEL_REFUND = 750; // per-mille of cost refunded on cancel

// Economy (e/s)
export const INCOME = {
  bastionTrickle: 3,
  bastionTrickleDeepCycle: 7,
  extractor: 6,
  extractorOverclocked: 8,
  gridFeed: 3,
  gridFeedTapped: 5,
};

// Terrain
export const HIGH_GROUND_DAMAGE = 1250; // per-mille, attacker above target
export const SLOW_ZONE_SPEED = 700; // per-mille
export const BUILDING_VISION_DEFAULT = 12;

// Capture points
export const CAPTURE_RADIUS = 8; // u
export const CAPTURE_BASE_SECONDS = 10; // solo unit, full meter
export const CAPTURE_POINT_VISION = 10; // u, held point without Uplink
export const CAPTURE_UPLINK_VISION = 20; // u
export const CAPTURE_MAX_RATE = 3; // cap on stacked capture speed
export const CAPTURE_METER_MAX = 1_000_000; // fixed-point meter

export type CaptureBuff = 'grid_feed' | 'uplink' | 'targeting_aura' | 'drive_aura' | 'shield_aura';
export const CAPTURE_BUFF_POOL: CaptureBuff[] = [
  'grid_feed',
  'uplink',
  'targeting_aura',
  'drive_aura',
  'shield_aura',
];
export const CAPTURE_AURA_RADIUS = 14; // u, for targeting/drive/shield auras

// Aura strengths (per-mille multipliers)
export const AEGIS_DAMAGE_TAKEN = 800; // -20%
export const SHIELD_AURA_DAMAGE_TAKEN = 850; // -15%
export const TARGETING_AURA_DAMAGE = 1150; // +15%
export const DRIVE_AURA_SPEED = 1200; // +20%

// Tech tree
export type TechId =
  | 'eco1' | 'eco2' | 'eco3'
  | 'mil1' | 'mil2' | 'mil3'
  | 'cmd1' | 'cmd2' | 'cmd3';

export interface TechDef {
  id: TechId;
  name: string;
  cost: number; // e
  time: number; // s
  requires: TechId | null;
}

export const TECHS: Record<TechId, TechDef> = {
  eco1: { id: 'eco1', name: 'Overclocked Extraction', cost: 100, time: 30, requires: null },
  eco2: { id: 'eco2', name: 'Grid Tap', cost: 150, time: 45, requires: 'eco1' },
  eco3: { id: 'eco3', name: 'Deep Cycle', cost: 250, time: 60, requires: 'eco2' },
  mil1: { id: 'mil1', name: 'Hardened Frames', cost: 100, time: 30, requires: null },
  mil2: { id: 'mil2', name: 'Focused Optics', cost: 150, time: 45, requires: 'mil1' },
  mil3: { id: 'mil3', name: 'Ballistic Extension', cost: 200, time: 60, requires: 'mil2' },
  cmd1: { id: 'cmd1', name: 'Servo Boost', cost: 100, time: 30, requires: null },
  cmd2: { id: 'cmd2', name: 'Nanoweave', cost: 150, time: 45, requires: 'cmd1' },
  cmd3: { id: 'cmd3', name: 'Thermoptic Veil', cost: 250, time: 60, requires: 'cmd2' },
};

// Tech effect magnitudes
export const HARDENED_FRAMES_HP = 1150; // per-mille unit HP
export const FOCUSED_OPTICS_DAMAGE = 1150; // per-mille unit damage
export const BALLISTIC_MANTIS_RANGE = 26; // u (from 22)
export const BALLISTIC_WATCHTOWER_RANGE = 19; // u (from 16)
export const SERVO_COMMANDER_SPEED = 7; // u/s (from 6)
export const SERVO_BUILD_RATE = 1200; // per-mille channel speed
export const GRID_TAP_CAPTURE_RATE = 1500; // per-mille capture speed
export const NANOWEAVE_REGEN = 2; // HP/s
export const NANOWEAVE_DELAY_SECONDS = 5; // s without damage
export const VEIL_STILL_SECONDS = 2; // s stationary before cloak

// Behaviors
export type Behavior = 'guard' | 'assault' | 'hold' | 'hunt';
export const GUARD_ENGAGE_RADIUS = 15; // u from rally
export const GUARD_CHASE_LEASH = 10; // u past engage radius

export type OverrideStance = 'fall_back' | 'defend' | 'release';

// Kiting (min-range units backing off a close threat): retreat runs back down
// the unit's advance lane — the segment from its home anchor (source
// fabricator, else bastion) to its rally — and may not wander further than
// this to the side of it. Stops orbiting chasers herding units to map edges.
export const KITE_CORRIDOR = 10; // u — max lateral offset from the lane while kiting
export const KITE_LANE_BACKSTEP = 5; // u — how far down-lane the retreat point sits

// Vision recompute cadence (ticks)
export const VISION_INTERVAL = 5;
