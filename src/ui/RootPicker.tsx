import { useEffect, useState } from 'react';
import { ChevronRight, Folder, FolderPlus, Search } from 'lucide-react';
import type { DriveApi, RemoteFile } from '../drive/types';
import { FOLDER_MIME } from '../drive/types';
import { cls } from './common';

interface Crumb {
  id: string;
  name: string;
}

/** Explorador de carpetas de Google Drive para elegir la carpeta principal de las notas. */
export function RootPicker({ drive, onPick, busy, progress }: { drive: DriveApi; onPick: (f: RemoteFile) => void; busy?: boolean; progress?: string }) {
  const [path, setPath] = useState<Crumb[]>([{ id: 'root', name: 'Mi unidad' }]);
  const [folders, setFolders] = useState<RemoteFile[] | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<RemoteFile[] | null>(null);
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('Notas');
  const current = path[path.length - 1];

  useEffect(() => {
    let alive = true;
    setFolders(null);
    setError(undefined);
    (async () => {
      const out: RemoteFile[] = [];
      let token: string | undefined;
      do {
        const page = await drive.listChildren([current.id], token, true);
        out.push(...page.files);
        token = page.nextPageToken;
      } while (token && out.length < 2000);
      out.sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true }));
      if (alive) setFolders(out);
    })().catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [drive, current.id]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults(null);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      drive
        .searchFolders(q)
        .then((r) => alive && setResults(r))
        .catch(() => alive && setResults([]));
    }, 300);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [drive, query]);

  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    const f = await drive.create({ name, mimeType: FOLDER_MIME, parents: [current.id] });
    setCreating(false);
    onPick(f);
  };

  const list = results ?? folders;
  const atRoot = current.id === 'root';

  return (
    <div className="picker">
      <div className="search">
        <Search size={18} aria-hidden="true" />
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar carpeta por nombre" aria-label="Buscar carpeta" />
      </div>
      {!results && (
        <nav className="crumbs picker-crumbs" aria-label="Ruta en Drive">
          {path.map((c, i) => (
            <button key={c.id} className={cls('crumb', i === path.length - 1 && 'is-current')} onClick={() => setPath(path.slice(0, i + 1))}>
              {c.name}
            </button>
          ))}
        </nav>
      )}
      {error && <p className="form-error">No se pudo leer Drive: {error}</p>}
      <ul className="rows picker-rows">
        {list === null && <li className="list-loading" aria-busy="true" />}
        {list?.length === 0 && <li className="picker-empty">{results ? 'Ninguna carpeta coincide.' : 'No hay subcarpetas aquí.'}</li>}
        {list?.map((f) => (
          <li key={f.id} className="row">
            <button
              className="row-main"
              onClick={() => {
                setQuery('');
                setResults(null);
                setPath(results ? [{ id: 'root', name: 'Mi unidad' }, { id: f.id, name: f.name }] : [...path, { id: f.id, name: f.name }]);
              }}
            >
              <span className="row-icon k-folder">
                <Folder size={22} strokeWidth={1.75} />
              </span>
              <span className="row-text">
                <span className="row-name">{f.name}</span>
              </span>
              <ChevronRight size={18} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
      <div className="picker-foot">
        {creating ? (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <input value={newName} onChange={(e) => setNewName(e.target.value)} aria-label="Nombre de la carpeta nueva" autoFocus />
            <button className="btn" type="submit">
              Crear y usar
            </button>
          </form>
        ) : (
          <button className="btn ghost" onClick={() => setCreating(true)} disabled={busy}>
            <FolderPlus size={18} /> Carpeta nueva en «{current.name}»
          </button>
        )}
        <button className="btn primary" disabled={atRoot || busy} onClick={() => onPick({ id: current.id, name: current.name, mimeType: FOLDER_MIME })}>
          {busy ? progress ?? 'Leyendo…' : atRoot ? 'Entra a una carpeta para elegirla' : `Usar «${current.name}»`}
        </button>
      </div>
    </div>
  );
}
