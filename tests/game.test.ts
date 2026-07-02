import { describe, expect, it } from 'vitest';
import { Game } from '../src/sim/game';
import { FP, STARTING_ENERGY, TICKS_PER_SECOND, UNIT_STATS, type UnitType } from '../src/sim/constants';
import { snapshot } from '../src/sim/snapshot';

/** Test-only: drop a unit directly into the world, bypassing production. */
function injectUnit(g: Game, player: 0 | 1, type: UnitType, x: number, y: number) {
  const anyG = g as any;
  const stats = UNIT_STATS[type];
  const u = {
    kind: 'unit',
    id: anyG.nextId++,
    player,
    type,
    pos: { x: Math.round(x * FP), y: Math.round(y * FP) },
    hp: stats.hp * FP,
    maxHp: stats.hp * FP,
    sourceBuilding: -1,
    rally: { x: Math.round(x * FP), y: Math.round(y * FP) },
    behavior: 'hunt',
    targetId: 0,
    path: [],
    pathIdx: 0,
    pathGoal: null,
  };
  anyG.entities.set(u.id, u);
  return u;
}

describe('determinism', () => {
  it('same seed + same commands => identical state', () => {
    const run = () => {
      const g = new Game(1234);
      g.applyCommand(0, { cmd: 'build', type: 'extractor', pos: [33.5, 17.5] });
      g.applyCommand(1, { cmd: 'build', type: 'fabricator', pos: [148, 148] });
      g.run(300);
      g.applyCommand(0, { cmd: 'move', pos: [90, 90] });
      g.applyCommand(1, { cmd: 'set_behavior', building: 5, behavior: 'assault' });
      g.run(1200);
      return g.stateHash();
    };
    expect(run()).toBe(run());
  });

  it('different seeds roll different capture buffs eventually', () => {
    const buffsFor = (seed: number) =>
      JSON.stringify(new Game(seed).capturePoints.map((cp) => cp.buffs));
    const distinct = new Set([buffsFor(1), buffsFor(2), buffsFor(3), buffsFor(4), buffsFor(5)]);
    expect(distinct.size).toBeGreaterThan(1);
  });
});

describe('setup', () => {
  it('each player starts with bastion, commander, 200e', () => {
    const g = new Game(1);
    for (const player of [0, 1] as const) {
      expect(g.commander(player)).not.toBeNull();
      const bastion = g.bastion(player);
      expect(bastion).not.toBeNull();
      expect(bastion!.done).toBe(true);
      expect(g.players[player].energy).toBe(STARTING_ENERGY);
    }
    expect(g.capturePoints.length).toBe(3);
    for (const cp of g.capturePoints) {
      expect(cp.buffs.length).toBe(2);
      expect(new Set(cp.buffs).size).toBe(2);
    }
  });
});

describe('economy & building', () => {
  it('bastion trickle: +3 e/s', () => {
    const g = new Game(1);
    g.run(100); // 10 s
    expect(g.players[0].energy).toBe(STARTING_ENERGY + 30 * FP);
  });

  it('commander walks to a blueprint, channels it, extractor income kicks in', () => {
    const g = new Game(1);
    g.applyCommand(0, { cmd: 'build', type: 'extractor', pos: [33.5, 17.5] });
    expect(g.players[0].energy).toBe(STARTING_ENERGY - 60 * FP);
    // walk (~8u at 6u/s) + channel 10s => finish well within 20 s
    g.run(20 * TICKS_PER_SECOND);
    const extractor = [...g.buildings(0)].find((b) => b.type === 'extractor');
    expect(extractor).toBeDefined();
    expect(extractor!.done).toBe(true);
    expect(g.incomeRate(0)).toBe(3 + 6);
  });

  it('construction pauses when the commander leaves', () => {
    const g = new Game(1);
    g.applyCommand(0, { cmd: 'build', type: 'fabricator', pos: [30, 34] });
    g.run(30); // walk + start channeling
    g.applyCommand(0, { cmd: 'move', pos: [20, 20], replace: true });
    const fab = [...g.buildings(0)].find((b) => b.type === 'fabricator')!;
    const progress = fab.buildTicks;
    g.run(100);
    expect(fab.done).toBe(false);
    expect(fab.buildTicks).toBe(progress); // paused
    g.applyCommand(0, { cmd: 'resume_build', building: fab.id });
    g.run(400);
    expect(fab.done).toBe(true);
  });

  it('invalid placements are rejected with reasons', () => {
    const g = new Game(1);
    g.applyCommand(0, { cmd: 'build', type: 'extractor', pos: [40, 40] });
    expect(g.players[0].invalid.some((i) => i.reason.includes('resource node'))).toBe(true);
    g.applyCommand(0, { cmd: 'build', type: 'fabricator', pos: [24, 24] }); // on own bastion
    expect(g.players[0].invalid.some((i) => i.reason.includes('overlaps'))).toBe(true);
    const before = g.players[0].energy;
    expect(before).toBe(STARTING_ENERGY); // nothing was charged
  });

  it('cancel refunds 75%', () => {
    const g = new Game(1);
    g.applyCommand(0, { cmd: 'build', type: 'fabricator', pos: [30, 34] });
    const fab = [...g.buildings(0)].find((b) => b.type === 'fabricator')!;
    g.applyCommand(0, { cmd: 'cancel_build', building: fab.id });
    expect(g.players[0].energy).toBe(STARTING_ENERGY - 150 * FP + 112500);
    expect([...g.buildings(0)].some((b) => b.type === 'fabricator')).toBe(false);
  });
});

describe('production & combat', () => {
  function gameWithFab(player: 0 | 1, pos: [number, number]): { g: Game; fabId: number } {
    const g = new Game(7);
    g.applyCommand(player, { cmd: 'build', type: 'fabricator', pos });
    const fab = [...g.buildings(player)].find((b) => b.type === 'fabricator')!;
    return { g, fabId: fab.id };
  }

  it('fabricator produces ronin by default and units go to rally', () => {
    const { g, fabId } = gameWithFab(0, [30, 34]);
    g.run(30 * TICKS_PER_SECOND);
    const fab = g.building(fabId)!;
    expect(fab.done).toBe(true);
    // 20s build + 15s ronin => first unit by ~40s
    g.run(30 * TICKS_PER_SECOND);
    const units = [...g.units(0)];
    expect(units.length).toBeGreaterThan(0);
    expect(units[0].type).toBe('ronin');
  });

  it('ronin beats equal-cost mantis up close (counter triangle)', () => {
    // 2 ronin (100e) vs 1 mantis (100e) spawned adjacent — inside mantis min range.
    const g = new Game(3);
    injectUnit(g, 0, 'ronin', 88, 90);
    injectUnit(g, 0, 'ronin', 88, 91);
    injectUnit(g, 1, 'mantis', 92, 90);
    g.run(30 * TICKS_PER_SECOND);
    const p0 = [...g.units(0)].length;
    const p1 = [...g.units(1)].length;
    expect(p0).toBeGreaterThan(0);
    expect(p1).toBe(0);
  });
});

describe('capture points', () => {
  it('commander captures at 2x, gains buff ownership', () => {
    const g = new Game(11);
    const cp = g.capturePoints.find((c) => c.id === 'west')!;
    // Teleport commander next to the west point (test-only shortcut).
    const cmdr = g.commander(0)!;
    cmdr.pos = { ...cp.pos };
    // Commander weight 2 => 5s to capture.
    g.run(5 * TICKS_PER_SECOND + 2);
    expect(cp.owner).toBe(0);
  });

  it('contested points freeze', () => {
    const g = new Game(11);
    const cp = g.capturePoints.find((c) => c.id === 'center')!;
    g.commander(0)!.pos = { ...cp.pos };
    g.commander(1)!.pos = { x: cp.pos.x + 3 * FP, y: cp.pos.y };
    g.run(50);
    expect(cp.contested).toBe(true);
    expect(cp.owner).toBe(-1);
    expect(cp.meter).toBe(0);
  });
});

describe('research', () => {
  it('research runs at the bastion and applies effects', () => {
    const g = new Game(5);
    g.applyCommand(0, { cmd: 'research', tech: 'eco1' });
    g.run(5 * TICKS_PER_SECOND); // walk + start
    expect(g.players[0].research?.tech).toBe('eco1');
    g.run(31 * TICKS_PER_SECOND);
    expect(g.players[0].techs.has('eco1')).toBe(true);
  });

  it('prereqs are enforced', () => {
    const g = new Game(5);
    g.applyCommand(0, { cmd: 'research', tech: 'eco2' });
    g.run(5 * TICKS_PER_SECOND);
    expect(g.players[0].research).toBeNull();
  });
});

describe('win condition', () => {
  it('commander death ends the game', () => {
    const g = new Game(9);
    const c1 = g.commander(1)!;
    c1.hp = 1;
    // Put an enemy ronin on top of it.
    injectUnit(g, 0, 'ronin', c1.pos.x / FP + 1, c1.pos.y / FP);
    g.run(100);
    expect(g.winner).toBe(0);
  });
});

describe('snapshot', () => {
  it('produces a serializable player view with fog applied', () => {
    const g = new Game(21);
    g.run(50);
    const snap = snapshot(g, 0) as any;
    expect(snap.you.energy).toBeGreaterThan(200);
    expect(snap.you.commander).not.toBeNull();
    expect(snap.you.buildings.length).toBe(1);
    // Enemy base is unscouted: no visible enemies.
    expect(snap.visibleEnemies.buildings.length).toBe(0);
    expect(snap.visibleEnemies.commander).toBeNull();
    expect(snap.capturePoints.length).toBe(3);
    expect(() => JSON.stringify(snap)).not.toThrow();
  });
});
