// A marbled print computed on the CPU with exact drop and tine maps, for browsers
// without WebGL2. Each pixel is traced backward through the operations.

import { absorption, BODY_CONC, hexToRgb, SILK_WHITE, toLinear } from './pigments';

type Op =
  | { kind: 'drop'; x: number; y: number; r: number; ink: number }
  | { kind: 'tine'; x: number; y: number; mx: number; my: number; a: number; l: number };

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pattern(seed: number): Op[] {
  const r = rng(seed);
  const ops: Op[] = [];
  const inks = [0, 2, 1, 3];
  // a bullseye in the middle, stones around it, then a comb each way
  for (let i = 0; i < 10; i++) ops.push({ kind: 'drop', x: 0.5, y: 0.5, r: 0.13 - i * 0.004, ink: inks[i % 3] });
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2 + r() * 0.3;
    const d = 0.3 + r() * 0.12;
    ops.push({ kind: 'drop', x: 0.5 + Math.cos(a) * d, y: 0.5 + Math.sin(a) * d, r: 0.05 + r() * 0.035, ink: inks[(i + 1) % 4] });
  }
  // down and back up, offset by half a tine, so the pattern stays centred
  for (let k = -7; k <= 7; k++) ops.push({ kind: 'tine', x: 0.5 + k / 14, y: 0, mx: 0, my: 1, a: 0.12, l: 0.012 });
  for (let k = -7; k <= 7; k++) ops.push({ kind: 'tine', x: 0.5 + k / 14 + 1 / 28, y: 0, mx: 0, my: -1, a: 0.12, l: 0.012 });
  return ops;
}

export function drawFallback(canvas: HTMLCanvasElement, seed = 7): void {
  const N = 300;
  const SS = 2; // samples per axis, for smooth edges
  canvas.width = N;
  canvas.height = N;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const img = ctx.createImageData(N, N);
  const ops = pattern(seed);
  const K = absorption();
  const white = hexToRgb(SILK_WHITE).map(toLinear);
  const toS = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
  const trace = (x: number, y: number): number => {
    for (let o = ops.length - 1; o >= 0; o--) {
      const op = ops[o];
      if (op.kind === 'drop') {
        const dx = x - op.x, dy = y - op.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < op.r * op.r) return op.ink;
        const s = Math.sqrt(1 - (op.r * op.r) / d2);
        x = op.x + dx * s;
        y = op.y + dy * s;
      } else {
        // distance to the tine line, then undo the shift along it
        const d = Math.abs((x - op.x) * op.my - (y - op.y) * op.mx);
        const z = (op.a * op.l) / (d + op.l);
        x -= z * op.mx;
        y -= z * op.my;
      }
    }
    return -1;
  };
  const conc = [0, 0, 0, 0];
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      conc.fill(0);
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const ink = trace((i + (sx + 0.5) / SS) / N, (j + (sy + 0.5) / SS) / N);
          if (ink >= 0) conc[ink] += BODY_CONC / (SS * SS);
        }
      const k = (j * N + i) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const a = conc[0] * K[ch] + conc[1] * K[3 + ch] + conc[2] * K[6 + ch] + conc[3] * K[9 + ch];
        img.data[k + ch] = Math.round(toS(white[ch] * Math.exp(-a)) * 255);
      }
      img.data[k + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
}
