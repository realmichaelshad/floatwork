// The scripted hand for attract mode. Positions are in units of the silk square
// (0 to 1, y down), so the same pattern plays at any screen size.

import type { InkIndex } from './gl/bath';

export interface ScriptDrop {
  t: number;
  u: number;
  v: number;
  r: number;
  ink: InkIndex;
}

export interface ScriptPass {
  t0: number;
  t1: number;
  tool: 'comb' | 'stylus';
  /** Hand position for s in 0..1. */
  path: (s: number) => [number, number];
  /** Comb spine direction (unit vector, square units). */
  spine?: [number, number];
}

export interface Pattern {
  name: string;
  drops: ScriptDrop[];
  passes: ScriptPass[];
}

/** Timeline of one attract cycle, in seconds. */
export const CYCLE = {
  length: 10,
  dropsFrom: 0.2,
  dropsTo: 3.1,
  toolsFrom: 3.35,
  toolsTo: 5.2,
  lay: 5.3,
  tug: 8.75,
  tugRelease: 9.15,
  fade: 9.45,
};

export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PALETTES: InkIndex[][] = [
  [0, 2, 1],
  [1, 2, 3],
  [0, 1, 2],
  [3, 2, 0],
];

const ease = (s: number) => s * s * (3 - 2 * s);

export function makePattern(cycle: number, seed = 1): Pattern {
  const r = rng(seed * 7919 + cycle * 104729);
  const pal = PALETTES[cycle % PALETTES.length];
  const kind = cycle % 4;
  const drops: ScriptDrop[] = [];
  const N = 16;
  const span = CYCLE.dropsTo - CYCLE.dropsFrom;
  const at = (i: number) => CYCLE.dropsFrom + (span * i) / (N - 1);
  const passes: ScriptPass[] = [];
  const t0 = CYCLE.toolsFrom, t1 = CYCLE.toolsTo;

  if (kind === 0) {
    // stones, then one comb pulled down through them
    const centres: [number, number][] = [];
    for (let i = 0; i < N; i++) {
      let u: number, v: number;
      if (i % 4 === 3 && centres.length) [u, v] = centres[Math.floor(r() * centres.length)];
      else {
        u = 0.1 + r() * 0.8;
        v = 0.1 + r() * 0.8;
        centres.push([u, v]);
      }
      drops.push({ t: at(i), u, v, r: 0.075 + r() * 0.06, ink: pal[i % 3] });
    }
    passes.push({ t0, t1, tool: 'comb', spine: [1, 0], path: (s) => [0.5, -0.1 + 1.06 * ease(s)] });
  } else if (kind === 1) {
    // a bullseye in the middle, combed across and back
    for (let i = 0; i < 10; i++) drops.push({ t: at(i), u: 0.5, v: 0.5, r: 0.15 - i * 0.005, ink: pal[i % 3] });
    const around: [number, number][] = [[0.18, 0.2], [0.82, 0.22], [0.2, 0.8], [0.8, 0.82], [0.5, 0.12], [0.5, 0.88]];
    around.forEach(([u, v], i) => drops.push({ t: at(10 + i), u, v, r: 0.09, ink: pal[(i + 1) % 3] }));
    const mid = t0 + (t1 - t0) * 0.45;
    passes.push({ t0, t1: mid, tool: 'comb', spine: [0, 1], path: (s) => [0.08 + 0.55 * ease(s), 0.5] });
    passes.push({ t0: mid + 0.05, t1, tool: 'comb', spine: [1, 0], path: (s) => [0.5 + 1 / 26, 0.1 + 0.6 * ease(s)] });
  } else if (kind === 2) {
    // rows of rings, then a waved comb pulled up
    const pts: [number, number][] = [];
    for (let row = 0; row < 3; row++) for (let c = 0; c < 4; c++) pts.push([0.17 + c * 0.22 + (row % 2) * 0.06, 0.2 + row * 0.3]);
    for (let i = 0; i < N; i++) {
      const p = pts[i % pts.length];
      drops.push({ t: at(i), u: p[0], v: p[1], r: i < pts.length ? 0.11 : 0.07, ink: pal[(i + Math.floor(i / 12)) % 3] });
    }
    passes.push({ t0, t1, tool: 'comb', spine: [1, 0], path: (s) => [0.5 + 0.06 * Math.sin(ease(s) * Math.PI * 5), 1.08 - 1.04 * ease(s)] });
  } else {
    // concentric rings drawn into a spiral with the stylus
    for (let i = 0; i < 9; i++) drops.push({ t: at(i), u: 0.5, v: 0.5, r: 0.15 - i * 0.006, ink: pal[i % 3] });
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + r();
      drops.push({ t: at(9 + i), u: 0.5 + Math.cos(a) * 0.33, v: 0.5 + Math.sin(a) * 0.33, r: 0.085, ink: pal[(i + 2) % 3] });
    }
    passes.push({
      t0,
      t1,
      tool: 'stylus',
      path: (s) => {
        const e = ease(s);
        const a = e * Math.PI * 5;
        const rad = 0.03 + 0.4 * e;
        return [0.5 + Math.cos(a) * rad, 0.5 + Math.sin(a) * rad];
      },
    });
  }
  return { name: ['stones', 'bullseye', 'wave', 'spiral'][kind], drops, passes };
}
