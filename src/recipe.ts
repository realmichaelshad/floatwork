// Pure logic for the swing tag: ink recipe percentages and the lot number.
// Input is an RGBA byte image of the printed square where each channel holds
// one pigment's concentration (R indigo, G madder, B ochre, A lamp black).

export const INK_KEYS = ['indigo', 'madder', 'ochre', 'black'] as const;
export type InkKey = (typeof INK_KEYS)[number];

export interface Recipe {
  /** Whole percentages of each ink among all ink on the silk, summing to 100 (or all 0 if bare). */
  shares: Record<InkKey, number>;
  /** Whole percentage of the silk area left without ink. */
  bare: number;
  /** Sum of all concentrations, 0 when nothing was floated. */
  total: number;
}

/** Rounds values to integers that sum to `target`, using the largest remainder method. */
export function largestRemainder(values: number[], target = 100): number[] {
  const sum = values.reduce((a, b) => a + b, 0);
  if (sum <= 0) return values.map(() => 0);
  const exact = values.map((v) => (v / sum) * target);
  const floors = exact.map(Math.floor);
  let left = target - floors.reduce((a, b) => a + b, 0);
  const order = exact
    .map((e, i) => ({ i, r: e - Math.floor(e) }))
    .sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; left > 0 && k < order.length; k++, left--) floors[order[k].i]++;
  return floors;
}

/** Threshold (0 to 255) below which a cell counts as bare silk. */
export const BARE_THRESHOLD = 20;

export function measureRecipe(px: ArrayLike<number>): Recipe {
  const sums = [0, 0, 0, 0];
  let cells = 0;
  let bareCells = 0;
  for (let i = 0; i + 3 < px.length; i += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2], a = px[i + 3];
    sums[0] += r;
    sums[1] += g;
    sums[2] += b;
    sums[3] += a;
    cells++;
    if (Math.max(r, g, b, a) < BARE_THRESHOLD) bareCells++;
  }
  const total = sums[0] + sums[1] + sums[2] + sums[3];
  const pct = largestRemainder(sums);
  const bare = cells ? Math.round((bareCells / cells) * 100) : 100;
  return {
    shares: { indigo: pct[0], madder: pct[1], ochre: pct[2], black: pct[3] },
    bare,
    total: total / 255,
  };
}

/** 32-bit FNV-1a over bytes. */
export function fnv1a(bytes: ArrayLike<number>): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i] & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Digits and consonants only, so a lot number can never spell a word. */
export const LOT_ALPHABET = '0123456789BCDFGHJKMNPQRSTVWXZ';

/**
 * Lot number for a print, six characters from a 29-letter alphabet. Concentrations are quantized to 8 levels first, so tiny
 * numeric noise does not change the number and the same pattern gives the same lot.
 */
export function lotNumber(px: ArrayLike<number>): { hash: number; code: string } {
  const q = new Uint8Array(px.length);
  for (let i = 0; i < px.length; i++) q[i] = (px[i] & 0xff) >> 5;
  const hash = fnv1a(q);
  const base = LOT_ALPHABET.length;
  let n = hash % Math.pow(base, 6);
  let s = '';
  for (let i = 0; i < 6; i++) {
    s = LOT_ALPHABET[n % base] + s;
    n = Math.floor(n / base);
  }
  return { hash, code: `${s.slice(0, 3)}-${s.slice(3)}` };
}
