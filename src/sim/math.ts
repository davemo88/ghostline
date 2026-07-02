// Integer/fixed-point math helpers. All sim positions are milli-units (mu).
// Everything here is exact integer arithmetic — deterministic on any platform.

export interface Vec {
  x: number; // mu
  y: number; // mu
}

/** Integer square root: greatest n with n*n <= v. Exact for v < 2^53. */
export function isqrt(v: number): number {
  if (v < 0) throw new Error('isqrt of negative');
  if (v < 2) return v;
  // Math.sqrt on integers < 2^53 is correctly rounded; correct off-by-one.
  let r = Math.floor(Math.sqrt(v));
  while (r * r > v) r--;
  while ((r + 1) * (r + 1) <= v) r++;
  return r;
}

export function dist2(a: Vec, b: Vec): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export function dist(a: Vec, b: Vec): number {
  return isqrt(dist2(a, b));
}

/** True if a and b are within r mu of each other. */
export function within(a: Vec, b: Vec, r: number): boolean {
  return dist2(a, b) <= r * r;
}

/** Move `pos` up to `step` mu toward `target`. Returns new position (floored). */
export function stepToward(pos: Vec, target: Vec, step: number): Vec {
  const dx = target.x - pos.x;
  const dy = target.y - pos.y;
  const d = isqrt(dx * dx + dy * dy);
  if (d <= step) return { x: target.x, y: target.y };
  return {
    x: pos.x + Math.floor((dx * step) / d),
    y: pos.y + Math.floor((dy * step) / d),
  };
}

/** Apply a per-mille multiplier with floor. */
export function pm(value: number, mult: number): number {
  return Math.floor((value * mult) / 1000);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
