import { expect, test } from '@playwright/test';
import { GoogleMock } from './googleMock';
import { ensureEdit, openRow } from './helpers';

test.use({ serviceWorkers: 'block' });

const CLIENT = 'test-client.apps.googleusercontent.com';

async function seed(g: GoogleMock) {
  const notes = await g.drive.ensurePath(['🖋Notes']);
  await g.drive.create({ name: 'Diario.md', mimeType: 'text/markdown', parents: [notes] }, new Blob(['# Diario\nHoy empecé con Tinta.\n']));
  const audio = await g.drive.ensurePath(['🎙️ NotesAudio'], notes);
  await g.drive.create({ name: 'llamada.m4a', mimeType: 'audio/mp4', parents: [audio] }, new Blob([new Uint8Array(256)], { type: 'audio/mp4' }));
  await g.drive.create({ name: 'Plan.gdoc', mimeType: 'application/vnd.google-apps.document', parents: [notes] });
  await g.drive.ensurePath(['Trabajo']);
  return notes;
}

test('Google Drive: conectar, elegir carpeta, editar, crear y recibir cambios', async ({ page }) => {
  const g = new GoogleMock();
  const notes = await seed(g);
  await g.install(page, CLIENT);

  await page.goto('./');
  await page.getByRole('button', { name: 'Conectar Google Drive' }).click();
  await expect(page.getByRole('heading', { name: 'Elige la carpeta de tus notas' })).toBeVisible();

  const auth = g.authRequests[0];
  expect(auth.origin + auth.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
  expect(auth.searchParams.get('client_id')).toBe(CLIENT);
  expect(auth.searchParams.get('response_type')).toBe('token');
  expect(auth.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive');
  expect(auth.searchParams.get('redirect_uri')).toBe('http://localhost:4174/');
  expect(auth.searchParams.get('prompt')).toBe('select_account');

  // Elegir la carpeta (también se puede buscar por nombre)
  await page.getByRole('searchbox', { name: 'Buscar carpeta' }).fill('Notes');
  await page.locator('.picker .row-main', { hasText: '🖋Notes' }).click();
  await page.getByRole('button', { name: 'Usar «🖋Notes»' }).click();
  await expect(page.locator('.folder-title')).toHaveText('🖋Notes');
  await expect(page.locator('.row-name', { hasText: /^Diario$/ })).toBeVisible();
  await expect(page.locator('.row-name', { hasText: '🎙️ NotesAudio' })).toBeVisible();
  await expect(page.locator('.row-name', { hasText: 'Plan.gdoc' })).toBeVisible();
  await expect(page.locator('.row-name', { hasText: 'Trabajo' })).toHaveCount(0);

  // Editar una nota → se sube con PATCH multipart
  await openRow(page, 'Diario');
  await ensureEdit(page);
  await page.getByRole('textbox', { name: 'Texto de la nota' }).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('Escrito desde el Fold.');
  const diario = g.drive.findByName('Diario.md')!;
  await expect.poll(() => g.drive.readText(diario.id), { timeout: 15_000 }).toBe('# Diario\nHoy empecé con Tinta.\nEscrito desde el Fold.');
  const upload = g.calls.find((c) => c.method === 'PATCH' && c.path === `/upload/drive/v3/files/${diario.id}`);
  expect(upload?.query.uploadType).toBe('multipart');

  // Crear una nota nueva → POST multipart con la carpeta correcta
  await page.goBack();
  await page.getByRole('button', { name: 'Crear' }).click();
  await page.getByRole('button', { name: /^Nota Markdown/ }).click();
  await page.getByRole('textbox', { name: 'Texto de la nota' }).fill('Idea nueva');
  await expect.poll(() => g.drive.allFiles().filter((f) => f.name.startsWith('Nota ') && f.parents?.[0] === notes).length, { timeout: 15_000 }).toBe(1);
  const created = g.drive.allFiles().find((f) => f.name.startsWith('Nota '))!;
  await expect.poll(() => g.drive.readText(created.id), { timeout: 15_000 }).toBe('Idea nueva');

  // Un cambio hecho en otro dispositivo aparece al sincronizar
  await page.goBack();
  await g.drive.create({ name: 'Desde el Boox.md', mimeType: 'text/markdown', parents: [notes] }, new Blob(['hola']));
  await page.getByRole('button', { name: /Todo guardado|cambios por subir|Sincronizando/ }).click();
  await page.getByRole('button', { name: 'Sincronizar ahora' }).click();
  await page.getByRole('button', { name: 'Cerrar' }).click();
  await expect(page.locator('.row-name', { hasText: 'Desde el Boox' })).toBeVisible();
});

test('Google Drive: la sesión vencida se renueva sola y un 401 pide token nuevo', async ({ page }) => {
  const g = new GoogleMock();
  await seed(g);
  await g.install(page, CLIENT);
  await page.goto('./');
  await page.getByRole('button', { name: 'Conectar Google Drive' }).click();
  await page.locator('.picker .row-main', { hasText: '🖋Notes' }).click();
  await page.getByRole('button', { name: 'Usar «🖋Notes»' }).click();
  await expect(page.locator('.row-name', { hasText: /^Diario$/ })).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('tinta.loginHint'))).toBe('"demo@tinta.local"');

  // Token vencido al abrir la app: redirección silenciosa (prompt=none) con login_hint.
  await page.evaluate(() => {
    const t = JSON.parse(localStorage.getItem('tinta.token')!);
    t.expiresAt = Date.now() - 1000;
    localStorage.setItem('tinta.token', JSON.stringify(t));
  });
  const before = g.authRequests.length;
  await page.reload();
  await expect(page.locator('.row-name', { hasText: /^Diario$/ })).toBeVisible();
  expect(g.authRequests.length).toBe(before + 1);
  const silent = g.authRequests.at(-1)!;
  expect(silent.searchParams.get('prompt')).toBe('none');
  expect(silent.searchParams.get('login_hint')).toBe('demo@tinta.local');

  // Google rechaza el token (401) a mitad de uso → renovación silenciosa y la edición se sube.
  await openRow(page, 'Diario');
  await ensureEdit(page);
  g.fail401 = 1;
  const authBefore = g.authRequests.length;
  await page.getByRole('textbox', { name: 'Texto de la nota' }).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('Tras renovar la sesión.');
  await expect.poll(() => g.authRequests.length, { timeout: 20_000 }).toBeGreaterThan(authBefore);
  const diario = g.drive.findByName('Diario.md')!;
  await expect.poll(() => g.drive.readText(diario.id), { timeout: 20_000 }).toContain('Tras renovar la sesión.');
});

test('Google Drive: si Google pide volver a entrar, se muestra el botón para reconectar', async ({ page }) => {
  const g = new GoogleMock();
  await seed(g);
  await g.install(page, CLIENT);
  await page.goto('./');
  await page.getByRole('button', { name: 'Conectar Google Drive' }).click();
  await page.locator('.picker .row-main', { hasText: '🖋Notes' }).click();
  await page.getByRole('button', { name: 'Usar «🖋Notes»' }).click();
  await expect(page.locator('.row-name', { hasText: /^Diario$/ })).toBeVisible();

  await page.evaluate(() => {
    const t = JSON.parse(localStorage.getItem('tinta.token')!);
    t.expiresAt = Date.now() - 1000;
    localStorage.setItem('tinta.token', JSON.stringify(t));
  });
  g.denyNextAuth = true;
  await page.reload();
  // El intento silencioso falla: la app abre con lo guardado y ofrece reconectar (sin bucles).
  await expect(page.locator('.row-name', { hasText: /^Diario$/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reconectar', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reconectar', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Reconectar', exact: true })).toBeHidden();
  await expect(page.locator('.row-name', { hasText: /^Diario$/ })).toBeVisible();
  expect(g.authRequests.at(-1)!.searchParams.get('prompt')).toBeNull();
});
