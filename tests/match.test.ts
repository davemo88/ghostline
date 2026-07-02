import { describe, expect, it } from 'vitest';
import { Game } from '../src/sim/game';
import { TICKS_PER_SECOND } from '../src/sim/constants';

describe('scripted match (end-to-end)', () => {
  it('wasp rush crosses the map and kills an idle commander', () => {
    const g = new Game(42);
    // P0: fabricator behind the bastion, set to wasps on Hunt. P1 idles.
    g.applyCommand(0, { cmd: 'build', type: 'fabricator', pos: [30, 34] });
    const fab = [...g.buildings(0)].find((b) => b.type === 'fabricator')!;
    g.applyCommand(0, { cmd: 'set_production', building: fab.id, unit: 'wasp', on: true });
    g.applyCommand(0, { cmd: 'set_behavior', building: fab.id, behavior: 'hunt' });

    const start = performance.now();
    g.run(6 * 60 * TICKS_PER_SECOND);
    const wallMs = performance.now() - start;

    expect(g.winner).toBe(0);
    expect(g.gameTime).toBeLessThan(6 * 60);
    // Headless perf sanity: must simulate much faster than real time.
    expect(wallMs).toBeLessThan(20000);
  });

  it('guarded commander survives longer than an unguarded one', () => {
    const attack = (defend: boolean): number => {
      const g = new Game(42);
      g.applyCommand(0, { cmd: 'build', type: 'fabricator', pos: [30, 34] });
      const fab0 = [...g.buildings(0)].find((b) => b.type === 'fabricator')!;
      g.applyCommand(0, { cmd: 'set_production', building: fab0.id, unit: 'wasp', on: true });
      g.applyCommand(0, { cmd: 'set_behavior', building: fab0.id, behavior: 'hunt' });
      if (defend) {
        // P1 builds a watchtower next to its bastion.
        g.applyCommand(1, { cmd: 'build', type: 'watchtower', pos: [150, 152] });
      }
      g.run(8 * 60 * TICKS_PER_SECOND);
      return g.winner === 0 ? g.tick : Number.MAX_SAFE_INTEGER;
    };
    const undefended = attack(false);
    const defended = attack(true);
    expect(defended).toBeGreaterThan(undefended);
  });
});
