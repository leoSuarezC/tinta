import { useEffect, useState } from 'react';
import {
  AudioLines,
  Camera,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  Folder,
  FolderInput,
  FolderPlus,
  NotebookText,
  PenLine,
  Pencil,
  RefreshCw,
  Star,
  StarOff,
  Trash2,
  Upload,
} from 'lucide-react';
import { useServices } from '../app/services';
import { go, useApp } from '../app/state';
import { useItem } from '../app/hooks';
import { createInk, createNote, downloadBlob, driveUrl, openItem, pickFiles, saveFiles } from '../app/actions';
import { ROOT_LID } from '../sync/SyncEngine';
import type { Template } from '../ink/pdfInk';
import { extOf, sanitizeName } from '../model/fileTypes';
import { cls, KindIcon, Sheet } from './common';
import { displayName, fullDate, itemKind, KIND_LABEL, sinceText } from './format';
import { RecorderSheet } from './Recorder';
import { SettingsSheet } from './Settings';
import { ShareSheet } from './ShareSheet';
import { FolderBrowser } from './FolderBrowser';

export function Dialogs() {
  const dialog = useApp((s) => s.dialog);
  const close = useApp((s) => s.closeDialog);
  if (!dialog) return null;
  const onClose = () => void close();
  switch (dialog.type) {
    case 'new':
      return <NewSheet folder={dialog.folder} onClose={onClose} />;
    case 'item':
      return <ItemSheet lid={dialog.lid} onClose={onClose} />;
    case 'rename':
      return <RenameSheet lid={dialog.lid} onClose={onClose} />;
    case 'move':
      return <MoveSheet lid={dialog.lid} onClose={onClose} />;
    case 'delete':
      return <DeleteSheet lid={dialog.lid} onClose={onClose} />;
    case 'newFolder':
      return <NewFolderSheet folder={dialog.folder} onClose={onClose} />;
    case 'newInk':
      return <NewInkSheet folder={dialog.folder} onClose={onClose} />;
    case 'recorder':
      return <RecorderSheet folder={dialog.folder} onSaved={dialog.onSaved} onClose={onClose} />;
    case 'settings':
      return <SettingsSheet onClose={onClose} />;
    case 'sync':
      return <SyncSheet onClose={onClose} />;
    case 'share':
      return <ShareSheet onClose={onClose} />;
  }
}

function Action({ icon, label, hint, onClick, danger }: { icon: React.ReactNode; label: string; hint?: string; onClick: () => void; danger?: boolean }) {
  return (
    <button className={cls('action', danger && 'is-danger')} onClick={onClick}>
      <span className="action-icon">{icon}</span>
      <span className="action-text">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </span>
    </button>
  );
}

function NewSheet({ folder, onClose }: { folder: string; onClose: () => void }) {
  const s = useServices();
  const { openDialog, closeDialog } = useApp.getState();
  const folderItem = useItem(folder);
  const then = async (fn: () => Promise<unknown> | void) => {
    await closeDialog();
    await fn();
  };
  return (
    <Sheet title={`Crear en «${folderItem?.name ?? ''}»`} onClose={onClose} className="new-sheet">
      <div className="action-grid">
        <Action icon={<NotebookText size={24} />} label="Nota" hint="Markdown, con listas y tareas" onClick={() => void then(() => createNote(s, folder, 'md'))} />
        <Action icon={<PenLine size={24} />} label="Nota a mano" hint="Con el lápiz o el dedo" onClick={() => openDialog({ type: 'newInk', folder })} />
        <Action icon={<AudioLines size={24} />} label="Audio" hint="Grabar una nota de voz" onClick={() => openDialog({ type: 'recorder', folder })} />
        <Action
          icon={<Camera size={24} />}
          label="Foto"
          hint="Con la cámara"
          onClick={() =>
            void then(async () => {
              const files = await pickFiles({ accept: 'image/*', capture: 'environment' });
              if (files.length) await saveFiles(s, folder, files, { open: true });
            })
          }
        />
        <Action
          icon={<Upload size={24} />}
          label="Subir archivos"
          hint="PDF, imágenes, audio…"
          onClick={() =>
            void then(async () => {
              const files = await pickFiles({ multiple: true });
              if (files.length) await saveFiles(s, folder, files, { open: files.length === 1 });
            })
          }
        />
        <Action icon={<FolderPlus size={24} />} label="Carpeta" onClick={() => openDialog({ type: 'newFolder', folder })} />
        <Action icon={<FileText size={24} />} label="Texto simple" hint="Archivo .txt" onClick={() => void then(() => createNote(s, folder, 'txt'))} />
      </div>
    </Sheet>
  );
}

const TEMPLATES: { id: Template; label: string }[] = [
  { id: 'rayado', label: 'Rayado' },
  { id: 'cuadriculado', label: 'Cuadriculado' },
  { id: 'puntos', label: 'Puntos' },
  { id: 'blanco', label: 'En blanco' },
];

function NewInkSheet({ folder, onClose }: { folder: string; onClose: () => void }) {
  const s = useServices();
  const template = useApp((st) => st.settings.template);
  const update = useApp((st) => st.updateSettings);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    await useApp.getState().closeDialog();
    await createInk(s, folder, template, name);
  };
  return (
    <Sheet
      title="Nota a mano"
      onClose={onClose}
      footer={
        <button className="btn primary wide" onClick={() => void create()} disabled={busy}>
          Crear cuaderno
        </button>
      }
    >
      <div className="templates" role="radiogroup" aria-label="Papel">
        {TEMPLATES.map((t) => (
          <button key={t.id} role="radio" aria-checked={template === t.id} className={cls('template', template === t.id && 'is-on')} onClick={() => update({ template: t.id })}>
            <span className={cls('paper', `paper-${t.id}`)} aria-hidden="true" />
            <span>{t.label}</span>
          </button>
        ))}
      </div>
      <label className="field">
        <span>Nombre (opcional)</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="A mano y la fecha de hoy" onKeyDown={(e) => e.key === 'Enter' && void create()} />
      </label>
      <p className="field-hint">Se guarda como PDF: se ve en Drive, en el Boox y en cualquier lector.</p>
    </Sheet>
  );
}

function NewFolderSheet({ folder, onClose }: { folder: string; onClose: () => void }) {
  const { engine } = useServices();
  const [name, setName] = useState('');
  const create = async () => {
    const n = sanitizeName(name);
    if (!name.trim()) return;
    await useApp.getState().closeDialog();
    const f = await engine.createFolder(folder, n);
    openItem(f);
  };
  return (
    <Sheet
      title="Carpeta nueva"
      onClose={onClose}
      footer={
        <button className="btn primary wide" onClick={() => void create()} disabled={!name.trim()}>
          Crear carpeta
        </button>
      }
    >
      <label className="field">
        <span>Nombre</span>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void create()} />
      </label>
    </Sheet>
  );
}

function ItemSheet({ lid, onClose }: { lid: string; onClose: () => void }) {
  const s = useServices();
  const item = useItem(lid);
  const { openDialog, closeDialog, toast } = useApp.getState();
  if (!item) return null;
  const kind = itemKind(item);
  const link = driveUrl(item);
  const then = async (fn: () => Promise<unknown> | void) => {
    await closeDialog();
    await fn();
  };
  return (
    <Sheet title={displayName(item)} onClose={onClose} className="item-sheet">
      <div className="item-summary">
        <KindIcon kind={kind} mimeType={item.mimeType} size={28} />
        <div>
          <p>{KIND_LABEL[kind]}</p>
          <small>{item.modifiedTime ? `Modificado: ${fullDate(item.modifiedTime)}` : ''}</small>
          {item.syncError && <small className="form-error">Error al subir: {item.syncError}</small>}
        </div>
      </div>
      <div className="action-list">
        <Action icon={item.isFolder ? <Folder size={22} /> : <ChevronRight size={22} />} label="Abrir" onClick={() => void then(() => openItem(item))} />
        {item.canEdit && <Action icon={<Pencil size={22} />} label="Cambiar nombre" onClick={() => openDialog({ type: 'rename', lid })} />}
        <Action icon={<FolderInput size={22} />} label="Mover a otra carpeta" onClick={() => openDialog({ type: 'move', lid })} />
        <Action
          icon={item.starred ? <StarOff size={22} /> : <Star size={22} />}
          label={item.starred ? 'Quitar de destacadas' : 'Destacar'}
          hint={item.starred ? undefined : 'Aparece arriba en la carpeta principal'}
          onClick={() => void then(() => s.engine.setStarred(lid, !item.starred))}
        />
        {!item.isFolder && kind !== 'google' && kind !== 'shortcut' && (
          <Action
            icon={<Download size={22} />}
            label="Descargar"
            onClick={() =>
              void then(async () => {
                try {
                  downloadBlob(await s.engine.readBlob(lid), item.name);
                } catch {
                  toast('Sin conexión: no se pudo descargar', { tone: 'error' });
                }
              })
            }
          />
        )}
        {link && (
          <Action
            icon={<ExternalLink size={22} />}
            label="Abrir en Google Drive"
            onClick={() =>
              void then(() => {
                window.open(link, '_blank', 'noopener');
              })
            }
          />
        )}
        <Action icon={<Trash2 size={22} />} label="Eliminar" danger onClick={() => openDialog({ type: 'delete', lid })} />
      </div>
    </Sheet>
  );
}

function RenameSheet({ lid, onClose }: { lid: string; onClose: () => void }) {
  const { engine } = useServices();
  const item = useItem(lid);
  const [name, setName] = useState('');
  useEffect(() => {
    if (item) setName(displayName(item));
  }, [item?.lid]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!item) return null;
  const save = async () => {
    const v = name.trim();
    if (!v) return;
    const shown = displayName(item);
    const ext = extOf(item.name);
    const next = shown !== item.name && ext && extOf(v) !== ext ? `${v}.${ext}` : v;
    await useApp.getState().closeDialog();
    if (next !== item.name) await engine.rename(lid, sanitizeName(next));
  };
  return (
    <Sheet
      title="Cambiar nombre"
      onClose={onClose}
      footer={
        <button className="btn primary wide" onClick={() => void save()} disabled={!name.trim()}>
          Guardar nombre
        </button>
      }
    >
      <label className="field">
        <span>Nombre</span>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onFocus={(e) => e.currentTarget.select()} onKeyDown={(e) => e.key === 'Enter' && void save()} />
      </label>
    </Sheet>
  );
}

function MoveSheet({ lid, onClose }: { lid: string; onClose: () => void }) {
  const { engine } = useServices();
  const item = useItem(lid);
  const toast = useApp((s) => s.toast);
  if (!item) return null;
  return (
    <Sheet title={`Mover «${displayName(item)}»`} onClose={onClose}>
      <FolderBrowser
        start={item.parentLid ?? ROOT_LID}
        exclude={item.isFolder ? item.lid : undefined}
        chooseLabel={(n) => `Mover a «${n}»`}
        onChoose={async (target) => {
          try {
            await engine.move(lid, target);
            await useApp.getState().closeDialog();
            toast('Movido');
          } catch (e) {
            toast((e as Error).message, { tone: 'error' });
          }
        }}
      />
    </Sheet>
  );
}

function DeleteSheet({ lid, onClose }: { lid: string; onClose: () => void }) {
  const { engine } = useServices();
  const item = useItem(lid);
  const route = useApp((s) => s.route);
  if (!item) return null;
  const remove = async () => {
    await useApp.getState().closeDialog();
    const parent = item.parentLid ?? ROOT_LID;
    await engine.remove(lid);
    if (route.file === lid || route.folder === lid) go({ folder: parent }, { replace: true });
    useApp.getState().toast(`«${displayName(item)}» se movió a la papelera de Drive`);
  };
  return (
    <Sheet
      title="¿Eliminar?"
      onClose={onClose}
      footer={
        <div className="btn-row end">
          <button className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn danger" onClick={() => void remove()}>
            Eliminar
          </button>
        </div>
      }
    >
      <p className="confirm-text">
        «{displayName(item)}»{item.isFolder ? ' y todo lo que contiene' : ''} va a la papelera de Google Drive. Desde ahí se puede recuperar durante 30 días.
      </p>
    </Sheet>
  );
}

function SyncSheet({ onClose }: { onClose: () => void }) {
  const s = useServices();
  const status = useApp((st) => st.status);
  const [email, setEmail] = useState<string>();
  useEffect(() => {
    if (s.mode === 'demo') setEmail('modo demo');
    else setEmail(s.auth?.loginHint ?? undefined);
  }, [s]);
  const { state, pending, lastSyncAt, message } = status;
  let title = 'Todo está en Drive';
  let body = 'Las notas de este dispositivo y las de Drive coinciden.';
  if (state === 'syncing') {
    title = 'Sincronizando…';
    body = 'Revisando cambios en Drive y subiendo los de este dispositivo.';
  } else if (state === 'offline') {
    title = 'Sin conexión';
    body = pending ? `${pending} ${pending === 1 ? 'cambio espera' : 'cambios esperan'} en este dispositivo y se subirán al volver internet.` : 'Puedes seguir trabajando: todo se guarda aquí y se sube después.';
  } else if (state === 'auth') {
    title = 'Hay que reconectar con Google';
    body = 'La sesión de Google venció. Tus cambios están guardados en este dispositivo.';
  } else if (state === 'error') {
    title = 'Algo no se pudo sincronizar';
    body = message ?? 'Error desconocido';
  } else if (pending) {
    title = `${pending} ${pending === 1 ? 'cambio' : 'cambios'} por subir`;
    body = 'Se suben en unos segundos.';
  }
  return (
    <Sheet title="Sincronización" onClose={onClose}>
      <div className={cls('sync-summary', `is-${state}`)}>
        <p className="sync-title">{title}</p>
        <p>{body}</p>
        <p className="sync-meta">
          Última revisión: {sinceText(lastSyncAt)}
          {email ? <><br />Cuenta: {email}</> : null}
        </p>
      </div>
      <div className="btn-row">
        {state === 'auth' && s.auth ? (
          <button className="btn primary" onClick={() => s.auth!.signIn({ returnTo: location.hash })}>
            Reconectar con Google
          </button>
        ) : (
          <button className="btn primary" onClick={() => void s.engine.sync()} disabled={state === 'syncing'}>
            <RefreshCw size={18} /> Sincronizar ahora
          </button>
        )}
      </div>
    </Sheet>
  );
}
