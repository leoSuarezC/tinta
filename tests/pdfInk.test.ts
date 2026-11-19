import { describe, expect, it } from 'vitest';
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { appendNotebookPage, createNotebook, loadPdfForInk, savePdfWithInk } from '../src/ink/pdfInk';
import type { InkStroke } from '../src/ink/model';

const stroke = (id: string, x: number, y: number, tool: InkStroke['tool'] = 'pen'): InkStroke => ({
  id,
  tool,
  color: tool === 'pen' ? '#2340a8' : '#ffe14d',
  size: tool === 'pen' ? 2.4 : 16,
  pts: [x, y, 0.4, x + 20, y + 5, 0.6, x + 40, y + 2, 0.8, x + 60, y + 10, 0.5],
});

describe('tinta en PDF', () => {
  it('un cuaderno nuevo no tiene trazos y recuerda su plantilla', async () => {
    const bytes = await createNotebook('cuadriculado', 'Prueba');
    const loaded = await loadPdfForInk(bytes);
    expect(loaded.editable).toBe(true);
    expect(loaded.pages).toEqual([[]]);
    expect(loaded.template).toBe('cuadriculado');
  });

  it('guarda trazos como anotaciones /Ink con apariencia y los vuelve a leer', async () => {
    const base = await appendNotebookPage(await createNotebook('rayado', 'X'), 'rayado');
    const pages = [[stroke('a', 100, 600), stroke('b', 100, 500, 'highlighter')], [stroke('c', 50, 50)]];
    const saved = await savePdfWithInk(base, pages);

    const doc = await PDFDocument.load(saved);
    const annots = doc.getPages().map((p) => p.node.Annots()?.size() ?? 0);
    expect(annots).toEqual([1, 1]);
    const a = doc.getPages()[0].node.Annots()!.lookup(0, PDFDict);
    expect(a.get(PDFName.of('Subtype'))?.toString()).toBe('/Ink');
    expect(a.get(PDFName.of('AP'))).toBeDefined();
    expect(a.get(PDFName.of('InkList'))).toBeDefined();

    const again = await loadPdfForInk(saved);
    expect(again.pages[0].map((s) => s.id)).toEqual(['a', 'b']);
    expect(again.pages[1].map((s) => s.id)).toEqual(['c']);
    expect(again.pages[0][1].tool).toBe('highlighter');
    expect(again.template).toBe('rayado');
    // El PDF base ya no tiene las anotaciones de la app (no se duplican al volver a guardar).
    const base2 = await PDFDocument.load(again.baseBytes);
    expect(base2.getPages().map((p) => p.node.Annots()?.size() ?? 0)).toEqual([0, 0]);
    const resaved = await loadPdfForInk(await savePdfWithInk(again.baseBytes, again.pages));
    expect(resaved.pages.map((p) => p.length)).toEqual([2, 1]);
  });

  it('conserva las anotaciones de otras apps', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 300]);
    const other = doc.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [10, 10, 30, 30], Contents: 'nota de otra app' });
    page.node.addAnnot(doc.context.register(other));
    const bytes = await doc.save();
    const loaded = await loadPdfForInk(bytes);
    const saved = await savePdfWithInk(loaded.baseBytes, [[stroke('z', 20, 20)]]);
    const out = await PDFDocument.load(saved);
    expect(out.getPages()[0].node.Annots()!.size()).toBe(2);
  });

  it('un archivo que no es PDF queda como solo lectura', async () => {
    const r = await loadPdfForInk(new TextEncoder().encode('esto no es un pdf'));
    expect(r.editable).toBe(false);
    expect(r.error).toBeTruthy();
  });
});
