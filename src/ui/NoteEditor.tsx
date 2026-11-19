import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent } from 'react';
import {
  Bold,
  BookOpen,
  Camera,
  Code,
  Heading,
  ImagePlus,
  Italic,
  Link,
  List,
  ListTodo,
  Mic,
  MicOff,
  Pencil,
  Quote,
  AudioLines,
} from 'lucide-react';
import { useServices } from '../app/services';
import { flushAll, markUserInput, registerFlush, useMediaQuery } from '../app/hooks';
import { go, useApp } from '../app/state';
import { ATTACH_FOLDER, pickFiles, saveAttachment } from '../app/actions';
import type { LocalItem } from '../db/db';
import { OfflineError } from '../drive/types';
import { merge3 } from '../sync/merge';
import { continueList, indentLines, insertAt, toggleLinePrefix, toggleTaskAtLine, wrap, type Edit } from '../lib/editing';
import { renderMarkdown } from '../lib/markdown';
import { resolveByName, resolveRelative } from '../lib/resolve';
import { Dictation, describeDictationError, dictationSupported } from '../lib/dictation';
import { cls, Empty } from './common';
import { FileHeader } from './FileHeader';
import { formatDuration, itemKind } from './format';
import { PageButtons } from './PageButtons';
import { kindOf } from '../model/fileTypes';

export function NoteEditor({ item }: { item: LocalItem }) {
  const s = useServices();
  const { engine, store } = s;
  const isMd = itemKind(item) === 'markdown';
  const settings = useApp((st) => st.settings);
  const toast = useApp((st) => st.toast);
  const openDialog = useApp((st) => st.openDialog);
  const finePointer = useMediaQuery('(pointer: fine)');

  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [mode, setMode] = useState<'edit' | 'view' | null>(null);
  const [saving, setSaving] = useState(false);
  const [interim, setInterim] = useState('');
  const [listening, setListening] = useState(false);

  const savedRef = useRef('');
  const textRef = useRef('');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingSel = useRef<{ start: number; end: number } | null>(null);
  const dictation = useRef<Dictation | null>(null);
  const lidRef = useRef(item.lid);
  lidRef.current = item.lid;
  // Archivos con saltos de línea de Windows (CRLF): se editan con \n y se guardan como estaban.
  const crlfRef = useRef(false);
  const toDisk = (s: string) => (crlfRef.current ? s.replace(/\r?\n/g, '\r\n') : s);
  const fromDisk = (s: string) => s.replace(/\r\n/g, '\n');

  // ---- carga ----
  useEffect(() => {
    let alive = true;
    setText(null);
    setError(undefined);
    setMode(null);
    engine
      .readText(item.lid)
      .then((raw) => {
        if (!alive) return;
        crlfRef.current = /\r\n/.test(raw);
        const t = fromDisk(raw);
        savedRef.current = t;
        textRef.current = t;
        setText(t);
        setMode(!isMd || !t.trim() || finePointer ? 'edit' : 'view');
      })
      .catch((e) => alive && setError(e instanceof OfflineError ? 'offline' : String((e as Error)?.message ?? e)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.lid]);

  // ---- guardado ----
  const flush = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = undefined;
    }
    const lid = lidRef.current;
    const sent = textRef.current;
    const base = savedRef.current;
    if (sent === base) return;
    setSaving(true);
    try {
      const stored = fromDisk(await engine.saveText(lid, toDisk(sent), toDisk(base)));
      if (lidRef.current !== lid) return;
      savedRef.current = stored;
      if (textRef.current === sent) {
        if (stored !== sent) {
          textRef.current = stored;
          setText(stored);
        }
      } else {
        const merged = merge3(textRef.current, sent, stored).merged;
        textRef.current = merged;
        setText(merged);
        timer.current = setTimeout(() => void flush(), 400);
      }
    } finally {
      setSaving(false);
    }
  }, [engine]);

  useEffect(() => registerFlush(flush), [flush]);
  useEffect(() => {
    const lid = item.lid;
    return () => {
      // Al cambiar de archivo o salir: guarda lo pendiente del archivo anterior.
      if (textRef.current !== savedRef.current) void engine.saveText(lid, toDisk(textRef.current), toDisk(savedRef.current));
      if (timer.current) clearTimeout(timer.current);
      dictation.current?.stop();
    };
  }, [item.lid, engine]);

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') void flush();
    };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, [flush]);

  // Llegó una versión nueva desde Drive mientras la nota está abierta.
  useEffect(
    () =>
      engine.onContentReplaced(async (lid) => {
        if (lid !== lidRef.current) return;
        if (textRef.current !== savedRef.current) {
          await flush();
          return;
        }
        const c = await store.getContent(lid);
        const incoming = c?.text !== undefined ? fromDisk(c.text) : undefined;
        if (incoming !== undefined && incoming !== savedRef.current) {
          savedRef.current = incoming;
          textRef.current = incoming;
          setText(incoming);
          toast('La nota se actualizó con cambios de otro dispositivo');
        }
      }),
    [engine, store, flush, toast],
  );

  const change = useCallback(
    (t: string) => {
      textRef.current = t;
      setText(t);
      markUserInput();
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), 450);
    },
    [flush],
  );

  // ---- edición ----
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
    if (pendingSel.current) {
      ta.setSelectionRange(pendingSel.current.start, pendingSel.current.end);
      pendingSel.current = null;
    }
  }, [text, mode, settings.noteSize]);

  /** Aplica una edición; usa insertText cuando se puede para conservar Deshacer (Ctrl+Z). */
  const apply = useCallback(
    (edit: Edit) => {
      const ta = taRef.current;
      const prev = textRef.current;
      if (ta && document.activeElement === ta) {
        let a = 0;
        while (a < prev.length && a < edit.text.length && prev[a] === edit.text[a]) a++;
        let b = 0;
        while (b < prev.length - a && b < edit.text.length - a && prev[prev.length - 1 - b] === edit.text[edit.text.length - 1 - b]) b++;
        ta.setSelectionRange(a, prev.length - b);
        const ok = document.execCommand('insertText', false, edit.text.slice(a, edit.text.length - b));
        if (ok && ta.value === edit.text) {
          ta.setSelectionRange(edit.start, edit.end);
          change(edit.text);
          return;
        }
      }
      pendingSel.current = { start: edit.start, end: edit.end };
      change(edit.text);
    },
    [change],
  );

  const sel = () => {
    const ta = taRef.current;
    return ta ? { start: ta.selectionStart, end: ta.selectionEnd } : { start: textRef.current.length, end: textRef.current.length };
  };

  const onInput = (e: FormEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget;
    const next = ta.value;
    const prev = textRef.current;
    const pos = ta.selectionStart;
    // Salto de línea dentro de una lista: continuar la viñeta (funciona también con teclados Android).
    if (isMd && next.length === prev.length + 1 && next[pos - 1] === '\n' && next.slice(0, pos - 1) + next.slice(pos) === prev) {
      const edit = continueList(prev, pos - 1, pos - 1);
      if (edit) {
        pendingSel.current = { start: edit.start, end: edit.end };
        ta.value = edit.text;
        ta.setSelectionRange(edit.start, edit.end);
        change(edit.text);
        return;
      }
    }
    change(next);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const mod = e.ctrlKey || e.metaKey;
    const { start, end } = sel();
    const t = textRef.current;
    if (mod && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      apply(wrap(t, start, end, '**'));
    } else if (mod && e.key.toLowerCase() === 'i') {
      e.preventDefault();
      apply(wrap(t, start, end, '*'));
    } else if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void flush().then(() => engine.sync());
    } else if (e.key === 'Tab' && isMd) {
      const line = t.slice(t.lastIndexOf('\n', start - 1) + 1);
      if (/^\s*([-*+]|\d+[.)])\s/.test(line)) {
        e.preventDefault();
        apply(indentLines(t, start, end, e.shiftKey));
      }
    }
  };

  // ---- adjuntos ----
  const insertMarkdown = useCallback(
    (snippet: string, block = true) => {
      const { start, end } = sel();
      apply(insertAt(textRef.current, start, end, snippet, block));
    },
    [apply],
  );

  const attachImages = useCallback(
    async (files: Blob[]) => {
      for (const f of files) {
        const { path } = await saveAttachment(s, item, f, 'foto');
        insertMarkdown(`![](${path})`);
      }
    },
    [s, item, insertMarkdown],
  );

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'));
    if (files.length) {
      e.preventDefault();
      void attachImages(files);
    }
  };
  const onDrop = (e: DragEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
    if (files.length) {
      e.preventDefault();
      e.stopPropagation();
      void attachImages(files);
    }
  };

  const addPhoto = async (capture: boolean) => {
    const files = await pickFiles({ accept: 'image/*', multiple: !capture, capture: capture ? 'environment' : undefined });
    if (files.length) await attachImages(files);
  };

  const addAudio = async () => {
    const folder = await engine.ensureFolder(item.parentLid ?? 'root', ATTACH_FOLDER);
    openDialog({
      type: 'recorder',
      folder: folder.lid,
      onSaved: async (lid, seconds) => {
        const rec = await store.getItem(lid);
        if (!rec) return;
        const time = new Date().toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit' });
        insertMarkdown(`[🎙️ Audio ${time} (${formatDuration(seconds)})](${ATTACH_FOLDER}/${encodeURI(rec.name)})`);
      },
    });
  };

  // ---- dictado ----
  const toggleDictation = () => {
    if (dictation.current?.running) {
      dictation.current.stop();
      return;
    }
    if (mode !== 'edit') setMode('edit');
    const d = new Dictation({
      lang: settings.dictationLang,
      onInterim: setInterim,
      onFinal: (t) => {
        const { start, end } = sel();
        const before = textRef.current.slice(0, start);
        const capital = !before.trim() || /[.!?\n]\s*$/.test(before);
        const phrase = capital ? t.charAt(0).toUpperCase() + t.slice(1) : t;
        apply(insertAt(textRef.current, start, end, phrase));
      },
      onEnd: (err) => {
        setListening(false);
        setInterim('');
        const msg = describeDictationError(err);
        if (msg) toast(msg, { tone: 'error' });
      },
    });
    dictation.current = d;
    setListening(true);
    taRef.current?.focus();
    d.start();
  };

  // ---- vista previa ----
  const toggleTask = (line: number) => {
    const next = toggleTaskAtLine(textRef.current, line);
    if (next !== textRef.current) change(next);
  };

  if (error) {
    return (
      <div className="viewer">
        <FileHeader item={item} />
        {error === 'offline' ? (
          <Empty title="Esta nota todavía no está en este dispositivo">Conéctate a internet para abrirla; después quedará disponible sin conexión.</Empty>
        ) : (
          <Empty title="No se pudo abrir la nota">{error}</Empty>
        )}
      </div>
    );
  }

  const readOnly = !item.canEdit;
  return (
    <div className={cls('viewer', 'note-viewer', `mode-${mode}`)}>
      <FileHeader item={item} saving={saving}>
        {dictationSupported() && !readOnly && (
          <button className={cls('icon-btn', listening && 'is-on')} onClick={toggleDictation} aria-pressed={listening} aria-label={listening ? 'Detener dictado' : 'Dictar'}>
            {listening ? <MicOff size={21} /> : <Mic size={21} />}
          </button>
        )}
        {isMd && mode && (
          <button
            className="icon-btn mode-btn"
            onClick={() => {
              void flush();
              setMode(mode === 'edit' ? 'view' : 'edit');
            }}
            aria-label={mode === 'edit' ? 'Ver nota' : 'Editar nota'}
            title={mode === 'edit' ? 'Ver' : 'Editar'}
          >
            {mode === 'edit' ? <BookOpen size={21} /> : <Pencil size={21} />}
          </button>
        )}
      </FileHeader>
      <div className="note-scroll" ref={scrollRef}>
        <article className={cls('note-page', settings.ruled && !settings.eink && 'is-ruled', isMd ? 'is-md' : 'is-txt')}>
          {text === null || mode === null ? (
            <div className="note-loading" aria-busy="true" />
          ) : mode === 'edit' ? (
            <textarea
              ref={taRef}
              className="note-text"
              value={text}
              onChange={onInput}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              onDrop={onDrop}
              readOnly={readOnly}
              spellCheck
              autoCapitalize="sentences"
              aria-label="Texto de la nota"
              placeholder={isMd ? 'Escribe aquí. # Título, - lista, - [ ] tarea' : 'Escribe aquí'}
              autoFocus={!text}
            />
          ) : (
            <Preview text={text} item={item} onToggleTask={toggleTask} onEdit={() => setMode('edit')} />
          )}
        </article>
      </div>
      {interim && <div className="dictation-chip" aria-live="polite">{interim}</div>}
      {mode === 'edit' && isMd && !readOnly && (
        <div className="fmt-bar" role="toolbar" aria-label="Formato">
          <FmtBtn label="Título" onClick={() => apply(toggleLinePrefix(textRef.current, sel().start, sel().end, '# '))} icon={<Heading size={20} />} />
          <FmtBtn label="Negrita" onClick={() => apply(wrap(textRef.current, sel().start, sel().end, '**'))} icon={<Bold size={20} />} />
          <FmtBtn label="Cursiva" onClick={() => apply(wrap(textRef.current, sel().start, sel().end, '*'))} icon={<Italic size={20} />} />
          <FmtBtn label="Lista" onClick={() => apply(toggleLinePrefix(textRef.current, sel().start, sel().end, '- '))} icon={<List size={20} />} />
          <FmtBtn label="Tarea" onClick={() => apply(toggleLinePrefix(textRef.current, sel().start, sel().end, '- [ ] '))} icon={<ListTodo size={20} />} />
          <FmtBtn label="Cita" onClick={() => apply(toggleLinePrefix(textRef.current, sel().start, sel().end, '> '))} icon={<Quote size={20} />} />
          <FmtBtn label="Código" onClick={() => apply(wrap(textRef.current, sel().start, sel().end, '`'))} icon={<Code size={20} />} />
          <FmtBtn
            label="Enlace"
            onClick={() => {
              const { start, end } = sel();
              const label = textRef.current.slice(start, end) || 'enlace';
              const t = textRef.current.slice(0, start) + `[${label}](https://)` + textRef.current.slice(end);
              const pos = start + label.length + 3;
              apply({ text: t, start: pos, end: pos + 8 });
            }}
            icon={<Link size={20} />}
          />
          <span className="fmt-sep" aria-hidden="true" />
          <FmtBtn label="Tomar foto" onClick={() => void addPhoto(true)} icon={<Camera size={20} />} />
          <FmtBtn label="Insertar imagen" onClick={() => void addPhoto(false)} icon={<ImagePlus size={20} />} />
          <FmtBtn label="Grabar audio" onClick={() => void addAudio()} icon={<AudioLines size={20} />} />
        </div>
      )}
      <PageButtons target={scrollRef} />
    </div>
  );
}

function FmtBtn({ label, icon, onClick }: { label: string; icon: React.ReactNode; onClick: () => void }) {
  return (
    <button
      className="icon-btn"
      // Evita que el textarea pierda el foco (y el teclado se cierre) al tocar el botón.
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      {icon}
    </button>
  );
}

const AUDIO_RE = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|weba|webm)$/i;

function Preview({ text, item, onToggleTask, onEdit }: { text: string; item: LocalItem; onToggleTask: (line: number) => void; onEdit: () => void }) {
  const { engine, store } = useServices();
  const ref = useRef<HTMLDivElement>(null);
  const html = renderMarkdown(text);
  const folder = item.parentLid ?? 'root';

  // Resuelve imágenes y audios relativos contra el árbol de Drive (copias locales o descarga).
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const urls: string[] = [];
    let alive = true;
    const resolve = async (ref: string) => {
      if (ref.startsWith('tinta-embed:')) return resolveByName(store, folder, decodeURIComponent(ref.slice('tinta-embed:'.length)));
      // Si la nota se movió de carpeta, la ruta relativa ya no sirve: se busca el archivo por nombre.
      return (await resolveRelative(store, folder, ref)) ?? resolveByName(store, folder, decodeURIComponent(ref.split('/').pop() ?? ref));
    };

    root.querySelectorAll<HTMLImageElement>('img[data-src]').forEach(async (img) => {
      const target = await resolve(img.dataset.src!);
      if (!alive) return;
      if (!target || target.isFolder) {
        img.replaceWith(Object.assign(document.createElement('span'), { className: 'missing-media', textContent: `No se encontró ${img.dataset.src}` }));
        return;
      }
      const k = kindOf(target.name, target.mimeType);
      try {
        const blob = await engine.readBlob(target.lid);
        if (!alive) return;
        const url = URL.createObjectURL(blob);
        urls.push(url);
        if (k === 'audio') {
          const audio = document.createElement('audio');
          audio.controls = true;
          audio.src = url;
          img.replaceWith(audio);
        } else {
          img.src = url;
          img.dataset.lid = target.lid;
        }
      } catch {
        img.alt = `${img.alt || target.name} (sin conexión)`;
        img.classList.add('is-offline');
      }
    });

    root.querySelectorAll<HTMLAnchorElement>('a[data-rel]').forEach(async (a) => {
      const href = a.dataset.rel!;
      if (!AUDIO_RE.test(href.split(/[?#]/)[0])) return;
      const target = await resolveRelative(store, folder, href);
      if (!alive || !target) return;
      try {
        const blob = await engine.readBlob(target.lid);
        if (!alive) return;
        const url = URL.createObjectURL(blob);
        urls.push(url);
        const wrapEl = document.createElement('span');
        wrapEl.className = 'audio-embed';
        const audio = document.createElement('audio');
        audio.controls = true;
        audio.preload = 'metadata';
        audio.src = url;
        a.after(wrapEl);
        wrapEl.append(a, audio);
      } catch {
        /* sin conexión: queda el enlace */
      }
    });
    return () => {
      alive = false;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [html, engine, store, folder]);

  const onClick = async (e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    if (t instanceof HTMLInputElement && t.classList.contains('task-box')) {
      e.preventDefault();
      const line = Number(t.dataset.line);
      if (line >= 0) onToggleTask(line);
      return;
    }
    const img = t.closest('img[data-lid]') as HTMLImageElement | null;
    if (img?.dataset.lid) {
      go({ folder: (await store.getItem(img.dataset.lid))?.parentLid ?? 'root', file: img.dataset.lid });
      return;
    }
    const a = t.closest('a[data-rel]') as HTMLAnchorElement | null;
    if (a) {
      e.preventDefault();
      const target = await resolveRelative(store, folder, a.dataset.rel!);
      if (target) {
        await flushAll();
        go(target.isFolder ? { folder: target.lid } : { folder: target.parentLid ?? 'root', file: target.lid });
      } else useApp.getState().toast(`No se encontró «${a.dataset.rel}»`, { tone: 'error' });
    }
  };

  if (!text.trim()) {
    return (
      <button className="preview-empty" onClick={onEdit}>
        Nota vacía. Toca para escribir.
      </button>
    );
  }
  return <div ref={ref} className="md" onClick={onClick} onDoubleClick={onEdit} dangerouslySetInnerHTML={{ __html: html }} />;
}
