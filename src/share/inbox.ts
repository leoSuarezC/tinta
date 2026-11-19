import { openDB } from 'idb';

/**
 * Bandeja de lo que otras apps comparten con Tinta (menú Compartir de Android).
 * El service worker recibe el POST y lo guarda aquí; la app lo muestra al abrirse.
 */
export interface SharedEntry {
  id: string;
  at: number;
  files: { name: string; type: string; blob: Blob }[];
  title?: string;
  text?: string;
  url?: string;
}

const DB = 'tinta-inbox';

function open() {
  return openDB(DB, 1, {
    upgrade(d) {
      d.createObjectStore('shared', { keyPath: 'id' });
    },
  });
}

export async function putShared(entry: Omit<SharedEntry, 'id' | 'at'>) {
  const db = await open();
  await db.put('shared', { ...entry, id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, at: Date.now() });
  db.close();
}

export async function readShared(): Promise<SharedEntry[]> {
  const db = await open();
  const all = (await db.getAll('shared')) as SharedEntry[];
  db.close();
  return all.sort((a, b) => a.at - b.at);
}

export async function clearShared() {
  const db = await open();
  await db.clear('shared');
  db.close();
}
