import { expect, type Page } from '@playwright/test';

/* eslint-disable @typescript-eslint/no-explicit-any */
type W = any;

export async function openDemo(page: Page, settings?: Record<string, unknown>) {
  await page.addInitScript((s) => {
    localStorage.setItem('tinta.mode', 'demo');
    if (s && !localStorage.getItem('tinta.settings')) localStorage.setItem('tinta.settings', JSON.stringify(s));
  }, settings ?? null);
  await page.goto('./');
  await expect(page.locator('.explorer')).toBeVisible({ timeout: 20_000 });
  await page.waitForFunction(() => !!(window as W).__tinta);
}

export async function syncNow(page: Page) {
  await page.evaluate(async () => {
    const t = (window as W).__tinta;
    await t.engine.sync();
    await t.engine.sync();
  });
}

export async function remoteFile(page: Page, name: string) {
  return page.evaluate((n) => (window as W).__tinta.fake.findByName(n) ?? null, name);
}

export async function remoteText(page: Page, name: string): Promise<string | null> {
  return page.evaluate(async (n) => {
    const t = (window as W).__tinta;
    const f = t.fake.findByName(n);
    return f ? await t.fake.readText(f.id) : null;
  }, name);
}

export async function remoteBytes(page: Page, name: string): Promise<Uint8Array | null> {
  const b64 = await page.evaluate(async (n) => {
    const t = (window as W).__tinta;
    const f = t.fake.findByName(n);
    if (!f) return null;
    const blob: Blob = await t.fake.download(f.id);
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, name);
  return b64 ? new Uint8Array(Buffer.from(b64, 'base64')) : null;
}

/** Trazo con lápiz (pointerType "pen" y presión), en coordenadas relativas al elemento. */
export async function penStroke(page: Page, selector: string, points: [number, number, number?][], opts: { buttons?: number; id?: number } = {}) {
  await page.evaluate(
    ({ selector, points, opts }) => {
      const el = document.querySelector(selector)!;
      const r = el.getBoundingClientRect();
      const fire = (type: string, [x, y, p]: [number, number, number?]) =>
        el.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerType: 'pen',
            pointerId: opts.id ?? 11,
            isPrimary: true,
            pressure: p ?? 0.5,
            buttons: type === 'pointerup' ? 0 : (opts.buttons ?? 1),
            clientX: r.left + x,
            clientY: r.top + y,
          }),
        );
      fire('pointerdown', points[0]);
      for (const pt of points.slice(1)) fire('pointermove', pt);
      fire('pointerup', points[points.length - 1]);
    },
    { selector, points, opts },
  );
}

export const line = (x0: number, y0: number, x1: number, y1: number, n = 24): [number, number, number][] =>
  Array.from({ length: n }, (_, i) => [x0 + ((x1 - x0) * i) / (n - 1), y0 + ((y1 - y0) * i) / (n - 1), 0.3 + 0.4 * Math.sin((i / (n - 1)) * Math.PI)]);

/** Abre un elemento de la lista por su nombre visible. */
export async function openRow(page: Page, name: string) {
  await page.locator('.row-main, .card-main', { has: page.locator('.row-name', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) }).first().click();
}

export async function ensureEdit(page: Page) {
  await expect(page.locator('.note-text, .md, .preview-empty').first()).toBeVisible();
  const edit = page.getByRole('button', { name: 'Editar nota' });
  if (await edit.isVisible()) await edit.click();
  await expect(page.getByRole('textbox', { name: 'Texto de la nota' })).toBeVisible();
}

export async function inkPixels(page: Page, pageIndex = 0): Promise<number> {
  return page.evaluate((i) => {
    const c = document.querySelector<HTMLCanvasElement>(`.ink-page[data-page="${i}"] canvas.ink`);
    if (!c || !c.width) return 0;
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let k = 3; k < d.length; k += 4) if (d[k] > 0) n++;
    return n;
  }, pageIndex);
}
