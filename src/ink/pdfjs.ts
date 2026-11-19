// Carga perezosa de pdf.js (build "legacy", compatible con el Chrome 138 del Boox).
import type * as PdfJs from 'pdfjs-dist/legacy/build/pdf.mjs';

export type PDFDocumentProxy = PdfJs.PDFDocumentProxy;
export type PDFPageProxy = PdfJs.PDFPageProxy;

let lib: Promise<typeof PdfJs> | null = null;

function loadLib() {
  lib ??= (async () => {
    const [pdfjs, worker] = await Promise.all([
      import('pdfjs-dist/legacy/build/pdf.mjs'),
      import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
    ]);
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    return pdfjs;
  })();
  return lib;
}

const asset = (p: string) => new URL(`pdfjs/${p}`, document.baseURI).href;

export async function openPdf(data: Uint8Array): Promise<PDFDocumentProxy> {
  const pdfjs = await loadLib();
  // pdf.js transfiere el buffer al worker: se le pasa una copia.
  const task = pdfjs.getDocument({
    data: data.slice(),
    cMapUrl: asset('cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: asset('standard_fonts/'),
    wasmUrl: asset('wasm/'),
    iccUrl: asset('iccs/'),
    enableXfa: false,
  });
  return task.promise;
}

export async function annotationModeEnable() {
  const pdfjs = await loadLib();
  return pdfjs.AnnotationMode.ENABLE;
}
