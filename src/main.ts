import '@fontsource/libre-caslon-display/latin-400.css';
import '@fontsource/libre-caslon-text/latin-400.css';
import '@fontsource/libre-caslon-text/latin-400-italic.css';
import './style.css';

import { CYCLE, makePattern, Pattern } from './attract';
import { drawFallback } from './fallback';
import { Bath, DropHandle, InkIndex, Stroke } from './gl/bath';
import { Cloth } from './gl/cloth';
import { ClothRenderer } from './gl/clothRender';
import { clamp01, lookAt, mul, perspective, project, smooth, smoother, unproject, invert, Vec3, Mat4, lerp3 } from './gl/math';
import { createFullscreen, detectCaps } from './gl/util';
import { PIGMENTS } from './pigments';
import { lotNumber, measureRecipe, Recipe } from './recipe';

// ------------------------------------------------------------------ flags

const params = new URLSearchParams(location.search);
const CAPTURE = params.get('capture') === '1';
let attract = params.get('attract') === '1';
const LOOPSEED = params.get('loopseed');
const LOOPKIND = Number(params.get('loopkind') || 0);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const coarse = matchMedia('(pointer: coarse)').matches;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $('stage');
const canvas = $<HTMLCanvasElement>('gl');
const ghost = document.getElementById('ghost') as unknown as SVGSVGElement;
const hint = $('hint');
const caption = $('caption');
const tray = $('tray');
const grabEl = $('grab');
const scarfFrame = $('scarfFrame');
const ticket = $('ticket');
const layBtn = $<HTMLButtonElement>('lay');
const undoBtn = $<HTMLButtonElement>('undo');
const freshBtn = $<HTMLButtonElement>('fresh');
const header = $('top');

if (attract) document.documentElement.classList.add('attract');
if (CAPTURE) document.documentElement.classList.add('capture');

type Mode = 'bath' | 'laying' | 'lifting' | 'scarf';
let mode: Mode = 'bath';

function setMode(m: Mode): void {
  mode = m;
  stage.dataset.mode = m;
  ticket.hidden = !(m === 'lifting' || m === 'scarf');
}

// ------------------------------------------------------------------ GL setup

const gl = canvas.getContext('webgl2', {
  antialias: true,
  depth: true,
  alpha: false,
  premultipliedAlpha: false,
  preserveDrawingBuffer: CAPTURE,
  powerPreference: 'high-performance',
}) as WebGL2RenderingContext | null;

function showFallback(title?: string, text?: string, retry = false): void {
  const fb = $('fallback');
  fb.hidden = false;
  if (title) $('fallbackTitle').textContent = title;
  if (text) $('fallbackText').textContent = text;
  $('fallbackRetry').hidden = !retry;
  drawFallback($<HTMLCanvasElement>('fallbackArt'));
  tray.style.visibility = 'hidden';
  hint.classList.add('off');
}

let bath: Bath | null = null;
let cloth: Cloth | null = null;
let clothR: ClothRenderer | null = null;
let draw: () => void = () => {};

function initGL(): boolean {
  if (!gl) return false;
  try {
    const caps = detectCaps(gl);
    draw = createFullscreen(gl);
    bath = new Bath(gl, caps, draw);
    cloth = new Cloth(coarse ? 28 : 40, coarse ? 3 : 4);
    if (reducedMotion) cloth.wind = 0;
    clothR = new ClothRenderer(gl, cloth);
    return true;
  } catch (e) {
    console.warn(e);
    return false;
  }
}

// ------------------------------------------------------------------ layout

interface Geo {
  cw: number;
  ch: number;
  dpr: number;
  trayH: number;
  domH: number;
  sq: { x: number; y: number; size: number };
  tray: { x0: number; y0: number; x1: number; y1: number; rim: number };
}
let geo: Geo | null = null;

function measure(): Geo {
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, coarse ? 1.5 : 2);
  const trayH = attract ? 0 : tray.offsetHeight;
  const domH = Math.max(120, ch - trayH);
  const headerH = header.offsetHeight;
  const m = cw < 600 ? 8 : 16;
  const rim = cw < 600 ? 7 : 11;
  const bathTray = { x0: m, y0: headerH + 2, x1: cw - m, y1: domH - (attract ? m : 6), rim };
  // the water inside the rim, and the silk square inside the water
  const wx0 = bathTray.x0 + rim, wy0 = bathTray.y0 + rim, ww = bathTray.x1 - bathTray.x0 - 2 * rim, wh = bathTray.y1 - bathTray.y0 - 2 * rim;
  const pad = cw < 600 ? 10 : 22;
  const capRoom = attract ? 84 : 0;
  let size = Math.min(ww - 2 * pad, wh - 2 * pad - capRoom, 780);
  size = Math.max(160, Math.floor(size));
  const x = Math.round(wx0 + (ww - size) / 2);
  const y = Math.round(wy0 + Math.max(pad, (wh - capRoom - size) / 2));
  return { cw, ch, dpr, trayH, domH, sq: { x, y, size }, tray: bathTray };
}

function applyLayout(): void {
  if (!bath || !gl) return;
  const g = measure();
  const changed = !geo || g.cw !== geo.cw || g.domH !== geo.domH || g.sq.size !== geo.sq.size;
  geo = g;
  bath.tray = g.tray;
  canvas.width = Math.round(g.cw * g.dpr);
  canvas.height = Math.round(g.ch * g.dpr);
  document.documentElement.style.setProperty('--tray-h', `${g.trayH}px`);
  if (changed && mode === 'bath') {
    bath.setLayout({ domW: g.cw, domH: g.domH, sqX: g.sq.x, sqY: g.sq.y, sqSize: g.sq.size, coarse });
  } else if (!bath.layout) {
    bath.setLayout({ domW: g.cw, domH: g.domH, sqX: g.sq.x, sqY: g.sq.y, sqSize: g.sq.size, coarse });
  }
  updateButtons();
  requestFrame();
}

let resizeTimer = 0;
function onResize(): void {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(applyLayout, CAPTURE ? 0 : 120);
}

// ------------------------------------------------------------------ tool state

let ink: InkIndex = 0;
let tool: 'drop' | 'stylus' | 'comb' = 'drop';
let dropsMade = 0;
let strokesMade = 0;

function setInk(i: InkIndex, announce = true): void {
  ink = i;
  document.querySelectorAll<HTMLButtonElement>('.ink').forEach((b) => b.setAttribute('aria-checked', String(Number(b.dataset.ink) === i)));
  if (announce) flashCaption(i === 4 ? 'Clear ring' : PIGMENTS[i].name);
  if (tool !== 'drop') setTool('drop', false);
}

function setTool(t: typeof tool, announce = true): void {
  tool = t;
  document.querySelectorAll<HTMLButtonElement>('.tool').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.tool === t)));
  if (announce) flashCaption(t === 'drop' ? 'Drop: tap to float ink' : t === 'stylus' ? 'Stylus: drag to pull' : 'Comb: drag across');
}

let captionTimer = 0;
function flashCaption(text: string): void {
  caption.textContent = text;
  caption.classList.add('on');
  window.clearTimeout(captionTimer);
  captionTimer = window.setTimeout(() => caption.classList.remove('on'), 1600);
}

function setHint(text: string | null, small = false): void {
  if (!text) {
    hint.classList.add('off');
    return;
  }
  if (hint.textContent !== text) hint.textContent = text;
  hint.classList.toggle('small', small);
  hint.classList.remove('off');
}

function updateButtons(): void {
  if (!bath) return;
  layBtn.disabled = !bath.hasInk || mode !== 'bath';
  undoBtn.disabled = !bath.canUndo || mode !== 'bath';
}

document.querySelectorAll<HTMLButtonElement>('.ink').forEach((b) =>
  b.addEventListener('click', () => setInk(Number(b.dataset.ink) as InkIndex)),
);
document.querySelectorAll<HTMLButtonElement>('.tool').forEach((b) =>
  b.addEventListener('click', () => setTool(b.dataset.tool as typeof tool)),
);
// arrow keys move within each radio group
document.querySelectorAll<HTMLElement>('[role=radiogroup]').forEach((g) => {
  g.addEventListener('keydown', (e) => {
    const items = [...g.querySelectorAll<HTMLButtonElement>('[role=radio]')];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    let j = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % items.length;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + items.length) % items.length;
    if (j >= 0) {
      e.preventDefault();
      items[j].focus();
      items[j].click();
    }
  });
});

undoBtn.addEventListener('click', () => {
  if (bath?.undo()) {
    updateButtons();
    requestFrame();
  }
});

let skimFrom = -1;
freshBtn.addEventListener('click', () => freshBath(true));

function freshBath(animate: boolean): void {
  if (!bath || mode !== 'bath') return;
  endAllPointers();
  if (bath.hasInk) bath.snapshot();
  if (animate && !reducedMotion) skimFrom = now;
  else {
    bath.clear(true);
    afterClear();
  }
  requestFrame();
}

function afterClear(): void {
  dropsMade = 0;
  strokesMade = 0;
  if (!attract) setHint('Float some ink.');
  updateButtons();
}

// ------------------------------------------------------------------ bath input

interface Ptr {
  id: number;
  x: number;
  y: number;
  lx: number;
  ly: number;
  sx: number;
  sy: number;
  t0: number;
  kind: 'pending' | 'drop' | 'stroke' | 'comb';
  drop: DropHandle | null;
  spine: [number, number] | null;
  moved: number;
}
const ptrs = new Map<number, Ptr>();

function toBath(e: PointerEvent): [number, number] {
  const r = canvas.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

canvas.addEventListener('pointerdown', (e) => {
  if (!bath || !geo || mode !== 'bath') return;
  if (attract) return;
  const [x, y] = toBath(e);
  if (y > geo.domH) return;
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);
  if (ptrs.size === 0) bath.snapshot();
  const p: Ptr = { id: e.pointerId, x, y, lx: x, ly: y, sx: x, sy: y, t0: now, kind: 'pending', drop: null, spine: null, moved: 0 };
  if (tool === 'stylus') p.kind = 'stroke';
  if (tool === 'comb') p.kind = 'comb';
  ptrs.set(e.pointerId, p);
  requestFrame();
});

canvas.addEventListener('pointermove', (e) => {
  const p = ptrs.get(e.pointerId);
  if (!p) return;
  const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
  const last = events.length ? events[events.length - 1] : e;
  const [x, y] = toBath(last);
  p.moved = Math.max(p.moved, Math.hypot(x - p.sx, y - p.sy));
  p.x = x;
  p.y = y;
  if (p.kind === 'pending' && p.moved > 9) p.kind = 'stroke';
  if (p.kind === 'drop' && p.moved > 18) {
    p.kind = 'stroke';
  }
  requestFrame();
});

function endPointer(e: PointerEvent): void {
  const p = ptrs.get(e.pointerId);
  if (!p) return;
  if (p.kind === 'pending') startDrop(p);
  p.drop?.release();
  if (p.kind === 'stroke' || p.kind === 'comb') strokesMade++;
  ptrs.delete(e.pointerId);
  if (ptrs.size === 0) clearGhost();
  progressHints();
  updateButtons();
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

function endAllPointers(): void {
  ptrs.forEach((p) => p.drop?.release());
  ptrs.clear();
  clearGhost();
}

function sizes() {
  const s = geo!.sq.size;
  const gap = s / 13;
  return {
    drop: s * 0.075,
    stylusR: Math.max(7, s * 0.022),
    stylusL: Math.max(2.5, s * 0.009),
    tineR: Math.max(5.5, s * 0.017),
    tineGap: gap,
    tineL: gap * 0.085,
  };
}

function stylusStroke(ax: number, ay: number, bx: number, by: number): Stroke {
  const sz = sizes();
  return { ax, ay, bx, by, spine: [1, 0], gap: 1, count: 1, lambda: sz.stylusL, radius: sz.stylusR, strength: 0.55 };
}

function combStroke(ax: number, ay: number, bx: number, by: number, spine: [number, number]): Stroke {
  const sz = sizes();
  return { ax, ay, bx, by, spine, gap: sz.tineGap, count: combCount(sz.tineGap), lambda: sz.tineL, radius: sz.tineR, strength: 0.3 };
}

function startDrop(p: Ptr): void {
  if (!bath) return;
  p.drop = bath.drop(p.sx, p.sy, ink, sizes().drop, true);
  p.kind = 'drop';
  if (ink < 4) dropsMade++;
  progressHints();
  updateButtons();
}

function progressHints(): void {
  if (attract || mode !== 'bath') return;
  if (dropsMade === 0) setHint('Float some ink.');
  else if (dropsMade < 3 && strokesMade === 0) setHint(null);
  else if (strokesMade === 0) setHint(coarse ? 'Now drag through it.' : 'Now drag through it.', true);
  else setHint(null);
}

/** Comb tines for a hand at (x, y) moving with a given spine. */
function tines(spine: [number, number], count: number, gap: number): [number, number][] {
  const out: [number, number][] = [];
  for (let k = 0; k < count; k++) {
    const o = (k - (count - 1) / 2) * gap;
    out.push([spine[0] * o, spine[1] * o]);
  }
  return out;
}

function combCount(gap: number): number {
  return Math.min(41, Math.ceil((Math.max(geo!.cw, geo!.domH) * 1.25) / gap) | 1);
}

function snapSpine(dx: number, dy: number): [number, number] {
  // the spine is perpendicular to the first movement, snapped to the axes when close
  let a = Math.atan2(dy, dx) + Math.PI / 2;
  const q = Math.PI / 2;
  const snapped = Math.round(a / q) * q;
  if (Math.abs(a - snapped) < 0.3) a = snapped;
  return [Math.cos(a), Math.sin(a)];
}

/** Turns pointer motion since the last step into drops and stroke segments. */
function feedPointers(): void {
  if (!bath || !geo) return;
  ptrs.forEach((p) => {
    if (p.kind === 'pending' && now - p.t0 > 0.09) startDrop(p);
    if (p.kind === 'stroke') {
      if (p.x !== p.lx || p.y !== p.ly) bath!.addStroke(stylusStroke(p.lx, p.ly, p.x, p.y));
    } else if (p.kind === 'comb') {
      if (!p.spine && p.moved > 6) p.spine = snapSpine(p.x - p.sx, p.y - p.sy);
      if (p.spine && (p.x !== p.lx || p.y !== p.ly)) bath!.addStroke(combStroke(p.lx, p.ly, p.x, p.y, p.spine));
    }
    p.lx = p.x;
    p.ly = p.y;
  });
}

// ------------------------------------------------------------------ ghost (stylus tip and comb)

function clearGhost(): void {
  ghost.innerHTML = '';
}

function drawGhost(items: { x: number; y: number; kind: 'stylus' | 'comb'; spine?: [number, number] | null }[]): void {
  if (!geo) return;
  const sz = sizes();
  let s = '';
  for (const it of items) {
    if (it.kind === 'stylus') {
      s += `<circle cx="${it.x.toFixed(1)}" cy="${it.y.toFixed(1)}" r="5" fill="none" stroke="rgba(22,19,15,.55)" stroke-width="1.2"/>`;
      s += `<circle cx="${it.x.toFixed(1)}" cy="${it.y.toFixed(1)}" r="1.6" fill="rgba(22,19,15,.7)"/>`;
    } else if (it.spine) {
      const n = combCount(sz.tineGap);
      const pts = tines(it.spine, n, sz.tineGap);
      const a = pts[0], b = pts[pts.length - 1];
      s += `<line x1="${(it.x + a[0]).toFixed(1)}" y1="${(it.y + a[1]).toFixed(1)}" x2="${(it.x + b[0]).toFixed(1)}" y2="${(it.y + b[1]).toFixed(1)}" stroke="rgba(22,19,15,.22)" stroke-width="1"/>`;
      for (const [ox, oy] of pts) s += `<circle cx="${(it.x + ox).toFixed(1)}" cy="${(it.y + oy).toFixed(1)}" r="2" fill="rgba(22,19,15,.5)"/>`;
    }
  }
  ghost.innerHTML = s;
}

// ------------------------------------------------------------------ the print: laying, lifting, hanging

const H_TOP = 1.12;
let layAt = -1;
let liftAt = -1;
let fast = false;
let recipe: Recipe | null = null;
let lot = { hash: 0, code: '' };
let fadeAt = -1;

function durations() {
  return fast
    ? { lower: 0.55, transferFrom: 0.5, transferTo: 1.25, lift: 2.0 }
    : { lower: 1.1, transferFrom: 1.0, transferTo: 2.2, lift: 2.7 };
}

layBtn.addEventListener('click', () => startLay(false));

function startLay(isFast: boolean): void {
  if (!bath || !geo || mode !== 'bath') return;
  endAllPointers();
  fast = isFast;
  layAt = now;
  bath.guide = 0;
  setMode('laying');
  setHint(null);
  updateButtons();
  if (!attract) {
    const top = stage.getBoundingClientRect().top + window.scrollY;
    if (Math.abs(window.scrollY - top) > 4) window.scrollTo({ top, behavior: reducedMotion ? 'auto' : 'smooth' });
  }
  requestFrame();
}

function takePrint(): void {
  if (!bath || !cloth) return;
  bath.takePrint();
  const px = bath.readPrint(64);
  recipe = measureRecipe(px);
  lot = lotNumber(px);
  fillTicket();
  cloth.reset();
  liftAt = now;
  setMode('lifting');
  bath.silk.alpha = 0;
  frameTarget = null;
}

function fillTicket(): void {
  if (!recipe) return;
  $('lot').textContent = lot.code;
  const list = $('recipe');
  list.innerHTML = '';
  const rows = PIGMENTS.map((p) => ({ p, v: recipe!.shares[p.key] }))
    .filter((r) => r.v > 0)
    .sort((a, b) => b.v - a.v);
  if (!rows.length) {
    const li = document.createElement('li');
    li.textContent = 'No ink reached the silk.';
    list.appendChild(li);
  }
  for (const { p, v } of rows) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="sw" style="--c:${p.hex}"></span><span>${p.name}</span><span class="lead-dots"></span><span class="pct">${v}%</span>`;
    list.appendChild(li);
  }
  $('bare').textContent = `${recipe.bare}% of the silk left bare`;
}

$('again').addEventListener('click', marbleAnother);
function marbleAnother(): void {
  if (!bath || !cloth) return;
  cloth.release();
  grabbing = null;
  setMode('bath');
  bath.backdrop = 0;
  bath.guide = 1;
  bath.silk = { lower: 0, front: 0, alpha: 0 };
  bath.clear();
  layAt = liftAt = -1;
  afterClear();
  applyLayout();
  const top = stage.getBoundingClientRect().top + window.scrollY;
  window.scrollTo({ top, behavior: reducedMotion ? 'auto' : 'smooth' });
}

$('bag').addEventListener('click', () => ($('notice') as HTMLDialogElement).showModal());

$('save').addEventListener('click', savePrint);
function savePrint(): void {
  if (!bath?.print) return;
  const size = 2048;
  const px = bath.renderExport(size);
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(px.buffer as ArrayBuffer), size, size), 0, 0);
  c.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `floatwork-lot-${lot.code}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }, 'image/png');
}

/** Pin positions during the lift, s from 0 to 1. */
function pinPath(j: number, s: number): Vec3 {
  const side = j === 0 ? -1 : 1;
  const e = smooth(s);
  const y = H_TOP * Math.pow(0.5 - 0.5 * Math.cos(Math.PI * clamp01(s)), 0.8);
  return [side * (0.5 - 0.14 * e), Math.max(0.0005, y), -0.5 + 0.5 * smoother(s)];
}

// ------------------------------------------------------------------ camera

const FOV = (30 * Math.PI) / 180;
let frameTarget: { cx: number; cy: number; w: number; h: number } | null = null;

function measureFrame(): { cx: number; cy: number; w: number; h: number } {
  const c = canvas.getBoundingClientRect();
  const f = scarfFrame.getBoundingClientRect();
  if (f.width < 10 || f.height < 10) return { cx: c.width / 2, cy: c.height / 2, w: c.width * 0.8, h: c.height * 0.7 };
  return { cx: f.left - c.left + f.width / 2, cy: f.top - c.top + f.height / 2, w: f.width, h: f.height };
}

function camera(k: number): { vp: Mat4; eye: Vec3 } {
  const g = geo!;
  const t = Math.tan(FOV / 2);
  const aspect = g.cw / g.ch;
  const sq = g.sq;
  const R0 = g.ch / (2 * sq.size * t);
  const s0x = ((sq.x + sq.size / 2) / g.cw) * 2 - 1;
  const s0y = 1 - ((sq.y + sq.size / 2) / g.ch) * 2;
  if (!frameTarget) frameTarget = measureFrame();
  const f = frameTarget;
  const hh = H_TOP + 0.16;
  const ww = 1.08;
  const R1 = Math.max((hh * g.ch) / (f.h * 2 * t * 0.94), (ww * g.ch) / (f.w * 2 * t * 0.94));
  const s1x = (f.cx / g.cw) * 2 - 1;
  const s1y = 1 - (f.cy / g.ch) * 2;
  const e = smoother(k);
  const th = (e * Math.PI) / 2;
  const target = lerp3([0, 0, 0], [0, H_TOP - hh / 2 + 0.04, 0], e);
  const R = R0 + (R1 - R0) * e;
  const eye: Vec3 = [target[0], target[1] + R * Math.cos(th), target[2] + R * Math.sin(th)];
  const up: Vec3 = [0, Math.sin(th), -Math.cos(th)];
  const proj = perspective(FOV, aspect, 0.05, 60, s0x + (s1x - s0x) * e, s0y + (s1y - s0y) * e);
  return { vp: mul(proj, lookAt(eye, target, up)), eye };
}

// ------------------------------------------------------------------ cloth grabbing

let grabbing: { id: number; plane: Vec3; normal: Vec3 } | null = null;
let lastCam: { vp: Mat4; eye: Vec3 } | null = null;

function screenOf(vp: Mat4, x: number, y: number, z: number): [number, number] {
  const [nx, ny] = project(vp, x, y, z);
  return [((nx + 1) / 2) * geo!.cw, ((1 - ny) / 2) * geo!.ch];
}

function rayHit(vp: Mat4, sx: number, sy: number, plane: Vec3, normal: Vec3): Vec3 | null {
  const inv = invert(vp);
  if (!inv) return null;
  const nx = (sx / geo!.cw) * 2 - 1, ny = 1 - (sy / geo!.ch) * 2;
  const a = unproject(inv, nx, ny, -1);
  const b = unproject(inv, nx, ny, 1);
  const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const den = d[0] * normal[0] + d[1] * normal[1] + d[2] * normal[2];
  if (Math.abs(den) < 1e-6) return null;
  const tt = ((plane[0] - a[0]) * normal[0] + (plane[1] - a[1]) * normal[1] + (plane[2] - a[2]) * normal[2]) / den;
  return [a[0] + d[0] * tt, a[1] + d[1] * tt, a[2] + d[2] * tt];
}

function pickParticle(sx: number, sy: number, maxPx: number): number {
  if (!cloth || !lastCam) return -1;
  let best = -1, bd = maxPx * maxPx;
  for (let i = 0; i < cloth.count; i++) {
    const [x, y] = screenOf(lastCam.vp, cloth.pos[i * 3], cloth.pos[i * 3 + 1], cloth.pos[i * 3 + 2]);
    const d = (x - sx) ** 2 + (y - sy) ** 2;
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

function startGrab(idx: number, sx: number, sy: number, id: number): void {
  if (!cloth || !lastCam) return;
  const p: Vec3 = [cloth.pos[idx * 3], cloth.pos[idx * 3 + 1], cloth.pos[idx * 3 + 2]];
  const e = lastCam.eye;
  const n: Vec3 = [e[0] - p[0], e[1] - p[1], e[2] - p[2]];
  const l = Math.hypot(...n);
  grabbing = { id, plane: p, normal: [n[0] / l, n[1] / l, n[2] / l] };
  cloth.grab = { idx, target: p };
  moveGrab(sx, sy);
}

function moveGrab(sx: number, sy: number): void {
  if (!grabbing || !cloth?.grab || !lastCam) return;
  const hit = rayHit(lastCam.vp, sx, sy, grabbing.plane, grabbing.normal);
  if (hit) cloth.grab.target = cloth.clampToReach(cloth.grab.idx, hit);
}

grabEl.addEventListener('pointerdown', (e) => {
  if (mode !== 'scarf' || !geo) return;
  const r = canvas.getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top;
  const idx = pickParticle(sx, sy, coarse ? 70 : 50);
  if (idx < 0) return;
  e.preventDefault();
  grabEl.setPointerCapture(e.pointerId);
  startGrab(idx, sx, sy, e.pointerId);
  requestFrame();
});
grabEl.addEventListener('pointermove', (e) => {
  if (!grabbing || grabbing.id !== e.pointerId) return;
  const r = canvas.getBoundingClientRect();
  moveGrab(e.clientX - r.left, e.clientY - r.top);
  requestFrame();
});
const endGrab = (e: PointerEvent) => {
  if (!grabbing || grabbing.id !== e.pointerId) return;
  grabbing = null;
  cloth?.release();
};
grabEl.addEventListener('pointerup', endGrab);
grabEl.addEventListener('pointercancel', endGrab);

let grabBox = '';
function placeGrabArea(): void {
  if (!cloth || !lastCam || !geo) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const n = cloth.n;
  for (let v = 0; v < n; v += 3)
    for (let u = 0; u < n; u += 3) {
      const i = v * n + u;
      const [x, y] = screenOf(lastCam.vp, cloth.pos[i * 3], cloth.pos[i * 3 + 1], cloth.pos[i * 3 + 2]);
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
  const m = 18;
  const box = `${Math.round(x0 - m)},${Math.round(y0 - m)},${Math.round(x1 - x0 + 2 * m)},${Math.round(y1 - y0 + 2 * m)}`;
  if (box === grabBox) return;
  grabBox = box;
  const [bx, by, bw, bh] = box.split(',').map(Number);
  const top = Math.max(0, by);
  Object.assign(grabEl.style, { left: `${Math.max(0, bx)}px`, top: `${top}px`, width: `${Math.min(bw, geo.cw)}px`, height: `${Math.min(bh, geo.ch - top)}px` });
}

// ------------------------------------------------------------------ attract mode

let cycleStart = 0;
let cycleIndex = 0;
let pattern: Pattern | null = null;
let lastScriptT = -1;
let tugIdx = -1;
let tugFrom: Vec3 = [0, 0, 0];

function beginCycle(): void {
  if (!bath || !cloth) return;
  cycleStart = now;
  pattern = makePattern(LOOPSEED ? LOOPKIND : cycleIndex, LOOPSEED ? Number(LOOPSEED) || 1 : 1);
  cycleIndex++;
  lastScriptT = -1;
  cloth.release();
  cloth.reset();
  setMode('bath');
  bath.clear();
  bath.backdrop = 0;
  bath.guide = 0;
  bath.silk = { lower: 0, front: 0, alpha: 0 };
  layAt = liftAt = fadeAt = -1;
  tugIdx = -1;
  frameTarget = null;
}

function attractStep(): void {
  if (!bath || !cloth || !geo || !pattern) return;
  const t = now - cycleStart;
  const prev = lastScriptT;
  lastScriptT = t;
  const sq = geo.sq;
  const toPx = (u: number, v: number): [number, number] => [sq.x + u * sq.size, sq.y + v * sq.size];
  for (const d of pattern.drops) {
    if (d.t > prev && d.t <= t) {
      const [x, y] = toPx(d.u, d.v);
      bath.drop(x, y, d.ink, d.r * sq.size, false);
    }
  }
  const ghostItems: Parameters<typeof drawGhost>[0] = [];
  for (const ps of pattern.passes) {
    if (t < ps.t0 || prev > ps.t1) continue;
    const s0 = clamp01((Math.max(prev, ps.t0) - ps.t0) / (ps.t1 - ps.t0));
    const s1 = clamp01((t - ps.t0) / (ps.t1 - ps.t0));
    const [ax, ay] = toPx(...ps.path(s0));
    const [bx, by] = toPx(...ps.path(s1));
    if (ps.tool === 'stylus') {
      bath.addStroke(stylusStroke(ax, ay, bx, by));
      ghostItems.push({ x: bx, y: by, kind: 'stylus' });
    } else {
      bath.addStroke(combStroke(ax, ay, bx, by, ps.spine!));
      ghostItems.push({ x: bx, y: by, kind: 'comb', spine: ps.spine });
    }
  }
  if (ghostItems.length) drawGhost(ghostItems);
  else clearGhost();

  if (mode === 'bath' && t >= CYCLE.lay && prev < CYCLE.lay) startLay(true);

  // one soft tug on the hanging scarf
  if (mode === 'lifting' || mode === 'scarf') {
    if (t >= CYCLE.tug && prev < CYCLE.tug) {
      const n = cloth.n;
      tugIdx = Math.round(0.86 * (n - 1)) * n + Math.round(0.72 * (n - 1));
      tugFrom = [cloth.pos[tugIdx * 3], cloth.pos[tugIdx * 3 + 1], cloth.pos[tugIdx * 3 + 2]];
      cloth.grab = { idx: tugIdx, target: tugFrom };
    }
    if (tugIdx >= 0 && cloth.grab && t < CYCLE.tugRelease) {
      const k = smooth((t - CYCLE.tug) / (CYCLE.tugRelease - CYCLE.tug));
      cloth.grab.target = cloth.clampToReach(tugIdx, [tugFrom[0] + 0.1 * k, tugFrom[1] + 0.05 * k, tugFrom[2] + 0.24 * k]);
    }
    if (t >= CYCLE.tugRelease && prev < CYCLE.tugRelease) cloth.release();
  }
  if (t >= CYCLE.fade && prev < CYCLE.fade) fadeAt = now;

  // captions
  const cap = (a: number, b: number) => clamp01(Math.min((t - a) / 0.35, (b - t) / 0.35));
  const o1 = cap(0, CYCLE.dropsTo + 0.2);
  const o2 = cap(CYCLE.toolsFrom - 0.05, CYCLE.toolsTo + 0.1);
  const o3 = cap(CYCLE.lay, CYCLE.lay + 1.25);
  const lines: [string, number][] = [
    ['Float some ink.', o1],
    [pattern.passes[0].tool === 'comb' ? 'Comb it through.' : 'Draw it out.', o2],
    ['Lay the silk.', o3],
  ];
  const best = lines.reduce((a, b) => (b[1] > a[1] ? b : a));
  if (hint.textContent !== best[0]) hint.textContent = best[0];
  hint.classList.remove('off', 'small');
  hint.style.opacity = String(best[1] * 0.92);

  if (t >= CYCLE.length) beginCycle();
}

function exitAttract(): void {
  if (!attract) return;
  attract = false;
  document.documentElement.classList.remove('attract');
  hint.style.opacity = '';
  clearGhost();
  if (mode !== 'bath') {
    marbleAnother();
  } else {
    if (bath) bath.guide = 1;
    dropsMade = bath?.hasInk ? 3 : 0;
    strokesMade = dropsMade ? 1 : 0;
    progressHints();
  }
  frameTarget = null;
  applyLayout();
}

if (attract && !CAPTURE) {
  const stop = (e: Event) => {
    if (e.type === 'keydown' && (e as KeyboardEvent).key === 'Tab') return;
    exitAttract();
    ['pointerdown', 'keydown', 'wheel'].forEach((t) => window.removeEventListener(t, stop, true));
  };
  ['pointerdown', 'keydown', 'wheel'].forEach((t) => window.addEventListener(t, stop, { capture: true, passive: true }));
}

// ------------------------------------------------------------------ the loop

let now = 0;
let raf = 0;
let running = false;
let visible = true;
let onScreen = true;
const perf = { cpu: [] as number[], interval: [] as number[], last: 0, mode: [] as string[] };

function simulate(dt: number): void {
  if (!bath || !cloth || !geo) return;
  now += dt;
  if (attract) attractStep();

  if (mode === 'bath') {
    feedPointers();
    if (!attract) {
      const items: Parameters<typeof drawGhost>[0] = [];
      ptrs.forEach((p) => {
        if (p.kind === 'stroke') items.push({ x: p.x, y: p.y, kind: 'stylus' });
        if (p.kind === 'comb') items.push({ x: p.x, y: p.y, kind: 'comb', spine: p.spine });
      });
      if (items.length) drawGhost(items);
      else if (ptrs.size) clearGhost();
    }
    if (skimFrom >= 0) {
      const k = (now - skimFrom) / 0.65;
      bath.skim = geo.domH * (1 - smooth(k)) + 4;
      if (k >= 1) {
        skimFrom = -1;
        bath.skim = -1;
        bath.clear(true);
        afterClear();
      }
    }
  }

  // velocity solve at a fixed rate, ink advected once per frame
  const steps = Math.min(3, Math.max(1, Math.round(dt / (1 / 60))));
  for (let i = 0; i < steps; i++) bath.step(dt / steps);

  if (mode === 'laying') {
    const d = durations();
    const t = now - layAt;
    bath.silk.alpha = smooth(t / 0.25);
    bath.silk.lower = smoother(t / d.lower);
    bath.silk.front = 1.15 * clamp01((t - d.transferFrom) / (d.transferTo - d.transferFrom));
    if (t >= d.transferTo + 0.08) takePrint();
  }
  if (mode === 'lifting' || mode === 'scarf') {
    const d = durations();
    const s = clamp01((now - liftAt) / d.lift);
    cloth.pinTargets = [pinPath(0, s), pinPath(1, s)];
    if (s >= 1 && cloth.floor) cloth.floor = false;
    bath.backdrop = smooth((s - 0.3) / 0.55);
    if (mode === 'lifting' && s >= 1) {
      setMode('scarf');
      requestFrame();
    }
    const sub = Math.min(3, Math.max(1, Math.round(dt / (1 / 60))));
    for (let i = 0; i < sub; i++) cloth.step(Math.min(dt / sub, 1 / 30));
  }
}

function render(): void {
  if (!bath || !gl || !geo || !cloth || !clothR) return;
  const g = geo;
  const fbW = canvas.width, fbH = canvas.height;
  let fade = 0;
  if (fadeAt >= 0) {
    fade = smooth((now - fadeAt) / (CYCLE.length - CYCLE.fade));
    if (bath.hasInk) bath.clear();
  }
  const keepBackdrop = bath.backdrop;
  if (fade > 0) bath.backdrop = keepBackdrop * (1 - fade);
  bath.render(g.cw, g.ch, g.dpr, fbW, fbH);
  bath.backdrop = keepBackdrop;
  if ((mode === 'lifting' || mode === 'scarf') && bath.printColor) {
    const d = durations();
    const s = clamp01((now - liftAt) / d.lift);
    const k = clamp01((s - 0.04) / 0.8);
    const cam = camera(k);
    lastCam = cam;
    clothR.upload(cloth);
    gl.viewport(0, 0, fbW, fbH);
    clothR.render({
      vp: cam.vp,
      eye: cam.eye,
      tex: bath.printColor.tex,
      alpha: 1 - fade,
      wet: 1 - smooth(s * 1.2),
      shadow: bath.backdrop * (1 - fade),
      props: smooth((s - 0.75) / 0.25) * (1 - fade),
      pins: cloth.pinTargets,
    });
    if (mode === 'scarf' && !attract) placeGrabArea();
  }
}

function frame(dtMs: number): void {
  const t0 = performance.now();
  const dt = Math.min(0.05, Math.max(0.001, dtMs / 1000));
  simulate(dt);
  render();
  const cpu = performance.now() - t0;
  perf.cpu.push(cpu);
  perf.mode.push(mode);
  if (perf.cpu.length > 600) {
    perf.cpu.shift();
    perf.mode.shift();
  }
}

function needsFrames(): boolean {
  if (!bath || !cloth) return false;
  if (attract) return true;
  if (mode !== 'bath') {
    if (mode === 'scarf' && !grabbing && !reducedMotion) return true; // the scarf sways in the air
    return mode !== 'scarf' || !!grabbing || cloth.energy() > 1e-9;
  }
  return bath.busy || ptrs.size > 0 || skimFrom >= 0 || layAt >= 0;
}

function tick(ts: number): void {
  raf = 0;
  if (!running) return;
  const dtMs = perf.last ? ts - perf.last : 16.7;
  if (perf.last) {
    perf.interval.push(dtMs);
    if (perf.interval.length > 600) perf.interval.shift();
  }
  perf.last = ts;
  frame(dtMs);
  if (needsFrames() && visible && onScreen) raf = requestAnimationFrame(tick);
  else perf.last = 0;
}

function requestFrame(): void {
  if (CAPTURE || !running || raf || !visible || !onScreen) return;
  raf = requestAnimationFrame(tick);
}

document.addEventListener('visibilitychange', () => {
  visible = document.visibilityState === 'visible';
  if (visible) requestFrame();
});
new IntersectionObserver((entries) => {
  onScreen = entries[0].isIntersecting;
  if (onScreen) requestFrame();
}).observe(stage);

canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  running = false;
  showFallback('The bath was interrupted.', 'The graphics card reset, so the ink was lost. Refill the bath to start again.', true);
});
canvas.addEventListener('webglcontextrestored', () => {
  restart();
});
$('fallbackRetry').addEventListener('click', () => {
  if (gl && !gl.isContextLost()) restart();
});

function restart(): void {
  geo = null;
  if (!initGL()) return;
  $('fallback').hidden = true;
  tray.style.visibility = '';
  setMode('bath');
  layAt = liftAt = -1;
  applyLayout();
  bath!.clear();
  afterClear();
  running = true;
  requestFrame();
}

// ------------------------------------------------------------------ boot

function boot(): void {
  if (!initGL()) {
    showFallback();
    return;
  }
  applyLayout();
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);
  running = true;
  if (attract) {
    beginCycle();
    if (!CAPTURE && reducedMotion) cloth!.wind = 0;
  } else afterClear();
  if (!CAPTURE) requestFrame();
}

boot();

// ------------------------------------------------------------------ hooks for tests and capture

declare global {
  interface Window {
    __floatwork: unknown;
    __step: (ms: number) => void;
  }
}

window.__step = (ms: number) => {
  frame(ms);
};

window.__floatwork = {
  state: () => ({
    mode,
    attract,
    hasInk: bath?.hasInk ?? false,
    drops: dropsMade,
    strokes: strokesMade,
    lot: lot.code,
    hash: lot.hash,
    recipe,
    canUndo: bath?.canUndo ?? false,
    sim: bath?.sizeInfo,
    cloth: cloth ? { n: cloth.n, energy: cloth.energy(), grabbed: !!cloth.grab } : null,
    webgl: !!bath,
  }),
  perf: () => ({ cpu: perf.cpu.slice(), interval: perf.interval.slice(), mode: perf.mode.slice() }),
  resetPerf: () => {
    perf.cpu.length = 0;
    perf.interval.length = 0;
    perf.mode.length = 0;
  },
  /** Plays the drops and tool passes of a scripted pattern in the live bath (used for screenshots). */
  playPattern: (k: number, until = CYCLE.toolsTo + 0.6, dtMs = 1000 / 60) => {
    if (!bath || !geo) return;
    const p = makePattern(k, 1);
    const saved = { attract, pattern, cycleStart, lastScriptT };
    attract = true;
    pattern = p;
    cycleStart = now;
    lastScriptT = -1;
    const stopAt = Math.min(until, CYCLE.lay - 0.1);
    while (now - cycleStart < stopAt) frame(dtMs);
    attract = saved.attract;
    pattern = saved.pattern;
    hint.style.opacity = '';
    clearGhost();
    dropsMade = 16;
    strokesMade = 1;
    progressHints();
    updateButtons();
  },
  lay: () => startLay(false),
  grabAt: (u: number, v: number, dx: number, dy: number, dz: number) => {
    if (!cloth) return;
    const n = cloth.n;
    const idx = Math.round(v * (n - 1)) * n + Math.round(u * (n - 1));
    const p: Vec3 = [cloth.pos[idx * 3], cloth.pos[idx * 3 + 1], cloth.pos[idx * 3 + 2]];
    cloth.grab = { idx, target: cloth.clampToReach(idx, [p[0] + dx, p[1] + dy, p[2] + dz]) };
  },
  release: () => cloth?.release(),
};
