// Debug presentation for the sim core: canvas-2D top-down view, human plays
// player 0 through the same command pipeline Claude will use. The real
// Three.js presentation layer replaces this later; this stays as a sim debugger.

import {
  type Behavior,
  type BuildingType,
  BUILDING_STATS,
  CAPTURE_RADIUS,
  type Command,
  FP,
  Game,
  TECHS,
  type TechId,
  TICKS_PER_SECOND,
  type UnitType,
  availableTechs,
  cellIndex,
} from './sim';
import { ClaudePlayer } from './claude/driver';
import { createAnthropicTransport, DEFAULT_MODEL } from './claude/anthropic';

const SCALE = 5; // px per world unit
const game = new Game(Date.now() % 2 ** 31);

// -- Claude opponent (player 1) ------------------------------------------------

let claude: ClaudePlayer | null = null;
let uplink = false; // sim paused awaiting Claude's orders (§12: human can look, not act)
let lastTurnTick = -1;
let claudeError = '';

function toggleClaude(): void {
  if (claude) {
    claude = null;
    return;
  }
  const apiKey =
    localStorage.getItem('anthropic_apiKey') ??
    window.prompt('Anthropic API key (stored in localStorage, sent only to api.anthropic.com):');
  if (!apiKey) return;
  localStorage.setItem('anthropic_apiKey', apiKey);
  const model = localStorage.getItem('ghostline_model') ?? DEFAULT_MODEL;
  claude = new ClaudePlayer(
    1,
    createAnthropicTransport({
      apiKey,
      model,
      dangerouslyAllowBrowser: true,
      onError: (err) => {
        claudeError = err instanceof Error ? err.message : String(err);
      },
    }),
  );
}

/** All human input funnels through here so it can be locked during uplink. */
function issue(cmd: Command): void {
  if (uplink) return;
  game.applyCommand(0, cmd);
}

const canvas = document.getElementById('view') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const hud = document.getElementById('hud')!;

let paused = false;
let fogEnabled = true;
let mouse = { x: 90, y: 90 }; // world units
let rallyArm = false;

// -- terrain backdrop (drawn once) -------------------------------------------

const terrain = document.createElement('canvas');
terrain.width = game.map.size;
terrain.height = game.map.size;
{
  const t = terrain.getContext('2d')!;
  const img = t.createImageData(game.map.size, game.map.size);
  const elevColors = [
    [42, 46, 52],
    [58, 65, 74],
    [76, 85, 97],
  ];
  for (let i = 0; i < game.map.size * game.map.size; i++) {
    let [r, g, b] = elevColors[game.map.elevation[i]];
    if (game.map.ramp[i]) {
      r += 14;
      g += 14;
      b += 10;
    }
    if (game.map.slow[i]) {
      b += 26;
      g += 6;
    }
    img.data[i * 4] = r;
    img.data[i * 4 + 1] = g;
    img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = 255;
  }
  t.putImageData(img, 0, 0);
}

// -- input --------------------------------------------------------------------

function worldFromEvent(ev: MouseEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((ev.clientX - rect.left) / rect.width) * game.map.size,
    y: ((ev.clientY - rect.top) / rect.height) * game.map.size,
  };
}

canvas.addEventListener('mousemove', (ev) => {
  mouse = worldFromEvent(ev);
});

canvas.addEventListener('contextmenu', (ev) => {
  ev.preventDefault();
  const p = worldFromEvent(ev);
  issue({ cmd: 'move', pos: [p.x, p.y], replace: true });
});

canvas.addEventListener('click', () => {
  if (rallyArm) {
    const fab = hoveredFabricator();
    if (fab) issue({ cmd: 'set_rally', building: fab.id, pos: [mouse.x, mouse.y] });
    rallyArm = false;
  }
});

function hoveredFabricator() {
  for (const b of game.buildings(0)) {
    if (b.type !== 'fabricator') continue;
    const half = (BUILDING_STATS.fabricator.footprint / 2 + 1) * FP;
    if (Math.abs(b.pos.x - mouse.x * FP) < half && Math.abs(b.pos.y - mouse.y * FP) < half) return b;
  }
  return null;
}

function researchNext(branch: 'eco' | 'mil' | 'cmd'): void {
  const avail = availableTechs(game, 0).filter((t) => t.startsWith(branch));
  if (avail.length) issue({ cmd: 'research', tech: avail[0] as TechId });
}

const BUILD_KEYS: Record<string, BuildingType> = {
  e: 'extractor',
  f: 'fabricator',
  w: 'watchtower',
  s: 'sensor_spire',
  a: 'aegis_projector',
};
const UNIT_KEYS: Record<string, UnitType> = { 1: 'ronin', 2: 'oni', 3: 'mantis', 4: 'wasp', 5: 'kumo', 6: 'kaze', 7: 'taiko' };
const BEHAVIOR_KEYS: Record<string, Behavior> = { g: 'guard', h: 'hold', u: 'assault', n: 'hunt' };

window.addEventListener('keydown', (ev) => {
  const k = ev.key.toLowerCase();
  if (k === 'p') paused = !paused;
  else if (k === 'k') toggleClaude();
  else if (k === 'x') fogEnabled = !fogEnabled;
  else if (BUILD_KEYS[k]) issue({ cmd: 'build', type: BUILD_KEYS[k], pos: [mouse.x, mouse.y] });
  else if (k === 'r') researchNext('eco');
  else if (k === 't') researchNext('mil');
  else if (k === 'c') researchNext('cmd');
  else if (k === 'o') issue({ cmd: 'global_override', stance: 'fall_back' });
  else if (k === 'd') issue({ cmd: 'global_override', stance: 'defend' });
  else if (k === 'l') issue({ cmd: 'global_override', stance: 'release' });
  else if (k === 'y') rallyArm = true;
  else if (UNIT_KEYS[k]) {
    const fab = hoveredFabricator();
    if (fab) issue({ cmd: 'set_production', building: fab.id, unit: UNIT_KEYS[k], on: true });
  } else if (BEHAVIOR_KEYS[k]) {
    const fab = hoveredFabricator();
    if (fab) issue({ cmd: 'set_behavior', building: fab.id, behavior: BEHAVIOR_KEYS[k] });
  }
});

// -- sim loop -----------------------------------------------------------------

const TURN_TICKS = 10 * TICKS_PER_SECOND; // 10 s decision interval
setInterval(() => {
  if (paused || game.winner !== null || uplink) return;
  if (claude && game.tick % TURN_TICKS === 0 && game.tick !== lastTurnTick) {
    uplink = true;
    const bot = claude;
    bot
      .takeTurn(game)
      .catch(() => {})
      .finally(() => {
        lastTurnTick = game.tick;
        uplink = false;
      });
    return;
  }
  game.step();
}, 1000 / TICKS_PER_SECOND);

// -- render -------------------------------------------------------------------

const TEAM = ['#39e0d0', '#ff8a3d']; // teal you, orange enemy
const NEUTRAL = '#d05ce0';

function px(mu: number): number {
  return (mu / FP) * SCALE;
}

function draw(): void {
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(terrain, 0, 0, canvas.width, canvas.height);

  // nodes
  for (const n of game.map.nodes) {
    ctx.fillStyle = '#86f7b1';
    ctx.fillRect(px(n.x) - 6, px(n.y) - 6, 12, 12);
    ctx.strokeStyle = '#2a4438';
    ctx.strokeRect(px(n.x) - 6, px(n.y) - 6, 12, 12);
  }

  // capture points
  for (const cp of game.capturePoints) {
    const color = cp.owner === -1 ? NEUTRAL : TEAM[cp.owner];
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.arc(px(cp.pos.x), px(cp.pos.y), CAPTURE_RADIUS * SCALE, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(px(cp.pos.x), px(cp.pos.y), 4, 0, Math.PI * 2);
    ctx.fill();
    if (cp.meter > 0 && cp.meter < 1_000_000) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(px(cp.pos.x) - 15, px(cp.pos.y) + 10, (30 * cp.meter) / 1_000_000, 3);
    }
  }

  // buildings
  for (const b of game.buildings()) {
    const f = BUILDING_STATS[b.type].footprint * SCALE;
    const x = px(b.pos.x) - f / 2;
    const y = px(b.pos.y) - f / 2;
    if (fogEnabled && b.player === 1 && !game.cellVisibleForSnapshot(0, b.pos)) continue;
    ctx.fillStyle = b.done ? TEAM[b.player] : 'transparent';
    ctx.strokeStyle = TEAM[b.player];
    if (b.done) {
      ctx.globalAlpha = 0.85;
      ctx.fillRect(x, y, f, f);
      ctx.globalAlpha = 1;
    }
    ctx.strokeRect(x, y, f, f);
    // hp bar
    ctx.fillStyle = '#111';
    ctx.fillRect(x, y - 5, f, 3);
    ctx.fillStyle = '#7fff9e';
    ctx.fillRect(x, y - 5, (f * b.hp) / b.maxHp, 3);
    // rally line for own fabricators
    if (b.type === 'fabricator' && b.player === 0) {
      ctx.strokeStyle = 'rgba(57,224,208,0.35)';
      ctx.beginPath();
      ctx.moveTo(px(b.pos.x), px(b.pos.y));
      ctx.lineTo(px(b.rally.x), px(b.rally.y));
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = '9px monospace';
      ctx.fillText(`${b.production[0].toUpperCase()}·${b.behavior}`, x, y + f + 8);
    }
  }

  // units
  for (const u of game.units()) {
    if (fogEnabled && u.player === 1 && !game.cellVisibleForSnapshot(0, u.pos)) continue;
    ctx.fillStyle = TEAM[u.player];
    const r = u.type === 'oni' ? 4 : u.type === 'wasp' ? 2 : 3;
    ctx.beginPath();
    ctx.arc(px(u.pos.x), px(u.pos.y), r, 0, Math.PI * 2);
    ctx.fill();
    if (u.hp < u.maxHp) {
      ctx.fillStyle = '#7fff9e';
      ctx.fillRect(px(u.pos.x) - 4, px(u.pos.y) - 7, (8 * u.hp) / u.maxHp, 2);
    }
  }

  // artillery shells in flight: dot along the line + splash ring at the aim point
  for (const sh of game.shells) {
    if (
      fogEnabled &&
      sh.player === 1 &&
      !game.cellVisibleForSnapshot(0, sh.from) &&
      !game.cellVisibleForSnapshot(0, sh.to)
    ) {
      continue;
    }
    const t = 1 - sh.ticksLeft / sh.ticksTotal;
    ctx.fillStyle = '#ffd27f';
    ctx.beginPath();
    ctx.arc(px(sh.from.x + (sh.to.x - sh.from.x) * t), px(sh.from.y + (sh.to.y - sh.from.y) * t), 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,210,127,0.35)';
    ctx.beginPath();
    ctx.arc(px(sh.to.x), px(sh.to.y), (sh.splashMu / FP) * SCALE, 0, Math.PI * 2);
    ctx.stroke();
  }

  // commanders
  for (const player of [0, 1] as const) {
    const c = game.commander(player);
    if (!c) continue;
    if (fogEnabled && player === 1 && !game.canTarget(0, c)) continue;
    const x = px(c.pos.x);
    const y = px(c.pos.y);
    ctx.fillStyle = TEAM[player];
    ctx.beginPath();
    ctx.moveTo(x, y - 7);
    ctx.lineTo(x + 7, y);
    ctx.lineTo(x, y + 7);
    ctx.lineTo(x - 7, y);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.fillStyle = '#111';
    ctx.fillRect(x - 10, y - 13, 20, 3);
    ctx.fillStyle = '#7fff9e';
    ctx.fillRect(x - 10, y - 13, (20 * c.hp) / c.maxHp, 3);
  }

  // fog overlay
  if (fogEnabled) {
    const vis = game.players[0].visible;
    ctx.fillStyle = 'rgba(8,10,14,0.55)';
    for (let cy = 0; cy < game.map.size; cy++) {
      let runStart = -1;
      for (let cx = 0; cx <= game.map.size; cx++) {
        const dark = cx < game.map.size && !vis[cellIndex(game.map, cx, cy)];
        if (dark && runStart < 0) runStart = cx;
        else if (!dark && runStart >= 0) {
          ctx.fillRect(runStart * SCALE, cy * SCALE, (cx - runStart) * SCALE, SCALE);
          runStart = -1;
        }
      }
    }
    // last-known ghosts
    ctx.strokeStyle = 'rgba(255,138,61,0.5)';
    for (const lk of game.players[0].lastKnown.values()) {
      if (game.cellVisibleForSnapshot(0, lk.pos)) continue;
      const f = BUILDING_STATS[lk.type].footprint * SCALE;
      ctx.strokeRect(px(lk.pos.x) - f / 2, px(lk.pos.y) - f / 2, f, f);
    }
  }

  const p = game.players[0];
  const research = p.research
    ? ` | research: ${TECHS[p.research.tech].name} ${Math.ceil(p.research.ticksLeft / 10)}s`
    : '';
  const over = p.override ? ` | OVERRIDE: ${p.override}` : '';
  const winner =
    game.winner !== null ? ` | *** ${game.winner === -1 ? 'DRAW' : game.winner === 0 ? 'YOU WIN' : 'YOU LOSE'} ***` : '';
  const vsClaude = claude ? (uplink ? ' | ⟨UPLINK⟩ opponent thinking…' : ' | vs Claude') : '';
  const cErr = claudeError ? ` | claude: ${claudeError.slice(0, 60)}` : '';
  hud.textContent =
    `t=${game.gameTime.toFixed(0)}s | energy ${Math.floor(p.energy / FP)} (+${game.incomeRate(0)}/s)` +
    `${research}${over} | techs: ${[...p.techs].join(',') || 'none'}${winner}${paused ? ' | PAUSED' : ''}${vsClaude}${cErr}`;

  requestAnimationFrame(draw);
}

requestAnimationFrame(draw);
