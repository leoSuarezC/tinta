import { diff3Merge } from 'node-diff3';

/** Divide en líneas conservando los saltos, para que join('') reconstruya el texto exacto. */
export function splitLines(s: string): string[] {
  return s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function withTrailingNewline(lines: string[]): string[] {
  if (!lines.length) return lines;
  const last = lines[lines.length - 1];
  return last.endsWith('\n') ? lines : [...lines.slice(0, -1), last + '\n'];
}

const addNl = (s: string) => (s === '' || s.endsWith('\n') ? s : s + '\n');

export interface Merge3Result {
  merged: string;
  /** false si hubo cambios incompatibles en las mismas líneas. */
  clean: boolean;
}

/**
 * Fusión de 3 vías por líneas. `local` y `remote` derivan de `base`.
 * Si ambos lados solo insertaron texto en el mismo punto (p. ej. los dos agregaron
 * líneas al final), se conservan ambas inserciones: primero la remota, luego la local.
 */
export function merge3(local: string, base: string, remote: string): Merge3Result {
  if (local === remote) return { merged: local, clean: true };
  if (local === base) return { merged: remote, clean: true };
  if (remote === base) return { merged: local, clean: true };

  // Se normaliza el salto final para que "agregar una línea al final" no choque
  // con la última línea de la base cuando el archivo no terminaba en salto de línea.
  const stripFinal = !local.endsWith('\n') && !remote.endsWith('\n');
  const regions = diff3Merge<string>(splitLines(addNl(local)), splitLines(addNl(base)), splitLines(addNl(remote)), {
    excludeFalseConflicts: true,
  });
  const out: string[] = [];
  let clean = true;
  for (const r of regions) {
    if (r.ok) {
      out.push(...r.ok);
    } else if (r.conflict) {
      const { a, o, b } = r.conflict;
      if (o.length === 0) {
        out.push(...withTrailingNewline(b), ...withTrailingNewline(a));
      } else {
        clean = false;
        out.push(...a);
      }
    }
  }
  let merged = out.join('');
  if (stripFinal && merged.endsWith('\n')) merged = merged.slice(0, -1);
  return { merged, clean };
}
