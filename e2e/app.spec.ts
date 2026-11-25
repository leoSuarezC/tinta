import { expect, test } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { loadPdfForInk } from '../src/ink/pdfInk';
import { ensureEdit, inkPixels, line, openDemo, openRow, penStroke, remoteBytes, remoteFile, remoteText, syncNow } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */

test('crear una nota: listas que continúan, tareas, vista previa y nombre', async ({ page }) => {
  await openDemo(page);
  await page.getByRole('button', { name: 'Crear' }).click();
  await page.getByRole('button', { name: /^Nota Markdown/ }).click();
  const ta = page.getByRole('textbox', { name: 'Texto de la nota' });
  await expect(ta).toBeVisible();
  await ta.click();
  await page.keyboard.type('# Compras');
  await page.keyboard.press('Enter');
  await page.keyboard.type('- leche');
  await page.keyboard.press('Enter');
  await page.keyboard.type('pan');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Fin');
  await expect(ta).toHaveValue('# Compras\n- leche\n- pan\nFin');

  await page.getByRole('button', { name: 'Tarea', exact: true }).click();
  await expect(ta).toHaveValue('# Compras\n- leche\n- pan\n- [ ] Fin');

  await page.getByRole('button', { name: 'Ver nota' }).click();
  await expect(page.locator('.md h1')).toHaveText('Compras');
  await page.locator('.md input.task-box').click();
  await page.getByRole('button', { name: 'Editar nota' }).click();
  await expect(ta).toHaveValue('# Compras\n- leche\n- pan\n- [x] Fin');

  // Cambiar el nombre desde el título
  await page.locator('.title-btn').click();
  await page.getByRole('textbox', { name: 'Nombre' }).fill('Lista de compras');
  await page.keyboard.press('Enter');
  await expect(page.locator('.title-btn')).toHaveText('Lista de compras');

  await page.waitForTimeout(700);
  await syncNow(page);
  expect(await remoteText(page, 'Lista de compras.md')).toBe('# Compras\n- leche\n- pan\n- [x] Fin');
  await expect(page.locator('.file-status')).toHaveAttribute('aria-label', 'Guardado en Drive');
});

test('la búsqueda ignora tildes y muestra el fragmento', async ({ page }) => {
  await openDemo(page);
  await page.getByRole('searchbox', { name: 'Buscar' }).fill('cafe');
  await expect(page.locator('.row-snippet mark').first()).toHaveText('Café');
  await expect(page.locator('.row-name').first()).toHaveText('Mercado');
  await page.getByRole('searchbox', { name: 'Buscar' }).fill('zzz-nada');
  await expect(page.getByText('Sin resultados')).toBeVisible();
});

test('mover, destacar y eliminar desde el menú del archivo', async ({ page }) => {
  await openDemo(page);
  await page.getByRole('button', { name: 'Opciones de Bienvenida' }).click();
  await page.getByRole('button', { name: 'Mover a otra carpeta' }).click();
  await page.locator('.picker .row-main', { hasText: 'Proyectos' }).click();
  await page.getByRole('button', { name: 'Mover a «Proyectos»' }).click();
  await expect(page.getByText('Movido')).toBeVisible();
  await syncNow(page);
  const proyectos = await remoteFile(page, 'Proyectos');
  expect((await remoteFile(page, 'Bienvenida.md'))?.parents).toEqual([proyectos.id]);

  await openRow(page, 'Proyectos');
  await page.getByRole('button', { name: 'Opciones de Presupuesto.txt' }).click();
  await page.getByRole('button', { name: 'Destacar' }).click();
  await syncNow(page);
  expect((await remoteFile(page, 'Presupuesto.txt'))?.starred).toBe(true);

  await page.getByRole('button', { name: 'Opciones de Bienvenida' }).click();
  await page.getByRole('button', { name: 'Eliminar' }).click();
  await page.locator('.sheet-foot').getByRole('button', { name: 'Eliminar' }).click();
  await expect(page.getByText('se movió a la papelera de Drive')).toBeVisible();
  await syncNow(page);
  expect(await remoteFile(page, 'Bienvenida.md')).toBeNull();
});

test('nota a mano: escribir con lápiz, deshacer, borrar, agregar página y reabrir', async ({ page }) => {
  await openDemo(page);
  await page.getByRole('button', { name: 'Crear' }).click();
  await page.getByRole('button', { name: /^Nota a mano/ }).click();
  await page.getByRole('radio', { name: 'Cuadriculado' }).click();
  await page.getByLabel('Nombre (opcional)').fill('Ideas a mano');
  await page.getByRole('button', { name: 'Crear cuaderno' }).click();
  const pageSel = '.ink-page[data-page="0"]';
  await expect(page.locator(`${pageSel} canvas.bg`)).toBeVisible();
  await page.waitForTimeout(600);

  await penStroke(page, pageSel, line(40, 60, 260, 80));
  await penStroke(page, pageSel, line(40, 140, 260, 150));
  await penStroke(page, pageSel, line(40, 220, 260, 230));
  expect(await inkPixels(page)).toBeGreaterThan(100);

  await page.getByRole('button', { name: 'Deshacer' }).click();
  // Borrador con el botón lateral del lápiz sobre el segundo trazo
  await penStroke(page, pageSel, line(150, 120, 150, 170, 10), { buttons: 32 });
  await page.waitForTimeout(3200); // guardado automático
  await syncNow(page);

  let bytes = await remoteBytes(page, 'Ideas a mano.pdf');
  let loaded = await loadPdfForInk(bytes!);
  expect(loaded.template).toBe('cuadriculado');
  expect(loaded.pages[0]).toHaveLength(1);

  await page.getByRole('button', { name: 'Agregar página' }).click();
  await expect(page.locator('.ink-page[data-page="1"]')).toBeVisible();
  await penStroke(page, '.ink-page[data-page="1"]', line(40, 60, 200, 60));
  await page.waitForTimeout(3200);
  await syncNow(page);
  bytes = await remoteBytes(page, 'Ideas a mano.pdf');
  const doc = await PDFDocument.load(bytes!);
  expect(doc.getPageCount()).toBe(2);
  loaded = await loadPdfForInk(bytes!);
  expect(loaded.pages.map((p) => p.length)).toEqual([1, 1]);

  // Reabrir: los trazos siguen ahí y se pueden seguir editando
  await page.reload();
  await expect(page.locator(`${pageSel} canvas.bg`)).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(800);
  expect(await inkPixels(page)).toBeGreaterThan(100);
});

test('anotar y girar una imagen', async ({ page }) => {
  await openDemo(page);
  await openRow(page, 'Fotos');
  await openRow(page, 'Atardecer.png');
  await expect(page.locator('.image-stage img')).toBeVisible();
  const before = (await remoteFile(page, 'Atardecer.png')).md5Checksum;

  await page.getByRole('button', { name: /Anotar/ }).click();
  await expect(page.locator('.ink-page[data-page="0"] canvas.bg')).toBeVisible();
  await page.waitForTimeout(400);
  await penStroke(page, '.ink-page[data-page="0"]', line(30, 30, 220, 120));
  const one = await inkPixels(page);
  // Una sincronización en medio del dibujo no debe reiniciar el lienzo.
  await syncNow(page);
  await penStroke(page, '.ink-page[data-page="0"]', line(30, 200, 220, 160));
  expect(await inkPixels(page)).toBeGreaterThan(one * 1.5);
  await page.getByRole('button', { name: 'Listo' }).click();
  await expect(page.locator('.image-stage img')).toBeVisible();
  await syncNow(page);
  const after = await remoteFile(page, 'Atardecer.png');
  expect(after.md5Checksum).not.toBe(before);

  await page.getByRole('button', { name: 'Girar a la derecha' }).click();
  await page.waitForTimeout(800);
  await syncNow(page);
  const dims = await page.evaluate(async () => {
    const t = (window as any).__tinta;
    const f = t.fake.findByName('Atardecer.png');
    const bmp = await createImageBitmap(await t.fake.download(f.id));
    return [bmp.width, bmp.height];
  });
  expect(dims).toEqual([640, 960]);
});

test('grabar una nota de voz', async ({ page }) => {
  await openDemo(page);
  await page.getByRole('button', { name: 'Crear' }).click();
  await page.getByRole('button', { name: /^Audio/ }).click();
  await page.getByRole('button', { name: 'Empezar a grabar' }).click();
  await expect(page.getByRole('button', { name: 'Detener y guardar' })).toBeVisible();
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'Detener y guardar' }).click();
  await expect(page.locator('.row-name', { hasText: /^Nota de voz / })).toBeVisible();
  await syncNow(page);
  const files = await page.evaluate(() => (window as any).__tinta.fake.allFiles().filter((f: any) => f.name.startsWith('Nota de voz')));
  expect(files).toHaveLength(1);
  expect(Number(files[0].size)).toBeGreaterThan(500);
  expect(files[0].mimeType).toMatch(/^audio\//);
});

test('audio dentro de una nota: se guarda en _adjuntos y se enlaza', async ({ page }) => {
  await openDemo(page);
  await openRow(page, 'Bienvenida');
  await ensureEdit(page);
  const ta = page.getByRole('textbox', { name: 'Texto de la nota' });
  await ta.click();
  await page.keyboard.press('Control+End');
  await page.getByRole('button', { name: 'Grabar audio' }).click();
  await page.getByRole('button', { name: 'Empezar a grabar' }).click();
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'Detener y guardar' }).click();
  await expect(ta).toHaveValue(/\[🎙️ Audio .+\]\(_adjuntos\/audio-\d{8}-\d{6}\.(webm|ogg|m4a)\)/);
  await page.getByRole('button', { name: 'Ver nota' }).click();
  await expect(page.locator('.md .audio-embed audio')).toBeVisible();
  await page.waitForTimeout(600);
  await syncNow(page);
  const folder = await remoteFile(page, '_adjuntos');
  expect(folder?.mimeType).toBe('application/vnd.google-apps.folder');
});

test('lo compartido desde otra app (Android) se guarda en Drive', async ({ page }) => {
  await openDemo(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect(page.locator('.explorer')).toBeVisible();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const redirected = await page.evaluate(async () => {
    const fd = new FormData();
    fd.append('title', 'Receta de arepas');
    fd.append('text', 'Harina, agua y sal');
    fd.append('files', new File(['%PDF-1.4 prueba'], 'menu.pdf', { type: 'application/pdf' }));
    const r = await fetch('./compartir', { method: 'POST', body: fd });
    return r.redirected && r.url.includes('compartido=1');
  });
  expect(redirected).toBe(true);
  await page.goto('./?compartido=1');
  await expect(page.getByRole('dialog', { name: 'Guardar lo compartido' })).toBeVisible();
  await expect(page.getByText('menu.pdf')).toBeVisible();
  await page.getByRole('button', { name: 'Guardar en «Mis notas (demo)»' }).click();
  await page.waitForFunction(() => !!(window as any).__tinta);
  await syncNow(page);
  expect(await remoteFile(page, 'menu.pdf')).not.toBeNull();
  expect(await remoteText(page, 'Receta de arepas.md')).toBe('# Receta de arepas\n\nHarina, agua y sal\n');
});

test('un cambio hecho en otro dispositivo llega a la nota abierta', async ({ page }) => {
  await openDemo(page);
  await openRow(page, 'Mercado');
  await ensureEdit(page);
  await page.evaluate(async () => {
    const t = (window as any).__tinta;
    const f = t.fake.findByName('Mercado.md');
    await t.fake.update(f.id, {}, new Blob(['# Mercado del domingo\n- [ ] Mangos\n'], { type: 'text/markdown' }));
    await t.engine.sync();
  });
  await expect(page.getByRole('textbox', { name: 'Texto de la nota' })).toHaveValue('# Mercado del domingo\n- [ ] Mangos\n');
});

test('ediciones simultáneas en la misma línea dejan una copia de conflicto', async ({ page }) => {
  await openDemo(page);
  await openRow(page, 'Mercado');
  await ensureEdit(page);
  const ta = page.getByRole('textbox', { name: 'Texto de la nota' });
  await page.evaluate(() => (window as any).__tinta.fake.simulateOffline(40));
  await ta.click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('End');
  await page.keyboard.type(' (local)');
  await page.waitForTimeout(700);
  await page.evaluate(async () => {
    const t = (window as any).__tinta;
    t.fake.failures = [];
    const f = t.fake.findByName('Mercado.md');
    const text = await t.fake.readText(f.id);
    await t.fake.update(f.id, {}, new Blob([text.replace('# Mercado del sábado', '# Mercado del sábado (remoto)')]));
  });
  await syncNow(page);
  expect(await remoteText(page, 'Mercado.md')).toContain('# Mercado del sábado (remoto)');
  const copies = await page.evaluate(() => (window as any).__tinta.fake.allFiles().filter((f: any) => f.name.startsWith('Mercado (conflicto')));
  expect(copies).toHaveLength(1);
});

test('sin conexión los cambios esperan y se suben al volver', async ({ page }) => {
  await openDemo(page);
  await page.evaluate(() => (window as any).__tinta.fake.simulateOffline(200));
  await openRow(page, 'Bienvenida');
  await ensureEdit(page);
  await page.getByRole('textbox', { name: 'Texto de la nota' }).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\nEscrito sin conexión');
  await page.waitForTimeout(700);
  await page.evaluate(() => (window as any).__tinta.engine.sync());
  await expect(page.locator('.file-status')).toHaveAttribute('aria-label', /se sube a Drive en cuanto se pueda/);
  await page.evaluate(() => ((window as any).__tinta.fake.failures = []));
  await syncNow(page);
  expect(await remoteText(page, 'Bienvenida.md')).toContain('Escrito sin conexión');
  await expect(page.locator('.file-status')).toHaveAttribute('aria-label', 'Guardado en Drive');
});

test('el botón Atrás cierra hojas y vuelve de la nota a la carpeta', async ({ page, isMobile }) => {
  await openDemo(page);
  await page.getByRole('button', { name: 'Crear' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('dialog')).toBeHidden();
  await openRow(page, 'Proyectos');
  await openRow(page, 'Presupuesto.txt');
  await expect(page.getByRole('textbox', { name: 'Texto de la nota' })).toBeVisible();
  await page.goBack();
  if (isMobile) await expect(page.getByRole('textbox', { name: 'Texto de la nota' })).toBeHidden();
  await expect(page.locator('.folder-title')).toHaveText('Proyectos');
  await page.goBack();
  await expect(page.locator('.folder-title')).toHaveText('Mis notas (demo)');
});

test('modo e-ink: blanco y negro y botones para pasar página', async ({ page }) => {
  await openDemo(page);
  await page.getByRole('button', { name: 'Ajustes' }).click();
  await page.getByRole('switch', { name: /Modo e-ink/ }).check();
  await page.getByRole('button', { name: 'Cerrar' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-eink', '1');
  await expect(page.getByRole('button', { name: 'Página siguiente' })).toBeVisible();
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe('rgb(255, 255, 255)');
});

test('las carpetas muestran tarjetas con vista previa y al tocarlas se abre el editor', async ({ page }) => {
  await openDemo(page);
  const card = (name: RegExp) => page.locator('.card', { has: page.locator('.card-name', { hasText: name }) }).first();

  // Nota: se ven sus primeras líneas, con las tareas como casillas.
  const mercado = card(/^Mercado$/);
  await expect(mercado.locator('.card-text')).toContainText('Mercado del sábado');
  await expect(mercado.locator('.card-text')).toContainText('☐ Café de Santander');
  await expect(mercado.locator('.card-text')).toContainText('☑ Aguacates');
  // Las carpetas siguen como filas.
  await expect(page.locator('.rows .row-name', { hasText: /^A mano$/ })).toBeVisible();
  // La nota se ve completa (sin corte) y las tarjetas del mosaico no se enciman.
  await expect(mercado.locator('.card-text')).toContainText('Panela');
  await expect(mercado.locator('.card-text.is-cut')).toHaveCount(0);
  const boxes = await page.locator('.cards.is-mosaic').last().locator(':scope > .card').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()));
  expect(boxes.length).toBeGreaterThan(1);
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const overlap = a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
      expect(overlap, `tarjetas ${i} y ${j} encimadas`).toBe(false);
    }

  // Cuaderno a mano: la tarjeta muestra la página CON los trazos (son anotaciones del PDF) sin abrirlo antes.
  await openRow(page, 'A mano');
  const cuaderno = card(/^Cuaderno de ejemplo/);
  const img = cuaderno.locator('img.card-img.is-page');
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(100);
  // Píxeles de color fuerte (tinta azul o roja), que la plantilla rayada no tiene.
  const inked = await img.evaluate((el: HTMLImageElement) => {
    const c = document.createElement('canvas');
    c.width = el.naturalWidth;
    c.height = el.naturalHeight;
    const g = c.getContext('2d')!;
    g.drawImage(el, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]) > 90) n++;
    return n;
  });
  expect(inked).toBeGreaterThan(200);
  // La página completa: se dibuja con su proporción, sin recortar.
  const ratio = await img.evaluate((el: HTMLImageElement) => ({ shown: el.clientHeight / el.clientWidth, real: el.naturalHeight / el.naturalWidth }));
  expect(Math.abs(ratio.shown - ratio.real)).toBeLessThan(0.02);
  // Al tocar la tarjeta se abre el editor de tinta.
  await cuaderno.locator('.card-main').click();
  await expect(page.locator('.ink-page').first()).toBeVisible();
});
