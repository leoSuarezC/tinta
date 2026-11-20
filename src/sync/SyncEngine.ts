import {
  AuthRequiredError,
  DriveError,
  FOLDER_MIME,
  OfflineError,
  type DriveApi,
  type FilePatch,
  type RemoteChange,
  type RemoteFile,
} from '../drive/types';
import { newLid, type LocalItem, type Store } from '../db/db';
import { baseName, extOf, isTextKind, kindOf, stamp } from '../model/fileTypes';
import { merge3 } from './merge';

export const ROOT_LID = 'root';
const TEXT_PREFETCH_MAX = 2 * 1024 * 1024;

export type SyncState = 'idle' | 'syncing' | 'offline' | 'auth' | 'error';

export interface SyncStatus {
  state: SyncState;
  pending: number;
  lastSyncAt?: number;
  message?: string;
}

export class RootMissingError extends Error {
  constructor() {
    super('La carpeta principal ya no existe en Drive (¿se movió a la papelera?). Elige otra en Ajustes.');
    this.name = 'RootMissingError';
  }
}

type Fn<T> = (v: T) => void;

const isPassThrough = (e: unknown) => e instanceof AuthRequiredError || e instanceof OfflineError;
const isPermissionError = (e: unknown) =>
  e instanceof DriveError && e.status === 403 && ['insufficientFilePermissions', 'forbidden', 'cannotDeleteFile', 'insufficientPermissions', 'fileOwnerNotMemberOfWriterDomain'].includes(e.reason ?? '');

/**
 * Sincroniza una carpeta de Drive con la base local (IndexedDB).
 *
 * Cada elemento guarda su estado local, su "base" (último estado sincronizado: nombre,
 * carpeta, destacado y el hash del contenido que tenemos como base) y banderas de cambios
 * pendientes. `remoteMd5` es el hash más reciente conocido en Drive: si difiere de la base,
 * el contenido local está desactualizado (o, si además hay cambios locales, hay conflicto).
 *
 * Cada ciclo: pull (feed de cambios) → conflictos (fusión de 3 vías para texto, copia para
 * lo demás) → push (crear, metadatos, contenido, papelera) → caché de textos.
 */
export class SyncEngine {
  private running: Promise<void> | null = null;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private errors: string[] = [];
  status: SyncStatus = { state: 'idle', pending: 0 };
  private changeFns = new Set<Fn<void>>();
  private statusFns = new Set<Fn<SyncStatus>>();
  private contentFns = new Set<Fn<string>>();

  constructor(
    public store: Store,
    public drive: DriveApi,
  ) {}

  // ---------- eventos ----------
  onChange(fn: Fn<void>) {
    this.changeFns.add(fn);
    return () => void this.changeFns.delete(fn);
  }
  onStatus(fn: Fn<SyncStatus>) {
    this.statusFns.add(fn);
    return () => void this.statusFns.delete(fn);
  }
  /** Avisa cuando la sincronización reemplaza el contenido de un archivo (fusión o conflicto). */
  onContentReplaced(fn: Fn<string>) {
    this.contentFns.add(fn);
    return () => void this.contentFns.delete(fn);
  }
  private emitChange() {
    for (const f of this.changeFns) f();
  }
  private setStatus(p: Partial<SyncStatus>) {
    this.status = { ...this.status, ...p };
    for (const f of this.statusFns) f(this.status);
  }
  async refreshPending() {
    this.setStatus({ pending: await this.countPending() });
  }

  // ---------- configuración ----------
  rootDriveId() {
    return this.store.getMeta<string>('rootDriveId');
  }

  /** Primera carga (o cambio de carpeta principal): lista todo el árbol. */
  async initRoot(rootDriveId: string, onProgress?: (n: number) => void) {
    this.setStatus({ state: 'syncing', message: 'Leyendo tu carpeta…' });
    try {
      const startToken = await this.drive.getStartPageToken();
      const rootFile = await this.drive.getFile(rootDriveId);
      await this.store.clearAll();
      const root = this.itemFromRemote(rootFile, null, ROOT_LID);
      await this.store.putItem(root);
      await this.listSubtree(root, onProgress);
      await this.store.setMeta('rootDriveId', rootFile.id);
      await this.store.setMeta('rootName', rootFile.name);
      await this.store.setMeta('pageToken', startToken);
      const lastSyncAt = Date.now();
      await this.store.setMeta('lastSyncAt', lastSyncAt);
      this.emitChange();
      this.setStatus({ state: 'idle', lastSyncAt, message: undefined, pending: 0 });
      await this.prefetchTexts().catch(() => undefined);
      this.emitChange();
    } catch (e) {
      this.failStatus(e);
      throw e;
    }
  }

  private itemFromRemote(f: RemoteFile, parentLid: string | null, lid = newLid()): LocalItem {
    const isFolder = f.mimeType === FOLDER_MIME;
    return {
      lid,
      driveId: f.id,
      parentLid,
      name: f.name,
      mimeType: f.mimeType,
      isFolder,
      size: f.size !== undefined ? Number(f.size) : undefined,
      modifiedTime: f.modifiedTime,
      starred: !!f.starred,
      webViewLink: f.webViewLink,
      thumbnailLink: f.thumbnailLink,
      canEdit: f.capabilities?.canEdit !== false,
      shortcutTargetId: f.shortcutDetails?.targetId,
      base: { name: f.name, parentDriveId: f.parents?.[0] ?? null, md5: f.md5Checksum, version: f.version, starred: !!f.starred },
      remoteMd5: f.md5Checksum,
      dirtyContent: false,
      dirtyMeta: false,
      deleted: false,
      rev: 0,
      metaRev: 0,
      cached: isFolder,
    };
  }

  /** Lista recursivamente el contenido de una carpeta (varias carpetas por consulta). */
  private async listSubtree(folder: LocalItem, onProgress?: (n: number) => void) {
    const queue: LocalItem[] = [folder];
    const visited = new Set<string>();
    let count = 0;
    while (queue.length) {
      const batch = queue.splice(0, 20).filter((f) => f.driveId && !visited.has(f.lid));
      if (!batch.length) continue;
      batch.forEach((f) => visited.add(f.lid));
      const byDrive = new Map(batch.map((f) => [f.driveId!, f]));
      let pageToken: string | undefined;
      do {
        const page = await this.drive.listChildren([...byDrive.keys()], pageToken);
        // Una sola transacción por página de resultados (la carga inicial puede traer miles).
        const tx = this.store.db.transaction('items', 'readwrite');
        const byDriveIdx = tx.store.index('byDriveId');
        for (const f of page.files) {
          const parentId = f.parents?.find((p) => byDrive.has(p));
          const parent = parentId ? byDrive.get(parentId) : undefined;
          if (!parent) continue;
          const existing = await byDriveIdx.get(f.id);
          if (existing) {
            if (existing.isFolder) queue.push(existing);
            continue;
          }
          const item = this.itemFromRemote(f, parent.lid);
          await tx.store.put(item);
          count++;
          if (item.isFolder) queue.push(item);
        }
        await tx.done;
        onProgress?.(count);
        pageToken = page.nextPageToken;
      } while (pageToken);
    }
  }

  // ---------- ciclo de sincronización ----------
  requestSync(delayMs = 1500) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.sync();
    }, delayMs);
  }

  sync(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        let rounds = 0;
        do {
          this.again = false;
          await this.withLock(() => this.syncOnce());
        } while (this.again && ++rounds < 5 && this.status.state !== 'offline' && this.status.state !== 'auth');
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  /** Con varias pestañas abiertas, solo una sincroniza a la vez. */
  private async withLock(fn: () => Promise<void>) {
    const locks = typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
    if (!locks) return fn();
    await locks.request('tinta-sync', fn);
  }

  get isRunning() {
    return !!this.running;
  }

  private failStatus(e: unknown) {
    if (e instanceof AuthRequiredError) this.setStatus({ state: 'auth', message: e.message });
    else if (e instanceof OfflineError) this.setStatus({ state: 'offline', message: 'Sin conexión: los cambios se guardan en este dispositivo.' });
    else this.setStatus({ state: 'error', message: (e as Error)?.message ?? String(e) });
  }

  private async syncOnce() {
    const rootDriveId = await this.rootDriveId();
    if (!rootDriveId) return;
    this.errors = [];
    this.setStatus({ state: 'syncing', message: undefined, pending: await this.countPending() });
    try {
      await this.pull(rootDriveId);
      this.emitChange();
      await this.push();
      await this.prefetchTexts();
      const lastSyncAt = Date.now();
      await this.store.setMeta('lastSyncAt', lastSyncAt);
      const pending = await this.countPending();
      if (this.errors.length) {
        this.setStatus({ state: 'error', pending, lastSyncAt, message: this.errors.slice(0, 3).join(' · ') });
      } else {
        this.setStatus({ state: 'idle', pending, lastSyncAt, message: undefined });
      }
    } catch (e) {
      this.setStatus({ pending: await this.countPending() });
      this.failStatus(e);
    } finally {
      this.emitChange();
    }
  }

  // ---------- pull ----------
  private async pull(rootDriveId: string) {
    let token = await this.store.getMeta<string>('pageToken');
    if (!token) {
      await this.store.setMeta('pageToken', await this.drive.getStartPageToken());
      return;
    }
    const changes: RemoteChange[] = [];
    for (;;) {
      const page = await this.drive.listChanges(token);
      changes.push(...page.changes);
      if (page.nextPageToken) token = page.nextPageToken;
      else {
        token = page.newStartPageToken ?? token;
        break;
      }
    }
    if (changes.length) await this.applyRemoteChanges(changes, rootDriveId);
    await this.store.setMeta('pageToken', token);
  }

  private async applyRemoteChanges(changes: RemoteChange[], rootDriveId: string) {
    const latest = new Map<string, RemoteChange>();
    for (const c of changes) latest.set(c.fileId, c);
    let pending = [...latest.values()];
    const newFolders: LocalItem[] = [];

    // Varias pasadas: un archivo puede llegar antes que la carpeta nueva que lo contiene.
    let progress = true;
    while (pending.length && progress) {
      progress = false;
      const rest: RemoteChange[] = [];
      for (const c of pending) {
        const f = c.file;
        const gone = c.removed || !f || f.trashed;
        if (c.fileId === rootDriveId) {
          if (gone) throw new RootMissingError();
          await this.store.updateItem(ROOT_LID, (r) => {
            r.name = f!.name;
          });
          await this.store.setMeta('rootName', f!.name);
          progress = true;
          continue;
        }
        const local = await this.store.getByDriveId(c.fileId);
        if (gone) {
          if (local) await this.handleRemoteGone(local);
          progress = true;
          continue;
        }
        const parentId = f!.parents?.[0];
        const parent = parentId ? await this.store.getByDriveId(parentId) : undefined;
        if (parent?.isFolder) {
          if (local) await this.applyRemoteUpdate(local, f!, parent);
          else {
            const item = this.itemFromRemote(f!, parent.lid);
            await this.store.putItem(item);
            if (item.isFolder) newFolders.push(item);
          }
          progress = true;
        } else {
          rest.push(c);
        }
      }
      pending = rest;
    }
    // Lo que quedó apunta fuera del árbol: si lo teníamos, se movió fuera de la carpeta.
    for (const c of pending) {
      const local = await this.store.getByDriveId(c.fileId);
      if (local) await this.handleRemoteGone(local);
    }
    // Carpetas que entraron al árbol (nuevas o movidas desde fuera): su contenido puede no venir en el feed.
    for (const folder of newFolders) {
      const still = await this.store.getItem(folder.lid);
      if (still) await this.listSubtree(still);
    }
  }

  private async applyRemoteUpdate(local: LocalItem, f: RemoteFile, parent: LocalItem) {
    await this.store.updateItem(local.lid, (cur) => {
      const known = cur.remoteMd5 ?? cur.base?.md5;
      const contentChanged = !cur.isFolder && !!f.md5Checksum && f.md5Checksum !== known;
      if (!cur.dirtyMeta) {
        cur.name = f.name;
        cur.parentLid = parent.lid;
        cur.starred = !!f.starred;
      }
      cur.base = { name: f.name, parentDriveId: parent.driveId, starred: !!f.starred, version: f.version, md5: cur.base?.md5 };
      cur.webViewLink = f.webViewLink ?? cur.webViewLink;
      cur.thumbnailLink = f.thumbnailLink ?? (contentChanged ? undefined : cur.thumbnailLink);
      cur.canEdit = f.capabilities?.canEdit !== false;
      if (contentChanged) {
        cur.remoteMd5 = f.md5Checksum;
        if (!cur.dirtyContent) {
          cur.cached = false;
          cur.mimeType = f.mimeType;
        }
      }
      if (!cur.dirtyContent) {
        cur.size = f.size !== undefined ? Number(f.size) : cur.size;
        cur.modifiedTime = f.modifiedTime ?? cur.modifiedTime;
      }
    });
  }

  /** El elemento desapareció de la carpeta en Drive (papelera, borrado o movido fuera). */
  private async handleRemoteGone(local: LocalItem) {
    const subtree = new Set<string>();
    await this.collectSubtree(local.lid, subtree);
    await this.removeGone(local.lid, subtree, false);
  }

  private async collectSubtree(lid: string, out: Set<string>) {
    out.add(lid);
    for (const c of await this.store.children(lid, true)) await this.collectSubtree(c.lid, out);
  }

  /**
   * Borra localmente lo que desapareció en Drive, pero conserva:
   * - archivos con cambios sin subir (se desvinculan y se volverán a crear), y sus carpetas;
   * - elementos que el usuario movió aquí localmente pero que en Drive siguen en otro sitio
   *   (vuelven a su carpeta original).
   */
  private async removeGone(lid: string, subtree: Set<string>, ancestorDeleted: boolean): Promise<boolean> {
    const item = await this.store.getItem(lid);
    if (!item) return false;
    const userDeleted = ancestorDeleted || item.deleted;

    if (!userDeleted && item.driveId && item.base?.parentDriveId && lid !== [...subtree][0]) {
      const remoteParent = await this.store.getByDriveId(item.base.parentDriveId);
      if (remoteParent && !subtree.has(remoteParent.lid)) {
        await this.store.updateItem(lid, (cur) => {
          cur.parentLid = remoteParent.lid;
          cur.name = cur.base?.name ?? cur.name;
          cur.dirtyMeta = cur.starred !== !!cur.base?.starred;
        });
        return true;
      }
    }

    let keep = false;
    if (item.isFolder) {
      for (const child of await this.store.children(lid, true)) {
        if (await this.removeGone(child.lid, subtree, userDeleted)) keep = true;
      }
    } else {
      keep = item.dirtyContent && !userDeleted;
    }
    if (keep) {
      await this.store.updateItem(lid, (cur) => {
        cur.driveId = null;
        cur.base = null;
        cur.dirtyMeta = false;
        cur.remoteMd5 = undefined;
      });
    } else {
      await this.store.deleteItem(lid);
    }
    return keep;
  }

  // ---------- push ----------
  private async push() {
    let items = await this.store.allItems();
    // 0) Conflictos ya conocidos tras el pull
    for (const i of items) {
      if (i.driveId && i.dirtyContent && !i.deleted && i.remoteMd5 && i.remoteMd5 !== i.base?.md5) {
        await this.guard(i, () => this.resolveConflict(i.lid));
      }
    }

    items = await this.store.allItems();
    const byLid = new Map(items.map((i) => [i.lid, i]));
    const depth = (i: LocalItem) => {
      let d = 0;
      let cur: LocalItem | undefined = i;
      while (cur?.parentLid && d < 100) {
        cur = byLid.get(cur.parentLid);
        d++;
      }
      return d;
    };
    const underDeleted = (i: LocalItem) => {
      let cur = i.parentLid ? byLid.get(i.parentLid) : undefined;
      let n = 0;
      while (cur && n++ < 100) {
        if (cur.deleted) return true;
        cur = cur.parentLid ? byLid.get(cur.parentLid) : undefined;
      }
      return false;
    };

    // 1) Creaciones: carpetas antes que su contenido
    const creates = items
      .filter((i) => !i.driveId && !i.deleted && i.lid !== ROOT_LID && !underDeleted(i))
      .sort((a, b) => depth(a) - depth(b) || Number(b.isFolder) - Number(a.isFolder));
    for (const i of creates) await this.guard(i, () => this.pushCreate(i.lid));

    // 2) Metadatos (renombrar, mover, destacar) y 3) contenido
    items = await this.store.allItems();
    for (const i of items) if (i.driveId && i.dirtyMeta && !i.deleted) await this.guard(i, () => this.pushMeta(i.lid));
    items = await this.store.allItems();
    for (const i of items) if (i.driveId && i.dirtyContent && !i.deleted) await this.guard(i, () => this.pushContent(i.lid));

    // 4) Eliminaciones (van a la papelera de Drive)
    items = await this.store.allItems();
    byLid.clear();
    for (const i of items) byLid.set(i.lid, i);
    for (const i of items) {
      if (i.deleted && !underDeleted(i)) await this.guard(i, () => this.pushDelete(i.lid));
    }
  }

  private async guard(item: LocalItem, fn: () => Promise<void>) {
    try {
      await fn();
    } catch (e) {
      if (isPassThrough(e)) throw e;
      if (e instanceof DriveError && e.status === 404) {
        const cur = await this.store.getItem(item.lid);
        if (cur) await this.handleRemoteGone(cur);
        this.again = true;
        return;
      }
      const msg = `${item.name}: ${(e as Error)?.message ?? e}`;
      this.errors.push(msg);
      await this.store.updateItem(item.lid, (cur) => {
        cur.syncError = (e as Error)?.message ?? String(e);
      });
    }
  }

  private async commit(
    lid: string,
    res: RemoteFile,
    opts: { rev?: number; metaRev?: number; textSent?: string; contentSent: boolean; metaSent: boolean },
  ) {
    const tx = this.store.db.transaction(['items', 'contents'], 'readwrite');
    const items = tx.objectStore('items');
    const contents = tx.objectStore('contents');
    const cur = await items.get(lid);
    if (cur) {
      cur.driveId = res.id;
      cur.base = {
        name: res.name,
        parentDriveId: res.parents?.[0] ?? cur.base?.parentDriveId ?? null,
        md5: cur.base?.md5,
        version: res.version,
        starred: !!res.starred,
      };
      if (opts.contentSent) {
        cur.base.md5 = res.md5Checksum;
        cur.remoteMd5 = res.md5Checksum;
        if (cur.rev === opts.rev) {
          cur.dirtyContent = false;
          cur.size = res.size !== undefined ? Number(res.size) : cur.size;
        }
        cur.modifiedTime = res.modifiedTime ?? cur.modifiedTime;
        cur.cached = true;
      } else if (res.md5Checksum && res.md5Checksum !== (cur.remoteMd5 ?? cur.base.md5)) {
        // El contenido cambió en Drive entretanto: es un cambio remoto más.
        cur.remoteMd5 = res.md5Checksum;
        if (!cur.dirtyContent) cur.cached = false;
      }
      if (opts.metaSent && cur.metaRev === opts.metaRev) cur.dirtyMeta = false;
      cur.webViewLink = res.webViewLink ?? cur.webViewLink;
      cur.thumbnailLink = res.thumbnailLink ?? cur.thumbnailLink;
      cur.canEdit = res.capabilities?.canEdit !== false;
      cur.syncError = undefined;
      await items.put(cur);
      if (opts.contentSent) {
        const c = await contents.get(lid);
        if (c) await contents.put({ ...c, md5: res.md5Checksum, ...(opts.textSent !== undefined ? { baseText: opts.textSent } : {}) });
      }
    }
    await tx.done;
  }

  private async contentBlob(item: LocalItem): Promise<{ blob: Blob; textSent?: string } | undefined> {
    const c = await this.store.getContent(item.lid);
    if (c?.text !== undefined) return { blob: new Blob([c.text], { type: item.mimeType }), textSent: c.text };
    if (c?.blob) return { blob: c.blob.type ? c.blob : new Blob([c.blob], { type: item.mimeType }) };
    return undefined;
  }

  private async pushCreate(lid: string) {
    const item = await this.store.getItem(lid);
    if (!item || item.driveId || item.deleted) return;
    const parent = item.parentLid ? await this.store.getItem(item.parentLid) : undefined;
    if (!parent?.driveId) {
      this.again = true;
      return;
    }
    const rev = item.rev;
    const metaRev = item.metaRev;
    let res: RemoteFile;
    let textSent: string | undefined;
    if (item.isFolder) {
      res = await this.drive.create({ name: item.name, mimeType: FOLDER_MIME, parents: [parent.driveId] });
    } else {
      const content = await this.contentBlob(item);
      textSent = content?.textSent;
      res = await this.drive.create(
        { name: item.name, mimeType: item.mimeType, parents: [parent.driveId] },
        content?.blob ?? new Blob([], { type: item.mimeType }),
      );
    }
    if (item.starred) res = await this.drive.update(res.id, { starred: true });
    await this.commit(lid, res, { rev, metaRev, textSent, contentSent: !item.isFolder, metaSent: true });
  }

  private async pushMeta(lid: string) {
    const item = await this.store.getItem(lid);
    if (!item?.driveId || !item.dirtyMeta) return;
    const parent = item.parentLid ? await this.store.getItem(item.parentLid) : undefined;
    if (!parent?.driveId) {
      this.again = true;
      return;
    }
    const metaRev = item.metaRev;
    const patch: FilePatch = {};
    if (item.name !== item.base?.name) patch.name = item.name;
    if (parent.driveId !== item.base?.parentDriveId) {
      patch.addParents = [parent.driveId];
      if (item.base?.parentDriveId) patch.removeParents = [item.base.parentDriveId];
    }
    if (item.starred !== !!item.base?.starred) patch.starred = item.starred;
    if (!Object.keys(patch).length) {
      await this.store.updateItem(lid, (cur) => {
        if (cur.metaRev === metaRev) cur.dirtyMeta = false;
      });
      return;
    }
    let res: RemoteFile;
    try {
      res = await this.drive.update(item.driveId, patch);
    } catch (e) {
      if (isPermissionError(e)) {
        // Sin permiso (archivo compartido de otra persona): se deshace el cambio local.
        await this.store.updateItem(lid, (cur) => {
          if (cur.base) {
            cur.name = cur.base.name;
            cur.starred = cur.base.starred;
          }
          cur.dirtyMeta = false;
        });
        const parentBack = item.base?.parentDriveId ? await this.store.getByDriveId(item.base.parentDriveId) : undefined;
        if (parentBack) await this.store.updateItem(lid, (cur) => void (cur.parentLid = parentBack.lid));
        this.errors.push(`${item.name}: no tienes permiso para cambiarlo`);
        return;
      }
      throw e;
    }
    await this.commit(lid, res, { metaRev, contentSent: false, metaSent: true });
  }

  private async pushContent(lid: string) {
    let item = await this.store.getItem(lid);
    if (!item?.driveId || !item.dirtyContent) return;
    if (!item.canEdit) {
      await this.forkReadOnly(item);
      return;
    }
    // Se verifica el estado remoto justo antes de subir, para no pisar cambios de otro dispositivo.
    const fresh = await this.drive.getFile(item.driveId);
    if (fresh.trashed) {
      await this.handleRemoteGone(item);
      this.again = true;
      return;
    }
    if (fresh.md5Checksum && fresh.md5Checksum !== item.base?.md5) {
      await this.resolveConflict(lid, fresh);
      item = await this.store.getItem(lid);
      if (!item?.driveId || !item.dirtyContent || item.base?.md5 !== fresh.md5Checksum) return;
    }
    const rev = item.rev;
    const content = await this.contentBlob(item);
    if (!content) {
      await this.store.updateItem(lid, (cur) => {
        if (cur.rev === rev) cur.dirtyContent = false;
      });
      return;
    }
    const res = await this.drive.update(item.driveId, {}, content.blob);
    await this.commit(lid, res, { rev, textSent: content.textSent, contentSent: true, metaSent: false });
  }

  private async pushDelete(lid: string) {
    const item = await this.store.getItem(lid);
    if (!item) return;
    if (item.driveId) {
      try {
        await this.drive.update(item.driveId, { trashed: true });
      } catch (e) {
        if (isPermissionError(e)) {
          await this.store.updateItem(lid, (cur) => void (cur.deleted = false));
          this.errors.push(`${item.name}: no tienes permiso para eliminarlo`);
          return;
        }
        if (!(e instanceof DriveError && e.status === 404)) throw e;
      }
    }
    await this.deleteSubtreeLocal(lid);
  }

  private async deleteSubtreeLocal(lid: string) {
    for (const child of await this.store.children(lid, true)) await this.deleteSubtreeLocal(child.lid);
    await this.store.deleteItem(lid);
  }

  /** "Nota (conflicto 2026-10-08 1530).md" */
  private conflictName(name: string) {
    const ext = extOf(name);
    return `${baseName(name)} (conflicto ${stamp()})${ext ? '.' + ext : ''}`;
  }

  private async createConflictCopy(item: LocalItem, content: { text?: string; blob?: Blob }) {
    const copy: LocalItem = {
      ...item,
      lid: newLid(),
      driveId: null,
      base: null,
      name: await this.uniqueName(item.parentLid ?? ROOT_LID, this.conflictName(item.name)),
      starred: false,
      dirtyContent: true,
      dirtyMeta: false,
      deleted: false,
      rev: 1,
      metaRev: 0,
      cached: true,
      remoteMd5: undefined,
      syncError: undefined,
    };
    await this.store.putItem(copy);
    await this.store.putContent({ lid: copy.lid, ...content });
    this.again = true;
    return copy;
  }

  /** Archivo sin permiso de edición con cambios locales: los cambios pasan a una copia. */
  private async forkReadOnly(item: LocalItem) {
    const c = await this.store.getContent(item.lid);
    await this.createConflictCopy(item, c?.text !== undefined ? { text: c.text } : { blob: c?.blob });
    await this.store.updateItem(item.lid, (cur) => {
      cur.dirtyContent = false;
      cur.cached = false;
      cur.rev++;
    });
    this.contentFns.forEach((f) => f(item.lid));
  }

  /**
   * Cambió en los dos lados. Texto: fusión de 3 vías; si hay choque, los cambios locales van a
   * una copia "(conflicto …)" y el archivo toma la versión de Drive. Binarios: siempre copia.
   */
  private async resolveConflict(lid: string, fresh?: RemoteFile) {
    const item = await this.store.getItem(lid);
    if (!item?.driveId) return;
    const remote = fresh ?? (await this.drive.getFile(item.driveId));
    if (remote.trashed) {
      await this.handleRemoteGone(item);
      return;
    }
    const remoteMd5 = remote.md5Checksum;
    const rev = item.rev;
    const remoteBlob = await this.drive.download(item.driveId);
    const c = await this.store.getContent(lid);
    const kind = kindOf(item.name, item.mimeType);

    if (isTextKind(kind) && c?.text !== undefined) {
      const remoteText = await remoteBlob.text();
      const { merged, clean } = merge3(c.text, c.baseText ?? '', remoteText);
      const finalText = clean ? merged : remoteText;
      const applied = await this.applyResolution(lid, rev, remoteMd5, { text: finalText, baseText: remoteText }, finalText !== remoteText);
      if (!applied) this.again = true;
      else if (!clean) await this.createConflictCopy(item, { text: c.text });
    } else {
      const applied = await this.applyResolution(lid, rev, remoteMd5, { blob: remoteBlob }, false);
      if (!applied) this.again = true;
      else if (c?.blob || c?.text !== undefined) {
        await this.createConflictCopy(item, c.text !== undefined ? { text: c.text } : { blob: c.blob });
      }
    }
  }

  private async applyResolution(
    lid: string,
    rev: number,
    remoteMd5: string | undefined,
    content: { text?: string; baseText?: string; blob?: Blob },
    stillDirty: boolean,
  ): Promise<boolean> {
    const tx = this.store.db.transaction(['items', 'contents'], 'readwrite');
    const items = tx.objectStore('items');
    const contents = tx.objectStore('contents');
    const cur = await items.get(lid);
    let applied = false;
    if (cur && cur.rev === rev) {
      cur.base = { ...(cur.base ?? { name: cur.name, parentDriveId: null, starred: cur.starred }), md5: remoteMd5 };
      cur.remoteMd5 = remoteMd5;
      cur.dirtyContent = stillDirty;
      cur.cached = true;
      cur.rev++;
      if (content.text !== undefined) cur.size = new Blob([content.text]).size;
      else if (content.blob) cur.size = content.blob.size;
      await items.put(cur);
      await contents.put({ lid, ...content, md5: remoteMd5 });
      applied = true;
    }
    await tx.done;
    if (applied) this.contentFns.forEach((f) => f(lid));
    return applied;
  }

  // ---------- caché de contenidos ----------
  private async prefetchTexts() {
    const items = (await this.store.allItems()).filter(
      (i) =>
        i.driveId &&
        !i.isFolder &&
        !i.cached &&
        !i.deleted &&
        !i.dirtyContent &&
        isTextKind(kindOf(i.name, i.mimeType)) &&
        (i.size ?? 0) <= TEXT_PREFETCH_MAX,
    );
    const queue = [...items];
    const worker = async () => {
      for (;;) {
        const i = queue.shift();
        if (!i) return;
        try {
          await this.fetchAndCache(i.lid);
        } catch (e) {
          if (isPassThrough(e)) throw e;
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  }

  /** Descarga el contenido de Drive y lo guarda como base si nada cambió localmente entretanto. */
  private async fetchAndCache(lid: string): Promise<{ text?: string; blob?: Blob } | undefined> {
    const item = await this.store.getItem(lid);
    if (!item?.driveId) return undefined;
    const target = item.remoteMd5 ?? item.base?.md5;
    const rev = item.rev;
    const blob = await this.drive.download(item.driveId);
    const text = isTextKind(kindOf(item.name, item.mimeType)) ? await blob.text() : undefined;
    const tx = this.store.db.transaction(['items', 'contents'], 'readwrite');
    const cur = await tx.objectStore('items').get(lid);
    let replaced = false;
    let newlyCached = false;
    if (cur && cur.rev === rev && !cur.dirtyContent) {
      newlyCached = !cur.cached;
      const prev = await tx.objectStore('contents').get(lid);
      replaced = text !== undefined ? prev?.text !== undefined && prev.text !== text : !!prev?.blob;
      cur.cached = (cur.remoteMd5 ?? cur.base?.md5) === target;
      cur.base = { ...(cur.base ?? { name: cur.name, parentDriveId: null, starred: cur.starred }), md5: target };
      cur.size = blob.size;
      if (replaced) cur.rev++;
      await tx.objectStore('items').put(cur);
      await tx.objectStore('contents').put(text !== undefined ? { lid, text, baseText: text, md5: target } : { lid, blob, md5: target });
    }
    await tx.done;
    if (replaced) this.contentFns.forEach((f) => f(lid));
    // Avisar a la lista: la tarjeta ya puede mostrar la vista previa sin conexión.
    if (newlyCached && text === undefined) this.emitChange();
    return text !== undefined ? { text } : { blob };
  }

  // ---------- operaciones locales (las usa la interfaz) ----------
  async countPending(): Promise<number> {
    const items = await this.store.allItems();
    return items.filter((i) => i.lid !== ROOT_LID && (!i.driveId || i.dirtyContent || i.dirtyMeta || i.deleted)).length;
  }

  private async afterLocalChange(delay = 1500) {
    this.emitChange();
    await this.refreshPending();
    this.requestSync(delay);
  }

  async uniqueName(parentLid: string, name: string, exceptLid?: string): Promise<string> {
    const siblings = new Set(
      (await this.store.children(parentLid)).filter((i) => i.lid !== exceptLid).map((i) => i.name.toLowerCase()),
    );
    if (!siblings.has(name.toLowerCase())) return name;
    const ext = extOf(name);
    const stem = ext ? baseName(name) : name;
    for (let n = 2; n < 1000; n++) {
      const candidate = `${stem} (${n})${ext ? '.' + ext : ''}`;
      if (!siblings.has(candidate.toLowerCase())) return candidate;
    }
    return `${stem} ${Date.now()}${ext ? '.' + ext : ''}`;
  }

  private newLocalItem(parentLid: string, name: string, mimeType: string, isFolder: boolean, size?: number): LocalItem {
    return {
      lid: newLid(),
      driveId: null,
      parentLid,
      name,
      mimeType,
      isFolder,
      size,
      modifiedTime: new Date().toISOString(),
      starred: false,
      canEdit: true,
      base: null,
      dirtyContent: !isFolder,
      dirtyMeta: false,
      deleted: false,
      rev: 1,
      metaRev: 0,
      cached: true,
    };
  }

  async createFolder(parentLid: string, name: string): Promise<LocalItem> {
    const item = this.newLocalItem(parentLid, await this.uniqueName(parentLid, name), FOLDER_MIME, true);
    await this.store.putItem(item);
    await this.afterLocalChange(300);
    return item;
  }

  /** Busca una subcarpeta por nombre o la crea (p. ej. "_adjuntos"). */
  async ensureFolder(parentLid: string, name: string): Promise<LocalItem> {
    const existing = (await this.store.children(parentLid)).find((i) => i.isFolder && i.name === name);
    return existing ?? this.createFolder(parentLid, name);
  }

  async createFile(parentLid: string, name: string, mimeType: string, content: string | Blob): Promise<LocalItem> {
    const size = typeof content === 'string' ? new Blob([content]).size : content.size;
    const item = this.newLocalItem(parentLid, await this.uniqueName(parentLid, name), mimeType, false, size);
    await this.store.putItem(item);
    await this.store.putContent(typeof content === 'string' ? { lid: item.lid, text: content, baseText: '' } : { lid: item.lid, blob: content });
    await this.afterLocalChange(typeof content === 'string' ? 2500 : 500);
    return item;
  }

  /**
   * Guarda el texto de un editor. `baseText` es el texto sobre el que el usuario escribió:
   * si el contenido guardado cambió entretanto (llegó una versión de Drive), se fusiona en vez
   * de pisarlo. Devuelve el texto que quedó guardado.
   */
  async saveText(lid: string, text: string, baseText?: string): Promise<string> {
    const tx = this.store.db.transaction(['items', 'contents'], 'readwrite');
    const items = tx.objectStore('items');
    const contents = tx.objectStore('contents');
    const [item, c] = await Promise.all([items.get(lid), contents.get(lid)]);
    if (!item) {
      await tx.done;
      return text;
    }
    let finalText = text;
    if (baseText !== undefined && c?.text !== undefined && c.text !== baseText && c.text !== text) {
      finalText = merge3(text, baseText, c.text).merged;
    }
    if (c?.text === finalText) {
      await tx.done;
      return finalText;
    }
    await contents.put({ ...(c ?? { lid }), lid, text: finalText });
    item.dirtyContent = true;
    item.rev++;
    item.cached = true;
    item.size = new Blob([finalText]).size;
    item.modifiedTime = new Date().toISOString();
    await items.put(item);
    await tx.done;
    await this.afterLocalChange(2500);
    return finalText;
  }

  async saveBlob(lid: string, blob: Blob): Promise<void> {
    const tx = this.store.db.transaction(['items', 'contents'], 'readwrite');
    const items = tx.objectStore('items');
    const contents = tx.objectStore('contents');
    const [item, c] = await Promise.all([items.get(lid), contents.get(lid)]);
    if (!item) {
      await tx.done;
      return;
    }
    await contents.put({ lid, blob, md5: c?.md5 });
    item.dirtyContent = true;
    item.rev++;
    item.cached = true;
    item.size = blob.size;
    item.modifiedTime = new Date().toISOString();
    await items.put(item);
    await tx.done;
    await this.afterLocalChange(500);
  }

  async rename(lid: string, name: string): Promise<string | undefined> {
    if (lid === ROOT_LID) return;
    const item = await this.store.getItem(lid);
    if (!item || !item.parentLid) return;
    const unique = await this.uniqueName(item.parentLid, name, lid);
    await this.store.updateItem(lid, (cur) => {
      cur.name = unique;
      cur.dirtyMeta = true;
      cur.metaRev++;
    });
    await this.afterLocalChange(500);
    return unique;
  }

  async move(lid: string, newParentLid: string) {
    if (lid === ROOT_LID || lid === newParentLid) return;
    let cur = await this.store.getItem(newParentLid);
    while (cur) {
      if (cur.lid === lid) throw new Error('No se puede mover una carpeta dentro de sí misma');
      cur = cur.parentLid ? await this.store.getItem(cur.parentLid) : undefined;
    }
    const item = await this.store.getItem(lid);
    if (!item || item.parentLid === newParentLid) return;
    const name = await this.uniqueName(newParentLid, item.name, lid);
    await this.store.updateItem(lid, (c) => {
      c.parentLid = newParentLid;
      c.name = name;
      c.dirtyMeta = true;
      c.metaRev++;
    });
    await this.afterLocalChange(500);
  }

  async setStarred(lid: string, starred: boolean) {
    await this.store.updateItem(lid, (c) => {
      c.starred = starred;
      c.dirtyMeta = true;
      c.metaRev++;
    });
    await this.afterLocalChange(800);
  }

  async remove(lid: string) {
    if (lid === ROOT_LID) return;
    const item = await this.store.getItem(lid);
    if (!item) return;
    if (!item.driveId) await this.deleteSubtreeLocal(lid);
    else
      await this.store.updateItem(lid, (c) => {
        c.deleted = true;
        c.metaRev++;
      });
    await this.afterLocalChange(800);
  }

  /** Pide a Drive un enlace nuevo a la miniatura (los enlaces vencen en unas horas). */
  async refreshThumbnail(lid: string): Promise<string | undefined> {
    const item = await this.store.getItem(lid);
    if (!item?.driveId) return undefined;
    const f = await this.drive.getFile(item.driveId);
    await this.store.updateItem(lid, (cur) => {
      cur.thumbnailLink = f.thumbnailLink;
    });
    return f.thumbnailLink;
  }

  /** Texto del archivo: local si está al día; si no, lo descarga (o usa la copia vieja sin conexión). */
  async readText(lid: string): Promise<string> {
    const item = await this.store.getItem(lid);
    const c = await this.store.getContent(lid);
    if (!item) throw new Error('El archivo ya no existe');
    if ((item.cached || item.dirtyContent || !item.driveId) && c?.text !== undefined) return c.text;
    try {
      const r = await this.fetchAndCache(lid);
      return r?.text ?? '';
    } catch (e) {
      if (c?.text !== undefined) return c.text;
      throw e;
    }
  }

  async readBlob(lid: string): Promise<Blob> {
    const item = await this.store.getItem(lid);
    const c = await this.store.getContent(lid);
    if (!item) throw new Error('El archivo ya no existe');
    const fresh = item.cached || item.dirtyContent || !item.driveId;
    if (fresh && c?.blob) return c.blob;
    if (fresh && c?.text !== undefined) return new Blob([c.text], { type: item.mimeType });
    try {
      const r = await this.fetchAndCache(lid);
      if (r?.blob) return r.blob.type ? r.blob : new Blob([r.blob], { type: item.mimeType });
      return new Blob([r?.text ?? ''], { type: item.mimeType });
    } catch (e) {
      if (c?.blob) return c.blob;
      throw e;
    }
  }
}
