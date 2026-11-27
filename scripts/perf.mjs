// Measures frame times at 390 x 844 with 4x CPU throttling, from the built dist/:
// the bath while a finger keeps stirring it, and the hanging cloth while it sways and is pulled.
// Usage: npm run perf
import { serve } from './serve.mjs';
import { launch, BASE } from './browser.mjs';

const server = await serve();
const browser = await launch();

function quantile(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN;
}

function report(label, d) {
  const med = quantile(d.interval, 0.5);
  console.log(label + ': ' + d.interval.length + ' frames');
  console.log('  frame interval: median ' + med.toFixed(1) + ' ms, p95 ' + quantile(d.interval, 0.95).toFixed(1) + ' ms (about ' + (1000 / med).toFixed(0) + ' fps)');
  console.log('  main thread per frame: median ' + quantile(d.cpu, 0.5).toFixed(2) + ' ms, p95 ' + quantile(d.cpu, 0.95).toFixed(2) + ' ms');
}

async function touch(cdp, type, x, y, id) {
  const touchPoints = type === 'touchEnd' ? [] : [{ x, y, id }];
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
}

try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  const info = await page.evaluate(() => {
    const c = document.createElement('canvas').getContext('webgl2');
    const d = c.getExtension('WEBGL_debug_renderer_info');
    const s = window.__floatwork.state();
    return { gpu: d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown', sim: s.sim, cloth: s.cloth.n };
  });
  console.log('GPU: ' + info.gpu);
  console.log('Simulation: ' + JSON.stringify(info.sim) + ', cloth grid ' + info.cloth + ' x ' + info.cloth);

  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  console.log('CPU throttling: 4x');

  const box = await page.locator('#gl').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + 360;
  for (let i = 0; i < 8; i++) {
    await page.touchscreen.tap(cx + Math.cos(i) * 80, cy + Math.sin(i * 1.7) * 80);
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(800);

  // stir for five seconds with real touch events
  await page.evaluate(() => window.__floatwork.resetPerf());
  await touch(cdp, 'touchStart', cx, cy, 1);
  const t0 = Date.now();
  let a = 0;
  while (Date.now() - t0 < 5000) {
    a += 0.12;
    await touch(cdp, 'touchMove', cx + Math.cos(a) * 110, cy + Math.sin(a * 1.3) * 140, 1);
    await page.waitForTimeout(16);
  }
  await touch(cdp, 'touchEnd', 0, 0, 1);
  report('Bath, stirred by a finger', await page.evaluate(() => window.__floatwork.perf()));

  // lay the silk, then the cloth on its own and while pulled
  await page.tap('#lay');
  await page.waitForFunction(() => window.__floatwork.state().mode === 'scarf', null, { timeout: 30000 });
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__floatwork.resetPerf());
  await page.waitForTimeout(4000);
  report('Cloth, hanging in the wind', await page.evaluate(() => window.__floatwork.perf()));

  const g = await page.locator('#grab').boundingBox();
  await page.evaluate(() => window.__floatwork.resetPerf());
  await touch(cdp, 'touchStart', g.x + g.width * 0.6, g.y + g.height * 0.7, 2);
  const t1 = Date.now();
  while (Date.now() - t1 < 3000) {
    const k = (Date.now() - t1) / 3000;
    await touch(cdp, 'touchMove', g.x + g.width * (0.6 + 0.2 * Math.sin(k * 9)), g.y + g.height * (0.7 - 0.1 * k), 2);
    await page.waitForTimeout(16);
  }
  await touch(cdp, 'touchEnd', 0, 0, 2);
  report('Cloth, pulled by a finger', await page.evaluate(() => window.__floatwork.perf()));
  await ctx.close();
} finally {
  await browser.close();
  server.close();
}
