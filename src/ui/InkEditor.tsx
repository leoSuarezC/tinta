import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Eraser,
  FilePlus2,
  Hand,
  Highlighter,
  Minus,
  PenLine,
  Plus,
  Redo2,
  Undo2,
  Eye,
} from 'lucide-react';
import { useServices } from '../app/services';
import { markUserInput, registerFlush, useMediaQuery } from '../app/hooks';
import { useApp } from '../app/state';
import type { LocalItem } from '../db/db';
import {
  apply as applyMatrix,
  drawStroke,
  HIGHLIGHT_COLORS,
  HIGHLIGHT_SIZES,
  hitStroke,
  invert,
  PEN_COLORS,
  PEN_SIZES,
  strokeId,
  type InkStroke,
  type Matrix,
} from '../ink/model';
import { appendNotebookPage, loadPdfForInk, savePdfWithInk, type Template } from '../ink/pdfInk';
import { openPdf, type PDFDocumentProxy } from '../ink/pdfjs';
import { loadImage } from '../lib/images';
import { cls, Empty } from './common';
import { FileHeader } from './FileHeader';
import { PageButtons } from './PageButtons';

type Tool = 'pen' | 'highlighter' | 'eraser';

interface PageModel {
  /** Tamaño en px CSS con zoom 1 (antes de ajustar al ancho). */
  w: number;
  h: number;
  /** Matriz unidades de página → px CSS para una escala dada. */
  matrix(scale: number): Matrix;
  draw(canvas: HTMLCanvasElement, scale: number, pixelRatio: number): Promise<void>;
  cancel?(): void;
}

interface UndoEntry {
  page: number;
  added?: InkStroke[];
  removed?: InkStroke[];
}

export type InkSource = { kind: 'pdf'; bytes: Uint8Array } | { kind: 'image'; blob: Blob };

const MAX_CANVAS_PIXELS = 7_500_000;

function capture(el: Element, pointerId: number) {
  try {
    el.setPointerCapture(pointerId);
  } catch {
    /* puntero sintético o ya liberado */
  }
}

export function InkEditor({ item, source, onClose }: { item: LocalItem; source: InkSource; onClose?: () => void }) {
  const { engine } = useServices();
  const settings = useApp((s) => s.settings);
  const updateSettings = useApp((s) => s.updateSettings);
  const toast = useApp((s) => s.toast);

  const [pages, setPages] = useState<PageModel[] | null>(null);
  const [strokes, setStrokes] = useState<InkStroke[][]>([]);
  const [error, setError] = useState<string>();
  const [template, setTemplate] = useState<Template>();
  const [drawMode, setDrawMode] = useState(false);
  const [tool, setTool] = useState<Tool>('pen');
  const [penColor, setPenColor] = useState(PEN_COLORS[0].value);
  const [penSize, setPenSize] = useState(PEN_SIZES[1]);
  const [hlColor, setHlColor] = useState(HIGHLIGHT_COLORS[0].value);
  const [hlSize, setHlSize] = useState(HIGHLIGHT_SIZES[1]);
  const [zoom, setZoom] = useState(1);
  const [fit, setFit] = useState(1);
  const [renderScale, setRenderScale] = useState(1);
  const [saving, setSaving] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const compactTools = useMediaQuery('(max-width: 640px)');

  const scrollRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<Uint8Array | null>(null);
  const imageRef = useRef<{ img: CanvasImageSource; w: number; h: number; type: string } | null>(null);
  const pdfRef = useRef<PDFDocumentProxy | null>(null);
  const strokesRef = useRef<InkStroke[][]>([]);
  strokesRef.current = strokes;
  const undoRef = useRef<UndoEntry[]>([]);
  const redoRef = useRef<UndoEntry[]>([]);
  const dirtyRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const savingRef = useRef<Promise<void> | null>(null);
  const isImage = source.kind === 'image';
  const penOnly = settings.penOnly === true;

  // ---------- carga ----------
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (source.kind === 'pdf') {
          const loaded = await loadPdfForInk(source.bytes);
          if (!alive) return;
          if (loaded.error) setError(loaded.error);
          baseRef.current = loaded.baseBytes;
          setTemplate(loaded.template);
          setDrawMode(!!loaded.template && loaded.editable && item.canEdit);
          const pdf = await openPdf(loaded.baseBytes);
          if (!alive) return void pdf.loadingTask.destroy();
          pdfRef.current = pdf;
          const models = await pdfPageModels(pdf);
          if (!alive) return;
          const initial = models.map((_, i) => loaded.pages[i] ?? []);
          setStrokes(initial);
          setPages(models);
          if (!loaded.editable) setDrawMode(false);
        } else {
          const { img, w, h } = await loadImage(source.blob);
          if (!alive) return;
          imageRef.current = { img, w, h, type: source.blob.type };
          setStrokes([[]]);
          setPages([imagePageModel(img, w, h)]);
          setDrawMode(true);
        }
      } catch (e) {
        if (alive) setError(`No se pudo abrir el archivo: ${(e as Error)?.message ?? e}`);
      }
    })();
    return () => {
      alive = false;
      void pdfRef.current?.loadingTask.destroy();
      pdfRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.lid, source]);

  // ---------- ajuste al ancho ----------
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !pages?.length) return;
    const measure = () => {
      const maxW = Math.max(...pages.map((p) => p.w));
      const avail = el.clientWidth - (el.clientWidth > 700 ? 64 : 16);
      setFit(Math.max(0.2, Math.min(avail / maxW, 2.5)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pages]);

  const scale = fit * zoom;
  // La resolución de los lienzos se actualiza un momento después del zoom (el zoom es fluido).
  useEffect(() => {
    const t = setTimeout(() => setRenderScale(scale), 180);
    return () => clearTimeout(t);
  }, [scale]);

  // ---------- guardado ----------
  // Si la sincronización reemplaza el archivo (cambió en otro dispositivo), esta vista se recarga
  // y no debe volver a guardar su versión vieja encima.
  const replacedRef = useRef(false);
  useEffect(() => engine.onContentReplaced((lid) => lid === item.lid && (replacedRef.current = true)), [engine, item.lid]);

  const save = useCallback(async () => {
    if (!dirtyRef.current || replacedRef.current) return;
    if (savingRef.current) await savingRef.current;
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    const snapshot = strokesRef.current;
    const run = (async () => {
      setSaving(true);
      try {
        let blob: Blob;
        if (source.kind === 'pdf') {
          const bytes = await savePdfWithInk(baseRef.current!, snapshot);
          blob = new Blob([bytes as BlobPart], { type: 'application/pdf' });
        } else {
          blob = await flattenImage(imageRef.current!, snapshot[0] ?? []);
        }
        await engine.saveBlob(item.lid, blob);
      } catch (e) {
        dirtyRef.current = true;
        toast(`No se pudo guardar: ${(e as Error)?.message ?? e}`, { tone: 'error' });
      } finally {
        setSaving(false);
      }
    })();
    savingRef.current = run;
    await run;
    savingRef.current = null;
  }, [engine, item.lid, source.kind, toast]);

  const scheduleSave = useCallback(() => {
    dirtyRef.current = true;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void save(), isImage ? 4000 : 2200);
  }, [save, isImage]);

  useEffect(() => registerFlush(save), [save]);
  useEffect(
    () => () => {
      clearTimeout(saveTimer.current);
      void save();
    },
    [save],
  );
  useEffect(() => {
    const onHide = () => document.visibilityState === 'hidden' && void save();
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, [save]);

  // ---------- trazos ----------
  const commit = useCallback(
    (entry: UndoEntry, record = true) => {
      setStrokes((prev) => {
        const next = prev.slice();
        let page = next[entry.page] ?? [];
        if (entry.removed?.length) {
          const ids = new Set(entry.removed.map((s) => s.id));
          page = page.filter((s) => !ids.has(s.id));
        }
        if (entry.added?.length) page = [...page, ...entry.added];
        next[entry.page] = page;
        strokesRef.current = next;
        return next;
      });
      if (record) {
        undoRef.current.push(entry);
        if (undoRef.current.length > 200) undoRef.current.shift();
        redoRef.current = [];
      }
      setCanUndo(undoRef.current.length > 0);
      setCanRedo(redoRef.current.length > 0);
      scheduleSave();
    },
    [scheduleSave],
  );

  const undo = useCallback(() => {
    const e = undoRef.current.pop();
    if (!e) return;
    redoRef.current.push(e);
    commit({ page: e.page, added: e.removed, removed: e.added }, false);
  }, [commit]);
  const redo = useCallback(() => {
    const e = redoRef.current.pop();
    if (!e) return;
    undoRef.current.push(e);
    commit(e, false);
  }, [commit]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if ((e.target as HTMLElement)?.closest('input, textarea')) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((k === 'z' && e.shiftKey) || k === 'y') {
        e.preventDefault();
        redo();
      } else if (k === 's') {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, save]);

  // ---------- entrada (lápiz, dedo, mouse) ----------
  const live = useRef<{
    pointerId: number;
    page: number;
    inv: Matrix;
    stroke?: InkStroke;
    erasing?: boolean;
    removed: InkStroke[];
    wet?: CanvasRenderingContext2D | null;
    m?: Matrix;
    lastCss?: [number, number];
  } | null>(null);
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const pan = useRef<{ x: number; y: number; vx: number; vy: number; t: number; pinch?: { d: number; zoom: number; cx: number; cy: number } } | null>(null);
  const inertia = useRef<number>(0);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  const canDraw = item.canEdit && !error;
  const manualPan = canDraw && (drawMode || penOnly);

  const toolState = useRef({ tool, penColor, penSize, hlColor, hlSize, drawMode, penOnly });
  toolState.current = { tool, penColor, penSize, hlColor, hlSize, drawMode, penOnly };

  const pageAt = (target: EventTarget | null) => {
    const el = (target as HTMLElement | null)?.closest<HTMLElement>('[data-page]');
    return el ? { el, index: Number(el.dataset.page) } : null;
  };

  const startStroke = (e: PointerEvent, el: HTMLElement, index: number, erasing: boolean) => {
    const page = pages![index];
    const m = page.matrix(scaleRef.current);
    const inv = invert(m);
    const st = toolState.current;
    const wetCanvas = el.querySelector<HTMLCanvasElement>('canvas.wet');
    const wet = wetCanvas?.getContext('2d', { desynchronized: true }) ?? null;
    if (wet && wetCanvas) {
      const dpr = wetCanvas.width / Math.max(1, wetCanvas.clientWidth);
      wet.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    const highlighter = st.tool === 'highlighter';
    live.current = {
      pointerId: e.pointerId,
      page: index,
      inv,
      m,
      wet,
      erasing,
      removed: [],
      stroke: erasing
        ? undefined
        : {
            id: strokeId(),
            tool: highlighter ? 'highlighter' : 'pen',
            color: highlighter ? st.hlColor : st.penColor,
            size: highlighter ? st.hlSize : st.penSize,
            pts: [],
            sim: e.pointerType !== 'pen',
          },
    };
    addPoints(e, el);
  };

  const addPoints = (e: PointerEvent, el: HTMLElement) => {
    const l = live.current;
    if (!l) return;
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    const list = events.length ? events : [e];
    const r = el.getBoundingClientRect();
    if (l.erasing) {
      const radius = 10 / scaleRef.current;
      const pageStrokes = strokesRef.current[l.page] ?? [];
      const already = new Set(l.removed.map((s) => s.id));
      for (const ev of list) {
        const [x, y] = applyMatrix(l.inv, ev.clientX - r.left, ev.clientY - r.top);
        for (const s of pageStrokes) if (!already.has(s.id) && hitStroke(s, x, y, radius)) {
          l.removed.push(s);
          already.add(s.id);
        }
      }
      if (l.removed.length) {
        // Vista inmediata: se ocultan los trazos tocados.
        const ids = new Set(l.removed.map((s) => s.id));
        setStrokes((prev) => {
          const next = prev.slice();
          next[l.page] = (next[l.page] ?? []).filter((s) => !ids.has(s.id));
          strokesRef.current = next;
          return next;
        });
      }
      return;
    }
    const s = l.stroke!;
    for (const ev of list) {
      const cx = ev.clientX - r.left;
      const cy = ev.clientY - r.top;
      const [x, y] = applyMatrix(l.inv, cx, cy);
      const p = ev.pointerType === 'pen' ? (ev.pressure || 0.5) : 0.5;
      s.pts.push(x, y, p);
      // Trazo "húmedo": segmentos simples, rápidos de dibujar (importante en e-ink).
      if (l.wet && l.lastCss) {
        const w = s.size * scaleRef.current * (s.tool === 'highlighter' ? 1 : 0.55 + p * 0.7);
        l.wet.globalAlpha = s.tool === 'highlighter' ? 0.4 : 1;
        l.wet.strokeStyle = s.color;
        l.wet.lineWidth = w;
        l.wet.lineCap = 'round';
        l.wet.lineJoin = 'round';
        l.wet.beginPath();
        l.wet.moveTo(l.lastCss[0], l.lastCss[1]);
        l.wet.lineTo(cx, cy);
        l.wet.stroke();
      }
      l.lastCss = [cx, cy];
    }
  };

  const endStroke = (cancelled = false) => {
    const l = live.current;
    live.current = null;
    if (!l) return;
    if (l.wet) {
      const c = l.wet.canvas;
      l.wet.setTransform(1, 0, 0, 1, 0, 0);
      l.wet.clearRect(0, 0, c.width, c.height);
    }
    if (l.erasing) {
      if (l.removed.length) {
        undoRef.current.push({ page: l.page, removed: l.removed });
        redoRef.current = [];
        setCanUndo(true);
        setCanRedo(false);
        scheduleSave();
      }
      return;
    }
    if (cancelled || !l.stroke || l.stroke.pts.length < 3) return;
    commit({ page: l.page, added: [l.stroke] });
  };

  const stopInertia = () => cancelAnimationFrame(inertia.current);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !pages) return;

    const onDown = (e: PointerEvent) => {
      const hit = pageAt(e.target);
      const st = toolState.current;
      if (e.pointerType === 'pen' && settings.penOnly === null) {
        updateSettings({ penOnly: true });
        toast('Lápiz detectado: ahora el dedo desplaza y solo el lápiz escribe.');
      }
      if (e.pointerType === 'touch') {
        if (live.current && live.current.pointerId !== e.pointerId) {
          // Segundo dedo durante un trazo con el dedo: se cancela el trazo y empieza el gesto.
          endStroke(true);
        }
        touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const fingerDraws = canDraw && st.drawMode && !st.penOnly && touches.current.size === 1;
        if (fingerDraws && hit) {
          stopInertia();
          capture(el, e.pointerId);
          startStroke(e, hit.el, hit.index, st.tool === 'eraser');
          return;
        }
        // Un dedo desplaza y dos dedos hacen zoom (siempre a mano: así el lápiz nunca desplaza la página).
        stopInertia();
        capture(el, e.pointerId);
        beginPan();
        return;
      }
      // Lápiz o mouse
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const penWrites = e.pointerType === 'pen' && canDraw && (st.drawMode || st.penOnly);
      const mouseWrites = e.pointerType === 'mouse' && canDraw && st.drawMode;
      if ((penWrites || mouseWrites) && hit) {
        e.preventDefault();
        stopInertia();
        capture(el, e.pointerId);
        const eraserButton = (e.buttons & 32) !== 0 || (e.pointerType === 'pen' && (e.buttons & 2) !== 0);
        startStroke(e, hit.el, hit.index, st.tool === 'eraser' || eraserButton);
      }
    };

    const beginPan = () => {
      const pts = [...touches.current.values()];
      if (pts.length >= 2) {
        const [a, b] = pts;
        const rect = el.getBoundingClientRect();
        pan.current = {
          x: (a.x + b.x) / 2,
          y: (a.y + b.y) / 2,
          vx: 0,
          vy: 0,
          t: performance.now(),
          pinch: { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: zoomRef.current, cx: (a.x + b.x) / 2 - rect.left, cy: (a.y + b.y) / 2 - rect.top },
        };
      } else if (pts.length === 1) {
        pan.current = { x: pts[0].x, y: pts[0].y, vx: 0, vy: 0, t: performance.now() };
      }
    };

    const onMove = (e: PointerEvent) => {
      const l = live.current;
      if (l && l.pointerId === e.pointerId) {
        const hit = el.querySelector<HTMLElement>(`[data-page="${l.page}"]`);
        if (hit) addPoints(e, hit);
        markUserInput();
        return;
      }
      if (e.pointerType !== 'touch' || !touches.current.has(e.pointerId)) return;
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const p = pan.current;
      if (!p) return;
      const pts = [...touches.current.values()];
      if (p.pinch && pts.length >= 2) {
        const [a, b] = pts;
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const nextZoom = clampZoom((p.pinch.zoom * d) / p.pinch.d);
        zoomAround(nextZoom, p.pinch.cx, p.pinch.cy);
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        el.scrollLeft -= mx - p.x;
        el.scrollTop -= my - p.y;
        p.x = mx;
        p.y = my;
      } else if (pts.length === 1) {
        const now = performance.now();
        const dx = e.clientX - p.x;
        const dy = e.clientY - p.y;
        el.scrollLeft -= dx;
        el.scrollTop -= dy;
        const dt = Math.max(1, now - p.t);
        p.vx = 0.8 * (dx / dt) + 0.2 * p.vx;
        p.vy = 0.8 * (dy / dt) + 0.2 * p.vy;
        p.x = e.clientX;
        p.y = e.clientY;
        p.t = now;
      }
    };

    const onUp = (e: PointerEvent) => {
      const l = live.current;
      if (l && l.pointerId === e.pointerId) {
        const hit = el.querySelector<HTMLElement>(`[data-page="${l.page}"]`);
        if (hit && e.type === 'pointerup') addPoints(e, hit);
        endStroke(e.type === 'pointercancel' && !l.erasing);
      }
      if (e.pointerType === 'touch') {
        touches.current.delete(e.pointerId);
        const p = pan.current;
        if (touches.current.size === 0) {
          pan.current = null;
          // Inercia al soltar (no en e-ink).
          if (p && !p.pinch && !useApp.getState().settings.eink && Math.hypot(p.vx, p.vy) > 0.15) {
            let vx = p.vx * 16;
            let vy = p.vy * 16;
            const step = () => {
              el.scrollLeft -= vx;
              el.scrollTop -= vy;
              vx *= 0.94;
              vy *= 0.94;
              if (Math.hypot(vx, vy) > 0.5) inertia.current = requestAnimationFrame(step);
            };
            inertia.current = requestAnimationFrame(step);
          }
        } else beginPan();
      }
    };

    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomAround(clampZoom(zoomRef.current * Math.exp(-e.deltaY * 0.0025)), e.clientX - rect.left, e.clientY - rect.top);
    };

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      el.removeEventListener('wheel', onWheel);
      stopInertia();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages, canDraw, settings.penOnly]);

  const clampZoom = (z: number) => Math.max(0.5, Math.min(4, z));

  /** Cambia el zoom manteniendo fijo el punto (cx, cy) del contenedor. */
  const zoomAround = (next: number, cx: number, cy: number) => {
    const el = scrollRef.current;
    const prev = zoomRef.current;
    if (!el || next === prev) return;
    const ratio = next / prev;
    const left = (el.scrollLeft + cx) * ratio - cx;
    const top = (el.scrollTop + cy) * ratio - cy;
    zoomRef.current = next;
    setZoom(next);
    requestAnimationFrame(() => {
      el.scrollLeft = left;
      el.scrollTop = top;
    });
  };

  const zoomBy = (factor: number) => {
    const el = scrollRef.current;
    if (!el) return;
    zoomAround(clampZoom(zoomRef.current * factor), el.clientWidth / 2, el.clientHeight / 2);
  };

  // ---------- páginas de cuaderno ----------
  const addPage = async () => {
    if (!template || !baseRef.current) return;
    await save();
    const bytes = await appendNotebookPage(baseRef.current, template);
    baseRef.current = bytes;
    const old = pdfRef.current;
    const pdf = await openPdf(bytes);
    pdfRef.current = pdf;
    const models = await pdfPageModels(pdf);
    setStrokes((prev) => {
      const next = [...prev, []];
      strokesRef.current = next;
      return next;
    });
    setPages(models);
    void old?.loadingTask.destroy();
    dirtyRef.current = true;
    void save();
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      el?.querySelector(`[data-page="${models.length - 1}"]`)?.scrollIntoView({ block: 'start' });
    });
  };

  // ---------- render ----------
  if (error && !pages) {
    return (
      <div className="viewer">
        <FileHeader item={item} />
        <Empty title="No se pudo abrir">{error}</Empty>
      </div>
    );
  }

  const colors = tool === 'highlighter' ? HIGHLIGHT_COLORS : PEN_COLORS;
  const sizes = tool === 'highlighter' ? HIGHLIGHT_SIZES : PEN_SIZES;
  const curColor = tool === 'highlighter' ? hlColor : penColor;
  const curSize = tool === 'highlighter' ? hlSize : penSize;
  const showTools = canDraw && (drawMode || isImage);

  const swatches = colors.map((c) => (
    <button
      key={c.id}
      className={cls('swatch', curColor === c.value && 'is-on')}
      style={{ '--sw': c.value } as React.CSSProperties}
      onClick={() => {
        if (tool === 'highlighter') setHlColor(c.value);
        else setPenColor(c.value);
        setPaletteOpen(false);
      }}
      aria-label={c.label}
      aria-pressed={curColor === c.value}
    />
  ));
  const sizeDots = sizes.map((sz, i) => (
    <button
      key={sz}
      className={cls('size-dot', curSize === sz && 'is-on')}
      onClick={() => {
        if (tool === 'highlighter') setHlSize(sz);
        else setPenSize(sz);
        setPaletteOpen(false);
      }}
      aria-label={['Fino', 'Medio', 'Grueso'][i]}
      aria-pressed={curSize === sz}
    >
      <span style={{ width: 4 + i * 4, height: 4 + i * 4 }} />
    </button>
  ));

  return (
    <div className={cls('viewer', 'ink-viewer', drawMode && 'is-drawing', manualPan && 'manual-pan')}>
      <FileHeader item={item} saving={saving}>
        {!isImage && canDraw && (
          <button
            className={cls('icon-btn', 'labeled', drawMode && 'is-on')}
            onClick={() => setDrawMode(!drawMode)}
            aria-pressed={drawMode}
            aria-label={drawMode ? 'Leer' : 'Anotar'}
            title={drawMode ? 'Volver a leer' : 'Escribir y anotar'}
          >
            {drawMode ? <Eye size={20} /> : <PenLine size={20} />}
            <span>{drawMode ? 'Leer' : 'Anotar'}</span>
          </button>
        )}
        {isImage && onClose && (
          <button className="btn small" onClick={async () => { await save(); onClose(); }}>
            Listo
          </button>
        )}
      </FileHeader>

      {showTools && (
        <div className="ink-tools" role="toolbar" aria-label="Herramientas de escritura">
          <ToolBtn on={tool === 'pen'} label="Lápiz" onClick={() => setTool('pen')} icon={<PenLine size={20} />} />
          <ToolBtn on={tool === 'highlighter'} label="Resaltador" onClick={() => setTool('highlighter')} icon={<Highlighter size={20} />} />
          <ToolBtn on={tool === 'eraser'} label="Borrador" onClick={() => setTool('eraser')} icon={<Eraser size={20} />} />
          <span className="fmt-sep" aria-hidden="true" />
          {tool !== 'eraser' &&
            (compactTools ? (
              <>
                <button
                  className={cls('style-btn', paletteOpen && 'is-on')}
                  onClick={() => setPaletteOpen(!paletteOpen)}
                  aria-expanded={paletteOpen}
                  aria-label="Color y grosor"
                  title="Color y grosor"
                >
                  <span className="style-dot" style={{ background: curColor, width: 8 + sizes.indexOf(curSize) * 5, height: 8 + sizes.indexOf(curSize) * 5 }} />
                </button>
                <span className="fmt-sep" aria-hidden="true" />
              </>
            ) : (
              <>
                {swatches}
                <span className="fmt-sep" aria-hidden="true" />
                {sizeDots}
                <span className="fmt-sep" aria-hidden="true" />
              </>
            ))}
          <ToolBtn label="Deshacer" onClick={undo} disabled={!canUndo} icon={<Undo2 size={20} />} />
          <ToolBtn label="Rehacer" onClick={redo} disabled={!canRedo} icon={<Redo2 size={20} />} />
          <span className="fmt-sep" aria-hidden="true" />
          <ToolBtn
            on={penOnly}
            label={penOnly ? 'Solo lápiz: el dedo desplaza' : 'El dedo también escribe'}
            onClick={() => updateSettings({ penOnly: !penOnly })}
            icon={<Hand size={20} />}
          />
        </div>
      )}

      {showTools && compactTools && paletteOpen && tool !== 'eraser' && (
        <div className="ink-palette" role="group" aria-label="Color y grosor">
          {swatches}
          <span className="fmt-sep" aria-hidden="true" />
          {sizeDots}
        </div>
      )}

      <div className="ink-scroll" ref={scrollRef}>
        {!pages ? (
          <div className="ink-loading" aria-busy="true">
            Abriendo…
          </div>
        ) : (
          <div className="ink-pages">
            {pages.map((p, i) => (
              <PageView key={i} index={i} page={p} scale={scale} renderScale={renderScale} strokes={strokes[i] ?? []} />
            ))}
            {template && canDraw && (
              <button className="add-page" onClick={() => void addPage()}>
                <FilePlus2 size={20} /> Agregar página
              </button>
            )}
          </div>
        )}
      </div>

      <div className="zoom-ctl">
        <button className="icon-btn" onClick={() => zoomBy(1 / 1.25)} aria-label="Alejar">
          <Minus size={20} />
        </button>
        <button className="zoom-value" onClick={() => setZoom(1)} title="Ajustar al ancho">
          {Math.round(zoom * 100)}%
        </button>
        <button className="icon-btn" onClick={() => zoomBy(1.25)} aria-label="Acercar">
          <Plus size={20} />
        </button>
      </div>
      {error && <div className="ink-note">{error}</div>}
      <PageButtons target={scrollRef} className="ink-page-btns" />
    </div>
  );
}

function ToolBtn({ on, label, icon, onClick, disabled }: { on?: boolean; label: string; icon: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button className={cls('icon-btn', on && 'is-on')} onClick={onClick} aria-label={label} title={label} aria-pressed={on} disabled={disabled}>
      {icon}
    </button>
  );
}

const PageView = memo(function PageView({ index, page, scale, renderScale, strokes }: { index: number; page: PageModel; scale: number; renderScale: number; strokes: InkStroke[] }) {
  const bgRef = useRef<HTMLCanvasElement>(null);
  const inkRef = useRef<HTMLCanvasElement>(null);
  const wetRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(index < 2);
  const prevStrokes = useRef<InkStroke[]>([]);
  const drawnScale = useRef(0);
  const cssW = page.w * scale;
  const cssH = page.h * scale;

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin: '120% 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const ratio = useMemo(() => {
    const dpr = window.devicePixelRatio || 1;
    const area = page.w * renderScale * page.h * renderScale;
    return Math.min(dpr, Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, area)));
  }, [page, renderScale]);

  // Fondo (página del PDF o imagen)
  useEffect(() => {
    const c = bgRef.current;
    if (!c) return;
    if (!visible) {
      c.width = 0;
      c.height = 0;
      drawnScale.current = 0;
      return;
    }
    let cancelled = false;
    c.width = Math.round(page.w * renderScale * ratio);
    c.height = Math.round(page.h * renderScale * ratio);
    page.draw(c, renderScale, ratio).catch(() => undefined).then(() => {
      if (!cancelled) drawnScale.current = renderScale;
    });
    return () => {
      cancelled = true;
      page.cancel?.();
    };
  }, [page, renderScale, ratio, visible]);

  // Tinta: redibuja todo, o solo el último trazo si se agregó uno.
  useEffect(() => {
    const c = inkRef.current;
    const w = wetRef.current;
    if (!c || !w) return;
    if (!visible) {
      // Fuera de pantalla se libera la memoria de los lienzos (cuadernos largos en el Boox).
      if (c.width) {
        c.width = 0;
        c.height = 0;
        w.width = 0;
        w.height = 0;
      }
      prevStrokes.current = [];
      return;
    }
    const pw = Math.round(page.w * renderScale * ratio);
    const ph = Math.round(page.h * renderScale * ratio);
    const resized = c.width !== pw || c.height !== ph;
    if (resized) {
      c.width = pw;
      c.height = ph;
      w.width = pw;
      w.height = ph;
    }
    const ctx = c.getContext('2d')!;
    const m = page.matrix(renderScale);
    const prev = prevStrokes.current;
    const appended = !resized && strokes.length === prev.length + 1 && prev.every((s, i) => strokes[i] === s);
    ctx.setTransform(ratio * m[0], ratio * m[1], ratio * m[2], ratio * m[3], ratio * m[4], ratio * m[5]);
    if (appended) drawStroke(ctx, strokes[strokes.length - 1]);
    else {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.restore();
      for (const s of strokes) drawStroke(ctx, s);
    }
    prevStrokes.current = strokes;
  }, [strokes, page, renderScale, ratio, visible]);

  return (
    <div className="ink-page" data-page={index} ref={boxRef} style={{ width: cssW, height: cssH }}>
      <canvas className="bg" ref={bgRef} />
      <canvas className="ink" ref={inkRef} />
      <canvas className="wet" ref={wetRef} />
    </div>
  );
});

async function pdfPageModels(pdf: PDFDocumentProxy): Promise<PageModel[]> {
  const out: PageModel[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const vp1 = page.getViewport({ scale: 1 });
    let task: { cancel(): void; promise: Promise<void> } | null = null;
    out.push({
      w: vp1.width,
      h: vp1.height,
      matrix: (scale) => page.getViewport({ scale }).transform as Matrix,
      async draw(canvas, scale, ratio) {
        task?.cancel();
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const viewport = page.getViewport({ scale: scale * ratio });
        task = page.render({ canvasContext: ctx, canvas, viewport } as Parameters<typeof page.render>[0]);
        try {
          await task.promise;
        } catch {
          /* cancelado */
        }
      },
      cancel: () => task?.cancel(),
    });
  }
  return out;
}

/** Las imágenes se anotan en un espacio de 612 unidades de ancho (como una página PDF). */
function imagePageModel(img: CanvasImageSource, iw: number, ih: number): PageModel {
  const w = 612;
  const h = (612 * ih) / iw;
  return {
    w,
    h,
    matrix: (scale) => [scale, 0, 0, scale, 0, 0],
    async draw(canvas) {
      const ctx = canvas.getContext('2d')!;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    },
  };
}

/** Funde los trazos en la imagen original a resolución completa. */
async function flattenImage(src: { img: CanvasImageSource; w: number; h: number; type: string }, strokes: InkStroke[]): Promise<Blob> {
  const c = document.createElement('canvas');
  c.width = src.w;
  c.height = src.h;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(src.img, 0, 0, src.w, src.h);
  const k = src.w / 612;
  ctx.setTransform(k, 0, 0, k, 0, 0);
  for (const s of strokes) drawStroke(ctx, s);
  const type = /png|gif|webp|svg/.test(src.type) ? 'image/png' : 'image/jpeg';
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('No se pudo generar la imagen'))), type, 0.92));
}
