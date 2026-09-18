/**
 * rng.js — seeded PRNG (mulberry32).
 *
 * All randomness in the simulation goes through here. Math.random() must not
 * appear anywhere in /src/sim/ — determinism is what makes bug reports
 * reproducible and lets headless-sim.js regression-test missions in CI.
 */

/** FNV-1a, so a mission id string becomes a stable 32-bit seed. */
export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function createRng(seed) {
  let a = (typeof seed === 'string' ? hashSeed(seed) : seed >>> 0) || 1;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    /** float in [0,1) */
    next,
    /** float in [min,max) */
    range: (min, max) => min + next() * (max - min),
    /** integer in [min,max] */
    int: (min, max) => Math.floor(min + next() * (max - min + 1)),
    /** true with probability p */
    chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    /** current internal state, so a run can be snapshotted and resumed */
    get state() { return a; },
    set state(v) { a = v >>> 0; },
  };
}
