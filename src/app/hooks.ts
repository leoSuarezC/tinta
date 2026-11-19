import { useEffect, useRef, useState } from 'react';
import type { LocalItem } from '../db/db';
import { useServices } from './services';
import { useApp } from './state';

const collator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });

export function sortItems(items: LocalItem[], sort: 'name' | 'modified'): LocalItem[] {
  return [...items].sort((a, b) => {
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
    if (sort === 'modified' && !a.isFolder) {
      return (b.modifiedTime ?? '').localeCompare(a.modifiedTime ?? '');
    }
    return collator.compare(a.name, b.name);
  });
}

/** Ejecuta una consulta a la base local y la repite cada vez que cambian los datos. */
export function useQuery<T>(fn: () => Promise<T>, deps: unknown[], initial: T): T {
  const version = useApp((s) => s.version);
  const [value, setValue] = useState<T>(initial);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    let alive = true;
    fnRef.current().then((v) => alive && setValue(v)).catch(() => undefined);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, ...deps]);
  return value;
}

export function useItem(lid: string | undefined): LocalItem | undefined | null {
  const { store } = useServices();
  // null = cargando; undefined = no existe
  return useQuery(async () => (lid ? await store.getItem(lid) : undefined), [lid], null as LocalItem | undefined | null);
}

export function useChildren(lid: string): LocalItem[] | null {
  const { store } = useServices();
  const sort = useApp((s) => s.settings.sort);
  return useQuery(async () => sortItems(await store.children(lid), sort), [lid, sort], null as LocalItem[] | null);
}

export function useAllItems(): LocalItem[] {
  const { store } = useServices();
  return useQuery(() => store.allItems(), [], [] as LocalItem[]);
}

/** Cadena de carpetas desde la raíz hasta `lid` (incluido). */
export function useAncestors(lid: string | undefined): LocalItem[] {
  const { store } = useServices();
  return useQuery(
    async () => {
      const out: LocalItem[] = [];
      let cur = lid ? await store.getItem(lid) : undefined;
      let guard = 0;
      while (cur && guard++ < 64) {
        out.unshift(cur);
        cur = cur.parentLid ? await store.getItem(cur.parentLid) : undefined;
      }
      return out;
    },
    [lid],
    [] as LocalItem[],
  );
}

export function useMediaQuery(q: string): boolean {
  const [m, setM] = useState(() => matchMedia(q).matches);
  useEffect(() => {
    const mq = matchMedia(q);
    const on = () => setM(mq.matches);
    mq.addEventListener('change', on);
    on();
    return () => mq.removeEventListener('change', on);
  }, [q]);
  return m;
}

export const WIDE_QUERY = '(min-width: 760px)';

/** URL temporal (object URL) para un blob; se libera sola. */
export function useObjectUrl(blob: Blob | null | undefined): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!blob) {
      setUrl(undefined);
      return;
    }
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url;
}

/** Registro de funciones que guardan cambios pendientes (antes de una redirección a Google, por ejemplo). */
const flushers = new Set<() => Promise<void> | void>();
export function registerFlush(fn: () => Promise<void> | void) {
  flushers.add(fn);
  return () => void flushers.delete(fn);
}
export async function flushAll() {
  await Promise.all([...flushers].map((f) => Promise.resolve(f()).catch(() => undefined)));
}

let holds = 0;
/** Mientras haya algo en curso (p. ej. una grabación) no se hace la redirección a Google. */
export function holdReauth() {
  holds++;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      holds--;
    }
  };
}
export function reauthHeld() {
  return holds > 0;
}

let lastInputAt = 0;
export function markUserInput() {
  lastInputAt = Date.now();
}
export function msSinceInput() {
  return Date.now() - lastInputAt;
}
