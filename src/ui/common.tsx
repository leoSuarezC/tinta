import { useEffect, useRef, type ReactNode, type PointerEvent as RPointerEvent } from 'react';
import {
  AudioLines,
  File,
  FileImage,
  FileText,
  FileType,
  Folder,
  Link2,
  NotebookText,
  Presentation,
  Sheet as SheetIcon,
  Video,
  X,
} from 'lucide-react';
import type { FileKind } from '../model/fileTypes';

export function cls(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(' ');
}

export function KindIcon({ kind, mimeType, size = 22 }: { kind: FileKind; mimeType?: string; size?: number }) {
  const p = { size, strokeWidth: 1.75, 'aria-hidden': true } as const;
  switch (kind) {
    case 'folder':
      return <Folder {...p} />;
    case 'markdown':
      return <NotebookText {...p} />;
    case 'text':
      return <FileText {...p} />;
    case 'image':
      return <FileImage {...p} />;
    case 'pdf':
      return <FileType {...p} />;
    case 'audio':
      return <AudioLines {...p} />;
    case 'video':
      return <Video {...p} />;
    case 'shortcut':
      return <Link2 {...p} />;
    case 'google':
      if (mimeType?.includes('spreadsheet')) return <SheetIcon {...p} />;
      if (mimeType?.includes('presentation')) return <Presentation {...p} />;
      return <FileText {...p} />;
    default:
      return <File {...p} />;
  }
}

/** Hoja inferior en el teléfono, ventana centrada en pantallas anchas. */
export function Sheet({
  title,
  onClose,
  children,
  footer,
  className,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('[autofocus], input, textarea, select, button:not(.sheet-close)');
    first?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="sheet-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cls('sheet', className)} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <header className="sheet-head">
          <h2>{title}</h2>
          <button className="icon-btn sheet-close" onClick={onClose} aria-label="Cerrar">
            <X size={22} />
          </button>
        </header>
        <div className="sheet-body">{children}</div>
        {footer && <footer className="sheet-foot">{footer}</footer>}
      </div>
    </div>
  );
}

/** Mantener presionado (táctil) abre el menú contextual; clic derecho también. */
export function useLongPress(onLong: () => void, ms = 480) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  return {
    onPointerDown(e: RPointerEvent) {
      fired.current = false;
      if (e.pointerType === 'mouse') return;
      start.current = { x: e.clientX, y: e.clientY };
      clear();
      timer.current = setTimeout(() => {
        fired.current = true;
        navigator.vibrate?.(12);
        onLong();
      }, ms);
    },
    onPointerMove(e: RPointerEvent) {
      if (!start.current) return;
      if (Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 10) clear();
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    onPointerLeave: clear,
    onContextMenu(e: React.MouseEvent) {
      e.preventDefault();
      clear();
      if (!fired.current) onLong();
      fired.current = true;
    },
    /** Llamar en onClick: devuelve true si el clic viene de una pulsación larga (y debe ignorarse). */
    consumed() {
      const f = fired.current;
      fired.current = false;
      return f;
    },
  };
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <p className="empty-title">{title}</p>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="toggle-row">
      <span className="toggle-text">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </span>
      <input type="checkbox" role="switch" className="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}
