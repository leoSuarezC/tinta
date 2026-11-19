import { describe, expect, it } from 'vitest';
import { FakeDrive } from '../src/drive/FakeDrive';
import { DriveError, FOLDER_MIME, OfflineError } from '../src/drive/types';
import { openStore, Store, type LocalItem } from '../src/db/db';
import { ROOT_LID, SyncEngine } from '../src/sync/SyncEngine';

let dbCounter = 0;

async function device(drive: FakeDrive) {
  const store = new Store(await openStore(`test-${Date.now()}-${++dbCounter}`));
  const engine = new SyncEngine(store, drive);
  return { store, engine };
}
type Device = Awaited<ReturnType<typeof device>>;

async function setup() {
  const drive = new FakeDrive();
  const notesId = await drive.ensurePath(['🖋Notes']);
  await drive.create({ name: 'Ideas.md', mimeType: 'text/markdown', parents: [notesId] }, new Blob(['# Ideas\nuno\ndos\ntres\n']));
  const subId = await drive.ensurePath(['Proyectos'], notesId);
  await drive.create({ name: 'Mesitas.txt', mimeType: 'text/plain', parents: [subId] }, new Blob(['cabañas\n']));
  await drive.create({ name: 'foto.jpg', mimeType: 'image/jpeg', parents: [subId] }, new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }));
  // Algo fuera de la carpeta, que no debe aparecer.
  await drive.create({ name: 'Fuera.md', mimeType: 'text/markdown', parents: [drive.myDriveId] }, new Blob(['x']));
  const A = await device(drive);
  await A.engine.initRoot(notesId);
  const B = await device(drive);
  await B.engine.initRoot(notesId);
  return { drive, notesId, subId, A, B };
}

async function byName(d: Device, name: string): Promise<LocalItem | undefined> {
  return (await d.store.allItems()).find((i) => i.name === name && !i.deleted);
}
async function must(d: Device, name: string): Promise<LocalItem> {
  const i = await byName(d, name);
  if (!i) throw new Error(`No existe localmente: ${name}`);
  return i;
}
async function text(d: Device, name: string) {
  return d.engine.readText((await must(d, name)).lid);
}
async function remoteText(drive: FakeDrive, name: string) {
  const f = drive.findByName(name);
  if (!f) throw new Error(`No existe en Drive: ${name}`);
  return drive.readText(f.id);
}

describe('carga inicial', () => {
  it('lista solo el árbol de la carpeta elegida, con jerarquía y textos en caché', async () => {
    const { A } = await setup();
    const items = await A.store.allItems();
    expect(items.map((i) => i.name).sort()).toEqual(['Ideas.md', 'Mesitas.txt', 'Proyectos', 'foto.jpg', '🖋Notes'].sort());
    const proyectos = await must(A, 'Proyectos');
    expect((await must(A, 'Mesitas.txt')).parentLid).toBe(proyectos.lid);
    expect((await must(A, 'Ideas.md')).parentLid).toBe(ROOT_LID);
    expect((await must(A, 'Ideas.md')).cached).toBe(true);
    expect((await must(A, 'foto.jpg')).cached).toBe(false);
    expect(await A.store.getContent((await must(A, 'Ideas.md')).lid)).toMatchObject({ text: '# Ideas\nuno\ndos\ntres\n' });
  });
});

describe('cambios locales → Drive → otro dispositivo', () => {
  it('crear, editar, renombrar, mover, destacar y borrar', async () => {
    const { drive, A, B } = await setup();
    const note = await A.engine.createFile(ROOT_LID, 'Nueva.md', 'text/markdown', 'hola');
    await A.engine.sync();
    expect(await remoteText(drive, 'Nueva.md')).toBe('hola');
    expect(A.engine.status.state).toBe('idle');
    expect(A.engine.status.pending).toBe(0);

    await B.engine.sync();
    expect(await text(B, 'Nueva.md')).toBe('hola');

    await A.engine.saveText(note.lid, 'hola mundo');
    await A.engine.sync();
    await B.engine.sync();
    expect(await text(B, 'Nueva.md')).toBe('hola mundo');

    const proyectos = await must(A, 'Proyectos');
    await A.engine.rename(note.lid, 'Renombrada.md');
    await A.engine.move(note.lid, proyectos.lid);
    await A.engine.setStarred(note.lid, true);
    await A.engine.sync();
    const remote = drive.findByName('Renombrada.md')!;
    expect(remote.parents).toEqual([drive.findByName('Proyectos')!.id]);
    expect(remote.starred).toBe(true);

    await B.engine.sync();
    const inB = await must(B, 'Renombrada.md');
    expect(inB.parentLid).toBe((await must(B, 'Proyectos')).lid);
    expect(inB.starred).toBe(true);
    expect(await byName(B, 'Nueva.md')).toBeUndefined();

    await A.engine.remove(note.lid);
    await A.engine.sync();
    expect(drive.allFiles().find((f) => f.name === 'Renombrada.md')?.trashed).toBe(true);
    await B.engine.sync();
    expect(await byName(B, 'Renombrada.md')).toBeUndefined();
  });

  it('carpetas nuevas con contenido se crean en orden (también sin conexión)', async () => {
    const { drive, A, B } = await setup();
    drive.simulateOffline(50);
    const f1 = await A.engine.createFolder(ROOT_LID, 'Viajes');
    const f2 = await A.engine.createFolder(f1.lid, 'Lisboa');
    await A.engine.createFile(f2.lid, 'plan.md', 'text/markdown', '- [ ] tranvía 28');
    await A.engine.sync();
    expect(A.engine.status.state).toBe('offline');
    expect(A.engine.status.pending).toBe(3);

    drive.failures = [];
    await A.engine.sync();
    expect(A.engine.status.state).toBe('idle');
    const lisboa = drive.findByName('Lisboa')!;
    expect(drive.findByName('plan.md')!.parents).toEqual([lisboa.id]);
    expect(lisboa.parents).toEqual([drive.findByName('Viajes')!.id]);

    await B.engine.sync();
    expect(await text(B, 'plan.md')).toBe('- [ ] tranvía 28');
    expect((await must(B, 'plan.md')).parentLid).toBe((await must(B, 'Lisboa')).lid);
  });

  it('borrar una carpeta la manda a la papelera con todo su contenido', async () => {
    const { drive, A, B } = await setup();
    await A.engine.remove((await must(A, 'Proyectos')).lid);
    await A.engine.sync();
    expect(drive.findByName('Mesitas.txt')).toBeUndefined();
    await B.engine.sync();
    expect(await byName(B, 'Proyectos')).toBeUndefined();
    expect(await byName(B, 'Mesitas.txt')).toBeUndefined();
  });
});

describe('cambios hechos fuera de la app', () => {
  it('archivos y carpetas nuevos, movidos dentro y fuera', async () => {
    const { drive, notesId, A } = await setup();
    // Una carpeta con contenido que estaba fuera se mueve dentro.
    const outside = await drive.ensurePath(['Archivo viejo']);
    await drive.create({ name: 'viejo.md', mimeType: 'text/markdown', parents: [outside] }, new Blob(['antiguo']));
    await drive.update(outside, { addParents: [notesId], removeParents: [drive.myDriveId] });
    // Un archivo se va fuera.
    const ideas = drive.findByName('Ideas.md')!;
    await drive.update(ideas.id, { addParents: [drive.myDriveId], removeParents: [notesId] });
    // Una carpeta nueva con un archivo nuevo.
    const nueva = await drive.ensurePath(['Nueva'], notesId);
    await drive.create({ name: 'n.md', mimeType: 'text/markdown', parents: [nueva] }, new Blob(['n']));

    await A.engine.sync();
    expect(await text(A, 'viejo.md')).toBe('antiguo');
    expect((await must(A, 'viejo.md')).parentLid).toBe((await must(A, 'Archivo viejo')).lid);
    expect(await byName(A, 'Ideas.md')).toBeUndefined();
    expect(await text(A, 'n.md')).toBe('n');
  });

  it('un archivo editado en Drive se actualiza sin marcarse como pendiente', async () => {
    const { drive, A } = await setup();
    await drive.update(drive.findByName('Ideas.md')!.id, {}, new Blob(['nuevo contenido']));
    await A.engine.sync();
    expect(await text(A, 'Ideas.md')).toBe('nuevo contenido');
    expect(A.engine.status.pending).toBe(0);
  });

  it('el eco de los propios cambios no vuelve a descargar nada', async () => {
    const { drive, A } = await setup();
    await A.engine.saveText((await must(A, 'Ideas.md')).lid, 'editado');
    await A.engine.sync();
    const calls = drive.callCount;
    await A.engine.sync();
    // Solo la consulta del feed de cambios (sin descargas ni subidas).
    expect(drive.callCount - calls).toBe(1);
    expect((await must(A, 'Ideas.md')).cached).toBe(true);
  });
});

describe('conflictos', () => {
  it('ediciones en líneas distintas se fusionan en ambos dispositivos', async () => {
    const { drive, A, B } = await setup();
    await A.engine.saveText((await must(A, 'Ideas.md')).lid, '# Ideas\nUNO\ndos\ntres\n');
    await B.engine.saveText((await must(B, 'Ideas.md')).lid, '# Ideas\nuno\ndos\nTRES\n');
    await A.engine.sync();
    await B.engine.sync();
    await A.engine.sync();
    const expected = '# Ideas\nUNO\ndos\nTRES\n';
    expect(await remoteText(drive, 'Ideas.md')).toBe(expected);
    expect(await text(A, 'Ideas.md')).toBe(expected);
    expect(await text(B, 'Ideas.md')).toBe(expected);
    expect((await B.store.allItems()).some((i) => i.name.includes('conflicto'))).toBe(false);
  });

  it('ediciones en la misma línea crean una copia de conflicto', async () => {
    const { drive, A, B } = await setup();
    await A.engine.saveText((await must(A, 'Ideas.md')).lid, '# Ideas\nuno desde A\ndos\ntres\n');
    await B.engine.saveText((await must(B, 'Ideas.md')).lid, '# Ideas\nuno desde B\ndos\ntres\n');
    await A.engine.sync();
    await B.engine.sync();
    expect(await remoteText(drive, 'Ideas.md')).toBe('# Ideas\nuno desde A\ndos\ntres\n');
    const copy = drive.allFiles().find((f) => f.name.startsWith('Ideas (conflicto'));
    expect(copy).toBeDefined();
    expect(await drive.readText(copy!.id)).toBe('# Ideas\nuno desde B\ndos\ntres\n');
    expect(await text(B, 'Ideas.md')).toBe('# Ideas\nuno desde A\ndos\ntres\n');
    await A.engine.sync();
    expect((await A.store.allItems()).some((i) => i.name.startsWith('Ideas (conflicto'))).toBe(true);
  });

  it('una edición sin conexión sobre una copia vieja se fusiona con lo nuevo', async () => {
    const { drive, A, B } = await setup();
    // B se entera de que hay una versión nueva pero no alcanza a descargarla.
    await A.engine.saveText((await must(A, 'Ideas.md')).lid, '# Ideas\nuno\ndos\ntres\ncuatro (A)\n');
    await A.engine.sync();
    const ideasB = await must(B, 'Ideas.md');
    drive.failures = [];
    // Pull manual: el feed llega, pero las descargas fallan (sin conexión a mitad de camino).
    const realDownload = drive.download.bind(drive);
    drive.download = async () => {
      throw new OfflineError();
    };
    await B.engine.sync();
    expect((await must(B, 'Ideas.md')).cached).toBe(false);
    // B edita la versión vieja que tiene.
    const stale = await B.engine.readText(ideasB.lid);
    expect(stale).toBe('# Ideas\nuno\ndos\ntres\n');
    await B.engine.saveText(ideasB.lid, '# Ideas (B)\nuno\ndos\ntres\n');
    drive.download = realDownload;
    await B.engine.sync();
    expect(await remoteText(drive, 'Ideas.md')).toBe('# Ideas (B)\nuno\ndos\ntres\ncuatro (A)\n');
  });

  it('borrado en Drive mientras había cambios locales: el archivo se vuelve a crear', async () => {
    const { drive, A } = await setup();
    await A.engine.saveText((await must(A, 'Ideas.md')).lid, 'cambio importante');
    await drive.update(drive.findByName('Ideas.md')!.id, { trashed: true });
    await A.engine.sync();
    const recreated = drive.allFiles().filter((f) => f.name === 'Ideas.md' && !f.trashed);
    expect(recreated).toHaveLength(1);
    expect(await drive.readText(recreated[0].id)).toBe('cambio importante');
  });

  it('carpeta borrada en Drive con un archivo editado dentro: se conservan ambos', async () => {
    const { drive, A } = await setup();
    await A.engine.saveText((await must(A, 'Mesitas.txt')).lid, 'presupuesto nuevo');
    await drive.update(drive.findByName('Proyectos')!.id, { trashed: true });
    await A.engine.sync();
    const folder = drive.allFiles().find((f) => f.name === 'Proyectos' && !f.trashed);
    expect(folder).toBeDefined();
    const file = drive.allFiles().find((f) => f.name === 'Mesitas.txt' && !f.trashed);
    expect(file?.parents).toEqual([folder!.id]);
    expect(await byName(A, 'foto.jpg')).toBeUndefined();
  });

  it('binarios editados en los dos lados: copia de conflicto', async () => {
    const { drive, A, B } = await setup();
    const fotoA = await must(A, 'foto.jpg');
    const fotoB = await must(B, 'foto.jpg');
    await A.engine.readBlob(fotoA.lid);
    await B.engine.readBlob(fotoB.lid);
    await A.engine.saveBlob(fotoA.lid, new Blob([new Uint8Array([9, 9])], { type: 'image/jpeg' }));
    await B.engine.saveBlob(fotoB.lid, new Blob([new Uint8Array([7, 7, 7])], { type: 'image/jpeg' }));
    await A.engine.sync();
    await B.engine.sync();
    const copies = drive.allFiles().filter((f) => f.name.startsWith('foto (conflicto') && !f.trashed);
    expect(copies).toHaveLength(1);
    expect(copies[0].size).toBe('3');
    expect(drive.findByName('foto.jpg')!.size).toBe('2');
  });

  it('seguir escribiendo durante la subida deja el archivo pendiente con lo último', async () => {
    const { drive, A } = await setup();
    const ideas = await must(A, 'Ideas.md');
    await A.engine.saveText(ideas.lid, 'versión 1');
    const realUpdate = drive.update.bind(drive);
    let once = true;
    drive.update = async (id, patch, content) => {
      const r = await realUpdate(id, patch, content);
      if (once && content) {
        once = false;
        await A.engine.saveText(ideas.lid, 'versión 2');
      }
      return r;
    };
    await A.engine.sync();
    await A.engine.sync();
    expect(await remoteText(drive, 'Ideas.md')).toBe('versión 2');
    expect((await must(A, 'Ideas.md')).dirtyContent).toBe(false);
  });
});

describe('estados', () => {
  it('sin conexión los cambios quedan pendientes y se suben al volver', async () => {
    const { drive, A } = await setup();
    await A.engine.saveText((await must(A, 'Ideas.md')).lid, 'offline');
    drive.simulateOffline(20);
    await A.engine.sync();
    expect(A.engine.status.state).toBe('offline');
    expect(A.engine.status.pending).toBe(1);
    drive.failures = [];
    await A.engine.sync();
    expect(A.engine.status).toMatchObject({ state: 'idle', pending: 0 });
    expect(await remoteText(drive, 'Ideas.md')).toBe('offline');
  });

  it('si la carpeta principal se borra, se avisa', async () => {
    const { drive, notesId, A } = await setup();
    await drive.update(notesId, { trashed: true });
    await A.engine.sync();
    expect(A.engine.status.state).toBe('error');
    expect(A.engine.status.message).toMatch(/carpeta principal/);
  });

  it('archivos sin permiso de edición: los cambios van a una copia', async () => {
    const { drive, notesId, A } = await setup();
    const ro = await drive.create({ name: 'Compartido.md', mimeType: 'text/markdown', parents: [notesId] }, new Blob(['original']));
    // Se simula un archivo compartido de solo lectura.
    (drive as unknown as { files: Map<string, { file: { capabilities: object } }> }).files.get(ro.id)!.file.capabilities = { canEdit: false };
    await drive.update(notesId, {});
    await A.engine.sync();
    await A.engine.saveText((await must(A, 'Compartido.md')).lid, 'mi versión');
    await A.engine.sync();
    await A.engine.sync();
    expect(await remoteText(drive, 'Compartido.md')).toBe('original');
    const copy = drive.allFiles().find((f) => f.name.startsWith('Compartido (conflicto'));
    expect(copy && (await drive.readText(copy.id))).toBe('mi versión');
  });

  it('cada carpeta nueva queda con el tipo correcto en Drive', async () => {
    const { drive, A } = await setup();
    await A.engine.createFolder(ROOT_LID, 'Diario');
    await A.engine.sync();
    expect(drive.findByName('Diario')!.mimeType).toBe(FOLDER_MIME);
  });
});

describe('editor y sincronización al mismo tiempo', () => {
  it('lo que el editor guarda sobre una versión vieja se fusiona con la que llegó de Drive', async () => {
    const { drive, A } = await setup();
    const ideas = await must(A, 'Ideas.md');
    const loaded = await A.engine.readText(ideas.lid); // el editor abrió esta versión
    // Llega una versión nueva desde otro dispositivo mientras la nota está abierta
    await drive.update(drive.findByName('Ideas.md')!.id, {}, new Blob(['# Ideas\nuno\ndos\ntres\ncuatro (Boox)\n']));
    await A.engine.sync();
    expect(await A.engine.readText(ideas.lid)).toContain('cuatro (Boox)');
    // El editor guarda su cambio hecho sobre la versión vieja
    const stored = await A.engine.saveText(ideas.lid, loaded.replace('uno', 'UNO (Fold)'), loaded);
    expect(stored).toBe('# Ideas\nUNO (Fold)\ndos\ntres\ncuatro (Boox)\n');
    await A.engine.sync();
    expect(await remoteText(drive, 'Ideas.md')).toBe('# Ideas\nUNO (Fold)\ndos\ntres\ncuatro (Boox)\n');
  });
});

describe('permisos', () => {
  it('si Drive no deja renombrar o eliminar, se deshace el cambio local y se avisa', async () => {
    const { drive, A } = await setup();
    const ideas = await must(A, 'Ideas.md');
    const realUpdate = drive.update.bind(drive);
    drive.update = async (id, patch, content) => {
      if (patch.name || patch.trashed) throw new DriveError('The user does not have sufficient permissions for this file.', 403, 'insufficientFilePermissions');
      return realUpdate(id, patch, content);
    };
    await A.engine.rename(ideas.lid, 'Otro nombre.md');
    await A.engine.sync();
    expect((await A.store.getItem(ideas.lid))?.name).toBe('Ideas.md');
    expect(A.engine.status.state).toBe('error');
    expect(A.engine.status.message).toMatch(/no tienes permiso/);
    await A.engine.remove(ideas.lid);
    await A.engine.sync();
    expect((await A.store.getItem(ideas.lid))?.deleted).toBe(false);
    expect(drive.findByName('Ideas.md')).toBeDefined();
  });
});
