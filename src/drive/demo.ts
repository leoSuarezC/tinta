import { openDB } from 'idb';
import { FakeDrive, type FakeDriveState } from './FakeDrive';
import { createNotebook, savePdfWithInk } from '../ink/pdfInk';
import type { InkStroke } from '../ink/model';

const DB_NAME = 'tinta-demo-drive';

const WELCOME = `# Bienvenido a Tinta

Esto es el **modo demo**: las notas viven solo en este navegador. Cuando conectes tu cuenta de Google, Tinta trabaja sobre la carpeta de Drive que elijas.

## Lo básico
- [x] Escribe en Markdown o en texto plano
- [ ] Toca una casilla para marcar una tarea
- [ ] Toca **+** para crear una nota, una nota a mano, un audio o una foto
- [ ] Mantén presionado un archivo para renombrarlo, moverlo o destacarlo

## Sin conexión
Todo se guarda primero en el dispositivo y se sube a Drive cuando hay internet. Si editas la misma nota en dos equipos, Tinta junta los cambios; si chocan en la misma línea, guarda una copia con «conflicto» en el nombre.

> En la tableta e-ink, activa el **modo e-ink** en Ajustes.
`;

const SHOPPING = `# Mercado del sábado

- [ ] Café de Santander
- [ ] Arepas
- [x] Aguacates
- [ ] Queso campesino
- [ ] Panela
`;

const IDEAS = `# Ideas para el fin de semana

1. Caminata temprano
2. Probar la receta de ajiaco
3. Ordenar las fotos del viaje

Pendiente: ![atardecer](../Fotos/Atardecer.png)
`;

const BUDGET = `Presupuesto del mes
-------------------
Arriendo        1.200.000
Servicios         280.000
Mercado           650.000
Transporte        180.000
`;

function doodle(): InkStroke[] {
  // Un subrayado ondulado y un círculo, para que el cuaderno de ejemplo no esté vacío.
  const wave: number[] = [];
  for (let i = 0; i <= 60; i++) {
    const x = 100 + i * 6;
    wave.push(x, 640 + Math.sin(i / 4) * 8, 0.35 + 0.4 * Math.sin((i / 60) * Math.PI));
  }
  const circle: number[] = [];
  for (let i = 0; i <= 64; i++) {
    const t = (i / 64) * Math.PI * 2.1;
    circle.push(400 + Math.cos(t) * 70, 500 + Math.sin(t) * 46, 0.55);
  }
  return [
    { id: 'demo-ola', tool: 'pen', color: '#2340a8', size: 2.4, pts: wave },
    { id: 'demo-circulo', tool: 'pen', color: '#cf3434', size: 2.4, pts: circle },
    { id: 'demo-resaltado', tool: 'highlighter', color: '#ffe14d', size: 16, pts: [96, 560, 0.5, 300, 562, 0.5, 520, 558, 0.5] },
  ];
}

async function sunsetPng(): Promise<Blob> {
  const c = document.createElement('canvas');
  c.width = 960;
  c.height = 640;
  const g = c.getContext('2d')!;
  const sky = g.createLinearGradient(0, 0, 0, 640);
  sky.addColorStop(0, '#24305e');
  sky.addColorStop(0.55, '#e07a5f');
  sky.addColorStop(1, '#f2cc8f');
  g.fillStyle = sky;
  g.fillRect(0, 0, 960, 640);
  g.fillStyle = '#f6e7c1';
  g.beginPath();
  g.arc(480, 430, 70, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#1d2747';
  g.beginPath();
  g.moveTo(0, 520);
  for (let x = 0; x <= 960; x += 40) g.lineTo(x, 470 + Math.sin(x / 90) * 30 + Math.cos(x / 37) * 12);
  g.lineTo(960, 640);
  g.lineTo(0, 640);
  g.fill();
  return new Promise((r) => c.toBlob((b) => r(b!), 'image/png'));
}

async function seed(drive: FakeDrive): Promise<string> {
  const root = await drive.ensurePath(['Mis notas (demo)']);
  const md = (s: string) => new Blob([s], { type: 'text/markdown' });
  await drive.create({ name: 'Bienvenida.md', mimeType: 'text/markdown', parents: [root] }, md(WELCOME));
  const shop = await drive.create({ name: 'Mercado.md', mimeType: 'text/markdown', parents: [root] }, md(SHOPPING));
  await drive.update(shop.id, { starred: true });
  const proyectos = await drive.ensurePath(['Proyectos'], root);
  await drive.create({ name: 'Ideas para el fin de semana.md', mimeType: 'text/markdown', parents: [proyectos] }, md(IDEAS));
  await drive.create({ name: 'Presupuesto.txt', mimeType: 'text/plain', parents: [proyectos] }, new Blob([BUDGET], { type: 'text/plain' }));
  const fotos = await drive.ensurePath(['Fotos'], root);
  await drive.create({ name: 'Atardecer.png', mimeType: 'image/png', parents: [fotos] }, await sunsetPng());
  const manuscritas = await drive.ensurePath(['A mano'], root);
  const pdf = await savePdfWithInk(await createNotebook('rayado', 'Cuaderno de ejemplo'), [doodle()]);
  await drive.create({ name: 'Cuaderno de ejemplo.pdf', mimeType: 'application/pdf', parents: [manuscritas] }, new Blob([pdf as BlobPart], { type: 'application/pdf' }));
  return root;
}

/** Drive simulado del modo demo, guardado en IndexedDB para que sobreviva a recargas. */
export async function openDemoDrive(): Promise<{ drive: FakeDrive; rootId: string }> {
  const db = await openDB(DB_NAME, 1, {
    upgrade(d) {
      d.createObjectStore('state');
    },
  });
  const saved = (await db.get('state', 'drive')) as FakeDriveState | undefined;
  const drive = new FakeDrive(saved);
  let rootId = (await db.get('state', 'rootId')) as string | undefined;
  if (!saved || !rootId) {
    rootId = await seed(drive);
    await db.put('state', drive.snapshot(), 'drive');
    await db.put('state', rootId, 'rootId');
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  drive.onMutate = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void db.put('state', drive.snapshot(), 'drive'), 250);
  };
  return { drive, rootId };
}

export async function resetDemo() {
  const { deleteDB } = await import('idb');
  await deleteDB(DB_NAME);
  await deleteDB('tinta-demo');
}
