import type { Cloth } from './cloth';
import type { Mat4, Vec3 } from './math';
import { createProgram, Program } from './util';

const VERT = `#version 300 es
in vec3 aPos;
in vec3 aNor;
in vec3 aTan;
in vec2 aUv;
uniform mat4 uVP;
out vec3 vPos;
out vec3 vNor;
out vec3 vTan;
out vec2 vUv;
void main() {
  vPos = aPos;
  vNor = aNor;
  vTan = aTan;
  vUv = aUv;
  gl_Position = uVP * vec4(aPos, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec3 vPos;
in vec3 vNor;
in vec3 vTan;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec3 uEye;
uniform vec3 uLight;
uniform float uAlpha;
uniform float uWet;
out vec4 outColor;

vec3 toLin(vec3 c) { return pow(c, vec3(2.2)); }
float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
}

void main() {
  vec3 V = normalize(uEye - vPos);
  vec3 N = normalize(vNor);
  if (dot(N, V) < 0.0) N = -N;
  vec3 T = normalize(vTan - N * dot(vTan, N));
  vec3 B = cross(N, T);

  // plain weave, only drawn where a thread is wider than a couple of pixels
  float threads = 210.0;
  vec2 t = vUv * threads;
  vec2 fw = fwidth(t);
  float detail = clamp(1.0 - max(fw.x, fw.y) * 2.6, 0.0, 1.0);
  vec2 f = fract(t);
  float over = mod(floor(t.x) + floor(t.y), 2.0);
  float across = over > 0.5 ? f.y : f.x;
  vec3 dirAcross = over > 0.5 ? B : T;
  vec3 Nw = normalize(N + dirAcross * (across - 0.5) * 0.25 * detail);
  // crepe grain: soft non-periodic noise at the scale of a few threads
  vec2 g = vUv * 260.0;
  float gfade = clamp(1.4 - max(fwidth(g).x, fwidth(g).y) * 1.2, 0.0, 1.0);
  float grain = (vnoise(g) - 0.5) * gfade;

  vec3 L = normalize(uLight);
  vec3 H = normalize(L + V);
  vec3 base = toLin(texture(uTex, vUv).rgb);
  base *= 1.0 - 0.02 * detail * (1.0 - sin(across * 3.14159));
  base *= 1.0 + 0.035 * grain;

  // rolled hem: a slightly darker, rounder line around the edge
  vec2 e = min(vUv, 1.0 - vUv);
  float hem = 1.0 - smoothstep(0.0, 0.007, min(e.x, e.y));
  base *= 1.0 - 0.10 * hem;

  float wrap = 0.45;
  float diff = max(0.0, (dot(Nw, L) + wrap) / (1.0 + wrap));
  float back = max(0.0, dot(-N, L));
  vec3 col = base * (0.42 + 0.68 * diff);
  // light passing through thin silk
  col += base * back * 0.30;

  // silk sheen: two anisotropic lobes, along the warp and along the weft
  float tw = dot(T, H), tb = dot(B, H);
  float sw = sqrt(max(0.0, 1.0 - tw * tw)), sb = sqrt(max(0.0, 1.0 - tb * tb));
  float spec = (pow(sw, 70.0) + pow(sb, 70.0)) * 0.11 + (pow(sw, 12.0) + pow(sb, 12.0)) * 0.035;
  spec *= 1.0 + 0.4 * grain;
  float NdV = max(dot(N, V), 0.0);
  float graze = pow(1.0 - NdV, 3.0);
  vec3 sheenCol = mix(vec3(1.0), base * 1.6 + 0.2, 0.35);
  col += sheenCol * (spec * (0.4 + 0.6 * diff) + graze * 0.10);
  col *= 1.0 - 0.18 * uWet * (1.0 - graze);

  float alpha = uAlpha * mix(1.0, 0.86, pow(1.0 - NdV, 4.0));
  outColor = vec4(pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2)), alpha);
}`;

const SHADOW_VERT = `#version 300 es
in vec3 aPos;
uniform mat4 uVP;
uniform vec3 uLs;
uniform float uWall;
uniform vec2 uJit;
void main() {
  vec3 p = aPos - uLs * ((aPos.z - uWall) / uLs.z);
  p.xy += uJit;
  gl_Position = uVP * vec4(p, 1.0);
}`;

const FLAT_FRAG = `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 outColor;
void main() { outColor = uColor; }`;

const FLAT_VERT = `#version 300 es
in vec3 aPos;
uniform mat4 uVP;
void main() { gl_Position = uVP * vec4(aPos, 1.0); }`;

export class ClothRenderer {
  private gl: WebGL2RenderingContext;
  private prog: Program;
  private shadow: Program;
  private flat: Program;
  private vao: WebGLVertexArrayObject;
  private shadowVao: WebGLVertexArrayObject;
  private dyn: WebGLBuffer;
  private data: Float32Array;
  private indexCount: number;
  private propVao: WebGLVertexArrayObject;
  private propBuf: WebGLBuffer;

  constructor(gl: WebGL2RenderingContext, cloth: Cloth) {
    this.gl = gl;
    this.prog = createProgram(gl, FRAG, VERT, ['aPos', 'aNor', 'aTan', 'aUv']);
    this.shadow = createProgram(gl, FLAT_FRAG, SHADOW_VERT, ['aPos']);
    this.flat = createProgram(gl, FLAT_FRAG, FLAT_VERT, ['aPos']);
    const n = cloth.n;
    this.data = new Float32Array(cloth.count * 9);
    const uv = new Float32Array(cloth.count * 2);
    for (let v = 0; v < n; v++)
      for (let u = 0; u < n; u++) {
        const i = v * n + u;
        uv[i * 2] = u / (n - 1);
        uv[i * 2 + 1] = 1 - v / (n - 1);
      }
    const idx: number[] = [];
    for (let v = 0; v + 1 < n; v++)
      for (let u = 0; u + 1 < n; u++) {
        const i = v * n + u;
        idx.push(i, i + n, i + 1, i + 1, i + n, i + n + 1);
      }
    this.indexCount = idx.length;

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.dyn = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dyn);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 36, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 36, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 36, 24);
    const uvBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
    gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 2, gl.FLOAT, false, 0, 0);
    const ib = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);

    this.shadowVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.shadowVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dyn);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 36, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);

    this.propVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.propVao);
    this.propBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.propBuf);
    gl.bufferData(gl.ARRAY_BUFFER, 4096, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  upload(cloth: Cloth): void {
    const d = this.data;
    for (let i = 0; i < cloth.count; i++) {
      d[i * 9] = cloth.pos[i * 3];
      d[i * 9 + 1] = cloth.pos[i * 3 + 1];
      d[i * 9 + 2] = cloth.pos[i * 3 + 2];
      d[i * 9 + 3] = cloth.nor[i * 3];
      d[i * 9 + 4] = cloth.nor[i * 3 + 1];
      d[i * 9 + 5] = cloth.nor[i * 3 + 2];
      d[i * 9 + 6] = cloth.tan[i * 3];
      d[i * 9 + 7] = cloth.tan[i * 3 + 1];
      d[i * 9 + 8] = cloth.tan[i * 3 + 2];
    }
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dyn);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, d);
  }

  render(opts: {
    vp: Mat4;
    eye: Vec3;
    tex: WebGLTexture;
    alpha: number;
    wet: number;
    shadow: number;
    props: number;
    pins: Vec3[];
  }): void {
    const gl = this.gl;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // soft shadow on the wall behind
    if (opts.shadow > 0) {
      gl.disable(gl.DEPTH_TEST);
      const p = this.shadow;
      gl.useProgram(p.prog);
      gl.uniformMatrix4fv(p.u.uVP, false, opts.vp);
      gl.uniform3f(p.u.uLs, -0.16, 0.3, 1.0);
      gl.uniform1f(p.u.uWall, -0.32);
      gl.uniform4f(p.u.uColor, 0.07, 0.086, 0.1, 0.013 * opts.shadow);
      gl.bindVertexArray(this.shadowVao);
      const j = 0.013;
      for (const [x, y] of [[0, 0], [j, 0], [-j, 0], [0, j], [0, -j], [j, j], [-j, -j], [j, -j], [-j, j], [2 * j, 0], [-2 * j, 0], [0, 2 * j], [0, -2 * j]]) {
        gl.uniform2f(p.u.uJit, x, y);
        gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0);
      }
    }

    // the line and the pegs
    if (opts.props > 0) {
      const p = this.flat;
      gl.useProgram(p.prog);
      gl.uniformMatrix4fv(p.u.uVP, false, opts.vp);
      gl.bindVertexArray(this.propVao);
      const y = opts.pins[0][1] + 0.012;
      const w = 0.0028;
      const line = new Float32Array([-6, y - w, 0, 6, y - w, 0, -6, y + w, 0, 6, y + w, 0]);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.propBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, line);
      gl.uniform4f(p.u.uColor, 0.07, 0.086, 0.1, 0.6 * opts.props);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    const p = this.prog;
    gl.useProgram(p.prog);
    gl.uniformMatrix4fv(p.u.uVP, false, opts.vp);
    gl.uniform3fv(p.u.uEye, opts.eye);
    gl.uniform3f(p.u.uLight, -0.45, 0.85, 0.75);
    gl.uniform1f(p.u.uAlpha, opts.alpha);
    gl.uniform1f(p.u.uWet, opts.wet);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, opts.tex);
    gl.uniform1i(p.u.uTex, 0);
    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0);
    gl.disable(gl.DEPTH_TEST);

    if (opts.props > 0) {
      const f = this.flat;
      gl.useProgram(f.prog);
      gl.uniformMatrix4fv(f.u.uVP, false, opts.vp);
      gl.bindVertexArray(this.propVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.propBuf);
      for (const pin of opts.pins) {
        const [x, y0, z] = pin;
        const pw = 0.0085, top = y0 + 0.026, bot = y0 - 0.032;
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array([x - pw, bot, z + 0.01, x + pw, bot, z + 0.01, x - pw * 0.8, top, z + 0.01, x + pw * 0.8, top, z + 0.01]));
        gl.uniform4f(f.u.uColor, 0.2, 0.23, 0.25, 0.96 * opts.props);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        const sy = y0 + 0.004, sw = 0.0025;
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array([x - pw, sy - sw, z + 0.011, x + pw, sy - sw, z + 0.011, x - pw, sy + sw, z + 0.011, x + pw, sy + sw, z + 0.011]));
        gl.uniform4f(f.u.uColor, 0.72, 0.76, 0.78, 0.9 * opts.props);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    }
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }
}
