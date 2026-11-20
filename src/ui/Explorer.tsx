import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { ArrowDownUp, ArrowLeft, EllipsisVertical, FolderOpen, Plus, Search, Settings, Star, X } from 'lucide-react';
import { useServices } from '../app/services';
import { useAllItems, useAncestors, useChildren, useItem, useQuery } from '../app/hooks';
import { go, useApp } from '../app/state';
import { openItem, saveFiles } from '../app/actions';
import type { LocalItem } from '../db/db';
import { ROOT_LID } from '../sync/SyncEngine';
import { formatBytes } from '../model/fileTypes';
import { cls, Empty, KindIcon, useLongPress } from './common';
import { displayName, fold, isPending, itemKind, KIND_LABEL, relativeDate } from './format';
import { SyncButton } from './SyncButton';
import { FileCard } from './FileCard';
import { PageButtons } from './PageButtons';

export function Explorer() {
  const route = useApp((s) => s.route);
  const query = useApp((s) => s.query);
  const folder = useItem(route.folder);
  const s = useServices();
  const toast = useApp((st) => st.toast);
  const [dragging, setDragging] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // Carpeta borrada o inexistente: volver a la raíz.
  useEffect(() => {
    if (route.folder === ROOT_LID) return;
    if (folder === undefined) go({ folder: ROOT_LID }, { replace: true });
    else if (folder?.deleted) go({ folder: folder.parentLid ?? ROOT_LID }, { replace: true });
  }, [folder, route.folder]);

  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length) {
      await saveFiles(s, route.folder, files, { open: files.length === 1 });
      if (files.length === 1) toast(`«${files[0].name}» guardado`);
    }
  };

  return (
    <section
      className={cls('explorer', dragging && 'is-dragging')}
      aria-label="Archivos"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <ExplorerHeader folder={folder ?? undefined} />
      <SearchField />
      <div className="explorer-scroll" ref={listRef}>
        {query.trim() ? <SearchResults query={query} /> : <FolderList folderLid={route.folder} />}
      </div>
      <PageButtons target={listRef} />
      <button className="fab" onClick={() => useApp.getState().openDialog({ type: 'new', folder: route.folder })} aria-label="Crear">
        <Plus size={28} strokeWidth={2.25} />
      </button>
      {dragging && (
        <div className="drop-hint" aria-hidden="true">
          Suelta para guardar en «{folder?.name}»
        </div>
      )}
    </section>
  );
}

function ExplorerHeader({ folder }: { folder?: LocalItem }) {
  const ancestors = useAncestors(folder?.lid);
  const openDialog = useApp((s) => s.openDialog);
  const isRoot = !folder || folder.lid === ROOT_LID;
  const crumbs = ancestors.slice(0, -1);
  return (
    <header className="explorer-head">
      <div className="explorer-bar">
        {!isRoot && (
          <button className="icon-btn" aria-label="Carpeta anterior" onClick={() => go({ folder: folder?.parentLid ?? ROOT_LID })}>
            <ArrowLeft size={22} />
          </button>
        )}
        <h1 className="folder-title" title={folder?.name}>
          {folder?.name ?? ' '}
        </h1>
        <SyncButton />
        <button className="icon-btn" aria-label="Ajustes" onClick={() => openDialog({ type: 'settings' })}>
          <Settings size={21} />
        </button>
      </div>
      {crumbs.length > 0 && (
        <nav className="crumbs" aria-label="Ruta">
          {crumbs.map((c) => (
            <button key={c.lid} className="crumb" onClick={() => go({ folder: c.lid })}>
              {c.name}
            </button>
          ))}
        </nav>
      )}
    </header>
  );
}

function SearchField() {
  const query = useApp((s) => s.query);
  const setQuery = useApp((s) => s.setQuery);
  const rootName = useItem(ROOT_LID)?.name;
  return (
    <div className="search">
      <Search size={18} aria-hidden="true" />
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={`Buscar en ${rootName ?? 'tus notas'}`}
        aria-label="Buscar"
        enterKeyHint="search"
      />
      {query && (
        <button className="icon-btn small" aria-label="Borrar búsqueda" onClick={() => setQuery('')}>
          <X size={18} />
        </button>
      )}
    </div>
  );
}

function FolderList({ folderLid }: { folderLid: string }) {
  const items = useChildren(folderLid);
  const all = useAllItems();
  const fileLid = useApp((s) => s.route.file);
  const isRoot = folderLid === ROOT_LID;

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of all) if (!i.deleted && i.parentLid) m.set(i.parentLid, (m.get(i.parentLid) ?? 0) + 1);
    return m;
  }, [all]);

  const starred = useMemo(() => {
    if (!isRoot) return [];
    const byLid = new Map(all.map((i) => [i.lid, i]));
    const alive = (i: LocalItem) => {
      let cur: LocalItem | undefined = i;
      let n = 0;
      while (cur && n++ < 64) {
        if (cur.deleted) return false;
        cur = cur.parentLid ? byLid.get(cur.parentLid) : undefined;
      }
      return true;
    };
    return all.filter((i) => i.starred && i.lid !== ROOT_LID && alive(i)).sort((a, b) => a.name.localeCompare(b.name, 'es'));
  }, [all, isRoot]);

  if (items === null) return <div className="list-loading" aria-busy="true" />;

  return (
    <>
      {starred.length > 0 && (
        <section className="group">
          <h2 className="group-title">
            <Star size={15} aria-hidden="true" /> Destacadas
          </h2>
          <Items items={starred} fileLid={fileLid} counts={counts} showFolder keyPrefix="s-" />
        </section>
      )}
      {items.length === 0 ? (
        <Empty icon={<FolderOpen size={40} strokeWidth={1.5} />} title="Esta carpeta está vacía">
          Toca <strong>+</strong> para escribir la primera nota.
        </Empty>
      ) : (
        <section className="group">
          <div className="group-head">
            <h2 className="group-title">{starred.length > 0 ? 'Todo' : <span className="sr-only">Contenido</span>}</h2>
            <SortToggle />
          </div>
          <Items items={items} fileLid={fileLid} counts={counts} />
        </section>
      )}
    </>
  );
}

/** Carpetas como filas arriba; archivos como tarjetas con vista previa debajo. */
function Items({
  items,
  fileLid,
  counts,
  showFolder,
  keyPrefix = '',
}: {
  items: LocalItem[];
  fileLid?: string;
  counts: Map<string, number>;
  showFolder?: boolean;
  keyPrefix?: string;
}) {
  const folders = items.filter((i) => i.isFolder);
  const files = items.filter((i) => !i.isFolder);
  return (
    <>
      {folders.length > 0 && (
        <ul className="rows">
          {folders.map((i) => (
            <ItemRow key={keyPrefix + i.lid} item={i} active={i.lid === fileLid} count={counts.get(i.lid)} showFolder={showFolder} />
          ))}
        </ul>
      )}
      {files.length > 0 && (
        <ul className="cards">
          {files.map((i) => (
            <FileCard key={keyPrefix + i.lid} item={i} active={i.lid === fileLid} showFolder={showFolder} />
          ))}
        </ul>
      )}
    </>
  );
}

function SortToggle() {
  const sort = useApp((s) => s.settings.sort);
  const update = useApp((s) => s.updateSettings);
  return (
    <button
      className="sort-btn"
      onClick={() => update({ sort: sort === 'name' ? 'modified' : 'name' })}
      aria-label={sort === 'name' ? 'Ordenado por nombre. Cambiar a recientes primero' : 'Recientes primero. Cambiar a orden por nombre'}
    >
      <ArrowDownUp size={15} aria-hidden="true" />
      {sort === 'name' ? 'Nombre' : 'Recientes'}
    </button>
  );
}

export function ItemRow({ item, active, count, showFolder, snippet }: { item: LocalItem; active?: boolean; count?: number; showFolder?: boolean; snippet?: React.ReactNode }) {
  const openDialog = useApp((s) => s.openDialog);
  const parent = useItem(showFolder ? (item.parentLid ?? undefined) : undefined);
  const lp = useLongPress(() => openDialog({ type: 'item', lid: item.lid }));
  const kind = itemKind(item);
  const pending = isPending(item);

  let meta: string;
  if (item.isFolder) meta = count ? `${count} ${count === 1 ? 'elemento' : 'elementos'}` : 'Vacía';
  else {
    const size = kind === 'markdown' || kind === 'text' ? '' : formatBytes(item.size);
    meta = [KIND_LABEL[kind], size].filter(Boolean).join(', ');
  }
  if (showFolder && parent && parent.lid !== ROOT_LID) meta = `En ${parent.name}`;

  return (
    <li className={cls('row', active && 'is-active', item.syncError && 'has-error')}>
      <button
        className="row-main"
        {...lp}
        onClick={() => {
          if (lp.consumed()) return;
          openItem(item);
        }}
        aria-current={active ? 'page' : undefined}
      >
        <span className={cls('row-icon', `k-${kind}`)}>
          <KindIcon kind={kind} mimeType={item.mimeType} />
        </span>
        <span className="row-text">
          <span className="row-name">{displayName(item)}</span>
          {snippet ? <span className="row-snippet">{snippet}</span> : <span className="row-meta">{meta}</span>}
        </span>
        <span className="row-side">
          {!item.isFolder && <span className="row-date">{relativeDate(item.modifiedTime)}</span>}
          <span className="row-flags">
            {item.starred && <Star size={14} className="flag-star" aria-label="Destacada" />}
            {pending && (
              <span className="flag-pending" title={item.syncError ? `Error: ${item.syncError}` : 'Sin subir a Drive'}>
                <span className="sr-only">{item.syncError ? 'Error al subir' : 'Sin subir'}</span>
              </span>
            )}
          </span>
        </span>
      </button>
      <button className="icon-btn row-more" aria-label={`Opciones de ${displayName(item)}`} onClick={() => openDialog({ type: 'item', lid: item.lid })}>
        <EllipsisVertical size={20} />
      </button>
    </li>
  );
}

function SearchResults({ query }: { query: string }) {
  const { store } = useServices();
  const fileLid = useApp((s) => s.route.file);
  const q = fold(query.trim());
  const results = useQuery(
    async () => {
      const [items, contents] = await Promise.all([store.allItems(), store.allContents()]);
      const byLid = new Map(items.map((i) => [i.lid, i]));
      const text = new Map(contents.filter((c) => c.text !== undefined).map((c) => [c.lid, c.text!]));
      const alive = (i: LocalItem) => {
        let cur: LocalItem | undefined = i;
        let n = 0;
        while (cur && n++ < 64) {
          if (cur.deleted) return false;
          cur = cur.parentLid ? byLid.get(cur.parentLid) : undefined;
        }
        return true;
      };
      const out: { item: LocalItem; score: number; snippet?: [string, string, string] }[] = [];
      for (const item of items) {
        if (item.lid === ROOT_LID || !alive(item)) continue;
        const name = fold(item.name);
        let score = 0;
        if (name.startsWith(q)) score = 3;
        else if (name.includes(q)) score = 2;
        let snippet: [string, string, string] | undefined;
        const body = text.get(item.lid);
        if (body) {
          const folded = fold(body);
          const at = folded.indexOf(q);
          if (at >= 0) {
            if (!score) score = 1;
            // fold() conserva la longitud para el español (NFD + quitar tildes), así que los índices
            // sirven sobre el texto original.
            const start = Math.max(0, at - 40);
            const squash = (x: string) => x.replace(/\s+/g, ' ');
            const pre = squash(body.slice(start, at));
            const hit = body.slice(at, at + q.length);
            const post = squash(body.slice(at + q.length, at + q.length + 60));
            snippet = [(start > 0 ? '…' : '') + pre.trimStart(), hit, post];
          }
        }
        if (score) out.push({ item, score, snippet });
      }
      out.sort((a, b) => b.score - a.score || (b.item.modifiedTime ?? '').localeCompare(a.item.modifiedTime ?? ''));
      return out.slice(0, 150);
    },
    [q],
    [] as { item: LocalItem; score: number; snippet?: [string, string, string] }[],
  );

  if (!q) return null;
  if (!results.length) return <Empty title="Sin resultados">No hay notas ni archivos que contengan «{query.trim()}».</Empty>;
  return (
    <section className="group">
      <h2 className="group-title">
        {results.length} {results.length === 1 ? 'resultado' : 'resultados'}
      </h2>
      <ul className="rows">
        {results.map(({ item, snippet }) => (
          <ItemRow
            key={item.lid}
            item={item}
            active={item.lid === fileLid}
            showFolder
            snippet={
              snippet ? (
                <>
                  {snippet[0]}
                  <mark>{snippet[1]}</mark>
                  {snippet[2]}
                </>
              ) : undefined
            }
          />
        ))}
      </ul>
    </section>
  );
}
