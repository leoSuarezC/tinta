import { useState } from 'react';
import { ChevronRight, Folder } from 'lucide-react';
import { useAncestors, useChildren, useItem } from '../app/hooks';
import { cls } from './common';

/** Explorador de carpetas locales (para mover y para guardar lo compartido). */
export function FolderBrowser({ start, exclude, onChoose, chooseLabel }: { start: string; exclude?: string; onChoose: (lid: string) => void; chooseLabel: (name: string) => string }) {
  const [cur, setCur] = useState(start);
  const folder = useItem(cur);
  const kids = useChildren(cur);
  const path = useAncestors(cur);
  const folders = (kids ?? []).filter((k) => k.isFolder && k.lid !== exclude);
  return (
    <div className="picker">
      <nav className="crumbs picker-crumbs" aria-label="Ruta">
        {path.map((c, i) => (
          <button key={c.lid} className={cls('crumb', i === path.length - 1 && 'is-current')} onClick={() => setCur(c.lid)}>
            {c.name}
          </button>
        ))}
      </nav>
      <ul className="rows picker-rows">
        {kids === null && <li className="list-loading" aria-busy="true" />}
        {kids && folders.length === 0 && <li className="picker-empty">No hay subcarpetas.</li>}
        {folders.map((f) => (
          <li key={f.lid} className="row">
            <button className="row-main" onClick={() => setCur(f.lid)}>
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
        <button className="btn primary wide" onClick={() => onChoose(cur)}>
          {chooseLabel(folder?.name ?? '')}
        </button>
      </div>
    </div>
  );
}

