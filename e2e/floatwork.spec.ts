import { expect, Page, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

interface State {
  mode: string;
  attract: boolean;
  hasInk: boolean;
  drops: number;
  strokes: number;
  lot: string;
  hash: number;
  recipe: { shares: Record<string, number>; bare: number; total: number } | null;
  canUndo: boolean;
  webgl: boolean;
  cloth: { grabbed: boolean; energy: number } | null;
}

type Pt = { x: number; y: number };

const state = (page: Page) => page.evaluate(() => (window as unknown as { __floatwork: { state(): State } }).__floatwork.state());

/** Collects console errors and failed requests; each test fails if any appear. */
function watch(page: Page) {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push('console: ' + m.text());
  });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('requestfailed', (r) => problems.push('request failed: ' + r.url()));
  page.on('response', (r) => {
    if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.url()}`);
  });
  return problems;
}

/** A point inside the silk square, in page coordinates (u, v from 0 to 1). */
async function bathPoint(page: Page, u: number, v: number): Promise<Pt> {
  const box = (await page.locator('#gl').boundingBox())!;
  const tray = (await page.locator('#tray').boundingBox())!;
  const header = (await page.locator('#top').boundingBox())!;
  const top = header.y + header.height;
  const bottom = tray.y;
  const size = Math.min(box.width - 40, bottom - top - 40);
  const x0 = box.x + (box.width - size) / 2;
  const y0 = top + (bottom - top - size) / 2;
  return { x: x0 + u * size, y: y0 + v * size };
}

// Each emulated touch sequence gets its own id: reusing an id across CDP sequences makes
// Chromium drop the click of the next tap, which is an emulation quirk, not app behaviour.
let nextTouchId = 1000;

async function touchDrag(page: Page, pts: Pt[], check?: () => Promise<void>) {
  const id = nextTouchId++;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pts[0].x, y: pts[0].y, id }] });
  for (const p of pts.slice(1)) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: p.x, y: p.y, id }] });
    await page.waitForTimeout(16);
  }
  if (check) await check();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

async function mouseDrag(page: Page, pts: Pt[], check?: () => Promise<void>) {
  await page.mouse.move(pts[0].x, pts[0].y);
  await page.mouse.down();
  for (const p of pts.slice(1)) {
    await page.mouse.move(p.x, p.y);
    await page.waitForTimeout(16);
  }
  if (check) await check();
  await page.mouse.up();
}

function line(a: Pt, b: Pt, n = 24): Pt[] {
  return Array.from({ length: n + 1 }, (_, i) => ({ x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n }));
}

test('marble a scarf: float ink, pull it, lay the silk, take the tag', async ({ page }, info) => {
  const touch = info.project.name === 'phone';
  const problems = watch(page);
  await page.goto('./');
  await expect.poll(async () => (await state(page)).webgl).toBe(true);
  expect((await state(page)).hasInk).toBe(false);
  await expect(page.locator('#lay')).toBeDisabled();
  await expect(page.locator('#hint')).toHaveText('Float some ink.');

  const tap = (p: Pt) => (touch ? page.touchscreen.tap(p.x, p.y) : page.mouse.click(p.x, p.y));
  const pick = (sel: string) => (touch ? page.tap(sel) : page.click(sel));
  const drag = (pts: Pt[], check?: () => Promise<void>) => (touch ? touchDrag(page, pts, check) : mouseDrag(page, pts, check));

  // float three inks
  const inks = ['[data-ink="0"]', '[data-ink="1"]', '[data-ink="2"]'];
  const spots = [[0.5, 0.5], [0.35, 0.4], [0.62, 0.58], [0.5, 0.45], [0.42, 0.62], [0.58, 0.36]];
  for (let i = 0; i < spots.length; i++) {
    await pick(inks[i % 3]);
    await tap(await bathPoint(page, spots[i][0], spots[i][1]));
    await page.waitForTimeout(120);
  }
  await expect.poll(async () => (await state(page)).drops).toBeGreaterThanOrEqual(6);
  expect((await state(page)).hasInk).toBe(true);
  await expect(page.locator('#lay')).toBeEnabled();

  // drag a stroke through the drops with the default tool, then comb across
  const scrollBefore = await page.evaluate(() => window.scrollY);
  await drag(line(await bathPoint(page, 0.2, 0.3), await bathPoint(page, 0.8, 0.7)));
  await expect.poll(async () => (await state(page)).strokes).toBe(1);
  await pick('[data-tool="comb"]');
  await drag(line(await bathPoint(page, 0.5, 0.05), await bathPoint(page, 0.5, 0.95)));
  await expect.poll(async () => (await state(page)).strokes).toBe(2);
  // dragging on the bath must never scroll the page
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
  expect((await state(page)).canUndo).toBe(true);

  // lay the silk and wait for the scarf to hang
  await pick('#lay');
  await expect.poll(async () => (await state(page)).mode, { timeout: 20_000 }).toBe('scarf');
  const s = await state(page);
  expect(s.lot).toMatch(/^[0-9BCDFGHJKMNP-TV-XZ]{3}-[0-9BCDFGHJKMNP-TV-XZ]{3}$/);
  expect(s.hash).not.toBe(0);
  expect(s.recipe).not.toBeNull();
  // the pattern is non-trivial: several inks reached the silk and not all of it is bare
  const used = Object.values(s.recipe!.shares).filter((v) => v > 0).length;
  expect(used).toBeGreaterThanOrEqual(2);
  expect(s.recipe!.bare).toBeLessThan(97);
  expect(Object.values(s.recipe!.shares).reduce((x, y) => x + y, 0)).toBe(100);
  await expect(page.locator('#ticket')).toBeVisible();
  await expect(page.locator('#lot')).toHaveText(s.lot);

  // pull the scarf and let it go
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
  const g = (await page.locator('#grab').boundingBox())!;
  expect(g.width).toBeGreaterThan(50);
  const from = { x: g.x + g.width * 0.6, y: g.y + g.height * 0.75 };
  const to = { x: from.x + 60, y: from.y - 30 };
  const grabbed = async () => expect((await state(page)).cloth!.grabbed).toBe(true);
  if (touch) await touchDrag(page, line(from, to, 10), grabbed);
  else await mouseDrag(page, line(from, to, 10), grabbed);
  await expect.poll(async () => (await state(page)).cloth!.grabbed).toBe(false);

  // the demo notice
  await pick('#bag');
  await expect(page.locator('#notice')).toBeVisible();
  await expect(page.locator('#notice')).toContainText('Demo. Nothing is charged or sent.');
  await pick('#notice button');
  await expect(page.locator('#notice')).toBeHidden();

  // save the print: a 2048 x 2048 PNG
  const [download] = await Promise.all([page.waitForEvent('download'), pick('#save')]);
  expect(download.suggestedFilename()).toBe(`floatwork-lot-${s.lot}.png`);
  const png = readFileSync((await download.path())!);
  expect(png.subarray(1, 4).toString()).toBe('PNG');
  expect(png.readUInt32BE(16)).toBe(2048);
  expect(png.readUInt32BE(20)).toBe(2048);

  // marble another returns to a fresh bath
  await pick('#again');
  await expect.poll(async () => (await state(page)).mode).toBe('bath');
  expect((await state(page)).hasInk).toBe(false);

  expect(problems).toEqual([]);
});

test('the same pattern gives the same lot number', async ({ page }) => {
  const problems = watch(page);
  const lotFor = async () => {
    await page.goto('./?capture=1');
    await expect.poll(async () => (await state(page)).webgl).toBe(true);
    return page.evaluate(() => {
      const w = window as unknown as { __floatwork: { playPattern(k: number): void; lay(): void; state(): State }; __step(ms: number): void };
      w.__step(16.7);
      w.__floatwork.playPattern(2);
      for (let i = 0; i < 60; i++) w.__step(16.7);
      w.__floatwork.lay();
      for (let i = 0; i < 300; i++) w.__step(16.7);
      return w.__floatwork.state().lot;
    });
  };
  const first = await lotFor();
  const second = await lotFor();
  expect(first).toMatch(/^[0-9A-Z]{3}-[0-9A-Z]{3}$/);
  expect(second).toBe(first);
  expect(problems).toEqual([]);
});

test('attract mode plays by itself and hands over on touch', async ({ page }, info) => {
  const problems = watch(page);
  await page.goto('./?attract=1');
  await expect.poll(async () => (await state(page)).attract).toBe(true);
  await expect(page.locator('#tray')).toBeHidden();
  await expect.poll(async () => (await state(page)).hasInk, { timeout: 10_000 }).toBe(true);
  await expect.poll(async () => (await state(page)).mode, { timeout: 15_000 }).not.toBe('bath');
  const box = (await page.locator('#gl').boundingBox())!;
  if (info.project.name === 'phone') await page.touchscreen.tap(box.x + 40, box.y + 200);
  else await page.mouse.click(box.x + 40, box.y + 200);
  await expect.poll(async () => (await state(page)).attract).toBe(false);
  await expect(page.locator('#tray')).toBeVisible();
  expect(problems).toEqual([]);
});

test('without WebGL2 the bath shows a designed fallback', async ({ page }) => {
  const problems = watch(page);
  await page.addInitScript(() => {
    const orig = HTMLCanvasElement.prototype.getContext;
    // @ts-expect-error test override
    HTMLCanvasElement.prototype.getContext = function (type: string, ...rest: unknown[]) {
      if (type === 'webgl2') return null;
      // @ts-expect-error test override
      return orig.call(this, type, ...rest);
    };
  });
  await page.goto('./');
  await expect(page.locator('#fallback')).toBeVisible();
  await expect(page.locator('#fallbackTitle')).toHaveText('This bath needs WebGL2.');
  const art = await page.locator('#fallbackArt').evaluate((c: HTMLCanvasElement) => c.width);
  expect(art).toBe(300);
  await expect(page.locator('#fallbackRetry')).toBeHidden();
  await expect(page.locator('#how')).toBeAttached();
  expect(problems).toEqual([]);
});

test('a lost WebGL context is handled and the bath can be refilled', async ({ page }) => {
  await page.goto('./');
  await expect.poll(async () => (await state(page)).webgl).toBe(true);
  await page.evaluate(() => {
    const gl = (document.getElementById('gl') as HTMLCanvasElement).getContext('webgl2')!;
    (window as unknown as { __lose: WEBGL_lose_context }).__lose = gl.getExtension('WEBGL_lose_context')!;
    (window as unknown as { __lose: WEBGL_lose_context }).__lose.loseContext();
  });
  await expect(page.locator('#fallback')).toBeVisible();
  await expect(page.locator('#fallbackTitle')).toHaveText('The bath was interrupted.');
  await page.evaluate(() => (window as unknown as { __lose: WEBGL_lose_context }).__lose.restoreContext());
  await expect(page.locator('#fallback')).toBeHidden();
  await expect(page.locator('#tray')).toBeVisible();
});
