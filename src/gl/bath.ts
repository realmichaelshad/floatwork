import { absorption, BATH_WHITE, BODY_CONC, hexToRgb, RIM_CONC, SILK_WHITE, toLinear, ZINC, ZINC_RIM } from '../pigments';
import * as S from './bathShaders';
import { bindTex, Caps, createProgram, createTarget, deleteTarget, Program, Target } from './util';

export interface BathLayout {
  /** Bath size in CSS px. */
  domW: number;
  domH: number;
  /** Silk square in CSS px, measured from the top-left of the bath. */
  sqX: number;
  sqY: number;
  sqSize: number;
  coarse: boolean;
}

/** Ink index: 0 indigo, 1 madder, 2 ochre, 3 lamp black, 4 clear (dispersant). */
export type InkIndex = 0 | 1 | 2 | 3 | 4;

interface Drop {
  cx: number;
  cy: number; // y up
  area: number;
  target: number;
  maxArea: number;
  held: boolean;
  ink: InkIndex;
  age: number;
}

export interface DropHandle {
  release(): void;
}

/** A stylus (one tine) or comb (a row of tines) moving by one step. Css px, y down. */
export interface Stroke {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  spine: [number, number];
  gap: number;
  count: number;
  lambda: number;
  radius: number;
  strength: number;
}

export interface Segment {
  ax: number;
  ay: number;
  bx: number;
  by: number; // css px, y down from bath top
  radius: number;
  strength: number;
}

interface Ripple {
  x: number;
  y: number;
  age: number;
}

export interface SilkState {
  lower: number;
  front: number;
  alpha: number;
}

const MAX_DROPS = 8;

export class Bath {
  private gl: WebGL2RenderingContext;
  private caps: Caps;
  private draw: () => void;
  private p: Record<string, Program> = {};
  layout!: BathLayout;
  private dens = 1;
  private inkW = 0;
  private inkH = 0;
  private velW = 0;
  private velH = 0;
  private cell = 5;
  private ink: Target[] = [];
  private map: Target[] = [];
  private mapW = 0;
  private mapH = 0;
  private mapDirty = false;
  private mapAge = 0;
  private mapKind: 'f32' | 'f16' | 'u8' = 'f16';
  private vel: Target[] = [];
  private pres: Target[] = [];
  private div: Target | null = null;
  private snaps: Target[] = [];
  private undoDepth = 5;
  private drops: Drop[] = [];
  private segs: Segment[] = [];
  private strokes: Stroke[] = [];
  private ripples: Ripple[] = [];
  private activeUntil = -1;
  private velDirty = false;
  private time = 0;
  private K = absorption();
  private bathLin = hexToRgb(BATH_WHITE).map(toLinear);
  private silkLin = hexToRgb(SILK_WHITE).map(toLinear);
  private paperLin = hexToRgb(ZINC).map(toLinear);
  private rimLin = hexToRgb(ZINC_RIM).map(toLinear);
  /** Tray outer edge in css px from the bath top-left, and rim width. */
  tray = { x0: 0, y0: 0, x1: 100, y1: 100, rim: 8 };
  /** Total ink area floated, per pigment, in css px^2 (for the empty check). */
  floated = [0, 0, 0, 0, 0];
  print: Target | null = null;
  printColor: Target | null = null;
  printSize = 0;
  silk: SilkState = { lower: 0, front: 0, alpha: 0 };
  backdrop = 0;
  skim = -1;
  guide = 1;

  constructor(gl: WebGL2RenderingContext, caps: Caps, draw: () => void) {
    this.gl = gl;
    this.caps = caps;
    this.draw = draw;
    this.p.advectVel = createProgram(gl, S.ADVECT_VEL);
    this.p.force = createProgram(gl, S.FORCE);
    this.p.div = createProgram(gl, S.DIVERGENCE);
    this.p.jacobi = createProgram(gl, S.JACOBI);
    this.p.grad = createProgram(gl, S.GRADIENT);
    this.p.mapAdvect = createProgram(gl, S.MAP_ADVECT);
    this.p.bake = createProgram(gl, S.BAKE);
    this.p.copy = createProgram(gl, S.COPY);
    this.p.down = createProgram(gl, S.DOWNSAMPLE);
    this.p.printColor = createProgram(gl, S.PRINT_COLOR);
    this.p.display = createProgram(gl, S.DISPLAY);
  }

  get sizeInfo(): { inkW: number; inkH: number; velW: number; velH: number; dens: number; format: string } {
    return { inkW: this.inkW, inkH: this.inkH, velW: this.velW, velH: this.velH, dens: this.dens, format: this.caps.floatFormat };
  }

  /** (Re)allocates the simulation for a new layout, keeping the ink centred. */
  setLayout(l: BathLayout): void {
    const gl = this.gl;
    const budget = (l.coarse ? 1.7e6 : 3.0e6) * (this.caps.floatFormat === 'u8' ? 0.6 : 1);
    let dens = Math.sqrt(budget / Math.max(1, l.domW * l.domH));
    dens = Math.min(dens, 1500 / l.sqSize, 3);
    dens = Math.min(dens, (this.caps.maxTex - 2) / l.domW, (this.caps.maxTex - 2) / l.domH);
    const inkW = Math.max(16, Math.round(l.domW * dens));
    const inkH = Math.max(16, Math.round(l.domH * dens));
    const cell = l.coarse ? 4.5 : 5.5;
    const velW = Math.max(8, Math.round(l.domW / cell));
    const velH = Math.max(8, Math.round(l.domH / cell));
    const kind = this.caps.floatFormat;

    const old = this.ink[0];
    const oldLayout = this.layout;
    const newInk = [createTarget(gl, inkW, inkH, kind), createTarget(gl, inkW, inkH, kind)];
    if (old && oldLayout) {
      this.bake(this.drops.length);
      // copy old ink so that the bath centres line up
      const cxOld = oldLayout.sqX + oldLayout.sqSize / 2;
      const cyOld = oldLayout.sqY + oldLayout.sqSize / 2;
      const cxNew = l.sqX + l.sqSize / 2;
      const cyNew = l.sqY + l.sqSize / 2;
      // new css x maps to old css x = x - cxNew + cxOld
      const x0 = (0 - cxNew + cxOld) / oldLayout.domW;
      const x1 = (l.domW - cxNew + cxOld) / oldLayout.domW;
      // y up: new y-down top 0 maps to old y-down (0 - cyNew + cyOld)
      const yTopOld = 0 - cyNew + cyOld;
      const yBotOld = l.domH - cyNew + cyOld;
      const v0 = 1 - yBotOld / oldLayout.domH;
      const v1 = 1 - yTopOld / oldLayout.domH;
      this.copy(this.ink[0], newInk[0], [x0, v0], [x1, v1]);
    }
    this.ink.forEach((t) => deleteTarget(gl, t));
    this.map.forEach((t) => deleteTarget(gl, t));
    this.vel.forEach((t) => deleteTarget(gl, t));
    this.pres.forEach((t) => deleteTarget(gl, t));
    deleteTarget(gl, this.div);
    this.snaps.forEach((t) => deleteTarget(gl, t));
    this.snaps = [];
    this.ink = newInk;
    this.mapW = Math.max(8, Math.round(inkW / 2));
    this.mapH = Math.max(8, Math.round(inkH / 2));
    this.mapKind = this.caps.floatFormat === 'u8' ? 'u8' : this.caps.float32Linear ? 'f32' : 'f16';
    this.map = [createTarget(gl, this.mapW, this.mapH, this.mapKind), createTarget(gl, this.mapW, this.mapH, this.mapKind)];
    this.mapDirty = false;
    this.drops = [];
    this.vel = [createTarget(gl, velW, velH, kind), createTarget(gl, velW, velH, kind)];
    this.pres = [createTarget(gl, velW, velH, kind), createTarget(gl, velW, velH, kind)];
    this.div = createTarget(gl, velW, velH, kind);
    this.layout = l;
    this.dens = dens;
    this.inkW = inkW;
    this.inkH = inkH;
    this.velW = velW;
    this.velH = velH;
    this.cell = l.domW / velW;
    this.undoDepth = l.coarse ? 4 : 6;
  }

  // ------------------------------------------------------------ input

  /** Starts a drop. Coordinates are css px from the bath top-left. */
  drop(x: number, y: number, ink: InkIndex, radius: number, holdable = true): DropHandle {
    if (this.drops.length >= MAX_DROPS) {
      // the oldest stops growing at once
      this.floated[this.drops[0].ink] += this.drops[0].area;
      this.bake(1);
    }
    const d: Drop = {
      cx: x,
      cy: this.layout.domH - y,
      area: 0,
      target: radius * radius,
      maxArea: radius * radius * 7,
      held: holdable,
      ink,
      age: 0,
    };
    this.drops.push(d);
    this.ripples.push({ x: d.cx, y: d.cy, age: 0 });
    if (this.ripples.length > 4) this.ripples.shift();
    this.touch();
    return {
      release: () => {
        d.held = false;
      },
    };
  }

  /** Adds stroke segments for the coming step (stylus or comb tines). */
  addSegments(list: Segment[]): void {
    for (const s of list) if (this.segs.length < 48) this.segs.push(s);
    if (list.length) this.touch();
  }

  /** A stylus or comb step: exact tine shift on the ink, plus a push on the water for inertia. */
  addStroke(st: Stroke): void {
    if (st.ax === st.bx && st.ay === st.by) return;
    if (this.strokes.length < 4) this.strokes.push(st);
    const segs: Segment[] = [];
    const room = Math.max(1, Math.floor(48 / 2));
    const step = Math.max(1, Math.ceil(st.count / room));
    for (let k = 0; k < st.count; k += step) {
      const o = (k - (st.count - 1) / 2) * st.gap;
      const ox = st.spine[0] * o, oy = st.spine[1] * o;
      segs.push({ ax: st.ax + ox, ay: st.ay + oy, bx: st.bx + ox, by: st.by + oy, radius: st.radius, strength: st.strength });
    }
    this.addSegments(segs);
  }

  private touch(): void {
    this.activeUntil = this.time + 2.6;
  }

  get busy(): boolean {
    return this.drops.length > 0 || this.time < this.activeUntil;
  }

  get hasInk(): boolean {
    return this.floated.slice(0, 4).some((a) => a > 0) || this.drops.some((d) => d.ink < 4);
  }

  // ------------------------------------------------------------ simulation

  step(dt: number): void {
    this.time += dt;
    for (const r of this.ripples) r.age += dt;
    this.ripples = this.ripples.filter((r) => r.age < 1.4);
    if (!this.busy) {
      if (this.mapDirty) this.bake(0);
      if (this.velDirty) {
        this.clearTarget(this.vel[0]);
        this.clearTarget(this.pres[0]);
        this.velDirty = false;
      }
      this.segs.length = 0;
      this.strokes.length = 0;
      return;
    }
    const gl = this.gl;
    gl.disable(gl.BLEND);
    this.stepVelocity(dt);
    this.velDirty = true;

    // the surface carries the map of where every bit of ink came from
    this.advectMap(dt);
    this.mapDirty = true;
    this.mapAge += dt;
    this.growDrops(dt);
    this.maybeBake();
  }

  private growDrops(dt: number): void {
    const k = 1 - Math.exp(-dt / 0.16);
    for (const d of this.drops) {
      if (d.held) d.target = Math.min(d.maxArea, d.target + 2600 * dt * (this.layout.coarse ? 0.6 : 1));
      d.area += (d.target - d.area) * k;
      d.age += dt;
    }
  }

  /** Bakes when the oldest drop has finished, when the surface has gone still, or after a second and a half of motion. */
  private maybeBake(): void {
    let n = 0;
    while (n < this.drops.length && Bath.done(this.drops[n])) n++;
    const still = this.time >= this.activeUntil - 1.2;
    if (n > 0 || (this.mapDirty && (still || this.mapAge > 1.5))) {
      for (let i = 0; i < n; i++) this.floated[this.drops[i].ink] += this.drops[i].area;
      this.bake(n);
    }
  }

  /** Writes the first n drops and the displacement map into the ink texture, with one resample. */
  private bake(n: number, into: Target | null = null): void {
    const gl = this.gl;
    const p = this.p.bake;
    const dst = into ?? this.ink[1];
    gl.disable(gl.BLEND);
    this.pass(p, dst, dst.w, dst.h);
    bindTex(gl, 0, this.ink[0].tex, p.u.uInk);
    bindTex(gl, 1, this.map[0].tex, p.u.uMap);
    gl.uniform2f(p.u.uDom, this.layout.domW, this.layout.domH);
    gl.uniform2f(p.u.uRes, this.inkW, this.inkH);
    this.setDrops(p, n);
    this.draw();
    if (into) return;
    this.ink.reverse();
    this.drops.splice(0, n);
    this.clearTarget(this.map[0]);
    this.mapDirty = false;
    this.mapAge = 0;
  }

  private advectMap(dt: number): void {
    const gl = this.gl;
    const p = this.p.mapAdvect;
    this.pass(p, this.map[1], this.mapW, this.mapH);
    bindTex(gl, 0, this.map[0].tex, p.u.uMap);
    bindTex(gl, 1, this.vel[0].tex, p.u.uVel);
    gl.uniform2f(p.u.uDom, this.layout.domW, this.layout.domH);
    gl.uniform1f(p.u.uDt, dt);
    const H = this.layout.domH;
    const A = new Float32Array(16), B = new Float32Array(16), C = new Float32Array(4);
    this.strokes.forEach((s, i) => {
      A.set([s.ax, H - s.ay, s.spine[0], -s.spine[1]], i * 4);
      B.set([s.bx - s.ax, -(s.by - s.ay), s.gap, s.lambda], i * 4);
      C[i] = s.count;
    });
    gl.uniform4fv(p.u.uStrokeA, A);
    gl.uniform4fv(p.u.uStrokeB, B);
    gl.uniform1fv(p.u.uStrokeC, C);
    gl.uniform1i(p.u.uStrokeN, this.strokes.length);
    this.draw();
    this.map.reverse();
    this.strokes.length = 0;
  }

  private setDrops(p: Program, n: number): void {
    const gl = this.gl;
    const dr = new Float32Array(MAX_DROPS * 4);
    const di = new Float32Array(MAX_DROPS * 4);
    for (let i = 0; i < n; i++) {
      const d = this.drops[i];
      dr.set([d.cx, d.cy, d.area, 0], i * 4);
      if (d.ink < 4) di[i * 4 + d.ink] = BODY_CONC;
    }
    gl.uniform4fv(p.u.uDrop, dr);
    gl.uniform4fv(p.u.uDropInk, di);
    gl.uniform1i(p.u.uDropN, n);
    gl.uniform1f(p.u.uTexPx, 1 / this.dens);
    gl.uniform1f(p.u.uRimGain, RIM_CONC / BODY_CONC);
  }

  private static done(d: Drop): boolean {
    return !d.held && d.target - d.area < Math.max(0.4, d.target * 0.01);
  }

  private pass(prog: Program, target: Target | null, w: number, h: number): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(prog.prog);
  }

  private stepVelocity(dt: number): void {
    const gl = this.gl;
    const L = this.layout;
    // advect + damp
    let p = this.p.advectVel;
    this.pass(p, this.vel[1], this.velW, this.velH);
    bindTex(gl, 0, this.vel[0].tex, p.u.uVel);
    gl.uniform2f(p.u.uDom, L.domW, L.domH);
    gl.uniform1f(p.u.uDt, dt);
    gl.uniform1f(p.u.uDamp, Math.exp(-dt * 3.2));
    this.draw();
    this.vel.reverse();

    if (this.segs.length) {
      p = this.p.force;
      this.pass(p, this.vel[1], this.velW, this.velH);
      bindTex(gl, 0, this.vel[0].tex, p.u.uVel);
      gl.uniform2f(p.u.uDom, L.domW, L.domH);
      gl.uniform1f(p.u.uDt, Math.max(dt, 1 / 240));
      const seg = new Float32Array(48 * 4);
      const sp = new Float32Array(48 * 2);
      this.segs.forEach((s, i) => {
        seg.set([s.ax, L.domH - s.ay, s.bx, L.domH - s.by], i * 4);
        sp.set([s.radius, s.strength], i * 2);
      });
      gl.uniform4fv(p.u.uSeg, seg);
      gl.uniform2fv(p.u.uSegP, sp);
      gl.uniform1i(p.u.uSegN, this.segs.length);
      this.draw();
      this.vel.reverse();
      this.segs.length = 0;
    }

    // projection
    const tx = 1 / this.velW, ty = 1 / this.velH, h = this.cell;
    p = this.p.div;
    this.pass(p, this.div, this.velW, this.velH);
    bindTex(gl, 0, this.vel[0].tex, p.u.uVel);
    gl.uniform2f(p.u.uTexel, tx, ty);
    gl.uniform1f(p.u.uH, h);
    this.draw();
    p = this.p.jacobi;
    gl.useProgram(p.prog);
    for (let i = 0; i < 22; i++) {
      this.pass(p, this.pres[1], this.velW, this.velH);
      bindTex(gl, 0, this.pres[0].tex, p.u.uP);
      bindTex(gl, 1, this.div!.tex, p.u.uDiv);
      gl.uniform2f(p.u.uTexel, tx, ty);
      gl.uniform1f(p.u.uH, h);
      this.draw();
      this.pres.reverse();
    }
    p = this.p.grad;
    this.pass(p, this.vel[1], this.velW, this.velH);
    bindTex(gl, 0, this.pres[0].tex, p.u.uP);
    bindTex(gl, 1, this.vel[0].tex, p.u.uVel);
    gl.uniform2f(p.u.uTexel, tx, ty);
    gl.uniform1f(p.u.uH, h);
    this.draw();
    this.vel.reverse();
  }

  // ------------------------------------------------------------ helpers

  private clearTarget(t: Target): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  private copy(
    src: Target,
    dst: Target,
    r0: [number, number] = [0, 0],
    r1: [number, number] = [1, 1],
    mul = 1,
    hole: [number, number, number, number] = [2, 2, 2, 2],
    holeMul = 1,
  ): void {
    const gl = this.gl;
    const p = this.p.copy;
    gl.disable(gl.BLEND);
    this.pass(p, dst, dst.w, dst.h);
    bindTex(gl, 0, src.tex, p.u.uSrc);
    gl.uniform2f(p.u.uR0, r0[0], r0[1]);
    gl.uniform2f(p.u.uR1, r1[0], r1[1]);
    gl.uniform1f(p.u.uMul, mul);
    gl.uniform4f(p.u.uHole, hole[0], hole[1], hole[2], hole[3]);
    gl.uniform1f(p.u.uHoleMul, holeMul);
    this.draw();
  }

  /** Remembers the bath before an action so it can be undone. */
  snapshot(): void {
    const gl = this.gl;
    let t: Target;
    if (this.snaps.length >= this.undoDepth) t = this.snaps.shift()!;
    else t = createTarget(gl, this.inkW, this.inkH, 'u8');
    this.bake(this.drops.length, t);
    this.snaps.push(t);
  }

  get canUndo(): boolean {
    return this.snaps.length > 0;
  }

  undo(): boolean {
    const t = this.snaps.pop();
    if (!t) return false;
    this.drops = [];
    this.segs.length = 0;
    this.copy(t, this.ink[0]);
    this.clearTarget(this.map[0]);
    this.mapDirty = false;
    deleteTarget(this.gl, t);
    this.clearTarget(this.vel[0]);
    this.clearTarget(this.pres[0]);
    return true;
  }

  clear(keepUndo = false): void {
    if (!keepUndo) {
      this.snaps.forEach((t) => deleteTarget(this.gl, t));
      this.snaps = [];
    }
    this.drops = [];
    this.segs.length = 0;
    this.ripples = [];
    for (const t of this.ink) this.clearTarget(t);
    for (const t of this.map) this.clearTarget(t);
    this.mapDirty = false;
    this.clearTarget(this.vel[0]);
    this.clearTarget(this.pres[0]);
    this.floated = [0, 0, 0, 0, 0];
    this.activeUntil = -1;
  }

  /** Square region in ink uv: [u0, v0, u1, v1] with v up. */
  private squareUv(): [number, number, number, number] {
    const L = this.layout;
    const u0 = L.sqX / L.domW;
    const u1 = (L.sqX + L.sqSize) / L.domW;
    const v1 = 1 - L.sqY / L.domH;
    const v0 = 1 - (L.sqY + L.sqSize) / L.domH;
    return [u0, v0, u1, v1];
  }

  /** The silk takes the ink inside the square. Leaves a faint ghost in the bath. */
  takePrint(): void {
    const gl = this.gl;
    const L = this.layout;
    this.drops.forEach((d) => (this.floated[d.ink] += d.area));
    this.bake(this.drops.length);
    const size = Math.min(2048, Math.max(256, Math.round(L.sqSize * this.dens)));
    if (!this.print || this.print.w !== size) {
      deleteTarget(gl, this.print);
      this.print = createTarget(gl, size, size, this.caps.floatFormat);
    }
    this.printSize = size;
    const [u0, v0, u1, v1] = this.squareUv();
    this.copy(this.ink[0], this.print, [u0, v0], [u1, v1]);
    // residue in the bath
    this.copy(this.ink[0], this.ink[1], [0, 0], [1, 1], 1, [u0, v0, u1, v1], 0.07);
    const [a, b] = this.ink;
    this.ink[0] = b;
    this.ink[1] = a;
    this.clearTarget(this.vel[0]);
    this.buildPrintColor();
  }

  private buildPrintColor(): void {
    const gl = this.gl;
    const size = 1024;
    if (!this.printColor) {
      this.printColor = createTarget(gl, size, size, 'u8', gl.LINEAR_MIPMAP_LINEAR);
    }
    const p = this.p.printColor;
    this.pass(p, this.printColor, size, size);
    bindTex(gl, 0, this.print!.tex, p.u.uSrc);
    gl.uniform2f(p.u.uRes, this.printSize, this.printSize);
    gl.uniform1i(p.u.uCubic, this.printSize < size ? 1 : 0);
    gl.uniform3fv(p.u.uK, this.K);
    gl.uniform3fv(p.u.uWhite, this.silkLin);
    this.draw();
    gl.bindTexture(gl.TEXTURE_2D, this.printColor.tex);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  /** 64x64 RGBA bytes of pigment concentration over the printed square. */
  readPrint(n = 64): Uint8Array {
    const gl = this.gl;
    const t = createTarget(gl, n, n, 'u8');
    const p = this.p.down;
    this.pass(p, t, n, n);
    bindTex(gl, 0, this.print!.tex, p.u.uSrc);
    gl.uniform2f(p.u.uCell, 1 / n, 1 / n);
    this.draw();
    const out = new Uint8Array(n * n * 4);
    gl.readPixels(0, 0, n, n, gl.RGBA, gl.UNSIGNED_BYTE, out);
    deleteTarget(gl, t);
    return out;
  }

  /** Renders the flat scarf at the given size and returns sRGB RGBA bytes, top row first. */
  renderExport(size = 2048): Uint8Array {
    const gl = this.gl;
    const t = createTarget(gl, size, size, 'u8');
    const p = this.p.printColor;
    this.pass(p, t, size, size);
    bindTex(gl, 0, this.print!.tex, p.u.uSrc);
    gl.uniform2f(p.u.uRes, this.printSize, this.printSize);
    gl.uniform1i(p.u.uCubic, 1);
    gl.uniform3fv(p.u.uK, this.K);
    gl.uniform3fv(p.u.uWhite, this.silkLin);
    this.draw();
    const raw = new Uint8Array(size * size * 4);
    gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    deleteTarget(gl, t);
    const out = new Uint8Array(raw.length);
    const row = size * 4;
    for (let y = 0; y < size; y++) out.set(raw.subarray((size - 1 - y) * row, (size - y) * row), y * row);
    return out;
  }

  // ------------------------------------------------------------ display

  render(canvasW: number, canvasH: number, dpr: number, fbW: number, fbH: number): void {
    const gl = this.gl;
    const L = this.layout;
    const p = this.p.display;
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    this.pass(p, null, fbW, fbH);
    bindTex(gl, 0, this.ink[0].tex, p.u.uInk);
    bindTex(gl, 1, this.vel[0].tex, p.u.uVel);
    bindTex(gl, 2, this.map[0].tex, p.u.uMap);
    this.setDrops(p, this.drops.length);
    gl.uniform2f(p.u.uDom, L.domW, L.domH);
    gl.uniform2f(p.u.uCanvas, canvasW, canvasH);
    gl.uniform1f(p.u.uDpr, dpr);
    gl.uniform1f(p.u.uTime, this.time);
    gl.uniform3fv(p.u.uK, this.K);
    gl.uniform3fv(p.u.uWhite, this.silkLin);
    gl.uniform3fv(p.u.uBath, this.bathLin);
    gl.uniform3fv(p.u.uPaper, this.paperLin);
    gl.uniform3fv(p.u.uRim, this.rimLin);
    const T = this.tray;
    gl.uniform4f(p.u.uTray, T.x0, L.domH - T.y1, T.x1, L.domH - T.y0);
    gl.uniform1f(p.u.uTrayRim, T.rim);
    gl.uniform4f(p.u.uSquare, L.sqX, L.domH - L.sqY - L.sqSize, L.sqSize, this.guide);
    gl.uniform4f(p.u.uSilk, this.silk.lower, this.silk.front, this.silk.alpha, 1);
    gl.uniform1f(p.u.uBackdrop, this.backdrop);
    gl.uniform1f(p.u.uSkim, this.skim);
    const rp = new Float32Array(16);
    this.ripples.forEach((r, i) => {
      const t = r.age / 1.4;
      rp.set([r.x, r.y, 8 + 90 * Math.sqrt(t), (1 - t) * (1 - t)], i * 4);
    });
    gl.uniform4fv(p.u.uRipple, rp);
    this.draw();
  }

  dispose(): void {
    const gl = this.gl;
    [...this.ink, ...this.map, ...this.vel, ...this.pres, ...this.snaps, this.div, this.print, this.printColor].forEach((t) => deleteTarget(gl, t));
  }
}
