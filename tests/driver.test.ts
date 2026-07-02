import { describe, expect, it } from 'vitest';
import { Game } from '../src/sim/game';
import { STARTING_ENERGY, FP, TICKS_PER_SECOND } from '../src/sim/constants';
import { ClaudePlayer, validateCommand, type Transport, type TurnRequest } from '../src/claude/driver';
import { buildSystemPrompt } from '../src/claude/prompt';

function fakeTransport(turns: { memo: string; commands: unknown[] }[]): Transport & { requests: TurnRequest[] } {
  let i = 0;
  const requests: TurnRequest[] = [];
  const t = (async (req: TurnRequest) => {
    requests.push(req);
    return turns[Math.min(i++, turns.length - 1)];
  }) as Transport & { requests: TurnRequest[] };
  t.requests = requests;
  return t;
}

describe('validateCommand', () => {
  it('accepts well-formed commands', () => {
    expect(validateCommand({ cmd: 'move', pos: [10, 20] })).toEqual({ cmd: 'move', pos: [10, 20], replace: false });
    expect(validateCommand({ cmd: 'build', type: 'extractor', pos: [33.5, 17.5] })).toEqual({
      cmd: 'build',
      type: 'extractor',
      pos: [33.5, 17.5],
    });
    expect(validateCommand({ cmd: 'set_production', building: 5, unit: 'wasp', on: true })).toEqual({
      cmd: 'set_production',
      building: 5,
      unit: 'wasp',
      on: true,
    });
    expect(validateCommand({ cmd: 'global_override', stance: 'fall_back' })).toEqual({
      cmd: 'global_override',
      stance: 'fall_back',
    });
  });

  it('rejects malformed commands with reasons', () => {
    expect(validateCommand({ cmd: 'move' })).toMatch(/pos/);
    expect(validateCommand({ cmd: 'move', pos: [1] })).toMatch(/pos/);
    expect(validateCommand({ cmd: 'build', type: 'bastion', pos: [1, 1] })).toMatch(/building type/);
    expect(validateCommand({ cmd: 'teleport', pos: [1, 1] })).toMatch(/unknown cmd/);
    expect(validateCommand({ cmd: 'set_behavior', building: 3, behavior: 'yolo' })).toMatch(/behavior/);
    expect(validateCommand({ cmd: 'research', tech: 'eco9' })).toMatch(/tech/);
    expect(validateCommand(null)).toMatch(/not an object/);
  });
});

describe('ClaudePlayer', () => {
  it('applies validated commands, surfaces malformed ones, and round-trips the memo', async () => {
    const g = new Game(99);
    const transport = fakeTransport([
      {
        memo: 'opening: eco first',
        commands: [
          { cmd: 'build', type: 'extractor', pos: [146.5, 162.5] }, // P1 base node
          { cmd: 'research', tech: 'eco1' },
          { cmd: 'warp_drive' }, // malformed — never reaches the engine
        ],
      },
      { memo: 'turn 2 memo', commands: [] },
    ]);
    const bot = new ClaudePlayer(1, transport);

    const r1 = await bot.takeTurn(g);
    expect(r1.commands.length).toBe(2);
    expect(r1.rejected.length).toBe(1);
    expect(bot.memo).toBe('opening: eco first');
    // Blueprint was placed and paid for.
    expect([...g.buildings(1)].some((b) => b.type === 'extractor')).toBe(true);
    expect(g.players[1].energy).toBe(STARTING_ENERGY - 60 * FP);

    // First user payload carried the no-memo marker; snapshot drains invalids.
    expect(transport.requests[0].user).toContain('first turn');

    g.run(5 * TICKS_PER_SECOND);
    const r2 = await bot.takeTurn(g);
    expect(r2.skipped).toBe(false);
    // Second request carries the memo and the malformed-command report.
    expect(transport.requests[1].user).toContain('opening: eco first');
    expect(transport.requests[1].user).toContain('malformed');
    // Turn history is recorded for the intel/debug panel.
    expect(bot.history.length).toBe(2);
    expect(bot.history[0].commands.length).toBe(2);
    expect(bot.history[0].memo).toBe('opening: eco first');
  });

  it('passes summarized thinking through to the turn record', async () => {
    const g = new Game(99);
    const transport: Transport = async () => ({
      memo: 'm',
      commands: [],
      thinking: 'I should expand my economy before attacking.',
    });
    const bot = new ClaudePlayer(1, transport);
    const r = await bot.takeTurn(g);
    expect(r.thinking).toBe('I should expand my economy before attacking.');
    expect(bot.history[0].thinking).toContain('economy');
  });

  it('skipped turns are no-ops that preserve the memo', async () => {
    const g = new Game(99);
    const transport: Transport = async () => ({ memo: '', commands: [], skipped: true });
    const bot = new ClaudePlayer(0, transport);
    bot.memo = 'keep me';
    const r = await bot.takeTurn(g);
    expect(r.skipped).toBe(true);
    expect(bot.memo).toBe('keep me');
    expect(g.commandLog.length).toBe(0);
  });

  it('caps runaway command lists', async () => {
    const g = new Game(99);
    const many = Array.from({ length: 100 }, () => ({ cmd: 'move', pos: [90, 90] }));
    const bot = new ClaudePlayer(0, fakeTransport([{ memo: 'x', commands: many }]));
    const r = await bot.takeTurn(g);
    expect(r.commands.length).toBe(30);
  });
});

describe('system prompt', () => {
  it('is stable per match and stays in the cacheable size range', () => {
    const g = new Game(7);
    const a = buildSystemPrompt(g, 10);
    const b = buildSystemPrompt(g, 10);
    expect(a).toBe(b); // byte-identical => prompt-cache friendly
    expect(a).toContain('ronin');
    expect(a).toContain('grid_feed');
    // Rough token budget check (~4 chars/token): §13.4 wants ≲2K tokens.
    expect(a.length).toBeLessThan(12000);
    // Includes the match's rolled buffs.
    for (const cp of g.capturePoints) {
      expect(a).toContain(cp.buffs[0]);
    }
  });

  it('a scripted two-bot match stays deterministic given identical transports', async () => {
    const play = async () => {
      const g = new Game(1234);
      const script = (player: 0 | 1) =>
        fakeTransport([
          {
            memo: 'eco',
            commands: [
              { cmd: 'build', type: 'extractor', pos: player === 0 ? [33.5, 17.5] : [146.5, 162.5] },
            ],
          },
          { memo: 'army', commands: [{ cmd: 'build', type: 'fabricator', pos: player === 0 ? [30, 34] : [150, 146] }] },
          { memo: 'hold', commands: [] },
        ]);
      const bots = [new ClaudePlayer(0, script(0)), new ClaudePlayer(1, script(1))];
      for (let turn = 0; turn < 6; turn++) {
        for (const b of bots) await b.takeTurn(g);
        g.run(100);
      }
      return g.stateHash();
    };
    expect(await play()).toBe(await play());
  });
});
