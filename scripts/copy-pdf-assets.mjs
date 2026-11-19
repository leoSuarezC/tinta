// Copia los recursos que pdf.js carga en tiempo de ejecución (CMaps, fuentes estándar,
// decodificadores WASM y perfiles ICC) a public/pdfjs para que se sirvan junto a la app.
import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'pdfjs-dist');
const dest = join(root, 'public', 'pdfjs');

if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });

for (const dir of ['cmaps', 'standard_fonts', 'iccs']) {
  cpSync(join(src, dir), join(dest, dir), { recursive: true });
}
// Solo los decodificadores de imagen; el motor de scripts (quickjs) no se usa.
cpSync(join(src, 'wasm'), join(dest, 'wasm'), {
  recursive: true,
  filter: (p) => !/quickjs/i.test(p),
});
console.log('pdf.js assets copied to public/pdfjs');
