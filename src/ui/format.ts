import { kindOf, type FileKind } from '../model/fileTypes';
import type { LocalItem } from '../db/db';

const timeFmt = new Intl.DateTimeFormat('es-CO', { hour: 'numeric', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'short' });
const dayYearFmt = new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'short', year: 'numeric' });
/** "5 oct" / "5 oct 2025" (sin los "de" que agrega es-CO). */
const compact = (f: Intl.DateTimeFormat, d: Date) =>
  f
    .formatToParts(d)
    .filter((p) => p.type !== 'literal')
    .map((p) => p.value.replace(/\.$/, ''))
    .join(' ');
const weekdayFmt = new Intl.DateTimeFormat('es-CO', { weekday: 'short' });
const fullFmt = new Intl.DateTimeFormat('es-CO', { dateStyle: 'long', timeStyle: 'short' });

const clean = (s: string) => s.replace(/\.$/, '').replace(/ /g, ' ');

export function relativeDate(iso?: string, now = new Date()): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (days <= 0) return timeFmt.format(d).replace(/\u00a0|\u202f/g, ' ');
  if (days === 1) return 'ayer';
  if (days < 7) return clean(weekdayFmt.format(d));
  if (d.getFullYear() === now.getFullYear()) return compact(dayFmt, d);
  return compact(dayYearFmt, d);
}

export function fullDate(iso?: string | number): string {
  if (iso === undefined) return '';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : fullFmt.format(d);
}

export function sinceText(ms?: number): string {
  if (!ms) return 'nunca';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return 'hace un momento';
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  return fullDate(ms);
}

export const KIND_LABEL: Record<FileKind, string> = {
  folder: 'Carpeta',
  markdown: 'Nota',
  text: 'Texto',
  image: 'Imagen',
  pdf: 'PDF',
  audio: 'Audio',
  video: 'Video',
  google: 'Archivo de Google',
  shortcut: 'Acceso directo',
  other: 'Archivo',
};

export function itemKind(i: Pick<LocalItem, 'name' | 'mimeType'>): FileKind {
  return kindOf(i.name, i.mimeType);
}

/** Nombre para mostrar: las notas sin ".md"; el resto con su extensión. */
export function displayName(i: Pick<LocalItem, 'name' | 'mimeType' | 'isFolder'>): string {
  if (i.isFolder) return i.name;
  const k = kindOf(i.name, i.mimeType);
  if (k === 'markdown') return i.name.replace(/\.(md|markdown|mdown|mkd)$/i, '');
  return i.name;
}

export function isPending(i: LocalItem) {
  return !i.driveId || i.dirtyContent || i.dirtyMeta || i.deleted;
}

export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** Minúsculas y sin tildes, para buscar "cafe" y encontrar "Café". */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}
