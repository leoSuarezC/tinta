import { FOLDER_MIME, GOOGLE_APPS_PREFIX, SHORTCUT_MIME } from '../drive/types';

export type FileKind = 'folder' | 'markdown' | 'text' | 'image' | 'pdf' | 'audio' | 'video' | 'google' | 'shortcut' | 'other';

const MD_EXT = new Set(['md', 'markdown', 'mdown', 'mkd']);
const TEXT_EXT = new Set([
  'txt', 'text', 'csv', 'tsv', 'json', 'yaml', 'yml', 'xml', 'log', 'ini', 'conf', 'toml', 'html', 'htm', 'css',
  'js', 'ts', 'py', 'cs', 'sh', 'bat', 'ps1', 'sql', 'srt', 'vtt', 'tex', 'org', 'rst', 'env',
]);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico']);
const AUDIO_EXT = new Set(['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac', 'weba', 'amr', '3gp']);
const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'm4v', 'mkv']);

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

export function baseName(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

export function kindOf(name: string, mimeType: string): FileKind {
  if (mimeType === FOLDER_MIME) return 'folder';
  if (mimeType === SHORTCUT_MIME) return 'shortcut';
  if (mimeType.startsWith(GOOGLE_APPS_PREFIX)) return 'google';
  const ext = extOf(name);
  if (MD_EXT.has(ext)) return 'markdown';
  if (ext === 'pdf' || mimeType === 'application/pdf') return 'pdf';
  if (IMAGE_EXT.has(ext) || (mimeType.startsWith('image/') && !/heic|heif|tiff/.test(mimeType))) return 'image';
  // .webm puede ser audio (grabaciones de la app) o video: se decide por mime.
  if (ext === 'webm') return mimeType.startsWith('video/') ? 'video' : 'audio';
  if (AUDIO_EXT.has(ext) || mimeType.startsWith('audio/')) return 'audio';
  if (VIDEO_EXT.has(ext) || mimeType.startsWith('video/')) return 'video';
  if (TEXT_EXT.has(ext) || mimeType.startsWith('text/') || mimeType === 'application/json') return 'text';
  return 'other';
}

export function isTextKind(k: FileKind) {
  return k === 'markdown' || k === 'text';
}

export function mimeForName(name: string): string {
  const ext = extOf(name);
  const map: Record<string, string> = {
    md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain', csv: 'text/csv', json: 'application/json',
    html: 'text/html', htm: 'text/html', xml: 'text/xml', yaml: 'text/yaml', yml: 'text/yaml',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif',
    pdf: 'application/pdf',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', weba: 'audio/webm', webm: 'audio/webm', flac: 'audio/flac',
    mp4: 'video/mp4', mov: 'video/quicktime',
  };
  return map[ext] ?? 'application/octet-stream';
}

/** Extensión adecuada para un tipo MIME (usada al guardar adjuntos y archivos compartidos). */
export function extForMime(mime: string): string {
  const m = mime.split(';')[0].trim().toLowerCase();
  const map: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'image/avif': 'avif',
    'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/aac': 'aac',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'application/pdf': 'pdf', 'text/plain': 'txt', 'text/markdown': 'md',
  };
  return map[m] ?? 'bin';
}

/** Nombre de archivo válido para Drive y para enlaces Markdown. */
export function sanitizeName(name: string): string {
  return name.replace(/[\u0000-\u001f/\\]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 200) || 'Sin título';
}

export function formatBytes(n?: number): string {
  if (n === undefined || isNaN(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

const pad = (n: number) => String(n).padStart(2, '0');
/** "2026-10-08 1530" — se usa en nombres de archivo nuevos. */
export function stamp(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
}
/** "20261008-153012" — compacto, sin espacios, para adjuntos. */
export function compactStamp(d = new Date()): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
