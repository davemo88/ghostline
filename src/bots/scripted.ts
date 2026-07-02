// Harness-only scripted bot. DESIGN_2.md §17 defers scripted AI as a game
// feature — this exists purely so the balance harness (§16) can run thousands
// of matches without API spend, and as a sparring partner for the Claude
// driver. It plays through the same command pipeline as everyone else.

import { type Command, FP, Game, type PlayerId, type UnitType, type Vec } from '../sim';

export type Opening = 'rush' | 'eco' | 'tech';
export const OPENINGS: Opening[] = ['rush', 'eco', 'tech'];

const COUNTER_PICK: Record<UnitType, UnitType> = {
  // What beats the unit the enemy has most of (Ronin > Mantis > Oni > Ronin).
  ronin: 'oni',
  oni: 'mantis',
  mantis: 'ronin',
  wasp: 'ronin',
};

export class ScriptedBot {
  readonly player: PlayerId;
  readonly opening: Opening;

  constructor(player: PlayerId, opening: Opening) {
    this.player = player;
    this.opening = opening;
  }

  /** Mirror a P0-frame position into this bot's frame. */
  private at(x: number, y: number): [number, number] {
    return this.player === 0 ? [x, y] : [180 - x, 180 - y];
  }

  private posU(v: Vec): [number, number] {
    return [v.x / FP, v.y / FP];
  }

  takeTurn(game: Game): void {
    const p = this.player;
    const cmds: Command[] = [];
    const me = game.players[p];
    const energy = me.energy / FP;
    const minutes = game.gameTime / 60;
    const cmdr = game.commander(p);
    if (!cmdr) return;

    const myBuildings = [...game.buildings(p)];
    const extractors = myBuildings.filter((b) => b.type === 'extractor');
    const fabs = myBuildings.filter((b) => b.type === 'fabricator');
    const blueprints = myBuildings.filter((b) => !b.done);
    const army = [...game.units(p)];
    const busy = cmdr.tasks.length > 0;

    // Resume any stalled blueprint before anything else.
    if (!busy && blueprints.length > 0) {
      cmds.push({ cmd: 'resume_build', building: blueprints[0].id });
    }

    // Build order: first unmet item that we can afford. Every opening gets a
    // fabricator early — the game punishes armyless windows hard.
    const nodeSpots: [number, number][] = [this.at(33.5, 17.5), this.at(55.5, 55.5), this.at(78.5, 102.5)];
    const fabSpots: [number, number][] = [this.at(31, 35), this.at(35, 31)];
    const towerSpot: [number, number] = this.at(29, 28);
    const towers = myBuildings.filter((b) => b.type === 'watchtower');

    type Item = { kind: 'extractor' | 'fabricator' | 'watchtower' };
    const plans: Record<Opening, Item['kind'][]> = {
      rush: ['extractor', 'fabricator', 'fabricator', 'extractor'],
      eco: ['extractor', 'fabricator', 'watchtower', 'extractor', 'extractor', 'fabricator'],
      tech: ['extractor', 'fabricator', 'watchtower', 'extractor'],
    };
    const have: Record<Item['kind'], number> = {
      extractor: extractors.length,
      fabricator: fabs.length,
      watchtower: towers.length,
    };
    const counted: Record<Item['kind'], number> = { extractor: 0, fabricator: 0, watchtower: 0 };
    let nextBuild: Item['kind'] | null = null;
    for (const kind of plans[this.opening]) {
      counted[kind]++;
      if (counted[kind] > have[kind]) {
        nextBuild = kind;
        break;
      }
    }
    const COST: Record<Item['kind'], number> = { extractor: 60, fabricator: 150, watchtower: 100 };
    if (!busy && blueprints.length === 0 && nextBuild && energy >= COST[nextBuild]) {
      const pos =
        nextBuild === 'extractor'
          ? nodeSpots[extractors.length]
          : nextBuild === 'fabricator'
            ? fabSpots[fabs.length]
            : towerSpot;
      if (pos) cmds.push({ cmd: 'build', type: nextBuild, pos });
    }

    // Tech line.
    if (this.opening === 'tech' && !me.research) {
      const order = ['eco1', 'mil1', 'mil2', 'eco2'] as const;
      const next = order.find((t) => !me.techs.has(t));
      if (next && energy >= 150) cmds.push({ cmd: 'research', tech: next });
    } else if (minutes > 4 && !me.research && energy > 300) {
      const next = (['eco1', 'mil1'] as const).find((t) => !me.techs.has(t));
      if (next) cmds.push({ cmd: 'research', tech: next });
    }

    // Production: counter what the enemy fields the most of.
    const enemyCounts = new Map<UnitType, number>();
    for (const e of game.entities.values()) {
      if (e.kind === 'unit' && e.player !== p && game.canTarget(p, e)) {
        enemyCounts.set(e.type, (enemyCounts.get(e.type) ?? 0) + 1);
      }
    }
    let want: UnitType = this.opening === 'rush' ? 'wasp' : 'ronin';
    let best = 0;
    for (const [t, n] of enemyCounts) {
      if (n > best) {
        best = n;
        want = COUNTER_PICK[t];
      }
    }
    for (const fab of fabs.filter((f) => f.done)) {
      if (fab.production !== want) {
        cmds.push({ cmd: 'set_production', building: fab.id, unit: want, on: true });
      }
    }

    // Army posture.
    const attackPos: [number, number] = this.player === 0 ? [156, 156] : [24, 24];
    const holdPos = this.at(46, 46); // top of the main ramp
    for (const fab of fabs.filter((f) => f.done)) {
      const aggressive = this.opening === 'rush' ? army.length >= 3 : army.length >= 6;
      if (aggressive && fab.behavior !== 'hunt') {
        cmds.push({ cmd: 'set_behavior', building: fab.id, behavior: 'hunt' });
        cmds.push({ cmd: 'set_rally', building: fab.id, pos: attackPos });
      } else if (!aggressive && fab.behavior !== 'guard') {
        cmds.push({ cmd: 'set_behavior', building: fab.id, behavior: 'guard' });
        cmds.push({ cmd: 'set_rally', building: fab.id, pos: holdPos });
      }
    }

    // Commander: after the build queue settles, grab the near flank point,
    // then sit at home. Never wander once the enemy has an army out.
    if (!busy && cmds.length === 0) {
      const flank = this.at(30, 150);
      const flankPoint = game.capturePoints.find(
        (cp) => Math.abs(cp.pos.x / FP - flank[0]) < 1 && Math.abs(cp.pos.y / FP - flank[1]) < 1,
      );
      const enemyArmyVisible = [...game.units()].some((u) => u.player !== p && game.canTarget(p, u));
      if (flankPoint && flankPoint.owner !== p && minutes > 2 && minutes < 8 && army.length >= 4 && !enemyArmyVisible) {
        cmds.push({ cmd: 'move', pos: this.posU(flankPoint.pos) });
      } else {
        const home = game.map.spawns[p].commander;
        cmds.push({ cmd: 'move', pos: this.posU(home) });
      }
    }

    game.applyCommands(p, cmds);
  }
}
