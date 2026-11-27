// The four pigments and how they absorb light.
// Color is computed subtractively: white * exp(-sum(conc_i * k_i)), in linear light.
// Each k is solved so that a drop at body concentration on silk lands on the brand swatch.

export interface Pigment {
  key: 'indigo' | 'madder' | 'ochre' | 'black';
  name: string;
  hex: string;
}

export const PIGMENTS: Pigment[] = [
  { key: 'indigo', name: 'Indigo', hex: '#24406e' },
  { key: 'madder', name: 'Madder', hex: '#b23a2e' },
  { key: 'ochre', name: 'Ochre', hex: '#d9a441' },
  { key: 'black', name: 'Lamp black', hex: '#1b1a19' },
];

/** Concentration of a freshly floated drop. The first ink out of the pipette is a little stronger, which gives stones their darker rim. */
export const BODY_CONC = 0.78;
export const RIM_CONC = 0.95;

export const SILK_WHITE = '#f7f4ee';
export const BATH_WHITE = '#eef0ea';
/** The bench, the wall and the page ground. */
export const ZINC = '#d8dee0';
export const ZINC_RIM = '#a7b0b4';

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/** Absorption coefficients, one vec3 per pigment, flattened (12 floats). */
export function absorption(): Float32Array {
  const white = hexToRgb(SILK_WHITE).map(toLinear);
  const out = new Float32Array(12);
  PIGMENTS.forEach((p, i) => {
    const c = hexToRgb(p.hex).map(toLinear);
    for (let ch = 0; ch < 3; ch++) out[i * 3 + ch] = -Math.log(Math.max(c[ch], 1e-4) / white[ch]) / BODY_CONC;
  });
  return out;
}
