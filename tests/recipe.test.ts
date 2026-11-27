import { describe, expect, it } from 'vitest';
import { largestRemainder, lotNumber, measureRecipe, fnv1a } from '../src/recipe';

function image(cells: [number, number, number, number][]): Uint8Array {
  const a = new Uint8Array(cells.length * 4);
  cells.forEach((c, i) => a.set(c, i * 4));
  return a;
}

describe('largestRemainder', () => {
  it('sums to exactly 100', () => {
    for (const v of [[1, 1, 1], [3, 3, 3, 1], [0.2, 0.3, 0.5], [7, 0, 0, 2], [1e-3, 5, 5, 5]]) {
      expect(largestRemainder(v).reduce((a, b) => a + b, 0)).toBe(100);
    }
  });
  it('gives the leftover to the largest remainders first', () => {
    expect(largestRemainder([1, 1, 1])).toEqual([34, 33, 33]);
    expect(largestRemainder([2, 1])).toEqual([67, 33]);
  });
  it('returns zeros for an empty input', () => {
    expect(largestRemainder([0, 0, 0, 0])).toEqual([0, 0, 0, 0]);
  });
});

describe('measureRecipe', () => {
  it('measures shares from channel sums', () => {
    const r = measureRecipe(image([[255, 0, 0, 0], [0, 255, 0, 0], [0, 0, 255, 0], [0, 0, 0, 255]]));
    expect(r.shares).toEqual({ indigo: 25, madder: 25, ochre: 25, black: 25 });
    expect(r.bare).toBe(0);
  });
  it('weights by concentration, not by cell count', () => {
    const r = measureRecipe(image([[200, 0, 0, 0], [0, 100, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]));
    expect(r.shares.indigo).toBe(67);
    expect(r.shares.madder).toBe(33);
    expect(r.shares.ochre).toBe(0);
    expect(r.bare).toBe(50);
  });
  it('counts mixed cells toward each ink', () => {
    const r = measureRecipe(image([[100, 100, 0, 0], [0, 0, 100, 100]]));
    expect(r.shares).toEqual({ indigo: 25, madder: 25, ochre: 25, black: 25 });
  });
  it('treats faint residue as bare silk', () => {
    const r = measureRecipe(image([[10, 5, 0, 0], [0, 0, 0, 0], [255, 0, 0, 0], [0, 0, 0, 0]]));
    expect(r.bare).toBe(75);
  });
  it('reports a blank print as fully bare with no shares', () => {
    const r = measureRecipe(new Uint8Array(64 * 4));
    expect(r.total).toBe(0);
    expect(r.bare).toBe(100);
    expect(Object.values(r.shares).every((v) => v === 0)).toBe(true);
  });
});

describe('lotNumber', () => {
  const base = new Uint8Array(64 * 64 * 4);
  for (let i = 0; i < base.length; i++) base[i] = (i * 37 + (i >> 7) * 11) & 0xff;

  it('is deterministic for the same pattern', () => {
    expect(lotNumber(base)).toEqual(lotNumber(base.slice()));
  });
  it('ignores noise below the quantization step', () => {
    const noisy = base.map((v) => (v & 0xe0) | ((v + 3) & 0x1f));
    expect(lotNumber(noisy).code).toBe(lotNumber(base).code);
  });
  it('changes when the pattern changes', () => {
    const other = base.slice();
    for (let i = 0; i < 400; i++) other[i * 4] = 255 - other[i * 4];
    expect(lotNumber(other).code).not.toBe(lotNumber(base).code);
  });
  it('formats as two groups of three characters with no vowels', () => {
    expect(lotNumber(base).code).toMatch(/^[0-9BCDFGHJKMNP-TV-XZ]{3}-[0-9BCDFGHJKMNP-TV-XZ]{3}$/);
    for (let k = 0; k < 2000; k++) {
      const img = base.slice();
      img[k] = 255 - img[k];
      expect(lotNumber(img).code).not.toMatch(/[AEIOUYL]/);
    }
  });
  it('uses the standard FNV-1a hash', () => {
    expect(fnv1a([])).toBe(0x811c9dc5);
    expect(fnv1a([0x61])).toBe(0xe40c292c); // "a"
  });
});
