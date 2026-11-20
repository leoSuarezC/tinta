import { describe, expect, it } from 'vitest';
import { notePreview } from '../src/lib/preview';

describe('vista previa de notas', () => {
  it('quita el título repetido y convierte tareas y viñetas', () => {
    const md = '# Compras\n\n- [ ] leche\n- [x] **pan**\n* café\n\n> cita con [enlace](https://x.y)';
    expect(notePreview(md, 'compras')).toEqual(['☐ leche', '☑ pan', '• café', '', 'cita con enlace']);
  });

  it('conserva un título distinto al nombre y junta líneas en blanco', () => {
    expect(notePreview('## Ideas\n\n\n\nPara el video', 'Diario')).toEqual(['Ideas', '', 'Para el video']);
  });

  it('corta por líneas y por caracteres', () => {
    const many = Array.from({ length: 30 }, (_, i) => `línea ${i}`).join('\n');
    expect(notePreview(many, 'x', 4)).toHaveLength(4);
    const long = 'a'.repeat(1000);
    const [first] = notePreview(long, 'x', 9, 50);
    expect(first).toHaveLength(51);
    expect(first.endsWith('…')).toBe(true);
  });

  it('nota vacía o solo con el título', () => {
    expect(notePreview('', 'x')).toEqual([]);
    expect(notePreview('# Hola\n\n', 'Hola')).toEqual([]);
  });
});
