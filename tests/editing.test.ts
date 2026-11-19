import { describe, expect, it } from 'vitest';
import { continueList, indentLines, insertAt, toggleLinePrefix, toggleTaskAtLine, wrap } from '../src/lib/editing';
import { isRelativeRef, renderMarkdown, splitRelPath } from '../src/lib/markdown';
import { applyVoiceCommands } from '../src/lib/dictation';

describe('edición de Markdown', () => {
  it('continúa viñetas, numeración y tareas', () => {
    expect(continueList('- uno', 5, 5)).toEqual({ text: '- uno\n- ', start: 8, end: 8 });
    expect(continueList('  * dos', 7, 7)?.text).toBe('  * dos\n  * ');
    expect(continueList('3. tres', 7, 7)?.text).toBe('3. tres\n4. ');
    expect(continueList('- [x] hecho', 11, 11)?.text).toBe('- [x] hecho\n- [ ] ');
    expect(continueList('texto normal', 12, 12)).toBeNull();
  });

  it('Enter en un ítem vacío termina la lista', () => {
    expect(continueList('- uno\n- ', 8, 8)).toEqual({ text: '- uno\n', start: 6, end: 6 });
    expect(continueList('- uno\n- [ ] ', 12, 12)).toEqual({ text: '- uno\n', start: 6, end: 6 });
  });

  it('marca y desmarca tareas por número de línea', () => {
    const t = '# Lista\n- [ ] a\n- [x] b\n  - [ ] c';
    expect(toggleTaskAtLine(t, 1)).toBe('# Lista\n- [x] a\n- [x] b\n  - [ ] c');
    expect(toggleTaskAtLine(t, 2)).toBe('# Lista\n- [ ] a\n- [ ] b\n  - [ ] c');
    expect(toggleTaskAtLine(t, 3)).toBe('# Lista\n- [ ] a\n- [x] b\n  - [x] c');
    expect(toggleTaskAtLine(t, 0)).toBe(t);
  });

  it('negrita: envuelve y quita', () => {
    const a = wrap('hola mundo', 5, 10, '**');
    expect(a).toEqual({ text: 'hola **mundo**', start: 7, end: 12 });
    expect(wrap(a.text, a.start, a.end, '**')).toEqual({ text: 'hola mundo', start: 5, end: 10 });
  });

  it('prefijos de línea: título, cita, lista y tarea', () => {
    expect(toggleLinePrefix('hola', 2, 2, '# ').text).toBe('# hola');
    expect(toggleLinePrefix('# hola', 3, 3, '# ').text).toBe('hola');
    expect(toggleLinePrefix('a\nb', 0, 3, '- ').text).toBe('- a\n- b');
    expect(toggleLinePrefix('- a', 1, 1, '- [ ] ').text).toBe('- [ ] a');
  });

  it('insertar texto dictado y bloques', () => {
    expect(insertAt('hola', 4, 4, 'mundo').text).toBe('hola mundo');
    expect(insertAt('hola', 4, 4, ', mundo').text).toBe('hola, mundo');
    expect(insertAt('uno', 3, 3, '![](a.png)', true).text).toBe('uno\n![](a.png)\n');
  });

  it('sangría en listas', () => {
    expect(indentLines('- a\n- b', 0, 7, false).text).toBe('  - a\n  - b');
    expect(indentLines('  - a', 3, 3, true).text).toBe('- a');
  });

  it('comandos de voz', () => {
    expect(applyVoiceCommands('primera idea nueva línea segunda')).toBe('primera idea\nsegunda');
    expect(applyVoiceCommands('fin punto y aparte otra')).toBe('fin.\notra');
    expect(applyVoiceCommands('en ese punto')).toBe('en ese punto');
  });
});

describe('vista previa de Markdown', () => {
  it('tareas con la línea correcta del texto fuente', () => {
    const html = renderMarkdown('# T\n\n- [ ] a\n- [x] b');
    expect(html).toContain('data-line="2"');
    expect(html).toContain('data-line="3" checked');
    expect(html).toContain('class="task done"');
  });

  it('imágenes relativas quedan para resolverse contra Drive; las externas no', () => {
    const html = renderMarkdown('![](_adjuntos/foto%201.jpg) ![x](https://ejemplo.com/a.png)');
    expect(html).toContain('data-src="_adjuntos/foto%201.jpg"');
    expect(html).toContain('src="https://ejemplo.com/a.png"');
  });

  it('enlaces externos se abren aparte y no se permite HTML crudo', () => {
    const html = renderMarkdown('[web](https://ejemplo.com) <script>alert(1)</script> [n](otra%20nota.md)');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('data-rel="otra%20nota.md"');
    expect(html).not.toContain('<script>');
  });

  it('embebidos estilo Obsidian', () => {
    expect(renderMarkdown('![[foto.png]]')).toContain('data-src="tinta-embed:foto.png"');
  });

  it('rutas relativas', () => {
    expect(isRelativeRef('../a.md')).toBe(true);
    expect(isRelativeRef('https://a')).toBe(false);
    expect(isRelativeRef('#titulo')).toBe(false);
    expect(isRelativeRef('mailto:x@y.z')).toBe(false);
    expect(splitRelPath('./_adjuntos/foto%201.jpg')).toEqual(['_adjuntos', 'foto 1.jpg']);
    expect(splitRelPath('<../Fotos/a b.png>')).toEqual(['..', 'Fotos', 'a b.png']);
  });
});
