import {
  AuthRequiredError,
  DriveError,
  FOLDER_MIME,
  OfflineError,
  REMOTE_FIELDS,
  type ChangesPage,
  type DriveApi,
  type DriveUser,
  type FilePatch,
  type NewFileMeta,
  type RemoteFile,
} from './types';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const MULTIPART_LIMIT = 5 * 1024 * 1024;

export interface TokenSource {
  /** Devuelve un token válido o lanza AuthRequiredError. */
  getToken(): Promise<string>;
  /** Avisado cuando Google rechaza el token (401). */
  invalidate(): void;
}

type FetchFn = typeof fetch;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.set(k, String(v));
  return u.toString();
}

/** Cliente HTTP de Google Drive v3 (sin dependencias, con reintentos). */
export class GoogleDrive implements DriveApi {
  private fetchFn: FetchFn;

  constructor(
    private tokens: TokenSource,
    fetchFn?: FetchFn,
    private maxRetries = 5,
    private baseDelayMs = 800,
  ) {
    this.fetchFn = fetchFn ?? ((...a) => fetch(...a));
  }

  private async request(url: string, init: RequestInit = {}, attempt = 0): Promise<Response> {
    const token = await this.tokens.getToken();
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    let res: Response;
    try {
      res = await this.fetchFn(url, { ...init, headers });
    } catch (e) {
      // Error de red: sin conexión o DNS/TLS fallido.
      if (attempt < 2 && (typeof navigator === 'undefined' || navigator.onLine !== false)) {
        await sleep(this.baseDelayMs * (attempt + 1));
        return this.request(url, init, attempt + 1);
      }
      throw new OfflineError((e as Error)?.message || 'Sin conexión');
    }
    if (res.ok) return res;

    let reason: string | undefined;
    let message = `Drive respondió ${res.status}`;
    try {
      const body = await res.clone().json();
      reason = body?.error?.errors?.[0]?.reason ?? body?.error?.status;
      message = body?.error?.message ?? message;
    } catch {
      /* cuerpo no JSON */
    }

    if (res.status === 401) {
      this.tokens.invalidate();
      throw new AuthRequiredError();
    }
    const retriable =
      res.status === 429 ||
      res.status >= 500 ||
      (res.status === 403 && (reason === 'userRateLimitExceeded' || reason === 'rateLimitExceeded'));
    if (retriable && attempt < this.maxRetries) {
      const delay = this.baseDelayMs * 2 ** attempt + Math.random() * this.baseDelayMs;
      await sleep(delay);
      return this.request(url, init, attempt + 1);
    }
    throw new DriveError(message, res.status, reason);
  }

  private async json<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await this.request(url, init);
    return (await res.json()) as T;
  }

  async about(): Promise<DriveUser> {
    const r = await this.json<{ user: DriveUser }>(`${API}/about?${qs({ fields: 'user(displayName,emailAddress,photoLink)' })}`);
    return r.user;
  }

  getFile(id: string): Promise<RemoteFile> {
    return this.json<RemoteFile>(`${API}/files/${encodeURIComponent(id)}?${qs({ fields: REMOTE_FIELDS, supportsAllDrives: true })}`);
  }

  async listChildren(parentIds: string[], pageToken?: string, foldersOnly = false) {
    const parents = parentIds.map((id) => `'${id.replace(/['\\]/g, '\\$&')}' in parents`).join(' or ');
    let q = `(${parents}) and trashed = false`;
    if (foldersOnly) q += ` and mimeType = '${FOLDER_MIME}'`;
    const url = `${API}/files?${qs({
      q,
      fields: `nextPageToken,files(${REMOTE_FIELDS})`,
      pageSize: 1000,
      pageToken,
      spaces: 'drive',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      orderBy: foldersOnly ? 'name' : undefined,
    })}`;
    const r = await this.json<{ files?: RemoteFile[]; nextPageToken?: string }>(url);
    return { files: r.files ?? [], nextPageToken: r.nextPageToken };
  }

  async download(id: string): Promise<Blob> {
    const res = await this.request(`${API}/files/${encodeURIComponent(id)}?${qs({ alt: 'media', supportsAllDrives: true })}`);
    return res.blob();
  }

  async create(meta: NewFileMeta, content?: Blob): Promise<RemoteFile> {
    const params = { fields: REMOTE_FIELDS, supportsAllDrives: true };
    if (!content) {
      return this.json<RemoteFile>(`${API}/files?${qs(params)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify(meta),
      });
    }
    if (content.size > MULTIPART_LIMIT) {
      return this.resumable('POST', `${UPLOAD}/files?${qs({ ...params, uploadType: 'resumable' })}`, meta, content, meta.mimeType);
    }
    return this.multipart('POST', `${UPLOAD}/files?${qs({ ...params, uploadType: 'multipart' })}`, meta, content, meta.mimeType);
  }

  async update(id: string, patch: FilePatch, content?: Blob): Promise<RemoteFile> {
    const { addParents, removeParents, ...metaPatch } = patch;
    const params = {
      fields: REMOTE_FIELDS,
      supportsAllDrives: true,
      addParents: addParents?.length ? addParents.join(',') : undefined,
      removeParents: removeParents?.length ? removeParents.join(',') : undefined,
    };
    const path = `files/${encodeURIComponent(id)}`;
    if (!content) {
      return this.json<RemoteFile>(`${API}/${path}?${qs(params)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify(metaPatch),
      });
    }
    const type = content.type || 'application/octet-stream';
    if (content.size > MULTIPART_LIMIT) {
      return this.resumable('PATCH', `${UPLOAD}/${path}?${qs({ ...params, uploadType: 'resumable' })}`, metaPatch, content, type);
    }
    return this.multipart('PATCH', `${UPLOAD}/${path}?${qs({ ...params, uploadType: 'multipart' })}`, metaPatch, content, type);
  }

  private multipart(method: string, url: string, meta: object, content: Blob, mimeType: string) {
    const boundary = `tinta-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
      `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
      content,
      `\r\n--${boundary}--`,
    ]);
    return this.json<RemoteFile>(url, {
      method,
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
  }

  private async resumable(method: string, url: string, meta: object, content: Blob, mimeType: string) {
    const start = await this.request(url, {
      method,
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType,
        'X-Upload-Content-Length': String(content.size),
      },
      body: JSON.stringify(meta),
    });
    const location = start.headers.get('Location') ?? start.headers.get('location');
    if (!location) {
      // Si el navegador no expone la cabecera, se cae a multipart.
      return this.multipart(method, url.replace('uploadType=resumable', 'uploadType=multipart'), meta, content, mimeType);
    }
    return this.json<RemoteFile>(location, { method: 'PUT', headers: { 'Content-Type': mimeType }, body: content });
  }

  async searchFolders(text: string): Promise<RemoteFile[]> {
    const t = text.replace(/['\\]/g, '\\$&');
    const url = `${API}/files?${qs({
      q: `mimeType = '${FOLDER_MIME}' and trashed = false and name contains '${t}'`,
      fields: `files(${REMOTE_FIELDS})`,
      pageSize: 50,
      spaces: 'drive',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    })}`;
    const r = await this.json<{ files?: RemoteFile[] }>(url);
    return r.files ?? [];
  }

  async getStartPageToken(): Promise<string> {
    const r = await this.json<{ startPageToken: string }>(`${API}/changes/startPageToken?${qs({ supportsAllDrives: true })}`);
    return r.startPageToken;
  }

  async listChanges(pageToken: string): Promise<ChangesPage> {
    const url = `${API}/changes?${qs({
      pageToken,
      pageSize: 1000,
      includeRemoved: true,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      spaces: 'drive',
      fields: `nextPageToken,newStartPageToken,changes(changeType,fileId,removed,time,file(${REMOTE_FIELDS}))`,
    })}`;
    type RawChange = ChangesPage['changes'][number] & { changeType?: string };
    const r = await this.json<{ changes?: RawChange[]; nextPageToken?: string; newStartPageToken?: string }>(url);
    return {
      changes: (r.changes ?? []).filter((c) => !c.changeType || c.changeType === 'file'),
      nextPageToken: r.nextPageToken,
      newStartPageToken: r.newStartPageToken,
    };
  }
}
