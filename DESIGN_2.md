# GHOSTLINE — Game Design Document

A minimalist 1v1 RTS where you command exactly one unit — the Commander — and win by killing the enemy's. Built for the web, playable by humans and by Claude.

All numbers in this document are **initial tuning values** — coherent starting points, expected to change during balance passes. Names are placeholders with the intended flavor.

---

## 1. Design Pillars

1. **One unit, total consequence.** You directly control only the Commander. Every strategic act — building, rewiring rally points, changing behaviors, researching — requires the Commander's physical presence somewhere. Positioning your one controllable unit *is* the strategy.
2. **Armies are systems, not selections.** Units are never directly controlled. You configure the machine (production, rally points, behaviors) and it fights for you. Skill is expressed in configuration and anticipation, not clicks-per-minute.
3. **Claude is a first-class player.** The simulation is deterministic, fully serializable, and advances in discrete ticks. A structured snapshot/command protocol lets Claude play on equal semantic footing with a human — no pixel parsing, no APM requirement.
4. **Legible depth.** Small roster (4 units, ~7 buildings, ~10 techs), strict counter relationships, readable terrain. Every match decision should be explainable in one sentence.

**Match profile:** 1v1, 10–15 minutes, single map archetype at launch.

---

## 2. Victory & Loss

- **Win condition:** destroy the enemy Commander. That's it.
- The Commander is **unarmed**. It cannot fight back — ever. Its defenses are speed, vision, escorts, and turrets.
- Losing your **Bastion** (base building) is not a loss, but it removes your research capability, its trickle income, and your Global Override console (§8). It is usually fatal in practice, but a Commander on the run with a hidden Fabricator can still win.
- No surrender/draw mechanics at launch. Anti-stalemate pressure comes from capture-point income differential (§9).

---

## 3. The Commander

| Stat | Value |
|---|---|
| HP | 300 (no regen by default; tech can add it) |
| Move speed | 6 u/s (fastest ground unit except the Wasp) |
| Vision radius | 16 u |
| Attack | none |

**Abilities:**

- **Build** — select a structure from the build menu, place a blueprint on valid terrain, then **channel construction while standing adjacent**. If the Commander leaves, construction pauses (blueprint persists, can be resumed). Blueprints are destructible at 25% of final HP. Channeled construction is the game's core risk mechanic: building forward is a commitment of your win condition.
- **Repair** — channel on an adjacent damaged friendly building: restores 20 HP/s, costs 1 energy per 4 HP.
- **Interact** — when adjacent to a friendly building, its control panel opens: set rally point, set behavior, set production type, toggle production, start research (Bastion only), trigger Global Override (Bastion only).
- **Capture** — the Commander (or any unit) standing in a capture point's radius captures it (§9). The Commander captures at 2× rate.

The Commander is **always the selected unit**. Right-click moves it; there is no unit selection UI.

---

## 4. Economy

**Single resource: Energy (e).**

| Source | Income |
|---|---|
| Bastion trickle | +3 e/s |
| Extractor (on a resource node) | +6 e/s |
| Held capture point with the **Grid feed** buff (§9) | +3 e/s |

- Starting stockpile: **200 e**.
- Resource nodes are fixed map locations (6 per map: 1 in each main base, 1 near each base "natural", 2 contested center). Nodes do **not** deplete at launch (depletion is a reserved tuning lever if turtling proves dominant).
- No supply/population cap. Army size is bounded by income and production throughput.
- Everything spends from the same pool: buildings, unit production, research, repairs.

**Income arc target:** ~9 e/s at 1 min (base + first extractor) → ~20–25 e/s at 6 min with map control. A player who controls both center nodes plus whichever capture points rolled Grid feed (§9) out-earns a turtle by ~40–60%, varying with the match's buff rolls.

---

## 5. Buildings

All construction is Commander-channeled (§3). Build cost is paid up front on blueprint placement (refunded 75% if cancelled before completion).

| Building | Cost | Build time | HP | Function |
|---|---|---|---|---|
| **Bastion** (start) | — | — | 1500 | +3 e/s trickle. Research site. Global Override console. Each player starts with one; cannot build more. |
| **Extractor** | 60 | 10 s | 250 | +6 e/s. Must be placed on a resource node. |
| **Fabricator** | 150 | 20 s | 500 | Unit production (§5.1). |
| **Watchtower** | 100 | 15 s | 350 | Turret: 18 DPS, range 16, targets nearest enemy. Benefits from high ground (§10). |
| **Sensor Spire** | 80 | 12 s | 150 | Vision radius 30. No attack. The fog-of-war answer. |
| **Aegis Projector** | 140 | 15 s | 300 | Aura, radius 14: friendly units take −20% damage. Does not stack. |

Placement rules: buildings need flat ground of their footprint size, cannot overlap, no other placement restrictions (no "build radius" — forward-building is legal and channel-risk is its cost).

### 5.1 Fabricator — production model

A Fabricator is a configured machine, not a queue you micromanage:

- It is set to produce **one unit type** (default: Ronin) and is either **ON** or **OFF**.
- While ON, it repeats: wait until stockpile ≥ unit cost → deduct cost → build for the unit's build time → spawn the unit, which travels to the rally point under the building's behavior (§7).
- Changing the unit type, rally point, behavior, or ON/OFF requires the Commander adjacent to that Fabricator.

This means army composition is decided by **which Fabricators you build and how you set them**, then paid for continuously. Rebalancing your composition mid-game means the Commander physically touring the base — a deliberate time cost.

---

## 6. Units & Combat

Four units in a counter triangle plus one niche harasser. Units auto-attack per their behavior; players never target manually.

| Unit | Cost | Build time | HP | DPS | Range | Speed | Vision |
|---|---|---|---|---|---|---|---|
| **Ronin** (light assault frame) | 50 | 15 s | 120 | 12 | 8 | 5.5 | 12 |
| **Oni** (heavy walker) | 120 | 35 s | 400 | 20 | 10 | 3.5 | 10 |
| **Mantis** (artillery strider) | 100 | 30 s | 90 | 25 | 22 (min 6) | 3.0 | 10 |
| **Wasp** (raider drone) | 40 | 12 s | 60 | 8 | 6 | 8.0 | 14 |

**Counter triangle** (damage multipliers, attacker → defender):

|  | vs Ronin | vs Oni | vs Mantis | vs Wasp | vs buildings |
|---|---|---|---|---|---|
| **Ronin** | 1.0 | 0.6 | **1.5** | 1.2 | 0.8 |
| **Oni** | **1.5** | 1.0 | 0.8 | 0.8 | 1.2 |
| **Mantis** | 0.8 | **1.5** | 1.0 | 0.5 | 1.5 |
| **Wasp** | 0.7 | 0.5 | 1.0 | 1.0 | **1.5** |

Readable as: **Ronin > Mantis > Oni > Ronin**; Wasp loses straight fights but excels at raiding buildings, scouting (best vision + speed), and chasing (fastest unit — the natural Commander-hunter).

- Damage model: continuous DPS applied per tick, no projectile simulation at launch (Mantis gets a visual-only arcing projectile). No overkill mechanics.
- Mantis has a **minimum range** of 6: closed-distance Ronin shred it. This is what makes the triangle work spatially, not just numerically.
- Units killed grant nothing (no bounty/XP).
- Death is removal; no wrecks/corpses affecting gameplay.

---

## 7. Rally Points & Behaviors

Every Fabricator has a **rally point** (a map position) and a **behavior**. Spawned units inherit both and are permanently governed by them (until the building's settings change — existing units adopt new settings too, so a Fabricator is effectively a *control channel* for all its living units).

**Behaviors:**

| Behavior | Unit logic |
|---|---|
| **Guard** | Move to rally. Engage enemies within 15 u of rally; chase max 10 u past that, then return. |
| **Assault** | Move toward rally, engaging anything encountered en route. On arrival, keep engaging anything in vision. The "attack-move" of this game. |
| **Hold** | Move to rally. Attack only what enters weapon range. Never chase. (Chokepoint / high-ground camping.) |
| **Hunt** | Ignore rally. Continuously seek nearest known enemy unit or building. All-out aggression. |

**Global Override** — a console at the Bastion (Commander must be adjacent). Triggering it overrides **all** units' behaviors simultaneously with one of:

- **FALL BACK** — every unit retreats to the Bastion, ignoring enemies.
- **DEFEND** — every unit behaves as Guard with rally = Bastion.
- **RELEASE** — cancel the override; units resume their Fabricator's behavior.

The override is the panic button and the "final push from home" button — powerful precisely because using it costs a Commander round-trip to base.

**Micro-behaviors (all units, always on):** units clump loosely with same-rally units (soft flocking), prefer targets they counter when multiple targets are in range, and Mantis units attempt to kite to max range when threatened by shorter-ranged enemies (simple: back away while on cooldown if enemy in min-range zone).

---

## 8. Tech Tree

Researched at the **Bastion** (Commander adjacent to start; research continues unattended; one research at a time). Three branches, no cross-requirements — depth within a branch requires the previous node.

**ECONOMY**
1. *Overclocked Extraction* — 100 e, 30 s — Extractors +2 e/s (to 8).
2. *Grid Tap* — 150 e, 45 s — Grid-feed capture points +2 e/s (to 5); capture rate +50%.
3. *Deep Cycle* — 250 e, 60 s — Bastion trickle +4 e/s (to 7); repairs cost no energy.

**MILITARY**
1. *Hardened Frames* — 100 e, 30 s — all units +15% HP.
2. *Focused Optics* — 150 e, 45 s — all units +15% damage.
3. *Ballistic Extension* — 200 e, 60 s — Mantis range 22→26; Watchtower range 16→19.

**COMMANDER**
1. *Servo Boost* — 100 e, 30 s — Commander speed 6→7; build channel 20% faster.
2. *Nanoweave* — 150 e, 45 s — Commander regenerates 2 HP/s out of combat (5 s without taking damage).
3. *Thermoptic Veil* — 250 e, 60 s — Commander is invisible while standing still and not building/repairing/interacting for ≥2 s. Revealed by Sensor Spires. (The signature GitS tech — a stalled endgame Commander-hunt becomes hide-and-seek around sensor coverage.)

~10 techs, ~1450 e and ~6 minutes to research everything — impossible to get it all in a normal match; picks define identity.

---

## 9. Capture Points

**3 per map** (one center, two on the flanks), visibly marked neutral beacons.

- **Capturing:** any friendly unit (or Commander, at 2× rate) inside radius 8 with no enemies present fills a capture meter: 10 s solo-unit baseline. Contested (both sides present) = frozen. Captured points must be fully neutralized (same process) before the other side can take them.
- **Randomized buffs:** at match start, each point rolls a **random subset of 2 buffs** (no duplicates within a point) from the shared pool below, using the match seed. Rolls are revealed to **both players from game start** — the map layout is symmetric, and points are shared objectives, so randomness stays fair while making every match's map-control priorities different.

  | Buff | Effect while held |
  |---|---|
  | **Grid feed** | +3 e/s income |
  | **Uplink** | Vision, radius 20, around the point |
  | **Targeting aura** | Holder's units within radius 14: +15% damage |
  | **Drive aura** | Holder's units within radius 14: +20% move speed |
  | **Shield aura** | Holder's units within radius 14: −15% damage taken |

- Aura-type buffs affect only the holder's units and do not stack with each other or with the Aegis Projector's aura (strongest applies, per stat).

The roll changes which point is *the* priority each match — a center with Grid feed + Targeting aura is a warzone; a flank with Uplink + Drive aura is a raider's staging ground. Points remain the anti-turtle engine: ceding the map concedes whatever income and auras rolled that match (expected ~3 e/s per point on average).

---

## 10. Terrain & Maps

Maps are heightmap-based with three elevation levels and painted zone properties.

- **Map size:** ~180 × 180 u (≈30 s Commander walk corner to corner). Mirrored symmetry.
- **Cliffs:** unpathable transitions between elevation levels; **ramps** are the only vertical routes. Chokepoints by construction.
- **High ground:** units and Watchtowers on higher elevation than their target get **+25% damage**; attackers on low ground have **no vision** up a cliff face without a Sensor Spire — nothing flies at launch, so high ground is only scouted by walking a ramp.
- **Slow zones** (rubble/flooded lowland): move speed ×0.7. Painted in valleys and around some capture points.
- **Zone rendering** must be legible at a glance: distinct ground material + subtle holographic boundary line.

**Launch map — "Junction 9":** two elevated main bases (Bastion + 1 node) at opposite corners, natural node at each base's ramp exit, low-ground center valley with 2 nodes + center capture point (in a slow zone — committing there is slow to enter, slow to leave), two flank routes with a capture point each on mid-elevation plateaus. Capture-point buffs are rolled per match (§9), so route priority shifts game to game.

---

## 11. Fog of War & Vision

- **Full fog:** unexplored terrain is dark (terrain relief faintly visible — map topology is public knowledge, unit/building presence is not).
- **Vision sources:** *all* friendly units, the Commander, all buildings (radius 12 unless specified), and held capture points. Shared team vision.
- **Last-known-state:** previously-seen enemy buildings render as ghosted snapshots until re-scouted (with a "last seen 0:42 ago" staleness the Claude protocol also exposes). Enemy *units* are not remembered — only live sightings.
- Thermoptic Veil (§8) is the only stealth in the game; Sensor Spires are its only counter.

---

## 12. Camera, Controls & UI

**Camera:** free RTS camera (pan/zoom, edge scroll + WASD/arrows), fog-limited. Space bar snaps to Commander. Double-tap space toggles follow-cam.

**Human controls:**

- **Right-click:** move Commander (its only direct order).
- **B:** open radial build menu around Commander → click structure → click placement → Commander autopaths and channels.
- **Click a friendly building:** shows its panel read-only; panel becomes interactive when Commander is adjacent (walk-to-interact happens automatically if you click a control while distant — Commander paths there first).
- Rally points set by clicking the map while a Fabricator panel is open; behavior via 4 icons on the panel.

**HUD:** energy stockpile + income rate (top), minimap with fog/pings (corner), Commander HP bar (always visible), event feed ("West point lost", "Bastion under attack"), research progress bar. Building overlays: rally-point lines and behavior icons visible when zoomed in, so army configuration is readable at a glance.

**Opponent-thinking state (vs Claude):** when the sim pauses awaiting Claude's orders, show a subtle "uplink" indicator; the human can pan, inspect, and plan but not issue orders while paused (fairness symmetry).

---

## 13. Claude Player Integration

The defining technical feature. The simulation is a deterministic fixed-tick core; Claude plays via a snapshot → commands loop.

### 13.1 Tick-turn model

- Sim runs at **10 ticks/s** game time.
- **Decision interval: 10 s of game time** (100 ticks; configurable 5–30 s). The game plays in real time for the human during each interval; at each boundary the sim **pauses**, serializes Claude's view, calls the Claude API, applies the returned commands, and resumes.
- Human orders during the interval apply immediately (humans get continuous control; Claude gets discrete control — this asymmetry is accepted and offset by Claude's perfect map awareness within its vision).
- All of Claude's commands are **standing orders** executed by the same engine rules a human is subject to (the Commander walks to buildings to change them, etc.). Claude issues intents; the engine enforces legality.

### 13.2 State snapshot (JSON, Claude's view only)

```jsonc
{
  "tick": 3200, "gameTime": 320.0, "decisionInterval": 10,
  "you": {
    "energy": 340, "incomeRate": 12,
    "commander": { "id": 1, "pos": [44, 91], "hp": 300, "maxHp": 300,
                   "currentOrder": "moving_to [60,80]", "queuedOrders": [] },
    "buildings": [ { "id": 7, "type": "fabricator", "pos": [30, 40], "hp": 500,
                     "production": "ronin", "on": true,
                     "rally": [90, 90], "behavior": "assault" } ],
    "units": [ { "id": 21, "type": "ronin", "pos": [88, 87], "hp": 95,
                 "sourceBuilding": 7, "state": "engaging unit 55" } ],
    "research": { "completed": ["eco1"], "inProgress": null, "available": ["eco2", "mil1", "cmd1"] }
  },
  "visibleEnemies": {
    "units": [ { "id": 55, "type": "wasp", "pos": [92, 85], "hp": 40 } ],
    "buildings": [ ],
    "commander": null
  },
  "lastKnown": { "buildings": [ { "type": "watchtower", "pos": [140, 60], "ageSeconds": 42 } ] },
  "capturePoints": [ { "id": "center", "pos": [90, 90], "owner": "you",
                       "buffs": ["grid_feed", "targeting_aura"],
                       "captureProgress": 1.0, "contested": false } ],
  "events": [ "unit 19 (ronin) destroyed by enemy oni at [88,86]",
              "capture point 'west' lost" ],
  "map": { /* static: sent once at game start — terrain grid, nodes, points, ramps */ },
  "invalidCommands": [ { "cmd": "research", "reason": "commander not adjacent to bastion" } ]
}
```

### 13.3 Command schema (Claude → engine, list per turn)

```jsonc
[
  { "cmd": "move",           "pos": [60, 80] },                     // commander; commands queue in order
  { "cmd": "build",          "type": "watchtower", "pos": [62, 78] },
  { "cmd": "set_rally",      "building": 7, "pos": [90, 90] },      // implies commander walks there first
  { "cmd": "set_behavior",   "building": 7, "behavior": "hold" },
  { "cmd": "set_production", "building": 7, "unit": "oni", "on": true },
  { "cmd": "research",       "tech": "mil1" },
  { "cmd": "global_override","stance": "fall_back" },               // or "defend" / "release"
  { "cmd": "repair",         "building": 7 }
]
```

Commander-dependent commands auto-queue the required movement. Illegal commands are dropped and reported in the next snapshot's `invalidCommands` — Claude self-corrects rather than the engine guessing.

### 13.4 Claude prompt design

- System prompt: rules digest (this doc's mechanics compressed), counter table, current tech tree, strategic doctrine hints. Kept under ~2K tokens.
- Per turn: latest snapshot + Claude's own **persistent scratchpad** (it returns a `"memo"` string each turn, echoed back next turn — its strategic memory across turns without resending history).
- Target: one API call per decision interval; a 12-minute match ≈ 72 calls.

### 13.5 Modes

- **Launch:** Human vs Claude.
- **Free (engine supports by construction):** Claude vs Claude headless (the sim core has no render dependency — this is the balance-testing harness), replay from command logs (deterministic sim + seeded RNG + command stream = perfect replays).

---

## 14. Aesthetics — Low-Poly Ghost in the Shell

- **World:** flat-shaded low-poly geometry; desaturated concrete/steel urban-industrial palette (grays, gunmetal blue) so that **emissive accents carry all meaning**: teal = you, signal orange = enemy, magenta = neutral/capture.
- **Units as machines:** everything is robotic/drone — no organic units (fits unarmed-Commander logic: it's a mobile fabrication chassis). Ronin = spider-legged frame, Oni = heavy quadruped, Mantis = long-limbed strider with dorsal cannon, Wasp = hovering tri-rotor.
- **Holographic UI language:** building panels, rally lines, aura boundaries and zone edges rendered as in-world scanline holograms rather than 2D overlays where feasible.
- **Fog** as digital static/wireframe dissolution rather than black clouds; last-known buildings render as glitching wireframe ghosts.
- **Thermoptic Veil** shimmer effect quoting the films' iconic camo.
- Sound: minimal synth ambience, distinct per-unit-type weapon sounds (audio is a legibility channel), muffled/lowpassed for off-screen events.

---

## 15. Technical Architecture

- **Language/stack:** TypeScript. Three.js for rendering. Vite for build. No game engine.
- **Two strictly separated layers:**
  1. **Sim core** — pure TS, zero DOM/Three imports. Deterministic fixed-tick (10 Hz), integer/fixed-point positions internally, seeded PRNG, entity-component-lite (plain objects, ~200 entities max). Input: command stream. Output: state + events. Runs in browser, in a worker, or headless in Node (tests, Claude-vs-Claude).
  2. **Presentation** — Three.js scene reading sim state read-only, interpolating entity transforms between ticks for 60 fps rendering; input layer translating human UI into the same command schema Claude uses (§13.3 — **one command pipeline for both player types**).
- **Pathfinding:** grid (1 u cells) A* with path caching; steering + soft flocking on top. Flow fields deferred unless group movement quality demands it.
- **Fog:** per-player visibility grid recomputed on a 0.5 s cadence, not per tick.
- **Claude driver:** thin async layer — pause sim at boundary tick, snapshot, POST to Anthropic API, validate/apply commands, resume. Model: latest Claude (e.g. `claude-fable-5`), with a cheap-model option for testing.
- **Persistence:** command-log replays as flat JSON files. No backend/accounts at launch; API key supplied locally.

---

## 16. Balance Targets & Tuning Levers

Testable assertions for the balance pass (Claude-vs-Claude headless runs make these measurable):

1. Median match length 10–15 min; <5% of matches exceed 20 min.
2. No opening (rush / eco / tech-first) wins >55% in self-play.
3. A pure single-unit-type army loses to an equal-cost countered composition ≥70% of the time.
4. Player holding 2+ capture points for 3+ consecutive minutes wins ≥65% (map control must matter).
5. Commander snipe attempts (Wasp packs on Hunt) succeed often enough to punish careless forward-building, rarely enough that escorted Commanders are safe: target 15–30% success rate when attempted.

Reserved levers, in preferred order: unit costs → income rates → counter multipliers → node depletion (off at launch) → decision-interval length (Claude difficulty knob).

---

## 17. Out of Scope (Launch)

Explicitly deferred: networked human-vs-human, scripted (non-Claude) AI, multiple maps, air units, unit veterancy, walls, more than one turret type, map editor, ranked/matchmaking, campaign. The architecture (deterministic sim + unified command pipeline) is chosen so none of these are foreclosed.
