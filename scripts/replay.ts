// Replay verifier: re-runs a recorded match (seed + command log) through the
// sim and checks the final state hash. Deterministic sim means any divergence
// is a bug (or a sim change since the recording — replays are version-tagged).
//
//   npm run replay -- replays/<file>.json

import fs from 'node:fs';
import { Game, type Command, type PlayerId } from '../src/sim';

interface ReplayFile {
  version: number;
  seed: number;
  ticks: number;
  winner: -1 | 0 | 1 | null;
  finalHash?: string;
  commands: { tick: number; player: PlayerId; cmd: Command }[];
}

const file = process.argv[2];
if (!file) {
  console.error('usage: npm run replay -- replays/<file>.json');
  process.exit(1);
}

const replay = JSON.parse(fs.readFileSync(file, 'utf8')) as ReplayFile;
const game = new Game(replay.seed);
let idx = 0;

while (game.tick < replay.ticks && game.winner === null) {
  while (idx < replay.commands.length && replay.commands[idx].tick === game.tick) {
    const c = replay.commands[idx++];
    game.applyCommand(c.player, c.cmd);
  }
  game.step();
}
// Apply any commands recorded at the final tick (issued after the last step).
while (idx < replay.commands.length && replay.commands[idx].tick === game.tick) {
  const c = replay.commands[idx++];
  game.applyCommand(c.player, c.cmd);
}

console.log(`replayed ${game.tick} ticks (${(game.gameTime / 60).toFixed(1)} min)`);
console.log(`winner: ${game.winner === null ? 'none' : game.winner === -1 ? 'draw' : `P${game.winner}`} (recorded: ${replay.winner === null ? 'none' : replay.winner === -1 ? 'draw' : `P${replay.winner}`})`);

if (replay.finalHash !== undefined) {
  const ok = game.stateHash() === replay.finalHash;
  console.log(`state hash: ${ok ? 'MATCH' : 'DIVERGED'}`);
  process.exit(ok ? 0 : 2);
} else {
  console.log('no finalHash recorded; winner comparison only');
  process.exit(game.winner === replay.winner ? 0 : 2);
}
