import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, Droplet, EllipsisVertical, X } from 'lucide-react';
import { useServices } from '../app/services';
import { back, useApp } from '../app/state';
import { useMediaQuery, WIDE_QUERY } from '../app/hooks';
import type { LocalItem } from '../db/db';
import { extOf } from '../model/fileTypes';
import { cls } from './common';
import { displayName, isPending } from './format';

export function closeFile(item: LocalItem) {
  back({ folder: item.parentLid ?? 'root' });
}

export function FileHeader({ item, children, saving }: { item: LocalItem; children?: ReactNode; saving?: boolean }) {
  const wide = useMediaQuery(WIDE_QUERY);
  const openDialog = useApp((s) => s.openDialog);
  const pending = isPending(item);
  const statusLabel = saving ? 'Guardando…' : pending ? 'Guardado en este dispositivo; se sube a Drive en cuanto se pueda' : 'Guardado en Drive';
  return (
    <header className="file-head">
      <button className="icon-btn" onClick={() => closeFile(item)} aria-label={wide ? 'Cerrar' : 'Volver'}>
        {wide ? <X size={22} /> : <ArrowLeft size={22} />}
      </button>
      <TitleField item={item} />
      <span className={cls('file-status', pending && 'is-pending')} title={statusLabel} role="status" aria-label={statusLabel}>
        <Droplet size={16} strokeWidth={2} aria-hidden="true" />
        <span className="file-status-text">{saving ? 'Guardando' : pending ? 'Sin subir' : 'En Drive'}</span>
      </span>
      {children}
      <button className="icon-btn" onClick={() => openDialog({ type: 'item', lid: item.lid })} aria-label="Más opciones">
        <EllipsisVertical size={21} />
      </button>
    </header>
  );
}

function TitleField({ item }: { item: LocalItem }) {
  const { engine } = useServices();
  const [editing, setEditing] = useState(false);
  const shown = displayName(item);
  const [value, setValue] = useState(shown);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!editing) setValue(shown);
  }, [shown, editing]);
  useEffect(() => {
    if (editing) ref.current?.select();
  }, [editing]);

  if (!item.canEdit || !editing) {
    return (
      <h1 className="file-title">
        <button className="title-btn" onClick={() => item.canEdit && setEditing(true)} title={item.canEdit ? 'Cambiar nombre' : item.name} disabled={!item.canEdit}>
          {shown}
        </button>
      </h1>
    );
  }
  const commit = async () => {
    setEditing(false);
    const v = value.trim();
    if (!v || v === shown) return;
    const ext = extOf(item.name);
    const hiddenExt = shown !== item.name && ext;
    const next = hiddenExt && extOf(v) !== ext ? `${v}.${ext}` : v;
    await engine.rename(item.lid, next);
  };
  return (
    <input
      ref={ref}
      className="file-title-input"
      value={value}
      aria-label="Nombre"
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setValue(shown);
          setEditing(false);
        }
      }}
    />
  );
}
