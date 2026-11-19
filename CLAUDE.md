# CLAUDE.md — Tinta (notas sincronizadas con Google Drive)

Traspaso para Claude Code. Léelo completo antes de cambiar algo. Detalle técnico en
[`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md); el porqué de cada decisión en
[`docs/DECISIONES.md`](docs/DECISIONES.md); la guía para el usuario final en [`README.md`](README.md).

## Para quién y cómo trabajar

- **Dueño:** Leonardo, desarrollador senior (.NET/Azure, React/TypeScript). Respóndele **en español**, en términos técnicos; no hace falta simplificar.
- **Dónde vive el proyecto:** esta carpeta de Google Drive (`👾leoClaude › 🖥️claudePC › 📝notesApp`). A partir de ahora se trabaja desde aquí.
- **La interfaz de la app está en español (Colombia).** Los comentarios del código también van en español. Identificadores en inglés.
- Antes de dar algo por terminado: `npm run typecheck`, `npm test` y `npx playwright test` en verde.

## Qué es

**Tinta** es una PWA (React + TypeScript + Vite) de notas que trabaja **sobre una carpeta de Google Drive** que el usuario elige (la de Leonardo se llama `🖋Notes` y adentro tiene, entre otras, `🎙️ NotesAudio`). Muestra y deja manejar **todo** lo que hay en esa carpeta:

- Notas `.md` (editor con renglones de cuaderno, vista previa, listas que continúan, tareas con casillas, fotos y audios embebidos) y `.txt`/otros de texto.
- Notas **a mano** guardadas como **PDF** (cuadernos con plantilla rayado / cuadriculado / puntos / blanco), con presión del lápiz.
- **Anotar PDF** existentes; **anotar y girar imágenes**.
- **Grabar audio** (suelto o dentro de una nota) y **dictado** (Web Speech API).
- **Compartir a Tinta** desde otras apps de Android (Web Share Target).
- Renombrar, mover, destacar (= estrella de Drive), eliminar (papelera de Drive), descargar, abrir en Drive.
- **Funciona sin conexión**: todo se guarda primero en IndexedDB y se sincroniza después; conflictos con fusión de 3 vías o copia "(conflicto …)".
- **Modo demo** sin cuenta (Drive simulado en el navegador) — útil para probar la interfaz.

### Dispositivos objetivo (todas las decisiones de diseño salen de aquí)

| Dispositivo | Detalles que importan |
|---|---|
| Samsung Galaxy Z Fold 6 | Chrome Android. Cerrado ≈ 384 px CSS (una columna). Abierto ≈ 800 px (dos paneles; el corte es `min-width: 760px`). S Pen. |
| Onyx Boox Note2 | **Android 9: Chrome congelado en la versión 138** (no recibe más actualizaciones). Pantalla e-ink 1404×1872 → ≈ 702×936 px CSS. Lápiz Wacom. La tinta en una app web tiene la latencia normal del e-ink (la tinta instantánea de Onyx solo existe para apps nativas con su SDK). |
| Laptop Windows (+ monitor) | Edge o Chrome, instalada como PWA. Mouse y teclado: arrastrar archivos, pegar capturas, atajos. |

## Estado (18 nov 2026)

**Hecho y probado automáticamente:** todo lo de la lista de arriba. 54 pruebas unitarias (motor de sincronización con dos "dispositivos" compartiendo un Drive simulado, fusión, cliente HTTP de Drive, formato de tinta en PDF, edición Markdown) y 32 pruebas de punta a punta (16 escenarios × perfil teléfono y escritorio), incluidos tres escenarios del camino real de Google contra un **Google simulado** (pantalla OAuth + API REST de Drive v3 respaldada por `FakeDrive`).

**Todavía NO verificado:**
1. Con **Google real**: no existe aún el Client ID de OAuth ni el hosting. Puntos a vigilar en el primer uso: CORS de la API de Drive, que el navegador exponga la cabecera `Location` en subidas reanudables (hay plan B a multipart), la redirección silenciosa `prompt=none`, la advertencia de "app no verificada".
2. En **dispositivos físicos**: presión real del S Pen y del lápiz Boox, botón lateral del lápiz (borrador), instalación como app, Compartir a Tinta (requiere WebAPK, o sea Google Play Services), dictado, grabación `.webm` y su reproducción en Drive/Windows, rendimiento de la carga inicial con la carpeta real (cientos de transcripciones y audios).

**Siguiente paso acordado:** publicar la app (GitHub Pages; el flujo `.github/workflows/deploy.yml` ya existe), crear el Client ID (pasos en el README, sección "Puesta en marcha") y hacer el primer inicio de sesión real con la carpeta `🖋Notes`.

## Comandos

```bash
npm ci                          # dependencias (Node 22+)
npm run dev                     # http://localhost:5173 (copia los recursos de pdf.js a public/pdfjs)
npm run typecheck               # tsc (app) + tsc (service worker, tsconfig.sw.json)
npm test                        # vitest: tests/*.test.ts (usa fake-indexeddb)
npm run build                   # dist/ (también copia public/pdfjs)
npx playwright install chromium # una vez por máquina
npx playwright test             # e2e: compila y sirve dist/ en el puerto 4174; perfiles "telefono" y "escritorio"
npx playwright test -g "nota a mano"   # un escenario
```

- El e2e compila solo antes de correr (`webServer` en `playwright.config.ts`); si el puerto 4174 está ocupado por un `vite preview` viejo, ciérralo.
- Para probar con Google en local, el cliente OAuth debe tener el origen `http://localhost:5173` y la redirección `http://localhost:5173/`.
- Client ID: `public/config.json` (`{ "googleClientId": "…" }`), o la variable de GitHub `GOOGLE_CLIENT_ID` (el flujo la escribe al compilar), o pegado en la pantalla de bienvenida (se guarda por dispositivo en `localStorage`).

## Mapa del código

```
src/
  main.tsx              Arranque: config.json, respuesta de OAuth, renovación silenciosa al abrir, servicios, service worker
  sw.ts                 Service worker (Workbox injectManifest): precache, recursos de pdf.js, POST /compartir
  app/
    App.tsx             Pantallas: bienvenida, elegir carpeta, principal (sincronización periódica, re-autenticación, compartir, atajos)
    services.ts         Crea Store + Drive (Google o Fake) + SyncEngine; modo google/demo; config
    state.ts            Estado global (zustand): ruta (#/c/<carpeta>/a/<archivo>), diálogos con entrada en el historial, toasts, ajustes
    hooks.ts            Consultas a IndexedDB que se repiten con `version`; flushAll (guardar antes de redirigir); holdReauth
    actions.ts          Crear nota / cuaderno, guardar archivos y adjuntos (_adjuntos), selector de archivos, descargar
    settings.ts         Ajustes por dispositivo (localStorage) y tema (claro/oscuro/e-ink)
  auth/googleAuth.ts    OAuth por redirección (response_type=token), prompt=none + login_hint, guarda el token, revocar
  drive/
    types.ts            Tipos de Drive v3, DriveApi (interfaz), errores (DriveError, AuthRequiredError, OfflineError)
    GoogleDrive.ts      Cliente REST sin dependencias: listados, descargas, multipart/reanudable, changes, reintentos
    FakeDrive.ts        Drive en memoria con la misma semántica (versiones, hash, papelera, feed de cambios); pruebas y demo
    demo.ts             Persiste el FakeDrive del modo demo en IndexedDB y siembra notas de ejemplo
  db/db.ts              IndexedDB (idb): items, contents, meta. Tipos LocalItem / LocalContent
  sync/
    SyncEngine.ts       EL CORAZÓN. Pull (feed de cambios) → conflictos → push → caché de textos. Operaciones locales.
    merge.ts            Fusión de 3 vías por líneas (node-diff3), unión de inserciones en el mismo punto
  ink/
    model.ts            Trazos (perfect-freehand), contorno, borrador, matrices, paletas y grosores
    pdfInk.ts           Leer/escribir anotaciones /Ink con datos /TintaInk; crear cuadernos y agregar páginas (pdf-lib)
    pdfjs.ts            Carga perezosa de pdf.js **legacy** (compatible con Chrome 138)
  lib/                  editing.ts (operaciones Markdown puras), markdown.ts (markdown-it + tareas), resolve.ts (rutas relativas),
                        dictation.ts (Web Speech), images.ts (reducir y girar)
  share/inbox.ts        Bandeja IndexedDB compartida entre el service worker y la app
  ui/                   Explorer, FileView (despacho por tipo), NoteEditor, InkEditor (PDF/cuadernos/imágenes), Recorder,
                        Dialogs, Settings, ShareSheet, RootPicker, FolderBrowser, SyncButton, FileHeader, PageButtons…
  styles/app.css        Tokens (claro, oscuro, e-ink) y todos los estilos
  fonts/                Atkinson Hyperlegible Next (UI) y Literata (notas), woff2 latin + latin-ext, licencia OFL
tests/                  vitest: sync, merge, googleDrive (fetch simulado), pdfInk, editing
e2e/                    Playwright: app.spec.ts (modo demo), google.spec.ts + googleMock.ts (Google simulado), helpers.ts
scripts/copy-pdf-assets.mjs   Copia cmaps, standard_fonts, wasm e iccs de pdfjs-dist a public/pdfjs
.github/workflows/deploy.yml  Pruebas + build + GitHub Pages
```

## Reglas que no se rompen

1. **Chrome 138 (Boox).** No usar APIs de JS ni CSS posteriores a Chrome 138 sin polyfill. `build.target` es `chrome110`. pdf.js siempre desde `pdfjs-dist/legacy/build/*` (trae polyfills de core-js). Al agregar una dependencia, revisa su soporte de navegadores.
2. **E-ink.** Todo estado debe entenderse en blanco y negro (forma, relleno o texto; nunca solo color). Bajo `:root[data-eink='1']` no hay animaciones, sombras ni grises claros. Cada cambio visual se revisa también en modo e-ink a 702×936.
3. **La UI nunca escribe directo en el Store.** Toda operación local pasa por `SyncEngine` (`createFile`, `saveText`, `saveBlob`, `rename`, `move`, `setStarred`, `remove`, `ensureFolder`…), que marca pendientes y agenda la sincronización.
4. **Invariantes de sincronización** (detalle en ARQUITECTURA.md §3):
   - `base.md5` = hash del contenido que tenemos como base (`contents.baseText` / blob en caché). `remoteMd5` = último hash conocido en Drive. Distintos y sin cambios locales → desactualizado; distintos y con cambios locales → conflicto.
   - Un commit de **solo metadatos nunca** cambia `base.md5`.
   - Toda escritura de resultados es condicional: `rev` (contenido) y `metaRev` (nombre/carpeta/estrella) detectan ediciones hechas durante una subida.
   - Los editores guardan con `saveText(lid, texto, textoBase)`: si el contenido cambió por debajo (llegó otra versión), se fusiona en vez de pisarlo.
   - Nada se pierde: lo que Drive borró pero tenía cambios locales se vuelve a crear; los choques van a copias "(conflicto …)".
   - Cualquier cambio en el motor lleva prueba en `tests/sync.test.ts` con dos dispositivos (`setup()` crea A y B sobre el mismo FakeDrive).
5. **Formato de tinta en PDF (no cambiar sin versionar).** Una anotación `/Ink` estándar por página, con `/AP` (contornos rellenos, resaltador con `/BM /Multiply`), `NM = tinta-ink-<página>` y la clave propia `/TintaInk` → flujo Flate con JSON `{"v":1,"strokes":[{id,tool,color,size,pts:[x,y,p,…],sim}]}` en coordenadas de página PDF. Al abrir se quitan esas anotaciones del PDF base y se convierten en trazos editables; al guardar se vuelven a escribir. Las anotaciones de otras apps se conservan. Cuadernos: palabras clave `tinta-cuaderno` y `plantilla:<rayado|cuadriculado|puntos|blanco>`, página 612×816 pt (3:4).
6. **OAuth sin servidor.** Flujo de token por redirección (`response_type=token`), alcance `https://www.googleapis.com/auth/drive`. La renovación es una redirección `prompt=none` con `login_hint`, que **nunca** ocurre mientras se graba audio (`holdReauth`), con un diálogo abierto o a menos de 4 s de la última escritura; antes se llama a `flushAll()`. Protección contra bucles: si un intento silencioso falla, no se repite en 10 min (se muestra "Reconectar").
7. **Solo la carpeta elegida.** Aunque el alcance es Drive completo, el código solo lee y escribe dentro del árbol de la carpeta raíz.
8. **Textos de la interfaz:** español de Colombia, voz activa, frases cortas, sin tecnicismos para el usuario; la misma acción se llama igual en todas partes ("Eliminar" → "se movió a la papelera de Drive"). Errores que dicen qué pasó y qué hacer.
9. **Diseño:** motivo de cuaderno (papel blanco frío `#fbfcfe`, renglones azules `#c9d6ea`, margen rojo `#de4f57`, tinta azul-negra `#19203a`, azul real `#2340a8` para enlaces y foco). Fuentes auto-alojadas (funciona sin conexión). Los renglones del editor están alineados a `--lh`. Tokens en `src/styles/app.css`; no introducir otra librería de UI.
10. **Accesibilidad básica:** botones con `aria-label` (las pruebas e2e los usan como selectores; si cambias un texto, ajusta las pruebas), foco visible, objetivos táctiles ≥ 44 px (52 px en e-ink).

## Trabajar desde Google Drive

- `node_modules/`, `dist/`, `public/pdfjs/`, `test-results/` y `playwright-report/` son generados (están en `.gitignore`). Google Drive para escritorio no permite excluir carpetas: `npm ci` aquí crea miles de archivos que Drive intentará subir. Si eso se vuelve lento, trabaja en un clon local con git y deja esta carpeta como copia.
- Recomendado: `git init` aquí mismo (no hay historial todavía) y usar GitHub como respaldo; también hace falta para GitHub Pages.
- No edites los mismos archivos a la vez desde la web de Drive y desde el PC.

## Pendientes y siguientes pasos

**Prioridad alta (para poder usarla de verdad):**
1. Publicar en GitHub Pages (o Azure Static Web Apps) y crear el Client ID (README → "Puesta en marcha"). Recomendación: publicar la app en Google Auth Platform para evitar el vencimiento de permisos cada 7 días del modo prueba.
2. Primer uso real con `🖋Notes`: revisar la carga inicial (cantidad de archivos, tiempo), una edición en cada dispositivo y un conflicto a propósito.
3. Pruebas en el Fold, el Boox (modo e-ink, solo lápiz, refresco A2) y Windows; anotar lo que falle.

**Mejoras posibles (aún no pedidas; confirmar con Leonardo antes):**
- Backend mínimo opcional (p. ej. Azure Function) para tokens de actualización y evitar la redirección cada hora.
- Dibujos dentro de notas Markdown (SVG editable en `_adjuntos`).
- Eliminar o reordenar páginas de cuadernos; exportar una nota a PDF.
- Reescribir enlaces de `_adjuntos` al mover una nota (hoy la vista previa los busca por nombre).
- Integración con las transcripciones de `🎙️ NotesAudio` (mostrar la transcripción junto al audio).
- Medir y, si hace falta, virtualizar listas muy largas en el Boox.

## Limitaciones conocidas

- Documentos de Google (Docs/Sheets/Slides) solo se abren en Drive.
- La sesión de Google dura 1 h: la app se reconecta con una redirección breve (los cambios nunca dependen de eso).
- En el Boox la escritura a mano tiene la latencia de una app web en e-ink.
- El dictado necesita internet y el servicio de voz de Google en el dispositivo; Firefox no lo tiene.
- Archivos de más de 60 MB piden confirmación antes de descargarse al dispositivo.
