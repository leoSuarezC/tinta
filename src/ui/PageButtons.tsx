import type { RefObject } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useApp } from '../app/state';

/**
 * En modo e-ink, deslizar deja "fantasmas" en la pantalla. Estos botones pasan una página
 * completa de golpe (sin animación), como un lector de libros.
 */
export function PageButtons({ target, className }: { target: RefObject<HTMLElement | null>; className?: string }) {
  const eink = useApp((s) => s.settings.eink);
  if (!eink) return null;
  const page = (dir: 1 | -1) => {
    const el = target.current;
    if (!el) return;
    el.scrollBy({ top: dir * el.clientHeight * 0.88, behavior: 'instant' as ScrollBehavior });
  };
  return (
    <div className={`page-btns ${className ?? ''}`}>
      <button className="icon-btn" aria-label="Página anterior" onClick={() => page(-1)}>
        <ChevronUp size={26} />
      </button>
      <button className="icon-btn" aria-label="Página siguiente" onClick={() => page(1)}>
        <ChevronDown size={26} />
      </button>
    </div>
  );
}
