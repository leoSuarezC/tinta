import {
  DriveError,
  FOLDER_MIME,
  OfflineError,
  type ChangesPage,
  type DriveApi,
  type DriveUser,
  type FilePatch,
  type NewFileMeta,
  type RemoteChange,
  type RemoteFile,
} from './types';

/** Hash de contenido estable (no es MD5 real, pero cumple el mismo papel: igualdad de contenido). */
export function contentHash(bytes: Uint8Array): string {
  let h1 = 0x811c9dc5 ^ bytes.length;
  let h2 = 0x01000193 ^ (bytes.length * 31);
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    h1 = Math.imul(h1 ^ b, 0x01000193);
    h2 = Math.imul(h2 ^ b, 0x5bd1e995);
    h2 ^= h2 >>> 15;
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

interface Entry {
  file: RemoteFile;
  content?: Blob;
}

export interface FakeDriveState {
  seq: number;
  clock: number;
  entries: Entry[];
  log: string[];
}

/**
 * Drive simulado en memoria con la semántica que usa la app: carpetas, padres, versión,
 * hash de contenido, papelera y feed de cambios. Se usa en pruebas y en el modo demo.
 */
export class FakeDrive implements DriveApi {
  readonly myDriveId = 'my-drive';
  private files = new Map<string, Entry>();
  private log: string[] = [];
  private seq = 0;
  private clock = Date.now() - 3 * 86_400_000;
  /** Errores a lanzar en las próximas llamadas (para pruebas). */
  failures: Error[] = [];
  /** Se llama tras cada mutación (el modo demo lo usa para persistir). */
  onMutate?: () => void;
  callCount = 0;
  /** Latencia simulada por llamada (el modo demo la usa para que se note la sincronización). */
  latencyMs = 0;
  user: DriveUser = { displayName: 'Modo demo', emailAddress: 'demo@tinta.local' };

  constructor(state?: FakeDriveState) {
    if (state) {
      this.seq = state.seq;
      this.clock = state.clock;
      this.log = [...state.log];
      for (const e of state.entries) this.files.set(e.file.id, { file: { ...e.file }, content: e.content });
    } else {
      this.files.set(this.myDriveId, {
        file: { id: this.myDriveId, name: 'Mi unidad', mimeType: FOLDER_MIME, parents: [], version: '1', trashed: false, starred: false },
      });
    }
  }

  snapshot(): FakeDriveState {
    return { seq: this.seq, clock: this.clock, log: [...this.log], entries: [...this.files.values()].map((e) => ({ file: { ...e.file }, content: e.content })) };
  }

  private resolve(id: string) {
    return id === 'root' ? this.myDriveId : id;
  }

  private async gate() {
    this.callCount++;
    if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs));
    const f = this.failures.shift();
    if (f) throw f;
  }

  private now() {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  private touch(id: string) {
    this.log.push(id);
    this.onMutate?.();
  }

  private entry(id: string): Entry {
    const e = this.files.get(this.resolve(id));
    if (!e) throw new DriveError(`File not found: ${id}`, 404, 'notFound');
    return e;
  }

  private copy(f: RemoteFile): RemoteFile {
    return JSON.parse(JSON.stringify(f));
  }

  private isTrashedDeep(f: RemoteFile): boolean {
    let cur: RemoteFile | undefined = f;
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      if (cur.trashed) return true;
      seen.add(cur.id);
      const p: string | undefined = cur.parents?.[0];
      const next: Entry | undefined = p ? this.files.get(p) : undefined;
      cur = next?.file;
    }
    return false;
  }

  private exposed(f: RemoteFile): RemoteFile {
    const c = this.copy(f);
    c.trashed = this.isTrashedDeep(f);
    return c;
  }

  async about() {
    await this.gate();
    return { ...this.user };
  }

  async getFile(id: string) {
    await this.gate();
    return this.exposed(this.entry(id).file);
  }

  async listChildren(parentIds: string[], pageToken?: string, foldersOnly = false) {
    await this.gate();
    const ids = new Set(parentIds.map((p) => this.resolve(p)));
    let all = [...this.files.values()]
      .map((e) => e.file)
      .filter((f) => f.parents?.some((p) => ids.has(p)) && !f.trashed && (!foldersOnly || f.mimeType === FOLDER_MIME));
    all.sort((a, b) => a.name.localeCompare(b.name));
    const start = pageToken ? Number(pageToken) : 0;
    const pageSize = 50;
    all = all.slice(start, start + pageSize + 1);
    const more = all.length > pageSize;
    return { files: all.slice(0, pageSize).map((f) => this.copy(f)), nextPageToken: more ? String(start + pageSize) : undefined };
  }

  async download(id: string) {
    await this.gate();
    const e = this.entry(id);
    if (e.file.mimeType === FOLDER_MIME || e.file.mimeType.startsWith('application/vnd.google-apps.')) {
      throw new DriveError('Only files with binary content can be downloaded', 403, 'fileNotDownloadable');
    }
    return e.content ?? new Blob([]);
  }

  async create(meta: NewFileMeta, content?: Blob) {
    await this.gate();
    const parents = meta.parents.map((p) => this.resolve(p));
    for (const p of parents) this.entry(p);
    const id = `f${++this.seq}`;
    const file: RemoteFile = {
      id,
      name: meta.name,
      mimeType: meta.mimeType,
      parents,
      modifiedTime: this.now(),
      version: '1',
      trashed: false,
      starred: false,
      webViewLink: `https://drive.google.com/file/d/${id}/view`,
      capabilities: { canEdit: true, canRename: true, canTrash: true },
    };
    if (meta.mimeType !== FOLDER_MIME) {
      const blob = content ?? new Blob([]);
      file.size = String(blob.size);
      file.md5Checksum = contentHash(new Uint8Array(await blob.arrayBuffer()));
      this.files.set(id, { file, content: blob });
    } else {
      this.files.set(id, { file });
    }
    this.touch(id);
    return this.copy(file);
  }

  async update(id: string, patch: FilePatch, content?: Blob) {
    await this.gate();
    const e = this.entry(id);
    const f = e.file;
    if (f.capabilities?.canEdit === false && (content || patch.name)) {
      throw new DriveError('The user does not have sufficient permissions for this file.', 403, 'insufficientFilePermissions');
    }
    if (patch.name !== undefined) f.name = patch.name;
    if (patch.trashed !== undefined) f.trashed = patch.trashed;
    if (patch.starred !== undefined) f.starred = patch.starred;
    if (patch.addParents || patch.removeParents) {
      const rem = new Set((patch.removeParents ?? []).map((p) => this.resolve(p)));
      const add = (patch.addParents ?? []).map((p) => this.resolve(p));
      for (const p of add) this.entry(p);
      f.parents = [...(f.parents ?? []).filter((p) => !rem.has(p)), ...add.filter((p) => !(f.parents ?? []).includes(p))];
    }
    if (content) {
      e.content = content;
      f.size = String(content.size);
      f.md5Checksum = contentHash(new Uint8Array(await content.arrayBuffer()));
      f.modifiedTime = this.now();
    }
    f.version = String(Number(f.version ?? '1') + 1);
    this.touch(f.id);
    // Las carpetas en la papelera arrastran a sus descendientes en el feed de cambios.
    if (patch.trashed !== undefined && f.mimeType === FOLDER_MIME) {
      for (const d of this.descendants(f.id)) this.touch(d);
    }
    return this.exposed(f);
  }

  private descendants(id: string): string[] {
    const out: string[] = [];
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const e of this.files.values()) {
        if (e.file.parents?.includes(cur)) {
          out.push(e.file.id);
          stack.push(e.file.id);
        }
      }
    }
    return out;
  }

  /** Borrado definitivo (como vaciar la papelera). */
  async purge(id: string) {
    const ids = [this.resolve(id), ...this.descendants(this.resolve(id))];
    for (const i of ids) {
      this.files.delete(i);
      this.log.push(`-${i}`);
    }
    this.onMutate?.();
  }

  async searchFolders(text: string) {
    await this.gate();
    const t = text.toLowerCase();
    return [...this.files.values()]
      .map((e) => e.file)
      .filter((f) => f.mimeType === FOLDER_MIME && f.id !== this.myDriveId && !this.isTrashedDeep(f) && f.name.toLowerCase().includes(t))
      .map((f) => this.copy(f));
  }

  async getStartPageToken() {
    await this.gate();
    return String(this.log.length);
  }

  async listChanges(pageToken: string): Promise<ChangesPage> {
    await this.gate();
    const start = Number(pageToken);
    const pageSize = 25;
    const slice = this.log.slice(start, start + pageSize);
    const changes: RemoteChange[] = slice.map((raw) => {
      if (raw.startsWith('-')) return { fileId: raw.slice(1), removed: true };
      const e = this.files.get(raw);
      if (!e) return { fileId: raw, removed: true };
      return { fileId: raw, removed: false, file: this.exposed(e.file) };
    });
    const end = start + slice.length;
    if (end < this.log.length) return { changes, nextPageToken: String(end) };
    return { changes, newStartPageToken: String(end) };
  }

  // ---- utilidades para pruebas / semilla del modo demo ----

  /** Crea una ruta de carpetas (si no existe) y devuelve el id de la última. */
  async ensurePath(path: string[], parent = this.myDriveId): Promise<string> {
    let cur = parent;
    for (const name of path) {
      const existing = [...this.files.values()].find((e) => e.file.name === name && e.file.parents?.includes(cur) && e.file.mimeType === FOLDER_MIME && !e.file.trashed);
      cur = existing ? existing.file.id : (await this.create({ name, mimeType: FOLDER_MIME, parents: [cur] })).id;
    }
    return cur;
  }

  findByName(name: string): RemoteFile | undefined {
    const e = [...this.files.values()].find((x) => x.file.name === name && !this.isTrashedDeep(x.file));
    return e ? this.copy(e.file) : undefined;
  }

  async readText(id: string): Promise<string> {
    return (await this.entry(id).content?.text()) ?? '';
  }

  allFiles(): RemoteFile[] {
    return [...this.files.values()].map((e) => this.exposed(e.file));
  }

  simulateOffline(times = 1) {
    for (let i = 0; i < times; i++) this.failures.push(new OfflineError());
  }
}
