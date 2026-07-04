// GHOSTLINE presentation layer (§12/§14): Three.js scene over the sim core.
// Sim ticks at 10 Hz; rendering interpolates entity transforms for 60 fps.
// The human plays player 0 through the same command pipeline Claude uses.

import * as THREE from 'three';
import {
  BUILDING_STATS,
  type BuildingType,
  type Command,
  FP,
  Game,
  TICKS_PER_SECOND,
  UNIT_STATS,
  type UnitType,
  VISION_INTERVAL,
} from './sim';
import { loadTuning, resetTuning, saveTuning, UNIT_DEFAULTS, VISUAL_TUNING } from './tuning';
import { SceneRig } from './render/scene';
import { Terrain } from './render/terrain';
import { EntityLayer } from './render/entities';
import { Hud } from './ui/hud';
import { ClaudePlayer } from './claude/driver';
import { createAnthropicTransport, DEFAULT_MODEL } from './claude/anthropic';
import { ScriptedBot } from './bots/scripted';

const params = new URLSearchParams(location.search);
loadTuning(); // apply saved unit tuning before the sim starts
const game = new Game(params.has('seed') ? Number(params.get('seed')) : Date.now() % 2 ** 31);

// ?demo: two scripted bots play each other (visual test / attract mode).
// ?fast: 4x sim speed.
const demoBots = params.has('demo') ? [new ScriptedBot(0, 'eco'), new ScriptedBot(1, 'rush')] : null;
const speed = params.has('fast') ? 4 : 1;

// -- Claude opponent -----------------------------------------------------------

let claude: ClaudePlayer | null = null;
let uplink = false;
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
  claude = new ClaudePlayer(
    1,
    createAnthropicTransport({
      apiKey,
      model: localStorage.getItem('ghostline_model') ?? DEFAULT_MODEL,
      dangerouslyAllowBrowser: true,
      onError: (err) => {
        claudeError = err instanceof Error ? err.message : String(err);
      },
    }),
  );
}

function issue(cmd: Command): void {
  if (uplink || game.winner !== null) return; // §12: no orders while the opponent thinks
  game.applyCommand(0, cmd);
}

// -- scene ----------------------------------------------------------------------

const rig = new SceneRig(document.getElementById('app')!);
const terrain = new Terrain(game.map);
rig.scene.add(terrain.mesh);
const entities = new EntityLayer(game, terrain);
rig.scene.add(entities.group);
const hud = new Hud(game, issue, (x, y) => {
  rig.follow = false;
  rig.snapTo(x, y);
});

let revealAll = false;
let paused = false;

// debug menu (` to toggle)
const debugMenu = document.getElementById('debugmenu')!;
const dbgInstant = document.getElementById('dbg-instant') as HTMLInputElement;
dbgInstant.onchange = () => {
  game.debugInstantBuild = dbgInstant.checked;
};

// -- unit tuning UI: numeric fields bound straight to UNIT_STATS / VISUAL_TUNING
const dbgUnitSel = document.getElementById('dbg-unit') as HTMLSelectElement;
const dbgFields = document.getElementById('dbg-fields')!;
const TUNABLE: { key: keyof (typeof UNIT_STATS)['kumo']; label: string }[] = [
  { key: 'cost', label: 'cost (e)' },
  { key: 'buildTime', label: 'build time (s)' },
  { key: 'hp', label: 'hp (new units)' },
  { key: 'dps', label: 'dps' },
  { key: 'range', label: 'range (u)' },
  { key: 'minRange', label: 'min range (u)' },
  { key: 'speed', label: 'speed (u/s)' },
  { key: 'vision', label: 'vision (u)' },
  { key: 'burstTicks', label: 'burst cooldown (ticks)' },
];
for (const u of Object.keys(UNIT_STATS)) {
  const opt = document.createElement('option');
  opt.value = u;
  opt.textContent = u;
  dbgUnitSel.appendChild(opt);
}
dbgUnitSel.value = 'kumo';

function tuningRow(label: string, value: number, dflt: number, apply: (v: number) => void): void {
  const row = document.createElement('div');
  row.className = 'trow';
  const span = document.createElement('span');
  span.textContent = label;
  span.title = `default: ${dflt}`;
  const input = document.createElement('input');
  input.type = 'number';
  input.step = 'any';
  input.value = String(value);
  input.oninput = () => {
    const v = parseFloat(input.value);
    if (Number.isFinite(v) && v >= 0) {
      apply(v);
      saveTuning();
    }
  };
  row.append(span, input);
  dbgFields.appendChild(row);
}

function renderTuning(): void {
  const u = dbgUnitSel.value as UnitType;
  const stats = UNIT_STATS[u];
  dbgFields.innerHTML = '';
  for (const f of TUNABLE) {
    tuningRow(f.label, stats[f.key] ?? 1, UNIT_DEFAULTS[u][f.key] ?? 1, (v) => {
      stats[f.key] = f.key === 'burstTicks' ? Math.max(1, Math.round(v)) : v;
    });
  }
  if (u === 'kumo') {
    tuningRow('burst rounds (visual)', VISUAL_TUNING.kumoBurstRounds, 4, (v) => {
      VISUAL_TUNING.kumoBurstRounds = Math.max(1, Math.round(v));
    });
    tuningRow('round spacing (frames)', VISUAL_TUNING.kumoBurstSpacing, 2, (v) => {
      VISUAL_TUNING.kumoBurstSpacing = Math.max(1, Math.round(v));
    });
  }
}
dbgUnitSel.onchange = renderTuning;
renderTuning();

document.getElementById('dbg-reset')!.onclick = () => {
  resetTuning(dbgUnitSel.value as UnitType);
  renderTuning();
};
document.getElementById('dbg-reset-all')!.onclick = () => {
  resetTuning();
  renderTuning();
};

// placement ghost
const ghost = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.4 }),
);
ghost.visible = false;
rig.scene.add(ghost);

// start camera on our base
rig.snapTo(game.map.spawns[0].commander.x / FP, game.map.spawns[0].commander.y / FP);

// -- picking ----------------------------------------------------------------------

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let mouseGround: { x: number; y: number } | null = null; // world units (sim frame)

function updateRay(ev: MouseEvent): void {
  ndc.x = (ev.clientX / window.innerWidth) * 2 - 1;
  ndc.y = -(ev.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(ndc, rig.camera);
  const hit = raycaster.intersectObject(terrain.mesh)[0];
  mouseGround = hit ? { x: hit.point.x, y: hit.point.z } : null;
}

function snapForFootprint(type: BuildingType, x: number, y: number): { x: number; y: number } {
  const f = BUILDING_STATS[type].footprint;
  if (f % 2 === 0) return { x: Math.round(x) * FP, y: Math.round(y) * FP };
  return { x: Math.floor(x) * FP + FP / 2, y: Math.floor(y) * FP + FP / 2 };
}

// -- input --------------------------------------------------------------------------

window.addEventListener('mousemove', updateRay);

window.addEventListener('contextmenu', (ev) => {
  ev.preventDefault();
  if ((ev.target as HTMLElement).closest('#panel,#buildbar,#minimap')) return;
  if (hud.placing) {
    hud.placing = null;
    return;
  }
  updateRay(ev);
  if (!mouseGround) return;
  // selected fabricator: right-click retargets its rally instead of moving the Commander
  const sel = hud.selected !== null ? game.building(hud.selected) : null;
  if (sel && sel.player === 0 && sel.done && sel.type === 'fabricator') {
    issue({ cmd: 'set_rally', building: sel.id, pos: [mouseGround.x, mouseGround.y] });
    return;
  }
  issue({ cmd: 'move', pos: [mouseGround.x, mouseGround.y], replace: true });
});

window.addEventListener('mousedown', (ev) => {
  if (ev.button !== 0) return;
  if ((ev.target as HTMLElement).closest('#panel,#buildbar,#minimap,#overlay')) return;
  updateRay(ev);
  if (hud.placing && mouseGround) {
    issue({ cmd: 'build', type: hud.placing, pos: [mouseGround.x, mouseGround.y] });
    hud.placing = null;
    return;
  }
  if (hud.rallyArm !== null && mouseGround) {
    issue({ cmd: 'set_rally', building: hud.rallyArm, pos: [mouseGround.x, mouseGround.y] });
    hud.rallyArm = null;
    return;
  }
  hud.select(entities.pick(raycaster, game));
});

// digits — WASD is camera pan
const BUILD_KEYS: Record<string, BuildingType> = {
  '1': 'extractor',
  '2': 'fabricator',
  '3': 'watchtower',
  '4': 'sensor_spire',
  '5': 'aegis_projector',
};

let lastSpace = 0;
window.addEventListener('keydown', (ev) => {
  const k = ev.key.toLowerCase();
  if (k === 'escape') {
    hud.placing = null;
    hud.rallyArm = null;
    hud.select(null);
  } else if (k === ' ') {
    ev.preventDefault();
    const c = game.commander(0);
    if (c) rig.snapTo(c.pos.x / FP, c.pos.y / FP);
    if (performance.now() - lastSpace < 350) rig.follow = !rig.follow;
    lastSpace = performance.now();
  } else if (k === 'b') {
    hud.placing = hud.placing ? null : 'extractor';
  } else if (BUILD_KEYS[k]) {
    hud.placing = BUILD_KEYS[k];
  } else if (k === '`') {
    debugMenu.style.display = debugMenu.style.display === 'block' ? 'none' : 'block';
  } else if (k === 'k') toggleClaude();
  else if (k === 'm') hud.showIntel = !hud.showIntel;
  else if (k === 'x') revealAll = !revealAll;
  else if (k === 'p') paused = !paused;
});

// -- sim loop -------------------------------------------------------------------------

const prevPos = new Map<number, { x: number; y: number }>();
let lastStepTime = performance.now();
const TURN_TICKS = 10 * TICKS_PER_SECOND;
const allVisible = new Uint8Array(game.map.size * game.map.size).fill(1);
let fogDirty = true;

setInterval(() => {
  if (paused || game.winner !== null || uplink) return;
  if (claude && game.tick % TURN_TICKS === 0 && game.tick !== lastTurnTick) {
    uplink = true;
    claude
      .takeTurn(game)
      .catch(() => {})
      .finally(() => {
        lastTurnTick = game.tick;
        uplink = false;
      });
    return;
  }
  prevPos.clear();
  for (const e of game.entities.values()) {
    if (e.kind !== 'building') prevPos.set(e.id, { x: e.pos.x, y: e.pos.y });
  }
  for (let i = 0; i < speed && game.winner === null; i++) {
    if (demoBots && game.tick % TURN_TICKS === 0) {
      for (const b of demoBots) b.takeTurn(game);
    }
    game.step();
  }
  lastStepTime = performance.now();
  if (game.tick % VISION_INTERVAL === 0) fogDirty = true;
}, 1000 / TICKS_PER_SECOND);

// -- render loop -------------------------------------------------------------------------

let lastFrame = performance.now();
function frame(): void {
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;

  if (fogDirty) {
    terrain.updateFog(revealAll ? allVisible : game.players[0].visible);
    fogDirty = false;
  }

  const alpha = Math.min(1, (now - lastStepTime) / (1000 / TICKS_PER_SECOND));
  const cmdr = game.commander(0);
  rig.update(dt, cmdr ? { x: cmdr.pos.x / FP, z: cmdr.pos.y / FP } : null);
  entities.update(game, prevPos, alpha, hud.selected);

  // placement ghost
  if (hud.placing && mouseGround) {
    const type = hud.placing;
    const f = BUILDING_STATS[type].footprint;
    const snapped = snapForFootprint(type, mouseGround.x, mouseGround.y);
    const err = game.placementError(type, snapped);
    ghost.visible = true;
    ghost.scale.set(f, 1.2, f);
    ghost.position.set(
      snapped.x / FP,
      terrain.heightAtMu(snapped.x, snapped.y) + 0.6,
      snapped.y / FP,
    );
    (ghost.material as THREE.MeshBasicMaterial).color.set(err ? '#ff4d4d' : '#58f5b0');
  } else {
    ghost.visible = false;
  }

  hud.update({ uplink, vsClaude: claude !== null, claudeError, paused });
  hud.renderIntel(claude ? claude.history : null);
  hud.drawMinimap(terrain, rig.target.x, rig.target.z, rig.dist * 0.45);
  rig.render();

  // Dev aid (?snap): headless-browser screenshots can't composite WebGL, so
  // mirror one rendered frame into a plain <img> that they can capture.
  if (snapAt !== null && now >= snapAt) {
    snapAt = null;
    const img = document.createElement('img');
    img.src = rig.renderer.domElement.toDataURL();
    img.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:5;pointer-events:none;';
    document.body.appendChild(img);
  }
  requestAnimationFrame(frame);
}
let snapAt: number | null = params.has('snap') ? performance.now() + Number(params.get('snap') || 3000) : null;
requestAnimationFrame(frame);

// x-key reveal needs a fog rewrite even between vision ticks
window.addEventListener('keydown', (ev) => {
  if (ev.key.toLowerCase() === 'x') fogDirty = true;
});
