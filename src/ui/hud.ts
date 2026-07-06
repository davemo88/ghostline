// HTML overlay UI (§12): energy/income top bar, event feed, build bar,
// building panel (interactive — the engine walks the Commander over when a
// control is used from afar), minimap with fog + camera viewport, win overlay.

import {
  BUILDING_STATS,
  type Behavior,
  type BuildingEnt,
  type BuildingType,
  COUNTER,
  type Command,
  type CommanderEnt,
  FP,
  type Game,
  TECHS,
  type TechId,
  TICKS_PER_SECOND,
  UNIT_STATS,
  type UnitType,
  WAVE_INTERVAL,
  availableTechs,
  cellIndex,
} from '../sim';
import type { Terrain } from '../render/terrain';
import type { TurnRecord } from '../claude/driver';

const BUILDABLE: { type: BuildingType; key: string; label: string }[] = [
  { type: 'extractor', key: '1', label: 'extractor' },
  { type: 'fabricator', key: '2', label: 'fabricator' },
  { type: 'watchtower', key: '3', label: 'watchtower' },
  { type: 'sensor_spire', key: '4', label: 'spire' },
  { type: 'aegis_projector', key: '5', label: 'aegis' },
];
const UNIT_ORDER: UnitType[] = ['ronin', 'oni', 'mantis', 'wasp', 'kumo', 'kaze', 'taiko'];
const BEHAVIORS: Behavior[] = ['guard', 'assault', 'hold', 'hunt'];

/** Native-tooltip text for a producible unit: stats + counter relationships. */
function unitTooltip(u: UnitType): string {
  const s = UNIT_STATS[u];
  const strong = (Object.keys(COUNTER[u]) as (UnitType | 'building' | 'commander')[])
    .filter((k) => k !== 'commander' && COUNTER[u][k] >= 1200)
    .map((k) => (k === 'building' ? 'buildings' : k));
  const counteredBy = UNIT_ORDER.filter((o) => o !== u && COUNTER[o][u] >= 1200);
  return [
    `${u} — ${s.cost}e · insta-builds on the wave`,
    `${s.hp}hp · ${s.dps}dps · range ${s.minRange ? `${s.minRange}–` : ''}${s.range} · speed ${s.speed} · vision ${s.vision}`,
    ...(s.windupTicks
      ? [`artillery: airburst splash r${s.splashRadius} · ${s.windupTicks / 10}s barrel-raise · shells land where the target was`]
      : []),
    `strong vs: ${strong.join(', ') || '—'}`,
    `countered by: ${counteredBy.join(', ') || '—'}`,
  ].join('\n');
}

function buildingTooltip(t: BuildingType): string {
  const s = BUILDING_STATS[t];
  const extra = [
    s.dps ? `${s.dps}dps · range ${s.range}` : '',
    s.auraRadius ? `damage-reduction aura, radius ${s.auraRadius}` : '',
    t === 'sensor_spire' ? `vision ${s.vision}` : '',
    t === 'extractor' ? 'harvests the resource node it is placed on' : '',
    t === 'fabricator' ? 'produces units continuously while powered' : '',
  ].filter(Boolean);
  return [`${t} — ${s.cost}e · ${s.buildTime}s build · ${s.hp}hp`, ...extra].join('\n');
}

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
      btn.title = buildingTooltip(b.type);
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

  select(e: BuildingEnt | CommanderEnt | null): void {
    this.selected = e ? e.id : null;
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
    const waveTicks = WAVE_INTERVAL * TICKS_PER_SECOND;
    const waveEta = Math.ceil((waveTicks - (game.tick % waveTicks)) / TICKS_PER_SECOND);
    this.topbar.textContent =
      `⚡ ${Math.floor(p.energy / FP)}  +${game.incomeRate(0)}/s | ⟳ wave ${waveEta}s | CMDR ${cmdr ? Math.ceil(cmdr.hp / FP) : 0}hp` +
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

  private renderCommanderPanel(c: CommanderEnt): void {
    const p = this.game.players[0];
    const cloaked = this.game.isCommanderCloaked(c);
    const desc = (t: CommanderEnt['tasks'][number]): string => {
      if (t.kind === 'move') return 'moving';
      const b = this.game.building(t.building);
      const name = b ? `${b.type} #${b.id}` : `#${t.building}`;
      return t.kind === 'build' ? `constructing ${name}` : t.kind === 'repair' ? `repairing ${name}` : `adjusting ${name}`;
    };
    const status = c.tasks.length === 0 ? 'idle' : desc(c.tasks[0]) + (c.tasks.length > 1 ? ` (+${c.tasks.length - 1} queued)` : '');

    const key = JSON.stringify(['cmdr', Math.ceil(c.hp / FP), status, cloaked, p.override, c.channeling]);
    if (key === this.panelKey) return;
    this.panelKey = key;

    this.panel.innerHTML = '';
    const h3 = document.createElement('h3');
    h3.textContent = `COMMANDER — ${Math.ceil(c.hp / FP)}/${Math.ceil(c.maxHp / FP)}hp${cloaked ? ' · veiled' : ''}`;
    this.panel.appendChild(h3);

    const statusEl = document.createElement('div');
    statusEl.className = 'row';
    statusEl.textContent = c.channeling ? `⚙ ${status}` : status;
    this.panel.appendChild(statusEl);

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
    const btn = (label: string, onClick: () => void, active = false, title = ''): HTMLButtonElement => {
      const el = document.createElement('button');
      el.textContent = label;
      el.className = active ? 'active' : '';
      el.title = title;
      el.onclick = onClick;
      return el;
    };

    row('', btn('stop', () => this.issue({ cmd: 'stop' }), false, 'clear all queued Commander orders'));
    row(
      'army:',
      btn('fall back', () => this.issue({ cmd: 'global_override', stance: 'fall_back' }), p.override === 'fall_back',
        'global override: all units retreat home (set at the bastion)'),
      btn('defend', () => this.issue({ cmd: 'global_override', stance: 'defend' }), p.override === 'defend',
        'global override: all units defend the base (set at the bastion)'),
      btn('release', () => this.issue({ cmd: 'global_override', stance: 'release' }), p.override === null,
        'clear the global override (set at the bastion)'),
    );
  }

  private renderPanel(): void {
    const ent = this.selected !== null ? this.game.entities.get(this.selected) : undefined;
    if (ent && ent.kind === 'commander' && ent.player === 0) {
      this.panel.style.display = 'block';
      return this.renderCommanderPanel(ent);
    }
    const b = ent && ent.kind === 'building' && ent.player === 0 ? ent : null;
    if (!b) {
      this.panel.style.display = 'none';
      this.selected = null;
      return;
    }
    this.panel.style.display = 'block';

    const pct = b.done ? 100 : Math.min(100, Math.floor((100 * b.buildTicks) / b.buildTicksNeeded));

    // Construction status from the Commander's task queue (so "resume" shows feedback).
    const cmdr = this.game.commander(0);
    const taskIdx = cmdr ? cmdr.tasks.findIndex((t) => t.kind === 'build' && t.building === b.id) : -1;
    const status = b.done
      ? ''
      : taskIdx === 0
        ? cmdr!.channeling
          ? 'constructing…'
          : 'commander en route…'
        : taskIdx > 0
          ? `queued (${taskIdx + 1} in line)`
          : 'PAUSED';

    // Fabricator wave status: releasing / short on energy / starved last wave / off.
    const waveTicks = WAVE_INTERVAL * TICKS_PER_SECOND;
    const waveEta = Math.ceil((waveTicks - (this.game.tick % waveTicks)) / TICKS_PER_SECOND);
    const unitCost = UNIT_STATS[b.production].cost;
    const canAfford = this.game.players[0].energy >= unitCost * FP;
    const prodState = !b.on ? 'off' : b.starved ? 'starved' : canAfford ? 'ok' : 'short';
    const prodText =
      b.type !== 'fabricator' || !b.done
        ? ''
        : !b.on
          ? 'production off'
          : b.starved
            ? `▲ skipped last wave — needs ${unitCost}e (older fabricators fund first)`
            : `${b.production} (${unitCost}e) deploys with wave in ${waveEta}s${canAfford ? '' : ' — ⚠ low energy'}`;

    // Re-render only when the displayed state changes (keeps buttons clickable).
    const key = JSON.stringify([
      b.id, b.type, b.done, Math.ceil(b.hp / FP), b.production, b.on, b.behavior,
      b.rally.x, b.rally.y, this.rallyArm, status, prodState,
      b.type === 'bastion' ? availableTechs(this.game, 0) : null,
      this.game.players[0].research?.tech ?? null,
    ]);
    if (key === this.panelKey) {
      // progress/countdowns tick without rebuilding the panel (buttons stay clickable)
      const fill = this.panel.querySelector<HTMLElement>('#build-fill');
      if (fill) fill.style.width = `${pct}%`;
      const label = this.panel.querySelector<HTMLElement>('#build-pct');
      if (label) label.textContent = `${pct}%`;
      const eta = this.panel.querySelector<HTMLElement>('#prod-eta');
      if (eta) eta.textContent = prodText;
      return;
    }
    this.panelKey = key;

    this.panel.innerHTML = '';
    const h3 = document.createElement('h3');
    h3.textContent = `${b.type} #${b.id} — ${Math.ceil(b.hp / FP)}/${Math.ceil(b.maxHp / FP)}hp${b.done ? '' : ` — ${status}`}`;
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
      const barBg = document.createElement('div');
      barBg.style.cssText = 'height:7px;background:#0d1a22;border:1px solid #1f4a55;border-radius:2px;margin:6px 0 2px;overflow:hidden;';
      const fill = document.createElement('div');
      fill.id = 'build-fill';
      fill.style.cssText = `height:100%;width:${pct}%;background:#39e0d0;transition:width .15s linear;`;
      barBg.appendChild(fill);
      this.panel.appendChild(barBg);
      const label = document.createElement('div');
      label.id = 'build-pct';
      label.style.cssText = 'font-size:11px;opacity:.7;margin-bottom:4px;';
      label.textContent = `${pct}%`;
      this.panel.appendChild(label);
      if (status === 'PAUSED') row('', btn('resume', () => this.issue({ cmd: 'resume_build', building: b.id })));
      row('', btn('cancel (75% back)', () => this.issue({ cmd: 'cancel_build', building: b.id })));
      return;
    }

    if (b.type === 'fabricator') {
      const eta = document.createElement('div');
      eta.id = 'prod-eta';
      eta.style.cssText = 'font-size:11px;opacity:.8;margin-bottom:4px;';
      eta.textContent = prodText;
      this.panel.appendChild(eta);
      row(
        'unit:',
        ...UNIT_ORDER.map((u) => {
          const el = btn(u, () => this.issue({ cmd: 'set_production', building: b.id, unit: u, on: true }), b.production === u);
          el.title = unitTooltip(u); // hover for stats + counters
          return el;
        }),
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
