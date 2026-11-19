import { describe, expect, it } from 'vitest';
import { merge3, splitLines } from '../src/sync/merge';

describe('splitLines', () => {
  it('reconstruye el texto exacto', () => {
    for (const s of ['', 'a', 'a\n', 'a\nb', 'a\nb\n', '\n\n', 'x\r\ny']) {
      expect(splitLines(s).join('')).toBe(s);
    }
  });
});

describe('merge3', () => {
  const base = 'uno\ndos\ntres\ncuatro\n';

  it('toma el lado que cambió', () => {
    expect(merge3(base, base, 'uno\nDOS\ntres\ncuatro\n')).toEqual({ merged: 'uno\nDOS\ntres\ncuatro\n', clean: true });
    expect(merge3('uno\nDOS\ntres\ncuatro\n', base, base)).toEqual({ merged: 'uno\nDOS\ntres\ncuatro\n', clean: true });
  });

  it('fusiona cambios en líneas distintas', () => {
    const local = 'uno\nDOS\ntres\ncuatro\n';
    const remote = 'uno\ndos\ntres\nCUATRO\n';
    expect(merge3(local, base, remote)).toEqual({ merged: 'uno\nDOS\ntres\nCUATRO\n', clean: true });
  });

  it('detecta el choque en la misma línea', () => {
    const r = merge3('uno\nlocal\ntres\ncuatro\n', base, 'uno\nremoto\ntres\ncuatro\n');
    expect(r.clean).toBe(false);
  });

  it('conserva las dos inserciones al final', () => {
    const r = merge3(base + 'desde el Boox\n', base, base + 'desde el Fold\n');
    expect(r).toEqual({ merged: base + 'desde el Fold\ndesde el Boox\n', clean: true });
  });

  it('conserva las dos inserciones aunque la base no termine en salto de línea', () => {
    const r = merge3('a\nb\nlocal', 'a\nb', 'a\nb\nremoto');
    expect(r).toEqual({ merged: 'a\nb\nremoto\nlocal', clean: true });
  });

  it('cambios idénticos en ambos lados no son conflicto', () => {
    const same = 'uno\nDOS\ntres\ncuatro\n';
    expect(merge3(same, base, same)).toEqual({ merged: same, clean: true });
  });

  it('borrado de un lado y edición en otra parte', () => {
    const local = 'uno\ntres\ncuatro\n';
    const remote = 'uno\ndos\ntres\ncuatro\ncinco\n';
    expect(merge3(local, base, remote)).toEqual({ merged: 'uno\ntres\ncuatro\ncinco\n', clean: true });
  });
});
