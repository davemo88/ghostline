// HTML overlay UI (§12): energy/income top bar, event feed, build bar,
// building panel (interactive — the engine walks the Commander over when a
// control is used from afar), minimap with fog + camera viewport, win overlay.

import {
  BUILDING_STATS,
  type Behavior,
  type BuildingEnt,
  type BuildingType,
  type Command,
  FP,
  type Game,
  TECHS,
  type TechId,
  type UnitType,
  availableTechs,
  cellIndex,
} from '../sim';
import type { Terrain } from '../render/terrain';
import type { TurnRecord } from '../claude/driver';

const BUILDABLE: { type: BuildingType; key: string; label: string }[] = [
  { type: 'extractor', key: 'E', label: 'extractor' },
  { type: 'fabricator', key: 'F', label: 'fabricator' },
  { type: 'watchtower', key: 'W', label: 'watchtower' },
  { type: 'sensor_spire', key: 'S', label: 'spire' },
  { type: 'aegis_projector', key: 'A', label: 'aegis' },
];
const UNIT_ORDER: UnitType[] = ['ronin', 'oni', 'mantis', 'wasp'];
const BEHAVIORS: Behavior[] = ['guard', 'assault', 'hold', 'hunt'];

export class Hud {
  placing: BuildingType | null = null;
  rallyArm: number | null = null; // fabricator id awaiting a rally click
  selected: number | null = null; // selected building id
  showIntel = false; // Claude's thoughts panel (M)

  private intel = document.getElementById('intel')!;
  private intelKey = '';

  private topbar = document.getElementById('topbar')!;
  private uplinkEl = document.getElementById('uplink')!;
  private eventsEl = document.getElementById('events')!;
  private buildbar = document.getElementById('buildbar')!;
  private panel = document.getElementById('panel')!;
  private overlay = document.getElementById('overlay')!;
  private minimap = document.getElementById('minimap') as HTMLCanvasElement;
  private mctx = this.minimap.getContext('2d')!;
  private terrainBase: ImageData;
  private issue: (cmd: Command) => void;
  private game: Game;
  private panelKey = '';

  constructor(game: Game, issue: (cmd: Command) => void, onMinimapClick: (x: number, y: number) => void) {
    this.game = game;
    this.issue = issue;

    for (const b of BUILDABLE) {
      const btn = document.createElement('button');
      btn.textContent = `${b.key}·${b.label} ${BUILDING_STATS[b.type].cost}e`;
      btn.onclick = () => {
        this.placing = b.type;
      };
      this.buildbar.appendChild(btn);
    }

    // minimap terrain backdrop (once)
    const size = game.map.size;
    this.terrainBase = new ImageData(size, size);
    for (let i = 0; i < size * size; i++) {
      const e = game.map.elevation[i];
      let [r, g, bl] = [[40, 44, 50], [56, 63, 72], [74, 83, 95]][e];
      if (game.map.slow[i]) bl += 26;
      this.terrainBase.data[i * 4] = r;
      this.terrainBase.data[i * 4 + 1] = g;
      this.terrainBase.data[i * 4 + 2] = bl;
      this.terrainBase.data[i * 4 + 3] = 255;
    }

    this.minimap.addEventListener('mousedown', (ev) => {
      const rect = this.minimap.getBoundingClientRect();
      onMinimapClick(
        ((ev.clientX - rect.left) / rect.width) * size,
        ((ev.clientY - rect.top) / rect.height) * size,
      );
    });
  }

  beginPlacement(type: BuildingType): void {
    this.placing = type;
  }

  select(b: BuildingEnt | null): void {
    this.selected = b ? b.id : null;
    this.panelKey = ''; // force re-render
  }

  /** Spectator/debug view of the Claude opponent's turns (thinking + memo + orders). */
  renderIntel(history: TurnRecord[] | null): void {
    if (!this.showIntel || !history) {
      this.intel.style.display = 'none';
      this.intelKey = '';
      return;
    }
    this.intel.style.display = 'block';
    const recent = history.slice(-4);
    const key = `${history.length}:${recent[recent.length - 1]?.turn ?? 0}`;
    if (key === this.intelKey) return;
    this.intelKey = key;

    const fmt = (t: TurnRecord): string => {
      const parts = [`<h4>turn ${t.turn} · ${t.gameTime.toFixed(0)}s${t.skipped ? ' · SKIPPED' : ''}</h4>`];
      if (t.thinking) parts.push(`<div class="think">${escapeHtml(t.thinking)}</div>`);
      if (t.memo) parts.push(`<div class="memo">memo: ${escapeHtml(t.memo)}</div>`);
      for (const c of t.commands) parts.push(`<div class="cmd">▸ ${escapeHtml(JSON.stringify(c))}</div>`);
      for (const r of t.rejected) parts.push(`<div class="rej">✗ ${escapeHtml(r.reason)}</div>`);
      if (!t.commands.length && !t.skipped) parts.push('<div class="cmd">▸ (no orders — standing orders continue)</div>');
      return parts.join('');
    };
    this.intel.innerHTML =
      '<h4 style="margin-top:0">⟨ CLAUDE UPLINK LOG ⟩</h4>' +
      (recent.length ? recent.map(fmt).join('') : '<div class="think">no turns yet…</div>');
    this.intel.scrollTop = this.intel.scrollHeight;
  }

  update(opts: { uplink: boolean; vsClaude: boolean; claudeError: string; paused: boolean }): void {
    const game = this.game;
    const p = game.players[0];
    const research = p.research
      ? ` | R&D: ${TECHS[p.research.tech].name} ${Math.ceil(p.research.ticksLeft / 10)}s`
      : '';
    const cmdr = game.commander(0);
    const over = p.override ? ` | OVERRIDE ${p.override}` : '';
    this.topbar.textContent =
      `⚡ ${Math.floor(p.energy / FP)}  +${game.incomeRate(0)}/s | CMDR ${cmdr ? Math.ceil(cmdr.hp / FP) : 0}hp` +
      `${research}${over} | ${game.gameTime.toFixed(0)}s` +
      (opts.vsClaude ? ' | vs Claude' : '') +
      (opts.paused ? ' | PAUSED' : '') +
      (opts.claudeError ? ` | ⚠ ${opts.claudeError.slice(0, 48)}` : '');

    this.uplinkEl.style.display = opts.uplink ? 'block' : 'none';

    const evs = p.events.slice(-5);
    this.eventsEl.innerHTML = evs.map((e) => `<div>· ${escapeHtml(e)}</div>`).join('');

    this.renderPanel();
    this.renderOverlay();
  }

  private renderOverlay(): void {
    const w = this.game.winner;
    if (w === null) {
      this.overlay.style.display = 'none';
      return;
    }
    this.overlay.style.display = 'flex';
    this.overlay.textContent = w === -1 ? 'DRAW' : w === 0 ? 'VICTORY' : 'COMMANDER LOST';
    this.overlay.style.color = w === 0 ? 'var(--you)' : 'var(--enemy)';
  }

  private renderPanel(): void {
    const b = this.selected !== null ? this.game.building(this.selected) : null;
    if (!b || b.player !== 0) {
      this.panel.style.display = 'none';
      this.selected = null;
      return;
    }
    this.panel.style.display = 'block';

    // Re-render only when the displayed state changes (keeps buttons clickable).
    const key = JSON.stringify([
      b.id, b.type, b.done, Math.ceil(b.hp / FP), b.production, b.on, b.behavior,
      b.rally.x, b.rally.y, this.rallyArm,
      b.type === 'bastion' ? availableTechs(this.game, 0) : null,
      this.game.players[0].research?.tech ?? null,
    ]);
    if (key === this.panelKey) return;
    this.panelKey = key;

    this.panel.innerHTML = '';
    const h3 = document.createElement('h3');
    h3.textContent = `${b.type} #${b.id} — ${Math.ceil(b.hp / FP)}/${Math.ceil(b.maxHp / FP)}hp${b.done ? '' : ' (building…)'}`;
    this.panel.appendChild(h3);

    const row = (label: string, ...els: HTMLElement[]): void => {
      const div = document.createElement('div');
      div.className = 'row';
      if (label) {
        const span = document.createElement('span');
        span.textContent = label;
        div.appendChild(span);
      }
      for (const el of els) div.appendChild(el);
      this.panel.appendChild(div);
    };
    const btn = (label: string, onClick: () => void, active = false): HTMLButtonElement => {
      const el = document.createElement('button');
      el.textContent = label;
      el.className = active ? 'active' : '';
      el.onclick = onClick;
      return el;
    };

    if (!b.done) {
      row('', btn('resume', () => this.issue({ cmd: 'resume_build', building: b.id })));
      row('', btn('cancel (75% back)', () => this.issue({ cmd: 'cancel_build', building: b.id })));
      return;
    }

    if (b.type === 'fabricator') {
      row(
        'unit:',
        ...UNIT_ORDER.map((u) =>
          btn(u, () => this.issue({ cmd: 'set_production', building: b.id, unit: u, on: true }), b.production === u),
        ),
      );
      row(
        'mode:',
        ...BEHAVIORS.map((bh) =>
          btn(bh, () => this.issue({ cmd: 'set_behavior', building: b.id, behavior: bh }), b.behavior === bh),
        ),
        btn(b.on ? 'ON' : 'OFF', () => this.issue({ cmd: 'set_production', building: b.id, on: !b.on }), b.on),
      );
      row(
        '',
        btn(this.rallyArm === b.id ? 'click map…' : 'set rally', () => {
          this.rallyArm = this.rallyArm === b.id ? null : b.id;
          this.panelKey = '';
        }, this.rallyArm === b.id),
      );
    }

    if (b.type === 'bastion') {
      const avail = availableTechs(this.game, 0);
      const researching = this.game.players[0].research;
      if (!researching && avail.length) {
        row(
          'tech:',
          ...avail.slice(0, 5).map((t: TechId) =>
            btn(`${t} ${TECHS[t].cost}e`, () => this.issue({ cmd: 'research', tech: t })),
          ),
        );
      }
      row(
        'override:',
        btn('fall back', () => this.issue({ cmd: 'global_override', stance: 'fall_back' })),
        btn('defend', () => this.issue({ cmd: 'global_override', stance: 'defend' })),
        btn('release', () => this.issue({ cmd: 'global_override', stance: 'release' })),
      );
    }

    if (b.hp < b.maxHp) {
      row('', btn('repair', () => this.issue({ cmd: 'repair', building: b.id })));
    }
  }

  drawMinimap(terrain: Terrain, camX: number, camZ: number, viewRadius: number): void {
    const game = this.game;
    const size = game.map.size;
    this.mctx.putImageData(this.terrainBase, 0, 0);
    const img = this.mctx.getImageData(0, 0, size, size);
    // fog shading
    for (let cy = 0; cy < size; cy++) {
      for (let cx = 0; cx < size; cx++) {
        const i = cy * size + cx;
        const f = terrain.isVisible(cx, cy) ? 1 : terrain.isExplored(cx, cy) ? 0.55 : 0.25;
        img.data[i * 4] *= f;
        img.data[i * 4 + 1] *= f;
        img.data[i * 4 + 2] *= f;
      }
    }
    this.mctx.putImageData(img, 0, 0);

    const dot = (x: number, y: number, color: string, s: number): void => {
      this.mctx.fillStyle = color;
      this.mctx.fillRect((x / FP) - s / 2, (y / FP) - s / 2, s, s);
    };
    for (const cp of game.capturePoints) {
      dot(cp.pos.x, cp.pos.y, cp.owner === -1 ? '#d05ce0' : cp.owner === 0 ? '#39e0d0' : '#ff8a3d', 5);
    }
    for (const e of game.entities.values()) {
      if (e.player === 1 && !game.canTarget(0, e)) continue;
      const color = e.player === 0 ? '#39e0d0' : '#ff8a3d';
      dot(e.pos.x, e.pos.y, color, e.kind === 'building' ? 4 : e.kind === 'commander' ? 4 : 2);
    }
    // camera viewport
    this.mctx.strokeStyle = 'rgba(255,255,255,0.6)';
    this.mctx.strokeRect(camX - viewRadius, camZ - viewRadius * 0.7, viewRadius * 2, viewRadius * 1.4);
  }

  /** Whether a cell is visible for placement-ghost coloring etc. */
  cellBlocked(game: Game, cx: number, cy: number): boolean {
    return game.blocked[cellIndex(game.map, cx, cy)] === 1;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
}
