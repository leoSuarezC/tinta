import type { LocalItem } from '../db/db';
import { compactStamp, extForMime, extOf, mimeForName, sanitizeName, stamp } from '../model/fileTypes';
import type { Template } from '../ink/pdfInk';
import { shrinkPhoto } from '../lib/images';
import type { Services } from './services';
import { go, useApp } from './state';

export const ATTACH_FOLDER = '_adjuntos';

export function openItem(item: LocalItem) {
  if (item.isFolder) go({ folder: item.lid });
  else go({ folder: item.parentLid ?? 'root', file: item.lid });
}

export async function createNote(s: Services, folder: string, ext: 'md' | 'txt' = 'md', name?: string, text = '') {
  const base = sanitizeName(name?.trim() || `Nota ${stamp()}`);
  const fileName = extOf(base) === ext ? base : `${base}.${ext}`;
  const item = await s.engine.createFile(folder, fileName, ext === 'md' ? 'text/markdown' : 'text/plain', text);
  go({ folder, file: item.lid });
  return item;
}

export async function createInk(s: Services, folder: string, template: Template, name?: string) {
  const base = sanitizeName(name?.trim() || `A mano ${stamp()}`);
  const { createNotebook } = await import('../ink/pdfInk');
  const bytes = await createNotebook(template, base);
  const item = await s.engine.createFile(folder, `${base.replace(/\.pdf$/i, '')}.pdf`, 'application/pdf', new Blob([bytes as BlobPart], { type: 'application/pdf' }));
  go({ folder, file: item.lid });
  return item;
}

/** Guarda archivos elegidos, pegados o compartidos en una carpeta. */
export async function saveFiles(s: Services, folder: string, files: File[] | Blob[], opts: { open?: boolean } = {}) {
  const shrink = useApp.getState().settings.shrinkPhotos;
  const created: LocalItem[] = [];
  for (const f of files) {
    let blob: Blob = f;
    let name = (f as File).name || `Archivo ${compactStamp()}.${extForMime(f.type)}`;
    if (shrink && /^image\//.test(f.type)) {
      blob = await shrinkPhoto(f).catch(() => f);
      if (blob !== f && blob.type === 'image/jpeg' && !/\.jpe?g$/i.test(name)) name = name.replace(/\.[^.]+$/, '') + '.jpg';
    }
    const type = blob.type || mimeForName(name);
    created.push(await s.engine.createFile(folder, sanitizeName(name), type, blob));
  }
  if (opts.open && created.length === 1) go({ folder, file: created[0].lid });
  if (created.length > 1) useApp.getState().toast(`${created.length} archivos guardados`);
  return created;
}

/** Guarda un adjunto en "_adjuntos" junto a la nota y devuelve la ruta relativa para Markdown. */
export async function saveAttachment(s: Services, note: LocalItem, blob: Blob, prefix: string, ext?: string) {
  const parent = note.parentLid ?? 'root';
  const folder = await s.engine.ensureFolder(parent, ATTACH_FOLDER);
  let data = blob;
  if (prefix === 'foto' && useApp.getState().settings.shrinkPhotos) data = await shrinkPhoto(blob).catch(() => blob);
  const extension = ext ?? extForMime(data.type);
  const name = `${prefix}-${compactStamp()}.${extension}`;
  const item = await s.engine.createFile(folder.lid, name, data.type || mimeForName(name), data);
  return { item, path: `${ATTACH_FOLDER}/${item.name}` };
}

/** Abre el selector de archivos del sistema. */
export function pickFiles(opts: { accept?: string; multiple?: boolean; capture?: 'environment' | 'user' } = {}): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (opts.accept) input.accept = opts.accept;
    if (opts.multiple) input.multiple = true;
    if (opts.capture) input.setAttribute('capture', opts.capture);
    input.style.display = 'none';
    document.body.appendChild(input);
    let done = false;
    const finish = (files: File[]) => {
      if (done) return;
      done = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => finish(Array.from(input.files ?? [])));
    input.addEventListener('cancel', () => finish([]));
    input.click();
  });
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function driveUrl(item: LocalItem): string | undefined {
  if (item.webViewLink) return item.webViewLink;
  if (!item.driveId) return undefined;
  return item.isFolder ? `https://drive.google.com/drive/folders/${item.driveId}` : `https://drive.google.com/file/d/${item.driveId}/view`;
}
