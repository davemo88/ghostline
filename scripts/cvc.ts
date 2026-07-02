// Headless Claude-vs-Claude match runner (§13.5) — the balance-testing harness.
//
//   ANTHROPIC_API_KEY=... npm run cvc
//   MODEL=claude-haiku-4-5 SEED=7 INTERVAL=10 MAX_MINUTES=20 npm run cvc
//
// Writes a replay (seed + full command log) to replays/<timestamp>-<seed>.json.
// Deterministic sim + seed + command log = perfect replay.

import fs from 'node:fs';
import path from 'node:path';
import { Game, TICKS_PER_SECOND } from '../src/sim';
import { ClaudePlayer } from '../src/claude/driver';
import { createAnthropicTransport, DEFAULT_MODEL } from '../src/claude/anthropic';

const seed = Number(process.env.SEED ?? Math.floor(Math.random() * 2 ** 31));
const model = process.env.MODEL ?? DEFAULT_MODEL;
const interval = Number(process.env.INTERVAL ?? 10); // seconds per decision
const maxMinutes = Number(process.env.MAX_MINUTES ?? 25);

async function main(): Promise<void> {
  console.log(`GHOSTLINE CvC | seed=${seed} model=${model} interval=${interval}s`);
  const game = new Game(seed);
  for (const cp of game.capturePoints) {
    console.log(`  point '${cp.id}': ${cp.buffs.join(' + ')}`);
  }

  const players = ([0, 1] as const).map(
    (p) =>
      new ClaudePlayer(
        p,
        createAnthropicTransport({
          model,
          onError: (err) => console.error(`P${p} turn error:`, err instanceof Error ? err.message : err),
        }),
        interval,
      ),
  );

  const ticksPerTurn = interval * TICKS_PER_SECOND;
  const maxTicks = maxMinutes * 60 * TICKS_PER_SECOND;

  let skippedRounds = 0;
  while (game.winner === null && game.tick < maxTicks) {
    let anyOrders = false;
    for (const p of players) {
      if (game.winner !== null) break;
      const result = await p.takeTurn(game);
      if (!result.skipped) anyOrders = true;
      const label = result.skipped ? 'skipped' : `${result.commands.length} cmds`;
      console.log(`[${game.gameTime.toFixed(0).padStart(4)}s] P${p.player}: ${label}`);
      for (const r of result.rejected) console.log(`         P${p.player} malformed: ${r.reason}`);
      if (process.env.VERBOSE) {
        if (result.thinking) console.log(`         P${p.player} thinking: ${result.thinking}`);
        console.log(`         P${p.player} memo: ${result.memo}`);
        for (const c of result.commands) console.log(`         P${p.player} ▸ ${JSON.stringify(c)}`);
      }
    }
    skippedRounds = anyOrders ? 0 : skippedRounds + 1;
    if (skippedRounds >= 3) {
      console.error('both players failed 3 rounds in a row (bad API key / model?) — aborting');
      process.exit(1);
    }
    game.run(ticksPerTurn);

    if (game.tick % (60 * TICKS_PER_SECOND) === 0) {
      const e = (p: 0 | 1) => Math.floor(game.players[p].energy / 1000);
      const armies = ([0, 1] as const).map((p) => [...game.units(p)].length);
      console.log(
        `--- ${game.gameTime / 60} min | energy ${e(0)} vs ${e(1)} | army ${armies[0]} vs ${armies[1]} | ` +
          `points ${game.capturePoints.map((cp) => (cp.owner === -1 ? '·' : cp.owner)).join('')}`,
      );
    }
  }

  const outcome =
    game.winner === null ? 'timeout' : game.winner === -1 ? 'draw' : `P${game.winner} wins`;
  console.log(`\n=== ${outcome} at ${(game.gameTime / 60).toFixed(1)} min ===`);

  const replay = {
    version: 1,
    seed,
    model,
    interval,
    winner: game.winner,
    ticks: game.tick,
    finalHash: game.stateHash(),
    buffs: game.capturePoints.map((cp) => ({ id: cp.id, buffs: cp.buffs })),
    memos: players.map((p) => p.memo),
    commands: game.commandLog,
  };
  const dir = path.join(process.cwd(), 'replays');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-seed${seed}.json`);
  fs.writeFileSync(file, JSON.stringify(replay, null, 2));
  console.log(`replay written: ${file}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
