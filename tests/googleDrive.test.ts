import { describe, expect, it, vi } from 'vitest';
import { GoogleDrive, type TokenSource } from '../src/drive/GoogleDrive';
import { AuthRequiredError, DriveError, OfflineError } from '../src/drive/types';

function tokens(): TokenSource & { invalidated: number } {
  return {
    invalidated: 0,
    async getToken() {
      return 'tok123';
    },
    invalidate() {
      this.invalidated++;
    },
  };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

describe('GoogleDrive (HTTP)', () => {
  it('lista hijos de varias carpetas con la consulta correcta y el token', async () => {
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => json({ files: [{ id: 'a', name: 'x.md', mimeType: 'text/markdown' }] }));
    const d = new GoogleDrive(tokens(), fetchFn as unknown as typeof fetch);
    const r = await d.listChildren(['p1', 'p2'], undefined, false);
    expect(r.files).toHaveLength(1);
    const [url, init] = fetchFn.mock.calls[0];
    const u = new URL(String(url));
    expect(u.origin + u.pathname).toBe('https://www.googleapis.com/drive/v3/files');
    expect(u.searchParams.get('q')).toBe("('p1' in parents or 'p2' in parents) and trashed = false");
    expect(u.searchParams.get('pageSize')).toBe('1000');
    expect(u.searchParams.get('supportsAllDrives')).toBe('true');
    expect(new Headers(init!.headers).get('Authorization')).toBe('Bearer tok123');
  });

  it('crea con subida multipart (metadatos + contenido)', async () => {
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => json({ id: 'new', name: 'n.md', mimeType: 'text/markdown' }));
    const d = new GoogleDrive(tokens(), fetchFn as unknown as typeof fetch);
    await d.create({ name: 'n.md', mimeType: 'text/markdown', parents: ['root1'] }, new Blob(['¡hola!'], { type: 'text/markdown' }));
    const [url, init] = fetchFn.mock.calls[0];
    expect(String(url)).toContain('https://www.googleapis.com/upload/drive/v3/files?');
    expect(String(url)).toContain('uploadType=multipart');
    expect(init!.method).toBe('POST');
    const ct = new Headers(init!.headers).get('Content-Type')!;
    expect(ct).toMatch(/^multipart\/related; boundary=/);
    const boundary = ct.split('boundary=')[1];
    const body = await (init!.body as Blob).text();
    expect(body).toContain(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{"name":"n.md","mimeType":"text/markdown","parents":["root1"]}`);
    expect(body).toContain('Content-Type: text/markdown\r\n\r\n¡hola!\r\n');
    expect(body.endsWith(`--${boundary}--`)).toBe(true);
  });

  it('mover usa addParents/removeParents en la URL y PATCH', async () => {
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => json({ id: 'f', name: 'b', mimeType: 'text/plain' }));
    const d = new GoogleDrive(tokens(), fetchFn as unknown as typeof fetch);
    await d.update('f', { name: 'b', addParents: ['n'], removeParents: ['o'] });
    const [url, init] = fetchFn.mock.calls[0];
    const u = new URL(String(url));
    expect(u.pathname).toBe('/drive/v3/files/f');
    expect(u.searchParams.get('addParents')).toBe('n');
    expect(u.searchParams.get('removeParents')).toBe('o');
    expect(init!.method).toBe('PATCH');
    expect(JSON.parse(init!.body as string)).toEqual({ name: 'b' });
  });

  it('archivos grandes usan subida reanudable', async () => {
    const fetchFn = vi
      .fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(new Response(null, { status: 200, headers: { Location: 'https://upload.example/session1' } }))
      .mockResolvedValueOnce(json({ id: 'big', name: 'audio.webm', mimeType: 'audio/webm' }));
    const d = new GoogleDrive(tokens(), fetchFn as unknown as typeof fetch);
    const big = new Blob([new Uint8Array(6 * 1024 * 1024)], { type: 'audio/webm' });
    const r = await d.create({ name: 'audio.webm', mimeType: 'audio/webm', parents: ['p'] }, big);
    expect(r.id).toBe('big');
    expect(String(fetchFn.mock.calls[0][0])).toContain('uploadType=resumable');
    expect(new Headers(fetchFn.mock.calls[0][1]!.headers).get('X-Upload-Content-Length')).toBe(String(big.size));
    expect(fetchFn.mock.calls[1][0]).toBe('https://upload.example/session1');
    expect(fetchFn.mock.calls[1][1]!.method).toBe('PUT');
  });

  it('reintenta 429/500 y límites de cuota', async () => {
    const fetchFn = vi
      .fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(json({ error: { message: 'busy' } }, 503))
      .mockResolvedValueOnce(json({ error: { errors: [{ reason: 'userRateLimitExceeded' }], message: 'slow down' } }, 403))
      .mockResolvedValueOnce(json({ user: { emailAddress: 'a@b.c' } }));
    const d = new GoogleDrive(tokens(), fetchFn as unknown as typeof fetch, 5, 1);
    expect(await d.about()).toEqual({ emailAddress: 'a@b.c' });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('401 invalida el token y pide iniciar sesión', async () => {
    const t = tokens();
    const d = new GoogleDrive(t, (async () => json({ error: { message: 'Invalid Credentials' } }, 401)) as typeof fetch);
    await expect(d.about()).rejects.toBeInstanceOf(AuthRequiredError);
    expect(t.invalidated).toBe(1);
  });

  it('errores de red se reportan como sin conexión', async () => {
    const d = new GoogleDrive(tokens(), (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch, 5, 1);
    await expect(d.getStartPageToken()).rejects.toBeInstanceOf(OfflineError);
  });

  it('otros errores llevan estado y motivo', async () => {
    const d = new GoogleDrive(tokens(), (async () =>
      json({ error: { errors: [{ reason: 'storageQuotaExceeded' }], message: 'The user has exceeded their Drive storage quota' } }, 403)) as typeof fetch);
    const err = await d.update('x', { name: 'y' }).catch((e) => e);
    expect(err).toBeInstanceOf(DriveError);
    expect(err).toMatchObject({ status: 403, reason: 'storageQuotaExceeded' });
  });

  it('el feed de cambios ignora cambios de unidades compartidas', async () => {
    const d = new GoogleDrive(tokens(), (async () =>
      json({ newStartPageToken: '9', changes: [{ changeType: 'drive', fileId: 'd' }, { changeType: 'file', fileId: 'f', removed: true }] })) as typeof fetch);
    const r = await d.listChanges('1');
    expect(r.changes.map((c) => c.fileId)).toEqual(['f']);
    expect(r.newStartPageToken).toBe('9');
  });
});
