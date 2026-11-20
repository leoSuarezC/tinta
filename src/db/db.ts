import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

/** Último estado sincronizado con Drive (base para detectar y fusionar cambios). */
export interface SyncBase {
  name: string;
  parentDriveId: string | null;
  md5?: string;
  version?: string;
  starred: boolean;
}

export interface LocalItem {
  lid: string;
  driveId: string | null;
  parentLid: string | null;
  name: string;
  mimeType: string;
  isFolder: boolean;
  size?: number;
  modifiedTime?: string;
  starred: boolean;
  webViewLink?: string;
  canEdit: boolean;
  shortcutTargetId?: string;
  base: SyncBase | null;
  /** Hash del contenido más reciente conocido en Drive. */
  remoteMd5?: string;
  dirtyContent: boolean;
  dirtyMeta: boolean;
  deleted: boolean;
  /** Se incrementa con cada cambio local de contenido; evita pisar ediciones hechas durante una subida. */
  rev: number;
  /** Igual que rev, para nombre, carpeta y destacado. */
  metaRev: number;
  /** El contenido está guardado localmente (para leerlo sin conexión). */
  cached: boolean;
  /** Miniatura de Drive (enlace temporal; se renueva si falla). */
  thumbnailLink?: string;
  syncError?: string;
}

export interface LocalContent {
  lid: string;
  text?: string;
  /** Texto de la última versión sincronizada (para la fusión de 3 vías). */
  baseText?: string;
  blob?: Blob;
  /** Hash remoto al que corresponde el contenido guardado. */
  md5?: string;
}

interface TintaDB extends DBSchema {
  items: { key: string; value: LocalItem; indexes: { byParent: string; byDriveId: string } };
  contents: { key: string; value: LocalContent };
  meta: { key: string; value: unknown };
}

export type Db = IDBPDatabase<TintaDB>;

export async function openStore(name: string): Promise<Db> {
  return openDB<TintaDB>(name, 1, {
    upgrade(db) {
      const items = db.createObjectStore('items', { keyPath: 'lid' });
      items.createIndex('byParent', 'parentLid');
      items.createIndex('byDriveId', 'driveId');
      db.createObjectStore('contents', { keyPath: 'lid' });
      db.createObjectStore('meta');
    },
  });
}

export class Store {
  constructor(public db: Db) {}

  getItem(lid: string) {
    return this.db.get('items', lid);
  }
  async getByDriveId(driveId: string) {
    return this.db.getFromIndex('items', 'byDriveId', driveId);
  }
  async children(parentLid: string, includeDeleted = false) {
    const all = await this.db.getAllFromIndex('items', 'byParent', parentLid);
    return includeDeleted ? all : all.filter((i) => !i.deleted);
  }
  allItems() {
    return this.db.getAll('items');
  }
  putItem(item: LocalItem) {
    return this.db.put('items', item);
  }
  async deleteItem(lid: string) {
    const tx = this.db.transaction(['items', 'contents'], 'readwrite');
    await Promise.all([tx.objectStore('items').delete(lid), tx.objectStore('contents').delete(lid), tx.done]);
  }
  /** Lee, modifica y guarda un elemento en una sola transacción. */
  async updateItem(lid: string, fn: (item: LocalItem) => LocalItem | void): Promise<LocalItem | undefined> {
    const tx = this.db.transaction('items', 'readwrite');
    const item = await tx.store.get(lid);
    if (!item) {
      await tx.done;
      return undefined;
    }
    const next = fn(item) ?? item;
    await tx.store.put(next);
    await tx.done;
    return next;
  }
  getContent(lid: string) {
    return this.db.get('contents', lid);
  }
  putContent(c: LocalContent) {
    return this.db.put('contents', c);
  }
  deleteContent(lid: string) {
    return this.db.delete('contents', lid);
  }
  async allContents() {
    return this.db.getAll('contents');
  }
  getMeta<T>(key: string): Promise<T | undefined> {
    return this.db.get('meta', key) as Promise<T | undefined>;
  }
  setMeta(key: string, value: unknown) {
    return this.db.put('meta', value, key);
  }
  async clearAll() {
    const tx = this.db.transaction(['items', 'contents', 'meta'], 'readwrite');
    await Promise.all([tx.objectStore('items').clear(), tx.objectStore('contents').clear(), tx.objectStore('meta').clear(), tx.done]);
  }
  /** Libera el espacio de archivos binarios ya sincronizados (se vuelven a descargar al abrirlos). */
  async evictBinaries(): Promise<number> {
    const tx = this.db.transaction(['items', 'contents'], 'readwrite');
    const items = tx.objectStore('items');
    const contents = tx.objectStore('contents');
    let freed = 0;
    let cursor = await contents.openCursor();
    while (cursor) {
      const c = cursor.value;
      if (c.blob) {
        const item = await items.get(c.lid);
        if (item && !item.dirtyContent) {
          freed += c.blob.size;
          await cursor.delete();
          await items.put({ ...item, cached: false });
        }
      }
      cursor = await cursor.continue();
    }
    await tx.done;
    return freed;
  }
}

export function newLid(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `l${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}
