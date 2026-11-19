/** Operaciones de edición de Markdown sobre texto + selección (independientes del DOM, con pruebas). */

export interface Edit {
  text: string;
  start: number;
  end: number;
}

const LIST_RE = /^(\s*)([-*+]|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?/;

function lineBounds(text: string, pos: number) {
  const start = text.lastIndexOf('\n', pos - 1) + 1;
  let end = text.indexOf('\n', pos);
  if (end < 0) end = text.length;
  return { start, end };
}

/** Enter dentro de una lista: continúa la viñeta (o la cierra si el ítem está vacío). Null = comportamiento normal. */
export function continueList(text: string, start: number, end: number): Edit | null {
  if (start !== end) return null;
  const { start: ls, end: le } = lineBounds(text, start);
  const line = text.slice(ls, le);
  const m = LIST_RE.exec(line);
  if (!m) return null;
  const markerLen = m[0].length;
  if (start < ls + markerLen) return null;
  const rest = line.slice(markerLen);
  if (!rest.trim()) {
    // Ítem vacío: se quita la viñeta y se sale de la lista.
    const t = text.slice(0, ls) + text.slice(ls + markerLen);
    return { text: t, start: ls, end: ls };
  }
  const indent = m[1];
  let marker = m[2];
  if (m[3]) marker = `${Number(m[3]) + 1}${m[4]}`;
  const task = m[6] ? '[ ] ' : '';
  const insert = `\n${indent}${marker}${m[5]}${task}`;
  const t = text.slice(0, start) + insert + text.slice(end);
  const pos = start + insert.length;
  return { text: t, start: pos, end: pos };
}

/** Marca o desmarca la casilla de la línea indicada (índice 0). */
export function toggleTaskAtLine(text: string, line: number): string {
  const lines = text.split('\n');
  if (line < 0 || line >= lines.length) return text;
  lines[line] = lines[line].replace(/^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]/, (_m, pre: string, mark: string) => `${pre}[${mark === ' ' ? 'x' : ' '}]`);
  return lines.join('\n');
}

/** Envuelve la selección (o la palabra) con marcadores, p. ej. ** para negrita. Repetir lo quita. */
export function wrap(text: string, start: number, end: number, before: string, after = before): Edit {
  const sel = text.slice(start, end);
  if (text.slice(start - before.length, start) === before && text.slice(end, end + after.length) === after) {
    const t = text.slice(0, start - before.length) + sel + text.slice(end + after.length);
    return { text: t, start: start - before.length, end: end - before.length };
  }
  const t = text.slice(0, start) + before + sel + after + text.slice(end);
  return { text: t, start: start + before.length, end: end + before.length };
}

/** Pone o quita un prefijo en las líneas seleccionadas ("# ", "> ", "- ", "- [ ] "). */
export function toggleLinePrefix(text: string, start: number, end: number, prefix: string): Edit {
  const first = lineBounds(text, start).start;
  const last = lineBounds(text, end).end;
  const block = text.slice(first, last);
  const lines = block.split('\n');
  const strip = (l: string) => l.replace(/^(\s*)(#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/, '$1');
  const all = lines.every((l) => !l.trim() || l.trimStart().startsWith(prefix));
  const out = lines.map((l) => {
    if (!l.trim() && lines.length > 1) return l;
    if (all) return l.replace(prefix, '');
    const indent = /^\s*/.exec(l)![0];
    return indent + prefix + strip(l).slice(indent.length);
  });
  const nb = out.join('\n');
  const t = text.slice(0, first) + nb + text.slice(last);
  const delta = nb.length - block.length;
  if (start === end) {
    const pos = Math.max(first, start + (lines.length === 1 ? delta : 0));
    return { text: t, start: pos, end: pos };
  }
  return { text: t, start: first, end: last + delta };
}

/** Inserta texto en el cursor, separándolo con espacios o saltos según corresponda. */
export function insertAt(text: string, start: number, end: number, snippet: string, block = false): Edit {
  let ins = snippet;
  const before = text.slice(0, start);
  const after = text.slice(end);
  if (block) {
    if (before && !before.endsWith('\n')) ins = '\n' + ins;
    if (after && !after.startsWith('\n')) ins = ins + '\n';
    else if (!after) ins = ins + '\n';
  } else {
    if (before && !/\s$/.test(before) && !/^[\s.,;:!?)]/.test(ins)) ins = ' ' + ins;
  }
  const t = before + ins + after;
  const pos = start + ins.length;
  return { text: t, start: pos, end: pos };
}

/** Sangría con Tab / Shift+Tab en listas. */
export function indentLines(text: string, start: number, end: number, out: boolean): Edit {
  const first = lineBounds(text, start).start;
  const last = lineBounds(text, end).end;
  const lines = text.slice(first, last).split('\n');
  let d0 = 0;
  let total = 0;
  const res = lines.map((l, i) => {
    if (out) {
      const m = /^( {1,2}|\t)/.exec(l);
      const n = m ? m[0].length : 0;
      if (i === 0) d0 = -n;
      total -= n;
      return l.slice(n);
    }
    if (i === 0) d0 = 2;
    total += 2;
    return '  ' + l;
  });
  const t = text.slice(0, first) + res.join('\n') + text.slice(last);
  return { text: t, start: Math.max(first, start + d0), end: end + total };
}
