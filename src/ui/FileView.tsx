import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { Download, ExternalLink, PenLine, RotateCw } from 'lucide-react';
import { useServices } from '../app/services';
import { useItem, useObjectUrl } from '../app/hooks';
import { go, useApp } from '../app/state';
import { downloadBlob, driveUrl } from '../app/actions';
import type { LocalItem } from '../db/db';
import { OfflineError } from '../drive/types';
import { formatBytes } from '../model/fileTypes';
import { rotateImage } from '../lib/images';
import { ROOT_LID } from '../sync/SyncEngine';
import { Empty, KindIcon } from './common';
import { FileHeader } from './FileHeader';
import { fullDate, itemKind, KIND_LABEL } from './format';
import { NoteEditor } from './NoteEditor';
import type { InkSource } from './InkEditor';

// El editor de tinta (pdf.js + pdf-lib) se carga solo cuando se abre un PDF o se anota una imagen.
const InkEditor = lazy(() => import('./InkEditor').then((m) => ({ default: m.InkEditor })));

function InkLoading({ item }: { item: LocalItem }) {
  return (
    <div className="viewer" aria-busy="true">
      <FileHeader item={item} />
      <div className="ink-loading">Abriendo…</div>
    </div>
  );
}

export function FileView({ lid }: { lid: string }) {
  const item = useItem(lid);
  const [, rerender] = useState(0);
  useEffect(() => {
    if (item === undefined) go({ folder: useApp.getState().route.folder ?? ROOT_LID }, { replace: true });
    else if (item?.deleted) go({ folder: item.parentLid ?? ROOT_LID }, { replace: true });
  }, [item]);
  if (!item || item.deleted) return <div className="viewer" aria-busy="true" />;
  const kind = itemKind(item);
  const heavy = ['pdf', 'image', 'audio', 'video'].includes(kind) && !item.cached && !item.dirtyContent && (item.size ?? 0) > LARGE_FILE;
  if (heavy && !approved.has(item.lid))
    return (
      <LargeFileGate
        key={item.lid}
        item={item}
        onApprove={() => {
          approved.add(item.lid);
          rerender((n) => n + 1);
        }}
      />
    );
  switch (kind) {
    case 'markdown':
    case 'text':
      return <NoteEditor key={item.lid} item={item} />;
    case 'pdf':
      return <PdfView key={item.lid} item={item} />;
    case 'image':
      return <ImageView key={item.lid} item={item} />;
    case 'audio':
    case 'video':
      return <MediaView key={item.lid} item={item} />;
    default:
      return <OtherView key={item.lid} item={item} />;
  }
}

const LARGE_FILE = 60 * 1024 * 1024;
const approved = new Set<string>();

/** Archivos muy pesados: se pregunta antes de descargarlos al dispositivo. */
function LargeFileGate({ item, onApprove }: { item: LocalItem; onApprove: () => void }) {
  const link = driveUrl(item);
  return (
    <div className="viewer">
      <FileHeader item={item} />
      <div className="media-stage">
        <div className="media-card">
          <KindIcon kind={itemKind(item)} size={40} />
          <p className="media-name">{item.name}</p>
          <p className="media-hint">Este archivo pesa {formatBytes(item.size)}. Para abrirlo aquí hay que descargarlo a este dispositivo.</p>
          <div className="btn-row">
            <button className="btn primary" onClick={onApprove}>
              Descargar y abrir
            </button>
            {link && (
              <a className="btn ghost" href={link} target="_blank" rel="noopener noreferrer">
                <ExternalLink size={18} /> Abrir en Drive
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Descarga (o lee de la caché) el contenido binario del archivo. */
function useBlob(item: LocalItem, reloadKey = 0) {
  const { engine } = useServices();
  const [blob, setBlob] = useState<Blob | null>(null);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let alive = true;
    setError(undefined);
    engine
      .readBlob(item.lid)
      .then((b) => alive && setBlob(b))
      .catch((e) => alive && setError(e instanceof OfflineError ? 'offline' : String((e as Error)?.message ?? e)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.lid, reloadKey]);
  return { blob, error };
}

function useReplacedKey(lid: string) {
  const { engine } = useServices();
  const [key, setKey] = useState(0);
  useEffect(() => engine.onContentReplaced((l) => l === lid && setKey((k) => k + 1)), [engine, lid]);
  return key;
}

function LoadError({ item, error }: { item: LocalItem; error: string }) {
  return (
    <div className="viewer">
      <FileHeader item={item} />
      {error === 'offline' ? (
        <Empty title="Este archivo todavía no está en este dispositivo">Conéctate a internet para abrirlo; después quedará disponible sin conexión.</Empty>
      ) : (
        <Empty title="No se pudo abrir">{error}</Empty>
      )}
    </div>
  );
}

function PdfView({ item }: { item: LocalItem }) {
  const key = useReplacedKey(item.lid);
  const { blob, error } = useBlob(item, key);
  const [source, setSource] = useState<InkSource | null>(null);
  useEffect(() => {
    let alive = true;
    if (blob) blob.arrayBuffer().then((b) => alive && setSource({ kind: 'pdf', bytes: new Uint8Array(b) }));
    return () => {
      alive = false;
    };
  }, [blob]);
  if (error) return <LoadError item={item} error={error} />;
  if (!source) return <div className="viewer" aria-busy="true"><FileHeader item={item} /><div className="ink-loading">Abriendo…</div></div>;
  return (
    <Suspense fallback={<InkLoading item={item} />}>
      <InkEditor key={key} item={item} source={source} />
    </Suspense>
  );
}

function ImageView({ item }: { item: LocalItem }) {
  const s = useServices();
  const key = useReplacedKey(item.lid);
  const [annotating, setAnnotating] = useState(false);
  const [bump, setBump] = useState(0);
  const { blob, error } = useBlob(item, key + bump);
  const url = useObjectUrl(blob);
  const toast = useApp((st) => st.toast);
  const [busy, setBusy] = useState(false);
  // Fuente estable: si cambiara en cada render, el editor de tinta se reiniciaría a mitad de un dibujo.
  const imageSource = useMemo<InkSource | null>(() => (blob ? { kind: 'image', blob } : null), [blob]);

  if (error) return <LoadError item={item} error={error} />;
  if (annotating && imageSource) {
    return (
      <Suspense fallback={<InkLoading item={item} />}>
        <InkEditor
          item={item}
          source={imageSource}
          onClose={() => {
            setAnnotating(false);
            setBump((b) => b + 1);
          }}
        />
      </Suspense>
    );
  }
  const rotate = async () => {
    if (!blob) return;
    setBusy(true);
    try {
      await s.engine.saveBlob(item.lid, await rotateImage(blob, 1));
      setBump((b) => b + 1);
    } catch (e) {
      toast(`No se pudo girar: ${(e as Error).message}`, { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const editable = item.canEdit && blob && !/svg|gif/.test(blob.type);
  return (
    <div className="viewer image-viewer">
      <FileHeader item={item}>
        {editable && (
          <>
            <button className="icon-btn" onClick={rotate} disabled={busy} aria-label="Girar a la derecha" title="Girar">
              <RotateCw size={21} />
            </button>
            <button className="icon-btn labeled" onClick={() => setAnnotating(true)} title="Dibujar sobre la imagen" aria-label="Anotar">
              <PenLine size={20} />
              <span>Anotar</span>
            </button>
          </>
        )}
      </FileHeader>
      <div className="image-stage">{url ? <img src={url} alt={item.name} /> : <div className="ink-loading">Abriendo…</div>}</div>
    </div>
  );
}

function MediaView({ item }: { item: LocalItem }) {
  const { blob, error } = useBlob(item);
  const url = useObjectUrl(blob);
  const kind = itemKind(item);
  if (error) return <LoadError item={item} error={error} />;
  return (
    <div className="viewer media-viewer">
      <FileHeader item={item} />
      <div className="media-stage">
        <div className="media-card">
          <KindIcon kind={kind} size={40} />
          <p className="media-name">{item.name}</p>
          <p className="media-meta">
            {formatBytes(item.size)}
            {item.modifiedTime ? `, ${fullDate(item.modifiedTime)}` : ''}
          </p>
          {url ? kind === 'video' ? <video src={url} controls playsInline /> : <audio src={url} controls preload="metadata" /> : <div className="ink-loading">Cargando…</div>}
        </div>
      </div>
    </div>
  );
}

function OtherView({ item }: { item: LocalItem }) {
  const { engine } = useServices();
  const toast = useApp((s) => s.toast);
  const kind = itemKind(item);
  const link = driveUrl(item);
  const google = kind === 'google' || kind === 'shortcut';
  return (
    <div className="viewer">
      <FileHeader item={item} />
      <div className="media-stage">
        <div className="media-card">
          <KindIcon kind={kind} mimeType={item.mimeType} size={40} />
          <p className="media-name">{item.name}</p>
          <p className="media-meta">
            {KIND_LABEL[kind]}
            {item.size ? `, ${formatBytes(item.size)}` : ''}
          </p>
          <p className="media-hint">
            {google ? 'Los documentos de Google se editan en Drive.' : 'Tinta no abre este tipo de archivo, pero lo mantiene sincronizado. Puedes descargarlo o abrirlo en Drive.'}
          </p>
          <div className="btn-row">
            {link && (
              <a className="btn" href={link} target="_blank" rel="noopener noreferrer">
                <ExternalLink size={18} /> Abrir en Drive
              </a>
            )}
            {!google && (
              <button
                className="btn ghost"
                onClick={async () => {
                  try {
                    downloadBlob(await engine.readBlob(item.lid), item.name);
                  } catch {
                    toast('Sin conexión: no se pudo descargar', { tone: 'error' });
                  }
                }}
              >
                <Download size={18} /> Descargar
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
