// Balance harness (§16): batch matches, aggregate the testable assertions.
//
//   npm run balance                          # scripted bots, no API cost
//   GAMES=54 SEED=1 npm run balance
//   BOTS=claude MODEL=claude-haiku-4-5 GAMES=6 npm run balance   # needs API key
//
// §16 targets measured:
//   1. median match length 10–15 min; <5% exceed 20 min
//   2. no opening (rush/eco/tech) wins >55%
//   3. (counter-comp — covered by unit tests; scripted bots always counter-pick)
//   4. holding 2+ capture points for 3+ consecutive min => win rate >=65%
//   5. commander snipes: how often the killing blow is a wasp

import fs from 'node:fs';
import path from 'node:path';
import { Game, TICKS_PER_SECOND } from '../src/sim';
import { OPENINGS, ScriptedBot, type Opening } from '../src/bots/scripted';
import { ClaudePlayer } from '../src/claude/driver';
import { createAnthropicTransport, DEFAULT_MODEL } from '../src/claude/anthropic';

const GAMES = Number(process.env.GAMES ?? 27);
const BASE_SEED = Number(process.env.SEED ?? 1000);
const MAX_MINUTES = Number(process.env.MAX_MINUTES ?? 25);
const BOTS = process.env.BOTS ?? 'scripted';
const INTERVAL_S = 10;

interface MatchRow {
  seed: number;
  openings: [Opening, Opening] | null;
  winner: -1 | 0 | 1 | null;
  minutes: number;
  winReason: string | null;
  mapControlWin: boolean | null; // did the 2+-points-for-3-min holder win?
  mapControlHolder: -1 | 0 | 1;
}

async function playMatch(seed: number, openings: [Opening, Opening] | null): Promise<MatchRow> {
  const game = new Game(seed);
  const scripted = openings
    ? [new ScriptedBot(0, openings[0]), new ScriptedBot(1, openings[1])]
    : null;
  const claude = scripted
    ? null
    : ([0, 1] as const).map(
        (p) =>
          new ClaudePlayer(
            p,
            createAnthropicTransport({
              model: process.env.MODEL ?? DEFAULT_MODEL,
              onError: (e) => console.error(`  P${p}:`, e instanceof Error ? e.message : e),
            }),
            INTERVAL_S,
          ),
      );

  const maxTicks = MAX_MINUTES * 60 * TICKS_PER_SECOND;
  const turnTicks = INTERVAL_S * TICKS_PER_SECOND;

  // Map-control tracking: consecutive seconds a player holds >=2 points.
  const holdStreak: [number, number] = [0, 0];
  let mapControlHolder: -1 | 0 | 1 = -1;

  while (game.winner === null && game.tick < maxTicks) {
    if (scripted) {
      for (const b of scripted) b.takeTurn(game);
    } else if (claude) {
      for (const b of claude) {
        if (game.winner === null) await b.takeTurn(game);
      }
    }
    game.run(turnTicks);

    const owned: [number, number] = [0, 0];
    for (const cp of game.capturePoints) if (cp.owner !== -1) owned[cp.owner]++;
    for (const p of [0, 1] as const) {
      holdStreak[p] = owned[p] >= 2 ? holdStreak[p] + INTERVAL_S : 0;
      if (holdStreak[p] >= 180 && mapControlHolder === -1) mapControlHolder = p;
    }
  }

  return {
    seed,
    openings,
    winner: game.winner,
    minutes: game.gameTime / 60,
    winReason: game.winReason,
    mapControlHolder,
    mapControlWin: mapControlHolder === -1 ? null : game.winner === mapControlHolder,
  };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

async function main(): Promise<void> {
  console.log(`GHOSTLINE balance run | bots=${BOTS} games=${GAMES} baseSeed=${BASE_SEED}`);
  const rows: MatchRow[] = [];

  for (let i = 0; i < GAMES; i++) {
    const openings: [Opening, Opening] | null =
      BOTS === 'scripted' ? [OPENINGS[i % 3], OPENINGS[Math.floor(i / 3) % 3]] : null;
    const row = await playMatch(BASE_SEED + i, openings);
    rows.push(row);
    const w = row.winner === null ? 'timeout' : row.winner === -1 ? 'draw' : `P${row.winner}`;
    console.log(
      `  game ${String(i + 1).padStart(2)} seed=${row.seed} ${
        row.openings ? row.openings.join(' vs ') : 'claude vs claude'
      } -> ${w} in ${row.minutes.toFixed(1)}min${row.winReason ? ` (${row.winReason})` : ''}`,
    );
  }

  // ---- §16 aggregates ----
  const finished = rows.filter((r) => r.winner === 0 || r.winner === 1);
  const lengths = finished.map((r) => r.minutes);
  console.log('\n=== §16 balance targets ===');
  console.log(
    `1. match length: median ${median(lengths).toFixed(1)} min (target 10-15); ` +
      `${((rows.filter((r) => r.minutes > 20).length / rows.length) * 100).toFixed(0)}% exceed 20 min (target <5%); ` +
      `${rows.length - finished.length} timeout/draw`,
  );

  if (BOTS === 'scripted') {
    const winsByOpening = new Map<Opening, { w: number; n: number }>();
    for (const r of finished) {
      if (!r.openings) continue;
      for (const p of [0, 1] as const) {
        const o = r.openings[p];
        const rec = winsByOpening.get(o) ?? { w: 0, n: 0 };
        rec.n++;
        if (r.winner === p) rec.w++;
        winsByOpening.set(o, rec);
      }
    }
    const parts = [...winsByOpening].map(
      ([o, { w, n }]) => `${o} ${(100 * w / n).toFixed(0)}% (${w}/${n})`,
    );
    console.log(`2. opening win rates (target: none >55%): ${parts.join(', ')}`);
  }

  const mc = rows.filter((r) => r.mapControlWin !== null);
  const mcWins = mc.filter((r) => r.mapControlWin).length;
  console.log(
    `4. map control (2+ pts held 3+ min): occurred in ${mc.length}/${rows.length} games; ` +
      (mc.length ? `holder won ${((100 * mcWins) / mc.length).toFixed(0)}% (target >=65%)` : 'n/a'),
  );

  const kills = finished.filter((r) => r.winReason);
  const waspKills = kills.filter((r) => r.winReason!.includes('wasp')).length;
  const towerKills = kills.filter((r) => r.winReason!.includes('watchtower')).length;
  console.log(
    `5. commander kill causes: ${kills.length} kills — wasp ${waspKills}, watchtower ${towerKills}, ` +
      `other ${kills.length - waspKills - towerKills} (snipe target band 15-30% of attempts)`,
  );

  const dir = path.join(process.cwd(), 'replays');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `balance-${BASE_SEED}-${GAMES}.json`);
  fs.writeFileSync(file, JSON.stringify(rows, null, 2));
  console.log(`\nresults written: ${file}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
