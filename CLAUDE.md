# GHOSTLINE

Minimalist 1v1 RTS (one controllable Commander, systems-driven armies), designed
to be playable by both humans and Claude. Full design: `DESIGN_2.md` (authoritative;
`DESIGN.md` is the original sketch).

## Commands

- `npm run dev` — Vite dev server. `/` is the Three.js game (K = play vs Claude);
  `/debug.html` is the 2D sim debugger. Game URL params: `?demo` (scripted bots
  play), `?fast` (4x), `?seed=N`, `?snap=MS` (headless-screenshot aid: delays the
  load event and mirrors one WebGL frame into an `<img>`).
- `npm test` — vitest suite
- `npm run build` — typecheck + production build (both pages)
- `ANTHROPIC_API_KEY=... npm run cvc` — headless Claude-vs-Claude match; env knobs: `MODEL` (default `claude-fable-5`), `SEED`, `INTERVAL` (decision seconds), `MAX_MINUTES`. Writes a replay (seed + command log + final hash) to `replays/`.
- `npm run balance` — batch §16 metrics; scripted bots by default (free), `BOTS=claude` for real self-play. See `BALANCE.md` for latest findings.
- `npm run replay -- replays/<file>.json` — re-run a replay, verify determinism.

## Architecture (enforced)

Two strictly separated layers (DESIGN_2.md §15):

1. **`src/sim/`** — deterministic sim core. Pure TS: **no DOM, no Three.js imports,
   ever.** Fixed tick (10 Hz), integer fixed-point math (milli-units / milli-HP /
   milli-energy; per-mille multipliers), seeded PRNG (`prng.ts`) as the only
   randomness. Import from `src/sim/index.ts` only.
2. **Presentation** — `src/main.ts` + `src/render/` (Three.js: stepped terrain
   with fog baked into vertex colors, low-poly entity meshes, 60 fps
   interpolation over the 10 Hz sim) + `src/ui/hud.ts` (HTML overlay: top bar,
   panel, build bar, minimap). `src/debug.ts`/`debug.html` is the 2D sim
   debugger — keep it working, it's the fastest way to inspect sim behavior.
   `src/bots/scripted.ts` is a harness-only bot (balance runs, `?demo`), not a
   game feature (§17).

Both human UI and the Claude driver issue the same `Command` objects through
`Game.applyCommand` — one command pipeline for both player types.

## Conventions

- Positions are `{x, y}` in milli-units (mu); 1 world unit = 1000 mu = 1 grid cell.
- All tuning values live in `src/sim/constants.ts` — they are initial values,
  expected to change in balance passes; don't scatter numbers elsewhere.
- Determinism is a hard invariant: same seed + same command stream ⇒ identical
  `stateHash()`. Iterate entities via the `entities` Map (insertion = id order).
  No `Date.now()`, `Math.random()`, or float trig in the sim.
- Tests: `tests/*.test.ts`. The determinism test and the end-to-end match test
  must stay green.

## Claude driver (`src/claude/`)

- `driver.ts` — `ClaudePlayer`: snapshot → transport → validate → apply, one call
  per decision interval; memory = model-maintained memo string echoed each turn.
  The `Transport` is injected; tests use fakes and never touch the network.
- `prompt.ts` — rules/map digest system prompt generated from sim constants
  (never hand-edit numbers into it); byte-stable per match for prompt caching.
- `anthropic.ts` — real transport. Default model `claude-fable-5` (per design
  doc §15) with server-side refusal fallbacks to `claude-opus-4-8`; structured
  outputs (`output_config.format`) guarantee parseable `{memo, commands}`.
  API/SDK questions: consult the `claude-api` skill before editing this file.
- Failed/refused turns become no-op "skipped" turns — a match never crashes on
  an API error. Malformed commands are reported back via `invalidCommands`.

## Status / roadmap

Done: sim core (map "Junction 9", A* pathing, economy, production, combat +
counter matrix, behaviors + soft flocking, global override, capture points with
rolled buffs, tech tree, fog/vision + last-known ghosts, veil cloak, snapshot
protocol §13.2, command schema §13.3), test suite, Claude API driver
(§13.1/13.4) with Human-vs-Claude (uplink pause; human input locked while
Claude thinks), headless CvC runner, replay recording + verifier, balance
harness with §16 metrics (`BALANCE.md`), Three.js presentation layer
(§12/§14) with build placement, building panels, minimap, event feed.

Open items: real Claude-vs-Claude balance data (needs API key — scripted-bot
numbers in `BALANCE.md` are indicative only); presentation polish (§14 wish
list: veil shimmer, zone boundary holograms, audio); Hunt with nothing scouted
falls back to the enemy spawn corner (documented simplification); possible
constants tuning per `BALANCE.md` after CvC data.
