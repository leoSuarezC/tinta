import {
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFString,
  decodePDFRawStream,
  rgb,
  type PDFPage,
} from 'pdf-lib';
import { compactStroke, hexToRgb, HIGHLIGHT_OPACITY, strokeBounds, strokeOutline, type InkStroke } from './model';

/**
 * Los trazos se guardan como anotaciones /Ink estándar (una por página), así que se ven en
 * cualquier lector de PDF (Drive, Boox, Acrobat). Además llevan los trazos originales (con
 * presión) en un flujo comprimido /TintaInk, para que la app los pueda seguir editando.
 */
const NM_PREFIX = 'tinta-ink';
const DATA_KEY = PDFName.of('TintaInk');
export const NOTEBOOK_KEYWORD = 'tinta-cuaderno';

export type Template = 'rayado' | 'cuadriculado' | 'puntos' | 'blanco';

export interface LoadedPdf {
  /** PDF sin las anotaciones de la app (lo que se dibuja de fondo). */
  baseBytes: Uint8Array;
  /** Trazos por página (índice 0 = primera página). */
  pages: InkStroke[][];
  /** Si el PDF es un cuaderno creado por la app, su plantilla. */
  template?: Template;
  editable: boolean;
  error?: string;
}

function isOurAnnot(dict: PDFDict): boolean {
  if (dict.get(DATA_KEY)) return true;
  const nm = dict.get(PDFName.of('NM'));
  const text = nm instanceof PDFHexString || nm instanceof PDFString ? nm.decodeText() : '';
  return text.startsWith(NM_PREFIX);
}

function readTemplate(doc: PDFDocument): Template | undefined {
  const kw = doc.getKeywords() ?? '';
  if (!kw.includes(NOTEBOOK_KEYWORD)) return undefined;
  const m = /plantilla:(rayado|cuadriculado|puntos|blanco)/.exec(kw);
  return (m?.[1] as Template) ?? 'rayado';
}

/** Lee un PDF: separa los trazos de la app de su contenido. */
export async function loadPdfForInk(bytes: Uint8Array): Promise<LoadedPdf> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e) {
    const encrypted = /encrypt/i.test(String((e as Error)?.message));
    return {
      baseBytes: bytes,
      pages: [],
      editable: false,
      error: encrypted ? 'Este PDF está protegido: se puede ver, pero no anotar.' : 'Este PDF no se puede anotar (parece dañado).',
    };
  }
  const pages = doc.getPages();
  const strokes: InkStroke[][] = pages.map(() => []);
  let found = false;
  pages.forEach((page, idx) => {
    const annots = page.node.Annots();
    if (!annots) return;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const dict = annots.lookupMaybe(i, PDFDict);
      if (!dict || !isOurAnnot(dict)) continue;
      found = true;
      const raw = dict.lookup(DATA_KEY);
      const data = raw instanceof PDFRawStream ? raw : undefined;
      if (data) {
        try {
          const json = new TextDecoder().decode(decodePDFRawStream(data).decode());
          const parsed = JSON.parse(json) as { v: number; strokes: InkStroke[] };
          strokes[idx].unshift(...(parsed.strokes ?? []));
        } catch {
          /* datos ilegibles: se descarta el trazo de la app pero se conserva el PDF */
        }
      }
      annots.remove(i);
    }
  });
  const template = readTemplate(doc);
  const baseBytes = found ? await doc.save({ useObjectStreams: false, updateFieldAppearances: false }) : bytes;
  return { baseBytes, pages: strokes, template, editable: true };
}

function num(n: number) {
  return (Math.round(n * 100) / 100).toString();
}

function appearanceContent(strokes: InkStroke[]): string {
  const ops: string[] = [];
  for (const s of strokes) {
    const outline = strokeOutline(s);
    if (outline.length < 3) continue;
    const [r, g, b] = hexToRgb(s.color);
    ops.push(s.tool === 'highlighter' ? '/GSH gs' : '/GS0 gs');
    ops.push(`${num(r)} ${num(g)} ${num(b)} rg`);
    ops.push(`${num(outline[0][0])} ${num(outline[0][1])} m`);
    for (let i = 1; i < outline.length; i++) ops.push(`${num(outline[i][0])} ${num(outline[i][1])} l`);
    ops.push('h f');
  }
  return ops.join('\n');
}

function addInkAnnotation(doc: PDFDocument, page: PDFPage, strokes: InkStroke[], pageIndex: number) {
  if (!strokes.length) return;
  const ctx = doc.context;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const s of strokes) {
    const [a, b, c, d] = strokeBounds(s);
    x1 = Math.min(x1, a); y1 = Math.min(y1, b); x2 = Math.max(x2, c); y2 = Math.max(y2, d);
  }
  const rect = [x1 - 2, y1 - 2, x2 + 2, y2 + 2].map((v) => Math.round(v * 100) / 100);

  const ap = ctx.flateStream(appearanceContent(strokes), {
    Type: 'XObject',
    Subtype: 'Form',
    BBox: rect,
    Resources: {
      ExtGState: {
        GS0: { Type: 'ExtGState', CA: 1, ca: 1 },
        GSH: { Type: 'ExtGState', CA: HIGHLIGHT_OPACITY, ca: HIGHLIGHT_OPACITY, BM: 'Multiply' },
      },
    },
  });
  const apRef = ctx.register(ap);

  const payload = JSON.stringify({ v: 1, strokes: strokes.map(compactStroke) });
  const dataRef = ctx.register(ctx.flateStream(new TextEncoder().encode(payload)));

  const inkList = strokes.map((s) => {
    const arr: number[] = [];
    for (let i = 0; i < s.pts.length; i += 3) arr.push(Math.round(s.pts[i] * 100) / 100, Math.round(s.pts[i + 1] * 100) / 100);
    return arr;
  });
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const pdfDate = `D:${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  const first = strokes.find((s) => s.tool === 'pen') ?? strokes[0];
  const annot = ctx.obj({
    Type: 'Annot',
    Subtype: 'Ink',
    Rect: rect,
    InkList: inkList,
    C: hexToRgb(first.color),
    BS: { W: Math.round(first.size * 100) / 100 },
    F: 4,
    NM: PDFHexString.fromText(`${NM_PREFIX}-${pageIndex + 1}`),
    T: PDFHexString.fromText('Tinta'),
    M: PDFString.of(pdfDate),
    AP: { N: apRef },
  });
  annot.set(DATA_KEY, dataRef);
  page.node.addAnnot(ctx.register(annot));
}

/** Guarda: PDF base + una anotación /Ink por página con trazos. */
export async function savePdfWithInk(baseBytes: Uint8Array, pages: InkStroke[][]): Promise<Uint8Array> {
  const doc = await PDFDocument.load(baseBytes, { updateMetadata: false });
  const docPages = doc.getPages();
  docPages.forEach((page, i) => addInkAnnotation(doc, page, pages[i] ?? [], i));
  return doc.save({ useObjectStreams: false, updateFieldAppearances: false });
}

// ---------- cuadernos ----------
export const NOTEBOOK_SIZE: [number, number] = [612, 816]; // proporción 3:4, como la pantalla del Boox

const RULE = rgb(0.72, 0.8, 0.92);
const MARGIN = rgb(0.88, 0.45, 0.47);

function drawTemplate(page: PDFPage, template: Template) {
  const { width, height } = page.getSize();
  if (template === 'rayado') {
    const top = 64;
    for (let y = height - top; y > 36; y -= 26) page.drawLine({ start: { x: 0, y }, end: { x: width, y }, thickness: 0.6, color: RULE });
    page.drawLine({ start: { x: 72, y: 0 }, end: { x: 72, y: height }, thickness: 0.8, color: MARGIN });
  } else if (template === 'cuadriculado') {
    const step = 14.17; // 5 mm
    for (let x = step; x < width; x += step) page.drawLine({ start: { x, y: 0 }, end: { x, y: height }, thickness: 0.4, color: RULE });
    for (let y = height - step; y > 0; y -= step) page.drawLine({ start: { x: 0, y }, end: { x: width, y }, thickness: 0.4, color: RULE });
  } else if (template === 'puntos') {
    const step = 18;
    for (let x = step; x < width; x += step)
      for (let y = height - step; y > 0; y -= step) page.drawCircle({ x, y, size: 0.7, color: rgb(0.6, 0.66, 0.76) });
  }
}

export async function createNotebook(template: Template, title: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setCreator('Tinta');
  doc.setProducer('Tinta');
  doc.setKeywords([NOTEBOOK_KEYWORD, `plantilla:${template}`]);
  const page = doc.addPage(NOTEBOOK_SIZE);
  drawTemplate(page, template);
  return doc.save();
}

/** Agrega una página (con la plantilla del cuaderno) al final del PDF base. */
export async function appendNotebookPage(baseBytes: Uint8Array, template: Template): Promise<Uint8Array> {
  const doc = await PDFDocument.load(baseBytes, { updateMetadata: false });
  const last = doc.getPages().at(-1);
  const size: [number, number] = last ? [last.getWidth(), last.getHeight()] : NOTEBOOK_SIZE;
  const page = doc.addPage(size);
  drawTemplate(page, template);
  return doc.save({ useObjectStreams: false });
}

/** Elimina una página del PDF base (los trazos se reorganizan aparte). */
export async function removePage(baseBytes: Uint8Array, index: number): Promise<Uint8Array> {
  const doc = await PDFDocument.load(baseBytes, { updateMetadata: false });
  if (doc.getPageCount() <= 1) return baseBytes;
  doc.removePage(index);
  return doc.save({ useObjectStreams: false });
}

