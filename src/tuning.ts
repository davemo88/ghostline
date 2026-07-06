// Runtime unit tuning (debug menu): mutates UNIT_STATS in place so changes
// apply live to the running sim, and persists the diff-from-defaults to
// localStorage so tweaks survive into the next playthrough.
//
// Presentation-layer only — the sim, tests, and headless scripts never import
// this. Tuned values break replay parity against the stock constants (same
// caveat as debugInstantBuild).

import { setWaveInterval, UNIT_STATS, type UnitStats, type UnitType, WAVE_INTERVAL } from './sim';

/** Pristine copy of the shipped constants, captured before any overrides. */
export const UNIT_DEFAULTS: Record<UnitType, UnitStats> = JSON.parse(JSON.stringify(UNIT_STATS));

/** Presentation-side knobs (tracer count / spacing of the kumo's visual burst). */
export const VISUAL_TUNING = {
  kumoBurstRounds: 4, // tracers per volley
  kumoBurstSpacing: 2, // frames between tracers
};
const VISUAL_DEFAULTS = { ...VISUAL_TUNING };
const WAVE_DEFAULT = WAVE_INTERVAL; // captured before any overrides

const KEY = 'ghostline_tuning';

export function loadTuning(): void {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    const data = JSON.parse(raw) as {
      units?: Record<string, Partial<UnitStats>>;
      visual?: Partial<typeof VISUAL_TUNING>;
      waveInterval?: number;
    };
    for (const [u, fields] of Object.entries(data.units ?? {})) {
      if (u in UNIT_STATS) Object.assign(UNIT_STATS[u as UnitType], fields);
    }
    Object.assign(VISUAL_TUNING, data.visual ?? {});
    if (typeof data.waveInterval === 'number') setWaveInterval(data.waveInterval);
  } catch {
    // corrupted save — ignore, run on defaults
  }
}

/** Persist only fields that differ from the shipped defaults. */
export function saveTuning(): void {
  const units: Record<string, Partial<UnitStats>> = {};
  for (const u of Object.keys(UNIT_STATS) as UnitType[]) {
    const diff: Record<string, number> = {};
    const stats = UNIT_STATS[u] as unknown as Record<string, number | undefined>;
    const defs = UNIT_DEFAULTS[u] as unknown as Record<string, number | undefined>;
    for (const k of new Set([...Object.keys(stats), ...Object.keys(defs)])) {
      if (stats[k] !== defs[k] && stats[k] !== undefined) diff[k] = stats[k]!;
    }
    if (Object.keys(diff).length) units[u] = diff;
  }
  const visual: Record<string, number> = {};
  for (const k of Object.keys(VISUAL_TUNING) as (keyof typeof VISUAL_TUNING)[]) {
    if (VISUAL_TUNING[k] !== VISUAL_DEFAULTS[k]) visual[k] = VISUAL_TUNING[k];
  }
  const waveDiff = WAVE_INTERVAL !== WAVE_DEFAULT;
  if (Object.keys(units).length || Object.keys(visual).length || waveDiff) {
    localStorage.setItem(
      KEY,
      JSON.stringify({ units, visual, ...(waveDiff ? { waveInterval: WAVE_INTERVAL } : {}) }),
    );
  } else {
    localStorage.removeItem(KEY);
  }
}

/** Restore one unit (or everything) to shipped defaults and re-save. */
export function resetTuning(unit?: UnitType): void {
  for (const u of unit ? [unit] : (Object.keys(UNIT_STATS) as UnitType[])) {
    const stats = UNIT_STATS[u] as unknown as Record<string, number | undefined>;
    const defs = UNIT_DEFAULTS[u] as unknown as Record<string, number | undefined>;
    for (const k of Object.keys(stats)) if (!(k in defs)) delete stats[k];
    Object.assign(stats, JSON.parse(JSON.stringify(defs)));
  }
  if (!unit) {
    Object.assign(VISUAL_TUNING, VISUAL_DEFAULTS);
    setWaveInterval(WAVE_DEFAULT);
  }
  saveTuning();
}
