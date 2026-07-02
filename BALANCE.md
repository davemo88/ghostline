# Balance notes

Run `npm run balance` (scripted bots, free) or `BOTS=claude npm run balance`
(real self-play, needs `ANTHROPIC_API_KEY`). Results land in `replays/`.

## Scripted-bot sweep, 27 games, seeds 1000-1026 (2026-07-02)

| §16 target | Measured | Verdict |
|---|---|---|
| 1. median length 10–15 min, <5% >20 min | median 3.8 min, 0% >20 | **short** — see note |
| 2. no opening >55% win | rush 33%, eco 56%, tech 61% | borderline |
| 3. counter comps beat mono ≥70% | covered by unit tests | ok |
| 4. 2+ points held 3 min ⇒ ≥65% win | 50% (4 occurrences — small n) | inconclusive |
| 5. wasp snipe share of kills | 3/27 (11%) | plausible |

Notes:

- **Match length** is bot-limited, not engine-limited: scripted bots go all-in
  (`hunt`) at 6 units and never regroup, so the first decisive fight usually
  ends the game. Do not stretch incomes/costs to fix this before Claude
  self-play data exists — smarter play lengthens games by itself.
- **Early armyless windows are lethal.** Bots that delayed their first
  fabricator past ~90s lost to wasp rushes almost every time (78% rush win
  rate before the bots learned to build a fabricator early). This is the
  design's intended pressure, but worth re-checking with Claude play: if
  fabricator-first is *forced*, opening diversity dies. Candidate lever if so:
  wasp cost 40→45 or wasp anti-commander multiplier below 1.0 (§16 lever
  order: unit costs first).
- **Commander walkabouts die.** An unescorted commander crossing the map at
  ~2 min gets run down by hunt wasps (8.0 speed vs 6.0). Working as designed
  (§16.5), but it means capture points before ~minute 3 belong to units, not
  commanders.
- Map-control target needs longer games to be measurable (points barely
  matter in a 4-minute game).

## Next data wanted

- `BOTS=claude GAMES=10 MODEL=claude-haiku-4-5 npm run balance` as a cheap
  first CvC read, then a full-model run for real numbers.
