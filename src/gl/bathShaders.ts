// GLSL for the marbling bath. Positions inside the bath are in CSS pixels with y up,
// origin at the bottom-left corner of the bath domain.

const HEAD = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 outColor;
`;

// ---------------------------------------------------------------- velocity

export const ADVECT_VEL = HEAD + `
uniform sampler2D uVel;
uniform vec2 uDom;
uniform float uDt;
uniform float uDamp;
void main() {
  vec2 v = texture(uVel, vUv).xy;
  vec2 back = vUv - v * uDt / uDom;
  vec2 nv = texture(uVel, back).xy * uDamp;
  vec2 e = min(vUv, 1.0 - vUv) * uDom;
  float wall = smoothstep(0.0, 10.0, min(e.x, e.y));
  outColor = vec4(nv * wall, 0.0, 1.0);
}`;

export const FORCE = HEAD + `
uniform sampler2D uVel;
uniform vec2 uDom;
uniform float uDt;
uniform vec4 uSeg[48];
uniform vec2 uSegP[48];
uniform int uSegN;
void main() {
  vec2 p = vUv * uDom;
  vec2 v = texture(uVel, vUv).xy;
  for (int i = 0; i < 48; i++) {
    if (i >= uSegN) break;
    vec2 a = uSeg[i].xy;
    vec2 b = uSeg[i].zw;
    vec2 ab = b - a;
    float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-4), 0.0, 1.0);
    float d = length(p - (a + ab * t));
    float r = uSegP[i].x;
    float w = exp(-(d * d) / (r * r)) * uSegP[i].y;
    v = mix(v, ab / uDt, clamp(w, 0.0, 1.0));
  }
  outColor = vec4(v, 0.0, 1.0);
}`;

export const DIVERGENCE = HEAD + `
uniform sampler2D uVel;
uniform vec2 uTexel;
uniform float uH;
void main() {
  float l = texture(uVel, vUv - vec2(uTexel.x, 0.0)).x;
  float r = texture(uVel, vUv + vec2(uTexel.x, 0.0)).x;
  float b = texture(uVel, vUv - vec2(0.0, uTexel.y)).y;
  float t = texture(uVel, vUv + vec2(0.0, uTexel.y)).y;
  outColor = vec4((r - l + t - b) / (2.0 * uH), 0.0, 0.0, 1.0);
}`;

export const JACOBI = HEAD + `
uniform sampler2D uP;
uniform sampler2D uDiv;
uniform vec2 uTexel;
uniform float uH;
void main() {
  float l = texture(uP, vUv - vec2(uTexel.x, 0.0)).x;
  float r = texture(uP, vUv + vec2(uTexel.x, 0.0)).x;
  float b = texture(uP, vUv - vec2(0.0, uTexel.y)).x;
  float t = texture(uP, vUv + vec2(0.0, uTexel.y)).x;
  float d = texture(uDiv, vUv).x;
  outColor = vec4((l + r + b + t - d * uH * uH) * 0.25, 0.0, 0.0, 1.0);
}`;

export const GRADIENT = HEAD + `
uniform sampler2D uP;
uniform sampler2D uVel;
uniform vec2 uTexel;
uniform float uH;
void main() {
  float l = texture(uP, vUv - vec2(uTexel.x, 0.0)).x;
  float r = texture(uP, vUv + vec2(uTexel.x, 0.0)).x;
  float b = texture(uP, vUv - vec2(0.0, uTexel.y)).x;
  float t = texture(uP, vUv + vec2(0.0, uTexel.y)).x;
  vec2 v = texture(uVel, vUv).xy - vec2(r - l, t - b) / (2.0 * uH);
  outColor = vec4(v, 0.0, 1.0);
}`;

// ---------------------------------------------------------------- ink

// The ink itself is only resampled when something is baked. In between, motion is
// stored in a smooth displacement map (where each point's ink came from), and
// drops still spreading are drawn analytically on top. A drop is an exact
// area-preserving map: a point at distance d from the centre moves to distance
// sqrt(d^2 + A) when area A of new ink enters at the centre.
export const TRACE = `
uniform vec4 uDrop[8];     // cx, cy, area, unused (css px, y up)
uniform vec4 uDropInk[8];  // body concentration per pigment
uniform int uDropN;
uniform float uTexPx;      // one ink texel in css px
uniform float uRimGain;

vec4 traceDrops(inout vec2 p, out float cover) {
  cover = 0.0;
  for (int k = 7; k >= 0; k--) {
    if (k >= uDropN) continue;
    vec2 c = uDrop[k].xy;
    float A = uDrop[k].z;
    if (A <= 0.0) continue;
    vec2 d = p - c;
    float r2 = dot(d, d);
    float R = sqrt(A);
    float cov = clamp((R - sqrt(r2)) / uTexPx + 0.5, 0.0, 1.0);
    vec4 ink = uDropInk[k] * mix(1.0, uRimGain, smoothstep(0.78, 1.0, r2 / A));
    if (cov >= 1.0) { cover = 1.0; return ink; }
    p = c + d * sqrt(max(1.0 - A / max(r2, A * 1.0001), 0.0));
    if (cov > 0.0) { cover = cov; return ink; }
  }
  return vec4(0.0);
}
`;

/**
 * Moves the displacement map along the velocity field (semi-Lagrangian, midpoint),
 * plus the exact tine-line shift of each stylus or comb stroke: a point at distance
 * d from the nearest tine moves along the stroke by lambda / (d + lambda) of it.
 */
export const MAP_ADVECT = HEAD + `
uniform sampler2D uMap;
uniform sampler2D uVel;
uniform vec2 uDom;
uniform float uDt;
uniform vec4 uStrokeA[4]; // hand start xy, spine xy (unit)
uniform vec4 uStrokeB[4]; // hand delta xy, tine gap, lambda
uniform float uStrokeC[4]; // tine count
uniform int uStrokeN;

float segDist(vec2 p, vec2 a, vec2 d) {
  float t = clamp(dot(p - a, d) / max(dot(d, d), 1e-6), 0.0, 1.0);
  return length(p - a - d * t);
}

vec2 tineShift(vec2 p) {
  vec2 u = vec2(0.0);
  for (int s = 0; s < 4; s++) {
    if (s >= uStrokeN) break;
    vec2 a = uStrokeA[s].xy;
    vec2 sp = uStrokeA[s].zw;
    vec2 dl = uStrokeB[s].xy;
    float gap = uStrokeB[s].z;
    float lam = uStrokeB[s].w;
    float n = uStrokeC[s];
    float mid = (n - 1.0) * 0.5;
    float k = clamp(floor(dot(p - a, sp) / gap + mid + 0.5), 0.0, n - 1.0);
    float d = 1e9;
    for (int j = -1; j <= 1; j++) {
      float kk = k + float(j);
      if (kk < 0.0 || kk > n - 1.0) continue;
      d = min(d, segDist(p, a + sp * (kk - mid) * gap, dl));
    }
    u += dl * lam / (d + lam);
  }
  return u;
}

void main() {
  vec2 p = vUv * uDom;
  vec2 v1 = texture(uVel, vUv).xy;
  vec2 v2 = texture(uVel, (p - 0.5 * v1 * uDt) / uDom).xy;
  vec2 q = clamp(p - v2 * uDt - tineShift(p), vec2(0.0), uDom);
  vec2 disp = texture(uMap, q / uDom).xy + (q - p);
  outColor = vec4(disp, 0.0, 1.0);
}`;

const CUBIC = `
float crw(float x) {
  x = abs(x);
  return x < 1.0 ? (1.5 * x - 2.5) * x * x + 1.0 : (x < 2.0 ? ((-0.5 * x + 2.5) * x - 4.0) * x + 2.0 : 0.0);
}
// Catmull-Rom, clamped to the four nearest texels so edges never ring.
vec4 sampleCubic(sampler2D t, vec2 uv, vec2 res) {
  vec2 tc = uv * res - 0.5;
  vec2 f = fract(tc);
  ivec2 i0 = ivec2(floor(tc));
  ivec2 mx = ivec2(res) - 1;
  vec4 sum = vec4(0.0);
  float ws = 0.0;
  vec4 lo = vec4(1e9), hi = vec4(-1e9);
  for (int j = -1; j <= 2; j++) {
    float wy = crw(float(j) - f.y);
    for (int i = -1; i <= 2; i++) {
      float w = crw(float(i) - f.x) * wy;
      vec4 s = texelFetch(t, clamp(i0 + ivec2(i, j), ivec2(0), mx), 0);
      sum += s * w;
      ws += w;
      if (i >= 0 && i <= 1 && j >= 0 && j <= 1) { lo = min(lo, s); hi = max(hi, s); }
    }
  }
  return clamp(sum / ws, lo, hi);
}
`;

/** Bakes finished drops and the displacement map into the ink, with one resample. */
export const BAKE = HEAD + TRACE + CUBIC + `
uniform sampler2D uInk;
uniform sampler2D uMap;
uniform vec2 uDom;
uniform vec2 uRes;
void main() {
  vec2 p = vUv * uDom;
  float cover;
  vec4 ink = traceDrops(p, cover);
  vec4 base = vec4(0.0);
  if (cover < 1.0) {
    p += texture(uMap, p / uDom).xy;
    base = sampleCubic(uInk, p / uDom, uRes);
  }
  outColor = clamp(mix(base, ink, cover), 0.0, 1.0);
}`;

/** Copies a sub-rectangle of a texture (uv from uR0 to uR1) and multiplies it. */
export const COPY = HEAD + `
uniform sampler2D uSrc;
uniform vec2 uR0;
uniform vec2 uR1;
uniform float uMul;
uniform vec4 uHole; // x0, y0, x1, y1 in destination uv: region multiplied by uHoleMul
uniform float uHoleMul;
void main() {
  vec2 uv = mix(uR0, uR1, vUv);
  vec4 c = texture(uSrc, uv);
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) c = vec4(0.0);
  float inHole = step(uHole.x, vUv.x) * step(uHole.y, vUv.y) * step(vUv.x, uHole.z) * step(vUv.y, uHole.w);
  outColor = clamp(c * uMul * mix(1.0, uHoleMul, inHole), 0.0, 1.0);
}`;

/** Box-filtered downsample for read-back (recipe and lot number). */
export const DOWNSAMPLE = HEAD + `
uniform sampler2D uSrc;
uniform vec2 uCell;
void main() {
  vec4 s = vec4(0.0);
  for (int y = 0; y < 4; y++)
    for (int x = 0; x < 4; x++)
      s += texture(uSrc, vUv + (vec2(x, y) - 1.5) * 0.25 * uCell);
  outColor = s / 16.0;
}`;

const ABSORB = `
uniform vec3 uK[4];
uniform vec3 uWhite;
vec3 toSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
vec3 absorb(vec4 c, vec3 white) {
  return white * exp(-(c.r * uK[0] + c.g * uK[1] + c.b * uK[2] + c.a * uK[3]));
}
`;

/** Concentrations to dyed-silk color. Optional Catmull-Rom sampling for the export. */
export const PRINT_COLOR = HEAD + ABSORB + `
uniform sampler2D uSrc;
uniform vec2 uRes;
uniform int uCubic;
vec4 cubic(vec2 uv) {
  vec2 tc = uv * uRes - 0.5;
  vec2 f = fract(tc);
  ivec2 i0 = ivec2(floor(tc)) - 1;
  ivec2 mx = ivec2(uRes) - 1;
  vec4 sum = vec4(0.0);
  float wsum = 0.0;
  for (int j = 0; j < 4; j++) {
    float ty = float(j) - 1.0 - f.y;
    float ay = abs(ty);
    float wy = ay < 1.0 ? (1.5 * ay - 2.5) * ay * ay + 1.0 : ((-0.5 * ay + 2.5) * ay - 4.0) * ay + 2.0;
    for (int i = 0; i < 4; i++) {
      float tx = float(i) - 1.0 - f.x;
      float ax = abs(tx);
      float wx = ax < 1.0 ? (1.5 * ax - 2.5) * ax * ax + 1.0 : ((-0.5 * ax + 2.5) * ax - 4.0) * ax + 2.0;
      vec4 s = texelFetch(uSrc, clamp(i0 + ivec2(i, j), ivec2(0), mx), 0);
      sum += s * wx * wy;
      wsum += wx * wy;
    }
  }
  return clamp(sum / wsum, 0.0, 1.0);
}
void main() {
  vec4 c;
  if (uCubic == 1) c = cubic(vUv);
  else {
    vec2 t = 0.6 / uRes;
    c = texture(uSrc, vUv) * 0.4 + 0.15 * (texture(uSrc, vUv + vec2(t.x, 0.0)) + texture(uSrc, vUv - vec2(t.x, 0.0)) + texture(uSrc, vUv + vec2(0.0, t.y)) + texture(uSrc, vUv - vec2(0.0, t.y)));
  }
  outColor = vec4(toSrgb(absorb(c * 1.04, uWhite)), 1.0);
}`;

// ---------------------------------------------------------------- display

export const DISPLAY = HEAD + ABSORB + TRACE + `
uniform sampler2D uInk;
uniform sampler2D uMap;
uniform sampler2D uVel;
uniform vec2 uDom;        // bath size in css px
uniform vec2 uCanvas;     // canvas size in css px
uniform float uDpr;
uniform float uTime;
uniform vec3 uBath;       // linear bath white
uniform vec3 uPaper;      // linear zinc (bench and wall)
uniform vec3 uRim;        // linear tray rim
uniform vec4 uTray;       // tray outer edge: x0, y0, x1, y1 (css px, y up)
uniform float uTrayRim;   // rim width in css px
uniform vec4 uSquare;     // silk square: x0, y0 (bottom-left, y up), size, guide alpha
uniform vec4 uSilk;       // lower 0..1, transfer front 0..1.2, silk alpha, wet ink strength
uniform float uBackdrop;  // 0 bath, 1 paper backdrop
uniform float uSkim;      // skim line y (css px, y up) or -1
uniform vec4 uRipple[4];  // x, y, radius, strength

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}

float sdBox(vec2 p, vec2 a, vec2 b, float r) {
  vec2 c = (a + b) * 0.5;
  vec2 h = (b - a) * 0.5 - r;
  vec2 d = abs(p - c) - h;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
}

float weave(vec2 q) {
  // plain weave: warp and weft threads alternate over and under
  vec2 t = q * 120.0;
  vec2 f = fract(t);
  float checker = mod(floor(t.x) + floor(t.y), 2.0);
  float warp = sin(f.x * 3.14159);
  float weft = sin(f.y * 3.14159);
  return mix(warp, weft, checker);
}

void main() {
  vec2 css = gl_FragCoord.xy / uDpr;
  vec2 p = vec2(css.x, css.y - (uCanvas.y - uDom.y));
  vec2 uv = p / uDom;

  // ---- bath surface
  vec2 q = p;
  float cover;
  vec4 fresh = traceDrops(q, cover);
  vec4 c = fresh;
  if (cover < 1.0) {
    q += texture(uMap, q / uDom).xy;
    c = mix(texture(uInk, q / uDom), fresh, cover);
  }
  // below the bath (under the tray) the surface is clean
  c *= smoothstep(-2.0, 0.0, p.y);
  if (uSkim >= 0.0 && p.y > uSkim) c = vec4(0.0);
  vec2 vel = texture(uVel, uv).xy;
  vec2 cen = uv - 0.5;
  float vig = 1.0 - 0.05 * smoothstep(0.3, 0.8, length(cen * vec2(uDom.x / uDom.y, 1.0) * 0.9));
  float light = 1.0 + 0.025 * (uv.y - 0.5) - 0.015 * (uv.x - 0.5);
  vec3 white = uBath * vig * light;
  vec3 col = absorb(c, white);

  // shimmer where the surface moves: a soft window reflection bent by the flow
  float speed = length(vel);
  vec2 bend = vel * 0.0016;
  float band = exp(-pow((uv.x + uv.y * 0.55 + bend.x + bend.y - 0.92) * 5.0, 2.0));
  float n = noise(p * 0.05 + bend * 40.0 + uTime * 0.15);
  float shimmer = band * (0.015 + 0.05 * smoothstep(5.0, 120.0, speed) * n);
  col += shimmer;

  // ripples from fresh drops
  for (int k = 0; k < 4; k++) {
    if (uRipple[k].w <= 0.0) continue;
    float d = length(p - uRipple[k].xy) - uRipple[k].z;
    col += uRipple[k].w * 0.05 * exp(-d * d / 30.0) * (0.6 + 0.4 * sign(d));
  }

  // skim line shadow
  if (uSkim >= 0.0) col *= 1.0 - 0.25 * exp(-pow((p.y - uSkim) / 3.0, 2.0)) - 0.08 * exp(-abs(p.y - uSkim) / 10.0) * step(uSkim, p.y);

  // corner ticks that show where the silk will lie
  if (uSquare.w > 0.0) {
    vec2 a = uSquare.xy - 7.0;
    vec2 b = uSquare.xy + uSquare.z + 7.0;
    vec2 dl = p - a, dr = b - p;
    float L = 16.0;
    float tick = 0.0;
    vec2 near = min(dl, dr);
    if (near.x >= 0.0 && near.y >= 0.0) {
      float hx = step(near.y, 1.0) * step(near.x, L);
      float vy = step(near.x, 1.0) * step(near.y, L);
      tick = max(hx, vy);
    }
    col = mix(col, col * 0.75, tick * uSquare.w);
  }

  // ---- the silk sheet being laid
  if (uSilk.z > 0.0) {
    float lower = uSilk.x;
    vec2 ctr = uSquare.xy + uSquare.z * 0.5;
    float scale = 1.0 + 0.06 * (1.0 - lower);
    float half_ = uSquare.z * 0.5 * scale;
    vec2 off = vec2(10.0, -14.0) * (1.0 - lower);
    vec2 ds = abs(p - ctr - off) - half_;
    float sh = 1.0 - smoothstep(-4.0, 6.0 + 22.0 * (1.0 - lower), max(ds.x, ds.y));
    col *= 1.0 - sh * 0.22 * uSilk.z * (0.4 + 0.6 * (1.0 - lower * 0.6));
    vec2 dsk = abs(p - ctr) - half_;
    float inSilk = 1.0 - smoothstep(-0.7, 0.7, max(dsk.x, dsk.y));
    if (inSilk > 0.0) {
      vec2 q = (p - ctr) / (2.0 * half_) + 0.5; // 0..1 over silk, y up
      float along = (q.x * 0.8 + (1.0 - q.y) * 0.2);
      float wob = noise(q * 9.0) * 0.06;
      float wet = smoothstep(uSilk.y - 0.10, uSilk.y - 0.01, along + wob);
      wet = 1.0 - wet;
      vec3 silkW = uWhite * (0.96 + 0.04 * weave(q));
      vec3 dye = absorb(c * uSilk.w * 1.04, silkW * 0.97);
      vec3 dry = mix(silkW, col, 0.12 + 0.2 * lower);
      vec3 s = mix(dry, dye, wet);
      // the front itself is a darker wet line
      s *= 1.0 - 0.06 * exp(-pow((along + wob - uSilk.y + 0.05) * 40.0, 2.0)) * step(uSilk.y, 1.05);
      col = mix(col, s, inSilk * uSilk.z);
    }
  }

  // ---- the tray: a zinc rim around the bath, standing on a zinc bench
  {
    float px = 1.0 / uDpr;
    float sd = sdBox(p, uTray.xy, uTray.zw, 6.0);
    float inner = sd + uTrayRim; // negative inside the water
    // the lip throws a soft shadow onto the water and the water edge catches a thin line of light
    vec3 water = col * (1.0 - 0.16 * exp(min(inner, 0.0) / 5.0));
    water += 0.05 * exp(-pow((inner + 1.2) / 0.9, 2.0));
    float t = clamp(-sd / uTrayRim, 0.0, 1.0);
    vec3 rim = uRim * (1.06 - 0.2 * t);
    rim *= 1.0 + 0.04 * (noise(p * vec2(0.9, 0.05)) - 0.5);
    float sdS = sdBox(p + vec2(-1.0, 2.5), uTray.xy, uTray.zw, 6.0);
    vec3 bench = uPaper * (1.0 - 0.13 * exp(-max(sdS, 0.0) / 4.0) * step(0.0, sd));
    bench *= 1.0 + 0.025 * (noise(p * vec2(0.7, 0.035)) - 0.5);
    float aOut = smoothstep(-px, px, sd);
    float aIn = smoothstep(px, -px, inner);
    col = mix(mix(rim, water, aIn), bench, aOut);
  }

  // ---- the zinc wall behind the hanging scarf
  if (uBackdrop > 0.0) {
    vec2 sc = css / uCanvas - vec2(0.42, 0.55);
    vec3 wall = uPaper * (1.0 - 0.03 * smoothstep(0.3, 1.0, length(sc)));
    col = mix(col, wall, uBackdrop);
  }

  // fine grain so flat areas never band
  outColor = vec4(toSrgb(col) + (hash(gl_FragCoord.xy + fract(uTime)) - 0.5) / 255.0, 1.0);
}`;
