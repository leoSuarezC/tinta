/** Utilidades de imagen: reducir fotos grandes y girar. */

const MAX_SIDE = 2560;

async function decode(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch {
      /* algunos formatos (SVG) no se pueden decodificar así */
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function dims(src: ImageBitmap | HTMLImageElement) {
  return 'naturalWidth' in src ? { w: src.naturalWidth, h: src.naturalHeight } : { w: src.width, h: src.height };
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('No se pudo generar la imagen'))), type, quality));
}

/** Reduce fotos de más de 2560 px a JPEG; las imágenes pequeñas, GIF y SVG quedan igual. */
export async function shrinkPhoto(file: Blob): Promise<Blob> {
  if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(file.type)) return file;
  if (file.size < 700 * 1024) return file;
  const img = await decode(file);
  const { w, h } = dims(img);
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
  if (scale === 1 && file.type === 'image/jpeg' && file.size < 2.5 * 1024 * 1024) return file;
  const c = document.createElement('canvas');
  c.width = Math.round(w * scale);
  c.height = Math.round(h * scale);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const out = await toBlob(c, 'image/jpeg', 0.86);
  return out.size < file.size ? out : file;
}

/** Gira 90° (horario si dir = 1). */
export async function rotateImage(blob: Blob, dir: 1 | -1 = 1): Promise<Blob> {
  const img = await decode(blob);
  const { w, h } = dims(img);
  const c = document.createElement('canvas');
  c.width = h;
  c.height = w;
  const ctx = c.getContext('2d')!;
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((dir * Math.PI) / 2);
  ctx.drawImage(img, -w / 2, -h / 2);
  const type = /png|webp|gif/.test(blob.type) ? 'image/png' : 'image/jpeg';
  return toBlob(c, type, 0.92);
}

export async function loadImage(blob: Blob) {
  const img = await decode(blob);
  return { img, ...dims(img) };
}
