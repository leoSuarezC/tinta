import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { LocalItem } from '../db/db';
import { FileCard } from './FileCard';

/**
 * Tarjetas en mosaico: columnas de igual ancho y cada tarjeta con la altura de su contenido.
 * Cada tarjeta va a la columna más corta, en orden, así que se leen de izquierda a derecha.
 * Las tarjetas se posicionan (no cambian de columna en el DOM) para no recargar sus vistas previas.
 */
export function Mosaic({ files, fileLid, showFolder, keyPrefix = '' }: { files: LocalItem[]; fileLid?: string; showFolder?: boolean; keyPrefix?: string }) {
  const listRef = useRef<HTMLUListElement>(null);
  const [box, setBox] = useState({ width: 0, padL: 0, padT: 0, padB: 0, gap: 12, min: 150 });
  const heights = useRef(new Map<string, number>());
  const [, setTick] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);

  // Ancho disponible y medidas definidas en CSS (--card-min, --card-gap).
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const read = () => {
      const cs = getComputedStyle(el);
      const padL = parseFloat(cs.paddingLeft) || 0;
      const padR = parseFloat(cs.paddingRight) || 0;
      setBox({
        width: el.clientWidth - padL - padR,
        padL,
        padT: parseFloat(cs.paddingTop) || 0,
        padB: parseFloat(cs.paddingBottom) || 0,
        gap: parseFloat(cs.getPropertyValue('--card-gap')) || 12,
        min: parseFloat(cs.getPropertyValue('--card-min')) || 150,
      });
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Altura de cada tarjeta: cambia cuando carga su imagen o cambia el ancho de columna.
  useEffect(() => {
    const ro = new ResizeObserver((entries) => {
      let changed = false;
      for (const e of entries) {
        const el = e.target as HTMLElement;
        const lid = el.dataset.lid;
        if (!lid) continue;
        const h = el.offsetHeight;
        if (heights.current.get(lid) !== h) {
          heights.current.set(lid, h);
          changed = true;
        }
      }
      if (changed) setTick((t) => t + 1);
    });
    observer.current = ro;
    for (const el of listRef.current?.querySelectorAll<HTMLElement>(':scope > .card') ?? []) ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const measure = useCallback((el: HTMLLIElement | null) => {
    if (el) observer.current?.observe(el);
  }, []);

  const { width, gap, min } = box;
  const cols = width > 0 ? Math.max(1, Math.floor((width + gap) / (min + gap))) : 0;
  const colW = cols ? (width - gap * (cols - 1)) / cols : 0;
  const tops = new Array<number>(cols).fill(0);
  const pos = files.map((f) => {
    if (!cols) return undefined;
    let c = 0;
    for (let i = 1; i < cols; i++) if (tops[i] < tops[c] - 1) c = i;
    const p = { x: box.padL + c * (colW + gap), y: box.padT + tops[c] };
    tops[c] += (heights.current.get(f.lid) ?? 220) + gap;
    return p;
  });
  const inner = cols ? Math.max(0, Math.max(...tops) - gap) : 0;

  return (
    <ul ref={listRef} className="cards is-mosaic" style={cols ? { height: inner + box.padT + box.padB } : undefined}>
      {files.map((i, n) => {
        const p = pos[n];
        return (
          <FileCard
            key={keyPrefix + i.lid}
            item={i}
            active={i.lid === fileLid}
            showFolder={showFolder}
            measure={measure}
            style={p ? { position: 'absolute', left: 0, top: 0, width: colW, transform: `translate(${p.x}px, ${p.y}px)` } : undefined}
          />
        );
      })}
    </ul>
  );
}
