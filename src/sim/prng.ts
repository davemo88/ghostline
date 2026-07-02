// Deterministic seeded PRNG (mulberry32). Only source of randomness in the sim.

export class Prng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** Uniform float in [0, 1). Exact same sequence on all IEEE-754 platforms. */
  next(): number {
    let t = (this.state += 0x6d2b79f5) >>> 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Pick k distinct elements from arr (order randomized). */
  sample<T>(arr: readonly T[], k: number): T[] {
    const pool = arr.slice();
    const out: T[] = [];
    for (let i = 0; i < k && pool.length > 0; i++) {
      out.push(pool.splice(this.int(pool.length), 1)[0]);
    }
    return out;
  }

  serialize(): number {
    return this.state;
  }

  static deserialize(state: number): Prng {
    const p = new Prng(0);
    (p as unknown as { state: number }).state = state >>> 0;
    return p;
  }
}
