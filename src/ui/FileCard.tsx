import { useEffect, useRef, useState } from 'react';
import { EllipsisVertical, Star } from 'lucide-react';
import { useServices } from '../app/services';
import { useItem, useObjectUrl, useQuery } from '../app/hooks';
import { useApp } from '../app/state';
import { openItem } from '../app/actions';
import type { LocalItem } from '../db/db';
import { ROOT_LID } from '../sync/SyncEngine';
import { isTextKind, type FileKind } from '../model/fileTypes';
import { notePreview } from '../lib/preview';
import { cls, KindIcon, useLongPress } from './common';
import { displayName, isPending, itemKind, relativeDate } from './format';

/** Tarjeta de un archivo con vista previa de su contenido. Al tocarla se abre el editor. */
export function FileCard({ item, active, showFolder }: { item: LocalItem; active?: boolean; showFolder?: boolean }) {
  const openDialog = useApp((s) => s.openDialog);
  const parent = useItem(showFolder ? (item.parentLid ?? undefined) : undefined);
  const lp = useLongPress(() => openDialog({ type: 'item', lid: item.lid }));
  const kind = itemKind(item);
  const pending = isPending(item);
  const ref = useRef<HTMLLIElement>(null);
  const visible = useInView(ref);
  const name = displayName(item);
  const where = showFolder && parent && parent.lid !== ROOT_LID ? `En ${parent.name}` : relativeDate(item.modifiedTime);

  return (
    <li ref={ref} className={cls('card', active && 'is-active', item.syncError && 'has-error')}>
      <button
        className="card-main"
        {...lp}
        onClick={() => {
          if (lp.consumed()) return;
          openItem(item);
        }}
        aria-current={active ? 'page' : undefined}
      >
        <span className={cls('card-preview', `k-${kind}`)} aria-hidden="true">
          {visible ? <Preview item={item} kind={kind} /> : null}
        </span>
        <span className="card-foot">
          <span className="row-name card-name">{name}</span>
          <span className="card-meta">
            <span className={cls('card-kind', `k-${kind}`)}>
              <KindIcon kind={kind} mimeType={item.mimeType} size={14} />
            </span>
            <span className="card-date">{where}</span>
            {item.starred && <Star size={13} className="flag-star" aria-label="Destacada" />}
            {pending && (
              <span className="flag-pending" title={item.syncError ? `Error: ${item.syncError}` : 'Sin subir a Drive'}>
                <span className="sr-only">{item.syncError ? 'Error al subir' : 'Sin subir'}</span>
              </span>
            )}
          </span>
        </span>
      </button>
      <button className="icon-btn small card-more" aria-label={`Opciones de ${name}`} onClick={() => openDialog({ type: 'item', lid: item.lid })}>
        <EllipsisVertical size={18} />
      </button>
    </li>
  );
}

function Preview({ item, kind }: { item: LocalItem; kind: FileKind }) {
  if (isTextKind(kind)) return <TextPreview item={item} />;
  if (kind === 'image') return <ImagePreview item={item} />;
  if (kind === 'pdf') return <PdfPreview item={item} />;
  if (kind === 'video' || kind === 'google' || kind === 'other') return <DriveThumb item={item} kind={kind} />;
  return <BigIcon item={item} kind={kind} />;
}

function BigIcon({ item, kind }: { item: LocalItem; kind: FileKind }) {
  return (
    <span className="card-icon">
      <KindIcon kind={kind} mimeType={item.mimeType} size={34} />
    </span>
  );
}

function TextPreview({ item }: { item: LocalItem }) {
  const { store } = useServices();
  const lines = useQuery(
    async () => {
      const c = await store.getContent(item.lid);
      return c?.text === undefined ? null : notePreview(c.text, displayName(item));
    },
    [item.lid, item.name],
    null as string[] | null,
  );
  if (lines === null) return <BigIcon item={item} kind={itemKind(item)} />;
  if (!lines.length) return <span className="card-text is-empty">Nota vacía</span>;
  return (
    <span className="card-text">
      {lines.map((l, i) => (
        <span key={i} className="card-line">
          {l || ' '}
        </span>
      ))}
    </span>
  );
}

/** Imagen guardada en el dispositivo; si no está, la miniatura de Drive. */
function ImagePreview({ item }: { item: LocalItem }) {
  const { store } = useServices();
  const opened = useApp((s) => s.route.file);
  // Abrir el archivo lo guarda en el dispositivo sin avisar a la lista: se vuelve a mirar al cambiar de archivo.
  const blob = useQuery(async () => (await store.getContent(item.lid))?.blob ?? null, [item.lid, item.rev, opened], null as Blob | null);
  const url = useObjectUrl(blob);
  if (url) return <img className="card-img" src={url} alt="" draggable={false} />;
  return <DriveThumb item={item} kind="image" />;
}

/**
 * Cuaderno o PDF: si hay cambios sin subir (o no está en Drive) se dibuja la primera página aquí;
 * si no, la miniatura de Drive (que no gasta batería en el Boox), y si Drive no tiene, la de aquí.
 */
function PdfPreview({ item }: { item: LocalItem }) {
  const local = item.dirtyContent || !item.driveId;
  if (local) return <LocalPdf item={item} />;
  return <DriveThumb item={item} kind="pdf" fallback={<LocalPdf item={item} />} />;
}

function LocalPdf({ item }: { item: LocalItem }) {
  const { store } = useServices();
  const opened = useApp((s) => s.route.file);
  const url = useQuery(
    async () => {
      const blob = (await store.getContent(item.lid))?.blob;
      return blob ? pdfThumb(`${item.lid}:${item.rev}:${blob.size}`, blob) : null;
    },
    [item.lid, item.rev, opened],
    null as string | null,
  );
  if (url) return <img className="card-img is-page" src={url} alt="" draggable={false} />;
  return <BigIcon item={item} kind="pdf" />;
}

/** Archivos cuyo enlace ya se pidió a Drive en esta sesión: no se vuelve a pedir. */
const refreshed = new Set<string>();

function DriveThumb({ item, kind, fallback }: { item: LocalItem; kind: FileKind; fallback?: React.ReactNode }) {
  const { engine } = useServices();
  const [link, setLink] = useState(item.thumbnailLink);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setLink(item.thumbnailLink);
    setFailed(false);
  }, [item.thumbnailLink]);

  const refresh = () => {
    if (!item.driveId || refreshed.has(item.lid) || !navigator.onLine) return setFailed(true);
    refreshed.add(item.lid);
    engine
      .refreshThumbnail(item.lid)
      .then((l) => (l ? setLink(l) : setFailed(true)))
      .catch(() => setFailed(true));
  };

  // Archivos sincronizados antes de que existieran las miniaturas: se pide el enlace una vez.
  useEffect(() => {
    if (!link && !failed) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link, failed]);

  if (!link || failed) return failed ? <>{fallback ?? <BigIcon item={item} kind={kind} />}</> : <BigIcon item={item} kind={kind} />;
  return (
    <img
      className={cls('card-img', kind === 'pdf' && 'is-page')}
      src={link.replace(/=s\d+$/, '=s480')}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      draggable={false}
      onError={refresh}
    />
  );
}

// ---------- miniaturas de PDF dibujadas en el dispositivo ----------

const pdfCache = new Map<string, Promise<string | null>>();
let pdfQueue: Promise<unknown> = Promise.resolve();

/** Primera página como imagen. Una a la vez, para no trabar el Boox. */
function pdfThumb(key: string, blob: Blob): Promise<string | null> {
  let p = pdfCache.get(key);
  if (!p) {
    p = pdfQueue.then(() => renderFirstPage(blob)).catch(() => null);
    pdfQueue = p;
    pdfCache.set(key, p);
    if (pdfCache.size > 80) {
      const [oldKey, old] = pdfCache.entries().next().value!;
      pdfCache.delete(oldKey);
      old.then((u) => u && URL.revokeObjectURL(u));
    }
  }
  return p;
}

async function renderFirstPage(blob: Blob): Promise<string | null> {
  const { openPdf } = await import('../ink/pdfjs');
  const pdf = await openPdf(new Uint8Array(await blob.arrayBuffer()));
  try {
    const page = await pdf.getPage(1);
    const vp1 = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: 360 / vp1.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, canvas, viewport } as Parameters<typeof page.render>[0]).promise;
    const out = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
    return out ? URL.createObjectURL(out) : null;
  } finally {
    void pdf.loadingTask.destroy();
  }
}

/** true desde que el elemento entra (o casi) en pantalla; no vuelve a false. */
function useInView(ref: React.RefObject<HTMLElement | null>) {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    if (typeof IntersectionObserver === 'undefined') return setSeen(true);
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setSeen(true), { rootMargin: '300px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, seen]);
  return seen;
}
