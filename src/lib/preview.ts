import { fold } from '../ui/format';

/**
 * Primeras líneas de una nota, ya "limpias" de Markdown, para la tarjeta de la carpeta.
 * Quita el título si repite el nombre del archivo y convierte tareas y viñetas en símbolos.
 */
export function notePreview(text: string, title: string, maxLines = 9, maxChars = 360): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let chars = 0;
  let skippedTitle = false;
  let inFence = false;
  for (const raw of lines) {
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    let l = inFence ? raw : clean(raw);
    if (!inFence && !skippedTitle && out.length === 0 && l.trim()) {
      skippedTitle = true;
      if (/^\s*#{1,6}\s/.test(raw) && fold(l.trim()) === fold(title.trim())) continue;
    }
    l = l.trimEnd();
    if (!l.trim()) {
      // Una sola línea en blanco entre párrafos, y nunca al principio.
      if (out.length && out[out.length - 1] !== '') out.push('');
      continue;
    }
    if (chars + l.length > maxChars) {
      out.push(l.slice(0, Math.max(0, maxChars - chars)).trimEnd() + '…');
      break;
    }
    out.push(l);
    chars += l.length;
    if (out.length >= maxLines) break;
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

function clean(line: string): string {
  let l = line;
  l = l.replace(/^\s*#{1,6}\s+/, '');
  l = l.replace(/^(\s*)>\s?/, '$1');
  l = l.replace(/^(\s*)[-*+]\s+\[[xX]\]\s+/, '$1☑ ');
  l = l.replace(/^(\s*)[-*+]\s+\[ \]\s+/, '$1☐ ');
  l = l.replace(/^(\s*)[-*+]\s+/, '$1• ');
  l = l.replace(/^\s*([-*_])(\s*\1){2,}\s*$/, '');
  l = l.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt: string) => (alt ? `[${alt}]` : ''));
  l = l.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  l = l.replace(/(\*\*|__|~~|`)/g, '');
  l = l.replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, '$1$2');
  return l;
}
