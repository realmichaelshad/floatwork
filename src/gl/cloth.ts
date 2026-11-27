// Position-based cloth: a square grid of particles joined by structural, shear and
// bending distance constraints, Verlet integration with small substeps, an
// aerodynamic drag term (what makes silk float) and long-range attachments to the
// two pins so the fabric never stretches like rubber.

import type { Vec3 } from './math';

export interface Grab {
  idx: number;
  target: Vec3;
}

export class Cloth {
  readonly n: number;
  readonly count: number;
  pos: Float32Array;
  prev: Float32Array;
  inv: Float32Array;
  nor: Float32Array;
  tan: Float32Array;
  private ca: Int32Array;
  private cb: Int32Array;
  private rest: Float32Array;
  private stiff: Float32Array;
  private lra: Float32Array[] = [];
  pins: number[];
  pinTargets: Vec3[];
  floor = true;
  grab: Grab | null = null;
  wind = 1;
  drag = 5.5;
  substeps: number;
  private time = 0;

  constructor(n: number, substeps = 4) {
    this.n = n;
    this.count = n * n;
    this.substeps = substeps;
    this.pos = new Float32Array(this.count * 3);
    this.prev = new Float32Array(this.count * 3);
    this.inv = new Float32Array(this.count);
    this.nor = new Float32Array(this.count * 3);
    this.tan = new Float32Array(this.count * 3);
    const a: number[] = [], b: number[] = [], r: number[] = [], s: number[] = [];
    const L = 1 / (n - 1);
    const add = (i: number, j: number, len: number, k: number) => {
      a.push(i);
      b.push(j);
      r.push(len);
      s.push(k);
    };
    for (let v = 0; v < n; v++)
      for (let u = 0; u < n; u++) {
        const i = v * n + u;
        if (u + 1 < n) add(i, i + 1, L, 1);
        if (v + 1 < n) add(i, i + n, L, 1);
      }
    for (let v = 0; v + 1 < n; v++)
      for (let u = 0; u < n; u++) {
        const i = v * n + u;
        if (u + 1 < n) add(i, i + n + 1, L * Math.SQRT2, 0.85);
        if (u > 0) add(i, i + n - 1, L * Math.SQRT2, 0.85);
      }
    for (let v = 0; v < n; v++)
      for (let u = 0; u < n; u++) {
        const i = v * n + u;
        if (u + 2 < n) add(i, i + 2, 2 * L, 0.05);
        if (v + 2 < n) add(i, i + 2 * n, 2 * L, 0.05);
      }
    this.ca = Int32Array.from(a);
    this.cb = Int32Array.from(b);
    this.rest = Float32Array.from(r);
    this.stiff = Float32Array.from(s);
    this.pins = [0, n - 1];
    this.pinTargets = [
      [-0.5, 0, -0.5],
      [0.5, 0, -0.5],
    ];
    this.reset();
  }

  /** Lays the cloth flat on the bath (y = 0), far edge at z = -0.5. */
  reset(): void {
    const n = this.n;
    for (let v = 0; v < n; v++)
      for (let u = 0; u < n; u++) {
        const i = v * n + u;
        const x = u / (n - 1) - 0.5;
        const z = v / (n - 1) - 0.5;
        // a wet sheet is never perfectly flat: a few soft ridges give the folds somewhere to start
        const y = 0.0005 + 0.004 * Math.max(0, Math.sin(u * 17.0 + v * 3.0) * Math.sin(v * 5.0 + 1.3));
        this.pos.set([x, y, z], i * 3);
        this.prev.set([x, y, z], i * 3);
        this.inv[i] = 1;
      }
    this.lra = this.pins.map((p) => {
      const out = new Float32Array(this.count);
      const px = this.pos[p * 3], pz = this.pos[p * 3 + 2];
      for (let i = 0; i < this.count; i++) out[i] = Math.hypot(this.pos[i * 3] - px, this.pos[i * 3 + 2] - pz) * 1.015;
      return out;
    });
    this.pinTargets = [
      [-0.5, 0.0005, -0.5],
      [0.5, 0.0005, -0.5],
    ];
    this.floor = true;
    this.grab = null;
    this.time = 0;
    this.computeNormals();
  }

  /** Wind velocity at time t, gentle and never repeating exactly. */
  private windAt(t: number): Vec3 {
    const w = this.wind;
    return [
      w * (0.05 * Math.sin(t * 0.31) + 0.03 * Math.sin(t * 1.13 + 2.0)),
      0,
      w * (0.16 + 0.12 * Math.sin(t * 0.53) + 0.07 * Math.sin(t * 1.71 + 1.0) + 0.04 * Math.sin(t * 3.1)),
    ];
  }

  step(dt: number): void {
    const S = this.substeps;
    const h = dt / S;
    const g = -10.5;
    const pos = this.pos, prev = this.prev, inv = this.inv, nor = this.nor;
    const N = this.count;
    for (let sub = 0; sub < S; sub++) {
      this.time += h;
      const wind = this.windAt(this.time);
      const damp = 0.9985;
      for (let i = 0; i < N; i++) {
        if (inv[i] === 0) continue;
        const k = i * 3;
        const vx = (pos[k] - prev[k]) * damp;
        const vy = (pos[k + 1] - prev[k + 1]) * damp;
        const vz = (pos[k + 2] - prev[k + 2]) * damp;
        // aerodynamic force along the normal, from velocity relative to the air
        const rx = vx / h - wind[0], ry = vy / h - wind[1], rz = vz / h - wind[2];
        const nx = nor[k], ny = nor[k + 1], nz = nor[k + 2];
        const vn = rx * nx + ry * ny + rz * nz;
        const f = -this.drag * vn;
        prev[k] = pos[k];
        prev[k + 1] = pos[k + 1];
        prev[k + 2] = pos[k + 2];
        pos[k] += vx + f * nx * h * h;
        pos[k + 1] += vy + (g + f * ny) * h * h;
        pos[k + 2] += vz + f * nz * h * h;
      }
      this.applyPins();
      this.solve();
      this.solve();
      this.applyLra();
      this.applyPins();
      if (this.floor) {
        for (let i = 0; i < N; i++) {
          const k = i * 3;
          if (pos[k + 1] < 0) {
            pos[k + 1] = 0;
            // friction with the wet surface
            prev[k] += (pos[k] - prev[k]) * 0.35;
            prev[k + 2] += (pos[k + 2] - prev[k + 2]) * 0.35;
          }
        }
      }
    }
    this.computeNormals();
  }

  private applyPins(): void {
    const pos = this.pos, prev = this.prev;
    this.pins.forEach((p, j) => {
      const t = this.pinTargets[j];
      this.inv[p] = 0;
      pos.set(t, p * 3);
      prev.set(t, p * 3);
    });
    const gr = this.grab;
    if (gr) {
      const k = gr.idx * 3;
      this.inv[gr.idx] = 0;
      // follow the hand softly so a fast flick does not tear the solver
      pos[k] += (gr.target[0] - pos[k]) * 0.35;
      pos[k + 1] += (gr.target[1] - pos[k + 1]) * 0.35;
      pos[k + 2] += (gr.target[2] - pos[k + 2]) * 0.35;
    }
  }

  private solve(): void {
    const pos = this.pos, inv = this.inv, ca = this.ca, cb = this.cb, rest = this.rest, stiff = this.stiff;
    const M = ca.length;
    for (let c = 0; c < M; c++) {
      const i = ca[c], j = cb[c];
      const wi = inv[i], wj = inv[j];
      const w = wi + wj;
      if (w === 0) continue;
      const ki = i * 3, kj = j * 3;
      const dx = pos[kj] - pos[ki], dy = pos[kj + 1] - pos[ki + 1], dz = pos[kj + 2] - pos[ki + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < 1e-9) continue;
      const s = ((d - rest[c]) / d) * stiff[c] / w;
      pos[ki] += dx * s * wi;
      pos[ki + 1] += dy * s * wi;
      pos[ki + 2] += dz * s * wi;
      pos[kj] -= dx * s * wj;
      pos[kj + 1] -= dy * s * wj;
      pos[kj + 2] -= dz * s * wj;
    }
  }

  private applyLra(): void {
    const pos = this.pos, inv = this.inv;
    this.pins.forEach((p, j) => {
      const r = this.lra[j];
      const px = pos[p * 3], py = pos[p * 3 + 1], pz = pos[p * 3 + 2];
      for (let i = 0; i < this.count; i++) {
        if (inv[i] === 0) continue;
        const k = i * 3;
        const dx = pos[k] - px, dy = pos[k + 1] - py, dz = pos[k + 2] - pz;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d > r[i]) {
          const s = r[i] / d;
          pos[k] = px + dx * s;
          pos[k + 1] = py + dy * s;
          pos[k + 2] = pz + dz * s;
        }
      }
    });
  }

  /** Clamps a grab target so it stays within reach of both pins. */
  clampToReach(idx: number, t: Vec3): Vec3 {
    let out: Vec3 = [t[0], t[1], t[2]];
    this.pins.forEach((p, j) => {
      const r = this.lra[j][idx] * 1.02;
      const px = this.pos[p * 3], py = this.pos[p * 3 + 1], pz = this.pos[p * 3 + 2];
      const dx = out[0] - px, dy = out[1] - py, dz = out[2] - pz;
      const d = Math.hypot(dx, dy, dz);
      if (d > r) out = [px + (dx * r) / d, py + (dy * r) / d, pz + (dz * r) / d];
    });
    return out;
  }

  release(): void {
    if (this.grab) this.inv[this.grab.idx] = 1;
    this.grab = null;
  }

  computeNormals(): void {
    const n = this.n, pos = this.pos, nor = this.nor, tan = this.tan;
    for (let v = 0; v < n; v++)
      for (let u = 0; u < n; u++) {
        const i = v * n + u;
        const l = v * n + Math.max(0, u - 1), r = v * n + Math.min(n - 1, u + 1);
        const t = Math.max(0, v - 1) * n + u, b = Math.min(n - 1, v + 1) * n + u;
        const ux = pos[r * 3] - pos[l * 3], uy = pos[r * 3 + 1] - pos[l * 3 + 1], uz = pos[r * 3 + 2] - pos[l * 3 + 2];
        const vx = pos[b * 3] - pos[t * 3], vy = pos[b * 3 + 1] - pos[t * 3 + 1], vz = pos[b * 3 + 2] - pos[t * 3 + 2];
        // n = dV x dU
        let nx = vy * uz - vz * uy, ny = vz * ux - vx * uz, nz = vx * uy - vy * ux;
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl; ny /= nl; nz /= nl;
        nor[i * 3] = nx; nor[i * 3 + 1] = ny; nor[i * 3 + 2] = nz;
        const ul = Math.hypot(ux, uy, uz) || 1;
        tan[i * 3] = ux / ul; tan[i * 3 + 1] = uy / ul; tan[i * 3 + 2] = uz / ul;
      }
  }

  /** Lowest and highest points, for framing. */
  bounds(): { min: Vec3; max: Vec3 } {
    const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < this.count; i++)
      for (let c = 0; c < 3; c++) {
        const x = this.pos[i * 3 + c];
        if (x < min[c]) min[c] = x;
        if (x > max[c]) max[c] = x;
      }
    return { min, max };
  }

  /** Kinetic activity, used to know when the cloth has settled. */
  energy(): number {
    let e = 0;
    for (let i = 0; i < this.pos.length; i++) {
      const d = this.pos[i] - this.prev[i];
      e += d * d;
    }
    return e;
  }
}
