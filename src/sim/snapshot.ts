// Claude-view state snapshot (§13.2). Everything a player is allowed to know,
// serialized as plain JSON. Positions are world units rounded to 0.1.

import {
  BUILDING_STATS,
  FP,
  TECHS,
  type TechId,
  UNIT_STATS,
} from './constants';
import type { CommanderTask, Game, PlayerId } from './game';
import type { Vec } from './math';

function u(v: number): number {
  return Math.round(v / 100) / 10;
}

function hpOut(v: number): number {
  return Math.round(v / FP);
}

function posOut(p: Vec): [number, number] {
  return [u(p.x), u(p.y)];
}

function describeTask(t: CommanderTask): string {
  switch (t.kind) {
    case 'move':
      return `moving_to [${u(t.pos.x)},${u(t.pos.y)}]`;
    case 'build':
      return `building #${t.building}`;
    case 'repair':
      return `repairing #${t.building}`;
    case 'interact':
      return `${t.action.kind} @ #${t.building}`;
  }
}

export function availableTechs(game: Game, player: PlayerId): TechId[] {
  const p = game.players[player];
  const out: TechId[] = [];
  for (const t of Object.values(TECHS)) {
    if (p.techs.has(t.id)) continue;
    if (t.requires && !p.techs.has(t.requires)) continue;
    out.push(t.id);
  }
  return out;
}

export function snapshot(game: Game, player: PlayerId, decisionInterval = 10): object {
  const p = game.players[player];
  const enemy = (1 - player) as PlayerId;
  const cmdr = game.commander(player);

  const myBuildings = [];
  for (const b of game.buildings(player)) {
    const entry: Record<string, unknown> = {
      id: b.id,
      type: b.type,
      pos: posOut(b.pos),
      hp: hpOut(b.hp),
      maxHp: hpOut(b.maxHp),
      done: b.done,
    };
    if (!b.done) entry.buildProgress = Math.round((1000 * b.buildTicks) / b.buildTicksNeeded) / 1000;
    if (b.type === 'fabricator') {
      entry.production = b.production;
      entry.on = b.on;
      entry.rally = posOut(b.rally);
      entry.behavior = b.behavior;
      if (b.starved) entry.skippedLastWave = true;
    }
    myBuildings.push(entry);
  }

  const myUnits = [];
  for (const un of game.units(player)) {
    myUnits.push({
      id: un.id,
      type: un.type,
      pos: posOut(un.pos),
      hp: hpOut(un.hp),
      maxHp: hpOut(un.maxHp),
      sourceBuilding: un.sourceBuilding,
      behavior: un.behavior,
      state: un.targetId ? `engaging ${un.targetId}` : 'idle_or_moving',
    });
  }

  const visUnits = [];
  let visCommander: object | null = null;
  const visBuildings = [];
  for (const e of game.entities.values()) {
    if (e.player !== enemy) continue;
    if (!game.canTarget(player, e)) continue;
    if (e.kind === 'unit') {
      visUnits.push({ id: e.id, type: e.type, pos: posOut(e.pos), hp: hpOut(e.hp) });
    } else if (e.kind === 'commander') {
      visCommander = { id: e.id, pos: posOut(e.pos), hp: hpOut(e.hp) };
    } else {
      visBuildings.push({ id: e.id, type: e.type, pos: posOut(e.pos), hp: hpOut(e.hp), done: e.done });
    }
  }

  const lastKnown = [];
  for (const lk of p.lastKnown.values()) {
    if (!game.cellVisibleForSnapshot(player, lk.pos)) {
      lastKnown.push({
        type: lk.type,
        pos: posOut(lk.pos),
        ageSeconds: Math.round((game.tick - lk.tick) / 10),
      });
    }
  }

  const snap = {
    tick: game.tick,
    gameTime: game.gameTime,
    decisionInterval,
    winner: game.winner,
    you: {
      energy: Math.floor(p.energy / FP),
      incomeRate: game.incomeRate(player),
      commander: cmdr
        ? {
            id: cmdr.id,
            pos: posOut(cmdr.pos),
            hp: hpOut(cmdr.hp),
            maxHp: hpOut(cmdr.maxHp),
            currentOrder: cmdr.tasks.length ? describeTask(cmdr.tasks[0]) : 'idle',
            queuedOrders: cmdr.tasks.slice(1).map(describeTask),
            cloaked: game.isCommanderCloaked(cmdr),
          }
        : null,
      buildings: myBuildings,
      units: myUnits,
      research: {
        completed: [...p.techs],
        inProgress: p.research
          ? { tech: p.research.tech, secondsLeft: Math.round(p.research.ticksLeft / 10) }
          : null,
        available: availableTechs(game, player),
      },
      override: p.override,
    },
    visibleEnemies: { units: visUnits, buildings: visBuildings, commander: visCommander },
    lastKnown: { buildings: lastKnown },
    capturePoints: game.capturePoints.map((cp) => ({
      id: cp.id,
      pos: posOut(cp.pos),
      owner: cp.owner === -1 ? null : cp.owner === player ? 'you' : 'enemy',
      buffs: cp.buffs,
      captureProgress: Math.round((1000 * cp.meter) / 1_000_000) / 1000,
      progressSide: cp.meterSide === -1 ? null : cp.meterSide === player ? 'you' : 'enemy',
      contested: cp.contested,
    })),
    events: p.events.splice(0),
    invalidCommands: p.invalid.splice(0),
  };
  return snap;
}

/** Static map info, sent once at game start (§13.2 "map"). */
export function mapInfo(game: Game): object {
  return {
    size: game.map.size,
    nodes: game.map.nodes.map(posOut),
    capturePoints: game.map.capturePoints.map((cp) => ({ id: cp.id, pos: posOut(cp.pos) })),
    spawns: game.map.spawns.map((s) => ({ bastion: posOut(s.bastion), commander: posOut(s.commander) })),
    // Terrain grids as compact rows (elevation digits, ramp/slow bitmaps).
    elevation: gridRows(game.map.elevation, game.map.size),
    ramp: gridRows(game.map.ramp, game.map.size),
    slow: gridRows(game.map.slow, game.map.size),
    unitStats: UNIT_STATS,
    buildingStats: BUILDING_STATS,
  };
}

function gridRows(grid: Uint8Array, size: number): string[] {
  const rows: string[] = [];
  for (let y = 0; y < size; y++) {
    let row = '';
    for (let x = 0; x < size; x++) row += grid[y * size + x];
    rows.push(row);
  }
  return rows;
}
