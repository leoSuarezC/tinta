import type { LocalItem, Store } from '../db/db';
import { ROOT_LID } from '../sync/SyncEngine';
import { splitRelPath } from './markdown';

/** Resuelve una ruta relativa ("_adjuntos/foto.jpg", "../Fotos/a.png") desde una carpeta del árbol. */
export async function resolveRelative(store: Store, fromFolder: string, href: string): Promise<LocalItem | undefined> {
  const segs = splitRelPath(href);
  if (!segs.length) return undefined;
  let cur = fromFolder;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s === '..') {
      const it = await store.getItem(cur);
      cur = it?.parentLid ?? ROOT_LID;
      continue;
    }
    const kids = await store.children(cur);
    const next = kids.find((k) => k.name === s) ?? kids.find((k) => k.name.toLowerCase() === s.toLowerCase());
    if (!next) return undefined;
    if (i === segs.length - 1) return next;
    if (!next.isFolder) return undefined;
    cur = next.lid;
  }
  return store.getItem(cur);
}

/** Embebidos estilo Obsidian (![[nombre]]): primero en la misma carpeta, luego en cualquier parte. */
export async function resolveByName(store: Store, fromFolder: string, name: string): Promise<LocalItem | undefined> {
  const direct = await resolveRelative(store, fromFolder, name);
  if (direct) return direct;
  const target = name.toLowerCase();
  const all = await store.allItems();
  return all.find((i) => !i.deleted && !i.isFolder && i.name.toLowerCase() === target) ?? all.find((i) => !i.deleted && !i.isFolder && i.name.toLowerCase().startsWith(target + '.'));
}
