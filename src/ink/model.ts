import { getStroke } from 'perfect-freehand';

export type InkTool = 'pen' | 'highlighter';

/** Un trazo en coordenadas de página (puntos PDF o píxeles de imagen). */
export interface InkStroke {
  id: string;
  tool: InkTool;
  color: string;
  /** Grosor en unidades de página. */
  size: number;
  /** [x, y, presión, x, y, presión, …] */
  pts: number[];
  /** Presión simulada por velocidad (mouse, dedo o lápiz sin presión). */
  sim?: boolean;
}

export type Matrix = [number, number, number, number, number, number];

export const PEN_COLORS = [
  { id: 'negro', label: 'Negro', value: '#1d1d1f' },
  { id: 'azul', label: 'Azul tinta', value: '#2340a8' },
  { id: 'rojo', label: 'Rojo', value: '#cf3434' },
  { id: 'verde', label: 'Verde', value: '#1e7a4c' },
];
export const HIGHLIGHT_COLORS = [
  { id: 'amarillo', label: 'Amarillo', value: '#ffe14d' },
  { id: 'verde', label: 'Verde', value: '#8ef0a0' },
  { id: 'rosa', label: 'Rosa', value: '#ff9ccf' },
];
/** Grosores en puntos (1 pt ≈ 0,35 mm). */
export const PEN_SIZES = [1.4, 2.4, 4];
export const HIGHLIGHT_SIZES = [10, 16, 24];

export const HIGHLIGHT_OPACITY = 0.38;

export function strokeId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

const outlineCache = new WeakMap<InkStroke, number[][]>();

/** Contorno (polígono relleno) del trazo, con grosor variable según la presión. */
export function strokeOutline(s: InkStroke, last = true): number[][] {
  const cached = last ? outlineCache.get(s) : undefined;
  if (cached) return cached;
  const input: number[][] = [];
  for (let i = 0; i < s.pts.length; i += 3) input.push([s.pts[i], s.pts[i + 1], s.pts[i + 2]]);
  const highlighter = s.tool === 'highlighter';
  const outline = getStroke(input, {
    size: s.size,
    thinning: highlighter ? 0 : s.sim ? 0.5 : 0.62,
    smoothing: 0.55,
    streamline: highlighter ? 0.6 : 0.42,
    simulatePressure: !!s.sim && !highlighter,
    start: { cap: true, taper: 0 },
    end: { cap: true, taper: 0 },
    last,
  });
  if (last) outlineCache.set(s, outline);
  return outline;
}

/** Path2D del contorno, para dibujar en canvas. */
export function strokePath(s: InkStroke): Path2D {
  const o = strokeOutline(s);
  const p = new Path2D();
  if (!o.length) return p;
  p.moveTo(o[0][0], o[0][1]);
  for (let i = 1; i < o.length; i++) {
    const [x0, y0] = o[i - 1];
    const [x1, y1] = o[i];
    p.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
  }
  p.closePath();
  return p;
}

export function drawStroke(ctx: CanvasRenderingContext2D, s: InkStroke) {
  ctx.save();
  if (s.tool === 'highlighter') {
    ctx.globalAlpha = HIGHLIGHT_OPACITY;
    ctx.globalCompositeOperation = 'multiply';
  }
  ctx.fillStyle = s.color;
  ctx.fill(strokePath(s));
  ctx.restore();
}

export function strokeBounds(s: InkStroke): [number, number, number, number] {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (let i = 0; i < s.pts.length; i += 3) {
    const x = s.pts[i], y = s.pts[i + 1];
    if (x < x1) x1 = x;
    if (y < y1) y1 = y;
    if (x > x2) x2 = x;
    if (y > y2) y2 = y;
  }
  const r = s.size;
  return [x1 - r, y1 - r, x2 + r, y2 + r];
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** ¿El borrador (círculo de radio r en (x,y)) toca el trazo? */
export function hitStroke(s: InkStroke, x: number, y: number, r: number): boolean {
  const tol = r + s.size / 2;
  const [bx1, by1, bx2, by2] = strokeBounds(s);
  if (x < bx1 - tol || x > bx2 + tol || y < by1 - tol || y > by2 + tol) return false;
  const p = s.pts;
  if (p.length === 3) return Math.hypot(p[0] - x, p[1] - y) <= tol;
  for (let i = 3; i < p.length; i += 3) {
    if (distToSegment(x, y, p[i - 3], p[i - 2], p[i], p[i + 1]) <= tol) return true;
  }
  return false;
}

export function invert(m: Matrix): Matrix {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

export function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Redondeo para guardar (reduce el tamaño del JSON sin pérdida visible). */
export function compactStroke(s: InkStroke): InkStroke {
  return { ...s, pts: s.pts.map((v, i) => (i % 3 === 2 ? Math.round(v * 100) / 100 : Math.round(v * 100) / 100)) };
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
