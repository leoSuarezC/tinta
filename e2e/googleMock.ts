import type { Page, Route } from '@playwright/test';
import { FakeDrive } from '../src/drive/FakeDrive';
import { DriveError, FOLDER_MIME } from '../src/drive/types';

/**
 * Simula los servidores de Google para las pruebas: la pantalla de OAuth (redirige de vuelta
 * con un token en el fragmento) y la API REST de Drive v3, respaldada por un FakeDrive.
 * Así se prueba el camino real de la app (fetch, cabeceras, multipart, feed de cambios).
 */
export class GoogleMock {
  drive = new FakeDrive();
  token = '';
  tokens = 0;
  authRequests: URL[] = [];
  calls: { method: string; path: string; query: Record<string, string>; body?: string }[] = [];
  fail401 = 0;
  denyNextAuth = false;

  private cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
    'Access-Control-Expose-Headers': 'Location',
  };

  async install(page: Page, clientId: string) {
    await page.route('**/config.json', (r) => r.fulfill({ json: { googleClientId: clientId } }));
    await page.route('https://accounts.google.com/**', (r) => this.auth(r));
    await page.route('https://oauth2.googleapis.com/**', (r) => r.fulfill({ status: 200, headers: this.cors, body: '' }));
    await page.route('https://www.googleapis.com/**', (r) => this.api(r));
  }

  private async auth(route: Route) {
    const url = new URL(route.request().url());
    this.authRequests.push(url);
    const redirect = url.searchParams.get('redirect_uri')!;
    const state = url.searchParams.get('state')!;
    let frag: URLSearchParams;
    if (this.denyNextAuth) {
      this.denyNextAuth = false;
      frag = new URLSearchParams({ error: url.searchParams.get('prompt') === 'none' ? 'interaction_required' : 'access_denied', state });
    } else {
      this.token = `tok-${++this.tokens}`;
      frag = new URLSearchParams({ access_token: this.token, token_type: 'Bearer', expires_in: '3599', scope: url.searchParams.get('scope')!, state });
    }
    await route.fulfill({ status: 302, headers: { Location: `${redirect}#${frag.toString()}` } });
  }

  private json(route: Route, status: number, body: unknown) {
    return route.fulfill({ status, headers: { ...this.cors, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  private async api(route: Route) {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: this.cors });
    const url = new URL(req.url());
    const query = Object.fromEntries(url.searchParams.entries());
    const raw = req.postDataBuffer() ?? undefined;
    this.calls.push({ method: req.method(), path: url.pathname, query, body: raw && raw.length < 20000 ? raw.toString('utf8') : undefined });

    if (this.fail401 > 0 || req.headers()['authorization'] !== `Bearer ${this.token}`) {
      if (this.fail401 > 0) this.fail401--;
      return this.json(route, 401, { error: { code: 401, message: 'Invalid Credentials', errors: [{ reason: 'authError' }] } });
    }
    const d = this.drive;
    const path = url.pathname;
    const method = req.method();
    try {
      if (path === '/drive/v3/about') return this.json(route, 200, { user: await d.about() });
      if (path === '/drive/v3/changes/startPageToken') return this.json(route, 200, { startPageToken: await d.getStartPageToken() });
      if (path === '/drive/v3/changes') {
        const r = await d.listChanges(query.pageToken);
        return this.json(route, 200, { ...r, changes: r.changes.map((c) => ({ ...c, changeType: 'file' })) });
      }
      if (path === '/drive/v3/files' && method === 'GET') {
        const q = query.q ?? '';
        const contains = /name contains '((?:[^'\\]|\\.)*)'/.exec(q);
        if (contains) return this.json(route, 200, { files: await d.searchFolders(contains[1].replace(/\\(.)/g, '$1')) });
        const parents = [...q.matchAll(/'([^']+)' in parents/g)].map((m) => m[1]);
        const r = await d.listChildren(parents, query.pageToken, q.includes(`mimeType = '${FOLDER_MIME}'`));
        return this.json(route, 200, r);
      }
      if (path === '/drive/v3/files' && method === 'POST') {
        return this.json(route, 200, await d.create(JSON.parse(raw!.toString('utf8'))));
      }
      const fileMatch = /^\/drive\/v3\/files\/([^/]+)$/.exec(path);
      if (fileMatch) {
        const id = decodeURIComponent(fileMatch[1]);
        if (method === 'GET' && query.alt === 'media') {
          const blob = await d.download(id);
          return route.fulfill({ status: 200, headers: { ...this.cors, 'Content-Type': blob.type || 'application/octet-stream' }, body: Buffer.from(await blob.arrayBuffer()) });
        }
        if (method === 'GET') return this.json(route, 200, await d.getFile(id));
        if (method === 'PATCH') {
          const meta = raw?.length ? JSON.parse(raw.toString('utf8')) : {};
          return this.json(route, 200, await d.update(id, { ...meta, ...parentsPatch(query) }));
        }
      }
      if (path === '/upload/drive/v3/files' && method === 'POST' && query.uploadType === 'multipart') {
        const { meta, media, type } = parseMultipart(raw!, req.headers()['content-type']);
        return this.json(route, 200, await d.create(meta, new Blob([new Uint8Array(media)], { type })));
      }
      const upMatch = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(path);
      if (upMatch && method === 'PATCH' && query.uploadType === 'multipart') {
        const { meta, media, type } = parseMultipart(raw!, req.headers()['content-type']);
        return this.json(route, 200, await d.update(decodeURIComponent(upMatch[1]), { ...meta, ...parentsPatch(query) }, new Blob([new Uint8Array(media)], { type })));
      }
      return this.json(route, 400, { error: { message: `Mock: ruta no soportada ${method} ${path}` } });
    } catch (e) {
      if (e instanceof DriveError) return this.json(route, e.status, { error: { message: e.message, errors: [{ reason: e.reason }] } });
      return this.json(route, 500, { error: { message: String(e) } });
    }
  }
}

function parentsPatch(q: Record<string, string>) {
  return {
    ...(q.addParents ? { addParents: q.addParents.split(',') } : {}),
    ...(q.removeParents ? { removeParents: q.removeParents.split(',') } : {}),
  };
}

function parseMultipart(buf: Buffer, contentType: string) {
  const boundary = /boundary=([^;]+)/.exec(contentType)?.[1];
  if (!boundary) throw new Error('Sin boundary');
  const delim = Buffer.from(`--${boundary}`);
  const parts: { headers: string; body: Buffer }[] = [];
  let idx = buf.indexOf(delim);
  while (idx !== -1) {
    const start = idx + delim.length;
    if (buf.subarray(start, start + 2).toString() === '--') break;
    const next = buf.indexOf(delim, start);
    if (next === -1) break;
    const part = buf.subarray(start + 2, next - 2);
    const sep = part.indexOf('\r\n\r\n');
    parts.push({ headers: part.subarray(0, sep).toString(), body: part.subarray(sep + 4) });
    idx = next;
  }
  const meta = JSON.parse(parts[0].body.toString('utf8'));
  const type = /Content-Type:\s*([^\r\n]+)/i.exec(parts[1].headers)?.[1] ?? 'application/octet-stream';
  return { meta, media: parts[1].body, type };
}
