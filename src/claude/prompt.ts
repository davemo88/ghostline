// System prompt for the Claude player (§13.4): rules digest + map digest +
// doctrine, kept under ~2K tokens. Generated from sim constants so numbers
// never drift from the engine. The string is deterministic per match, which
// makes it prompt-cache friendly (rules + map are the stable prefix).


import {
  BUILDING_STATS,
  COHESION_BREAK_RANGE,
  COMMANDER,
  COUNTER,
  FP,
  type Game,
  TECHS,
  UNIT_STATS,
  type UnitType,
  WAVE_INTERVAL,
} from '../sim';
const UNIT_TYPES: UnitType[] = ['ronin', 'oni', 'mantis', 'wasp', 'kumo', 'kaze', 'taiko'];

function unitTable(): string {
  const rows = UNIT_TYPES.map((t) => {
    const s = UNIT_STATS[t];
    const arty = s.windupTicks
      ? ` | ARTILLERY: airburst splash r${s.splashRadius} (hits cloaked), ${s.windupTicks / 10}s barrel-raise before firing, 1 shell/${(s.burstTicks ?? 1) / 10}s, shells take flight time and land where the target WAS at fire time — moving targets dodge, clumps and buildings don't. Never retreats: keeps shelling while anything is in its firing band, and stands helpless against enemies inside min range — screen it, or counter it by diving inside min${s.minRange}`
      : '';
    return `${t}: ${s.cost}e | ${s.hp}hp ${s.dps}dps rng${s.range}${s.minRange ? `(min${s.minRange})` : ''} spd${s.speed} vis${s.vision}${arty}`;
  });
  return rows.join('\n');
}

function counterTable(): string {
  const cols: (UnitType | 'building' | 'commander')[] = [...UNIT_TYPES, 'building'];
  const rows = UNIT_TYPES.map(
    (a) => `${a} -> ` + cols.map((d) => `${d}:${COUNTER[a][d] / 1000}x`).join(' '),
  );
  return rows.join('\n');
}

function buildingTable(): string {
  return Object.entries(BUILDING_STATS)
    .filter(([k]) => k !== 'bastion')
    .map(([k, s]) => {
      let extra = '';
      if (k === 'watchtower') extra = ` turret ${s.dps}dps rng${s.range}`;
      if (k === 'sensor_spire') extra = ` vision ${s.vision}, reveals cloaked commanders`;
      if (k === 'aegis_projector') extra = ` aura r${s.auraRadius}: friendly units -20% dmg taken`;
      if (k === 'extractor') extra = ` +6e/s, must be on a resource node`;
      if (k === 'fabricator') extra = ` unit production`;
      return `${k}: ${s.cost}e ${s.buildTime}s ${s.hp}hp${extra}`;
    })
    .join('\n');
}

function techTable(): string {
  return Object.values(TECHS)
    .map((t) => `${t.id} (${t.name}): ${t.cost}e ${t.time}s${t.requires ? ` requires ${t.requires}` : ''}`)
    .join('\n');
}

function mapDigest(game: Game): string {
  const nodes = game.map.nodes.map((n) => `[${n.x / FP},${n.y / FP}]`).join(' ');
  const cps = game.capturePoints
    .map((cp) => `${cp.id} at [${cp.pos.x / FP},${cp.pos.y / FP}] buffs: ${cp.buffs.join('+')}`)
    .join('; ');
  const spawns = game.map.spawns
    .map((s, i) => `P${i} bastion [${s.bastion.x / FP},${s.bastion.y / FP}]`)
    .join(', ');
  return `Map "Junction 9", 180x180, point-symmetric. ${spawns}.
Each base sits on a high plateau (elev 2) reachable ONLY via ramps: a main diagonal ramp toward the center, a north ramp (P0; mirrored for P1) and an east ramp. Mid-elevation flank plateaus (elev 1) at [30,150] and [150,30] hold the flank capture points, each with two ramp entries. Center valley is LOW ground with a slow zone (0.7x speed, radius 18 around [90,90]).
High ground: +25% damage vs lower targets; no vision up cliffs without a sensor spire.
Resource nodes (extractor sites): ${nodes} (first two per side are in-base + natural; center pair is contested, inside the slow zone).
Capture points (radius 8, ~10s to take, commander captures 2x): ${cps}. Buffs apply while held; grid_feed +3e/s, uplink vision r20, targeting/drive/shield auras r14 around the point.`;
}

export function buildSystemPrompt(game: Game, decisionInterval: number): string {
  return `You are playing GHOSTLINE, a 1v1 RTS. You command ONE unit: your Commander (unarmed, 300hp, speed ${COMMANDER.speed}). You WIN by destroying the enemy Commander; you LOSE if yours dies. Losing your Bastion is not defeat but removes research, trickle income, and the Global Override console.

CORE LOOP: Your Commander must physically walk to buildings to change them (the engine auto-queues the walking). Building = the Commander channels next to a blueprint; leaving pauses construction. Everything spends one resource: energy. Bastion trickles +3e/s; extractors +6e/s.

UNITS (cost/buildtime | stats):
${unitTable()}

COUNTER MULTIPLIERS (attacker -> defender). Ronin > Mantis > Oni > Ronin. Wasp: fast raider/scout, best vs buildings and hunting Commanders:
${counterTable()}

BUILDINGS:
${buildingTable()}

FABRICATORS: every ${WAVE_INTERVAL}s the wave fires (both players simultaneously) — each ON fabricator that can afford its unit's cost instantly builds and deploys it. Energy is the only throttle. When energy is short, OLDEST fabricators get funded first (greedy: a cheaper unit later in line can still release); skipped ones are flagged skippedLastWave. Units inherit the fabricator's rally point + behavior and follow live changes to them. Behaviors: guard (fight within 15 of rally, leash 10), assault (attack-move to rally; holds formation pace with nearby groupmates until enemies are within ${COHESION_BREAK_RANGE}), hold (never chase), hunt (seek nearest known enemy anywhere).

GLOBAL OVERRIDE (Commander at Bastion): fall_back (all units retreat, no fighting) / defend (all guard the Bastion) / release.

TECH (researched at Bastion, one at a time, continues unattended):
${techTable()}
Effects: eco1 extractors 8e/s; eco2 grid_feed 5e/s +50% capture; eco3 trickle 7e/s + free repairs; mil1 +15% unit hp; mil2 +15% unit dmg; mil3 mantis range 26, towers 19; cmd1 commander speed 7 + 20% faster building; cmd2 commander regen 2hp/s out of combat; cmd3 cloak while standing still >=2s (spires reveal).

${mapDigest(game)}

FOG: you see only what your units/buildings/held points see. Enemy buildings you scouted persist as stale "lastKnown" entries (ageSeconds). Enemy units are only visible live.

COMMANDS (respond with a JSON object {memo, commands}). Commands queue in order; the engine walks your Commander wherever needed. Illegal commands are dropped and reported back in invalidCommands next turn:
- {"cmd":"move","pos":[x,y]}  (add "replace":true to cancel the current queue first)
- {"cmd":"stop"}
- {"cmd":"build","type":"extractor|fabricator|watchtower|sensor_spire|aegis_projector","pos":[x,y]}  (cost charged immediately; extractors only on nodes)
- {"cmd":"resume_build","building":id} / {"cmd":"cancel_build","building":id}  (75% refund)
- {"cmd":"repair","building":id}
- {"cmd":"set_rally","building":id,"pos":[x,y]}
- {"cmd":"set_behavior","building":id,"behavior":"guard|assault|hold|hunt"}
- {"cmd":"set_production","building":id,"unit":"ronin|oni|mantis|wasp|kumo|kaze|taiko","on":true}
- {"cmd":"research","tech":"eco1|...|cmd3"}
- {"cmd":"global_override","stance":"fall_back|defend|release"}

DOCTRINE:
- You act every ${decisionInterval}s of game time; between turns your standing orders run. Prefer robust standing orders (rally + behavior) over micro.
- Economy first ~2 min: extractor on your base node, then the natural; a fabricator early. Then contest capture points by their rolled buffs.
- NEVER idle the Commander in danger; it is your win condition. Escort it or keep it home when the enemy has wasps. Forward-building is powerful but risks everything.
- Composition beats mass: check what the enemy builds and produce its counter. Mantis behind ronin holds ground; wasps snipe careless Commanders and raid extractors.
- The memo is your only memory. Keep a running plan, scouting notes (enemy comp, tech guesses), and timers in it. Update it every turn; keep it under 200 words.`;
}
