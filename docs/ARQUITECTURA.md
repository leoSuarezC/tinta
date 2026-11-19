# Arquitectura de Tinta

Documento de referencia para quien mantenga el código. Resumen y reglas en `CLAUDE.md`; decisiones y alternativas descartadas en `DECISIONES.md`.

## 1. Vista general

```
 ┌──────────────────────── Navegador (PWA) ────────────────────────┐
 │  React UI (src/ui)  ──acciones──►  SyncEngine (src/sync)         │
 │     ▲   │ consultas (useQuery + version)   │        │            │
 │     │   ▼                                  ▼        ▼            │
 │  zustand (src/app/state)            Store (IndexedDB)   DriveApi │
 │                                     items/contents/meta   │      │
 │                                                    GoogleDrive ──┼──► googleapis.com (REST v3)
 │                                                    FakeDrive  (demo y pruebas)              │
 │  GoogleAuth (redirección OAuth) ◄────────────────────────────────┼──► accounts.google.com
 │  Service worker (src/sw.ts): precache, pdf.js, POST /compartir ──► tinta-inbox (IndexedDB)  │
 └──────────────────────────────────────────────────────────────────┘
```

No hay servidor propio. La app es estática (cualquier hosting HTTPS) y habla directo con Google.

## 2. Datos locales (IndexedDB)

Bases de datos:

| Nombre | Uso |
|---|---|
| `tinta` | Modo Google: `items`, `contents`, `meta` |
| `tinta-demo` | Lo mismo para el modo demo |
| `tinta-demo-drive` | Estado del `FakeDrive` del modo demo |
| `tinta-inbox` | Lo que llega por "Compartir a Tinta" (lo escribe el service worker) |

`items` (clave `lid`, índices `byParent`, `byDriveId`) — `LocalItem` en `src/db/db.ts`:

| Campo | Significado |
|---|---|
| `lid` | Id local (uuid; la raíz es `'root'`) |
| `driveId` | Id en Drive, `null` si todavía no se creó allá |
| `parentLid` | Carpeta local que lo contiene |
| `name`, `mimeType`, `isFolder`, `size`, `modifiedTime`, `starred`, `webViewLink`, `canEdit`, `shortcutTargetId` | Estado local visible |
| `base` | Último estado sincronizado: `name`, `parentDriveId`, `starred`, `version` y `md5` (hash del contenido base que tenemos) |
| `remoteMd5` | Hash más reciente conocido en Drive |
| `dirtyContent`, `dirtyMeta`, `deleted` | Cambios locales pendientes (borrar = papelera de Drive al sincronizar) |
| `rev`, `metaRev` | Contadores de cambios locales (contenido / metadatos) |
| `cached` | El contenido está guardado y al día |
| `syncError` | Último error de subida del elemento |

`contents` (clave `lid`): `text` (texto actual), `baseText` (texto base para la fusión), `blob` (binario), `md5`.

`meta`: `rootDriveId`, `rootName`, `pageToken` (feed de cambios), `lastSyncAt`.

`localStorage`: `tinta.settings`, `tinta.mode` (`google`|`demo`), `tinta.clientId`, `tinta.token` (`{accessToken, expiresAt, scope}`), `tinta.loginHint` (correo), `tinta.silentFailAt`. `sessionStorage`: `tinta.oauth` (estado de la redirección en curso).

## 3. Motor de sincronización (`src/sync/SyncEngine.ts`)

### 3.1 Carga inicial — `initRoot(driveId)`
1. `getStartPageToken()` **antes** de listar (así lo que cambie durante el listado llega en el feed).
2. Se vacía el Store y se crea la raíz (`lid='root'`).
3. `listSubtree`: recorrido en anchura consultando hasta 20 carpetas por petición (`'a' in parents or 'b' in parents…`), páginas de 1000, una transacción de IndexedDB por página.
4. Se guardan `rootDriveId`, `rootName`, `pageToken`.
5. `prefetchTexts()`: descarga los textos (md/txt/…) de hasta 2 MB, 3 a la vez, para búsqueda y uso sin conexión. Los binarios se descargan al abrirlos.

### 3.2 Ciclo — `sync()`
Un solo ciclo a la vez (promesa + `again` para repetir hasta 5 veces), y entre pestañas con Web Locks (`tinta-sync`). Pasos: **pull → push → prefetch**. Estado observable: `idle | syncing | offline | auth | error`, más `pending` (elementos con cambios) y `message`.

Disparadores (en `App.tsx` → `Main`): al abrir, cada 60 s con la app visible, al volver a la app (`visibilitychange`), al recuperar conexión (`online`) y después de cada cambio local (`requestSync` con 300–2500 ms según la operación).

### 3.3 Pull
- Lee `changes.list` desde `pageToken` hasta `newStartPageToken`; deduplica por `fileId` (gana el último).
- Varias pasadas: un cambio cuyo padre todavía no se conoce (carpeta nueva en el mismo lote) se reintenta en la siguiente pasada.
- Por cada cambio:
  - Raíz: si se borró → `RootMissingError` (estado `error`); si se renombró → actualiza el nombre.
  - Borrado / en papelera / movido fuera del árbol → `handleRemoteGone`.
  - Padre conocido → nuevo elemento o `applyRemoteUpdate`.
- Carpetas que entran al árbol (nuevas o movidas desde fuera) se listan completas, porque su contenido no viene en el feed.
- `applyRemoteUpdate`: si no hay cambios locales de metadatos, adopta nombre/carpeta/estrella remotos; la `base` siempre toma lo remoto (para calcular bien el siguiente push). Si cambió el hash del contenido: `remoteMd5` nuevo y, sin cambios locales, `cached=false` (se vuelve a descargar).
- `handleRemoteGone` → `removeGone`: borra el subárbol local, pero **conserva** lo que tenga contenido sin subir (lo desvincula: `driveId=null`, se recreará) y devuelve a su carpeta original lo que el usuario había movido localmente a una carpeta que desapareció.

### 3.4 Push (en este orden)
0. **Conflictos ya conocidos:** `dirtyContent && remoteMd5 !== base.md5` → `resolveConflict`.
1. **Creaciones** (`driveId == null`), ordenadas por profundidad (carpetas antes que su contenido). Lo que está dentro de una carpeta borrada localmente no se crea.
2. **Metadatos** (`dirtyMeta`): `files.update` con `name`, `starred`, `addParents`/`removeParents`. 403 por permisos → se deshace el cambio local y se avisa.
3. **Contenido** (`dirtyContent`): antes de subir se pide `getFile` para comparar el hash con `base.md5`; si difiere → `resolveConflict`. Archivo sin permiso de edición → los cambios pasan a una copia.
4. **Eliminaciones:** `trashed: true` (recuperable en la papelera de Drive). 404 se ignora; 403 por permisos → se restaura localmente.

`guard()` envuelve cada operación: `AuthRequiredError`/`OfflineError` cortan el ciclo; 404 → el elemento desapareció en Drive (`handleRemoteGone`); otros errores quedan en `syncError` y en el mensaje de estado.

`commit()` aplica la respuesta de Drive en una transacción `items+contents`:
- Con contenido enviado: `base.md5 = remoteMd5 = md5` de la respuesta, `baseText = texto enviado`, y `dirtyContent=false` **solo si** `rev` no cambió durante la subida.
- Solo metadatos: no toca `base.md5`; si la respuesta trae otro hash, se trata como cambio remoto.
- `dirtyMeta=false` solo si `metaRev` no cambió.

### 3.5 Conflictos — `resolveConflict`
- Se pide el estado remoto y se descarga el contenido.
- **Texto:** `merge3(local, baseText, remoto)` (`src/sync/merge.ts`, node-diff3 por líneas). Inserciones de ambos lados en el mismo punto (p. ej. los dos agregaron líneas al final) se conservan, primero la remota. Se normaliza el salto de línea final para que "agregar al final" no choque.
  - Limpia → el contenido local pasa a ser la fusión, la base pasa a ser lo remoto, y se sube.
  - Con choque → el archivo toma la versión remota y lo local va a una copia nueva `Nombre (conflicto AAAA-MM-DD HHMM).ext`.
- **Binarios:** siempre copia de conflicto con lo local; el original toma lo remoto.
- `applyResolution` es condicional a `rev` (si el usuario siguió escribiendo, se reintenta en el siguiente ciclo) y emite `onContentReplaced(lid)` para que el editor abierto se actualice.

### 3.6 Editores y concurrencia
- `saveText(lid, texto, textoBase)`: si el texto guardado ya no es `textoBase` (llegó una versión nueva entre medio), se fusiona con `merge3` dentro de la misma transacción y se devuelve el resultado; el editor lo muestra.
- `fetchAndCache` (descargas de caché) incrementa `rev` y emite `onContentReplaced` si reemplazó un contenido distinto.
- El editor de notas, al recibir `onContentReplaced`, guarda lo pendiente (fusiona) o recarga.
- El editor de tinta, al recibir `onContentReplaced`, no vuelve a guardar su versión vieja encima (se recarga con la nueva).

### 3.7 Operaciones locales
`createFolder`, `ensureFolder`, `createFile`, `saveText`, `saveBlob`, `rename`, `move` (impide mover una carpeta dentro de sí misma), `setStarred`, `remove` (sin `driveId` se borra local de inmediato), `readText` / `readBlob` (local si está al día; si no, descarga; sin conexión usa la copia vieja), `uniqueName` (evita duplicados con " (2)").

### 3.8 Varias pestañas
Web Locks para que sincronice una sola; `BroadcastChannel('tinta')` para que las demás refresquen la interfaz.

## 4. Autenticación (`src/auth/googleAuth.ts`)

- `signIn({silent, selectAccount, returnTo})` guarda `{state, silent, returnTo}` en `sessionStorage` y navega a `https://accounts.google.com/o/oauth2/v2/auth` con `client_id`, `redirect_uri` (origen + ruta de la app, sin `index.html`), `response_type=token`, `scope=…/auth/drive`, `include_granted_scopes=true`, `state`, y `prompt=none` + `login_hint` si es silenciosa (`select_account` en el primer inicio).
- `handleRedirect()` (al arrancar) lee el fragmento `#access_token=…&expires_in=…&scope=…&state=…` o `#error=…`, verifica `state` y que el alcance incluya Drive, guarda el token y restaura la ruta (`returnTo`, que puede incluir `?nuevo=…`).
- `getToken()` lanza `AuthRequiredError` si faltan menos de 30 s; un 401 de Drive invalida el token.
- Al abrir la app con token vencido, `main.tsx` hace la redirección silenciosa antes de pintar. Durante el uso, `Main` la hace cuando el estado pasa a `auth`, respetando las condiciones de la regla 6 de `CLAUDE.md`. Si un intento silencioso falla (`interaction_required`, `consent_required`…) se registra `tinta.silentFailAt` y por 10 min solo se ofrece el botón "Reconectar".
- `signOut()` borra el token y revoca (`POST https://oauth2.googleapis.com/revoke`, `no-cors`).

## 5. Cliente de Drive (`src/drive/GoogleDrive.ts`)

- Base `https://www.googleapis.com/drive/v3`, subidas en `https://www.googleapis.com/upload/drive/v3`; siempre `supportsAllDrives=true`.
- Campos pedidos (`REMOTE_FIELDS`): `id,name,mimeType,parents,modifiedTime,size,md5Checksum,version,trashed,starred,webViewLink,capabilities(canEdit,canRename,canTrash),shortcutDetails(targetId,targetMimeType)`.
- Listado: `q=('<id>' in parents or …) and trashed = false`, `pageSize=1000`, `includeItemsFromAllDrives=true`.
- Cambios: `changes.list` con `includeRemoved=true`, `spaces=drive`, se descartan los `changeType: 'drive'`.
- Subidas: multipart hasta 5 MB; reanudable por encima (si el navegador no expone `Location`, vuelve a multipart). Actualizar contenido = `PATCH /upload/…/files/<id>?uploadType=multipart`.
- Reintentos con espera exponencial para 429, 5xx y 403 `userRateLimitExceeded`/`rateLimitExceeded`; errores de red → `OfflineError`; 401 → `AuthRequiredError`.
- Carpetas `application/vnd.google-apps.folder`; los tipos `application/vnd.google-apps.*` no se descargan (se abren en Drive).

## 6. Notas (`src/ui/NoteEditor.tsx`, `src/lib/*`)

- `textarea` que crece con el contenido (un solo scroll); renglones como `background` alineado a `--lh = round(note-size × 1.72)`; margen rojo con `::before`.
- Guardado: 450 ms después de la última tecla → `saveText(lid, texto, base)`; también al ocultar la app, al cambiar de archivo y antes de redirigir (`registerFlush`).
- Saltos de línea de Windows (CRLF) se editan como `\n` y se guardan como estaban.
- Continuación de listas: se detecta en `onInput` comparando el texto anterior y el nuevo (funciona con teclados Android que no mandan `keydown` útil). Barra de formato y atajos (Ctrl+B/I/S, Tab en listas) usan `execCommand('insertText')` para no romper Deshacer.
- Vista previa: markdown-it con `html: false`, `breaks: true`, `linkify`. Regla propia de tareas: `<input class="task-box" data-line="N">` con la línea del texto fuente; al tocarla se cambia `[ ]`↔`[x]` en esa línea. Imágenes relativas → `data-src` y se resuelven contra el árbol (`resolveRelative`, y si falla por nombre con `resolveByName`); también `![[archivo]]` estilo Obsidian. Enlaces relativos a audio muestran un reproductor; otros enlaces relativos abren el archivo en la app.
- Adjuntos: subcarpeta `_adjuntos` junto a la nota (`foto-AAAAMMDD-HHMMSS.jpg`, `audio-AAAAMMDD-HHMMSS.webm`). Fotos grandes se reducen a 2560 px JPEG (ajuste "Reducir fotos grandes").
- Dictado (`src/lib/dictation.ts`): `webkitSpeechRecognition` continuo con reinicio automático (Android lo corta tras pausas), idioma configurable (`es-CO` por defecto), comandos "nueva línea", "nuevo párrafo", "punto y aparte", "punto final".

## 7. Tinta (`src/ink/*`, `src/ui/InkEditor.tsx`)

- **Trazos:** `pts = [x, y, presión, …]` en unidades de página; `sim=true` cuando la presión se simula (mouse, dedo o lápiz sin presión). Contorno con perfect-freehand (cacheado por trazo); se dibuja como `Path2D` relleno. Resaltador: opacidad 0,38 y `multiply`. Grosores: lápiz 1,4 / 2,4 / 4 pt; resaltador 10 / 16 / 24 pt.
- **Espacios de coordenadas:** PDF → espacio de usuario PDF (y hacia arriba); la matriz de `page.getViewport({scale}).transform` de pdf.js lleva a px CSS (maneja `/Rotate` y CropBox). Imágenes → 612 unidades de ancho (y hacia abajo), así los grosores se sienten igual que en un PDF.
- **Abrir un PDF:** pdf-lib lee el archivo, extrae los trazos de las anotaciones de Tinta y las quita → bytes "base"; pdf.js dibuja la base (con las anotaciones de otras apps). Si pdf-lib no puede (cifrado o dañado) queda solo lectura.
- **Guardar:** 2,2 s después del último cambio (y al salir): pdf-lib vuelve a cargar la base y agrega una anotación `/Ink` por página (formato en `CLAUDE.md`, regla 5). Imágenes: 4 s; se funde siempre desde la imagen original de la sesión (deshacer funciona mientras está abierta; al cerrarla los trazos quedan en la imagen; Drive guarda la versión anterior).
- **Páginas:** cada una tiene tres lienzos (fondo, tinta, trazo "húmedo" con `desynchronized: true`). Solo las páginas cerca de la pantalla tienen memoria asignada (IntersectionObserver ±120 %); el resto se libera. Máximo 7,5 MP por lienzo. La resolución se recalcula 180 ms después de terminar el zoom.
- **Entrada:** el contenedor tiene `touch-action: none` y la app maneja todo: lápiz escribe (en modo Leer solo si "Solo lápiz" está activo), mouse escribe en modo Anotar, un dedo desplaza (con inercia, salvo e-ink), dos dedos hacen zoom; Ctrl+rueda también. El dedo escribe solo en modo Anotar y con "Solo lápiz" apagado. El primer evento de lápiz activa "Solo lápiz" automáticamente (`penOnly: null → true`). Botón lateral del lápiz (`buttons & 2` o `& 32`) = borrador de trazos completos. `getCoalescedEvents` para trazos suaves. Deshacer/rehacer por pila de `{page, added, removed}`.
- **Cuadernos:** `createNotebook(plantilla)` y `appendNotebookPage` dibujan la plantilla en el contenido de la página (rayado cada 26 pt con margen en x=72, cuadriculado de 5 mm, puntos cada 18 pt).

## 8. PWA (`vite.config.ts`, `src/sw.ts`)

- vite-plugin-pwa en modo `injectManifest`; manifiesto con `start_url`/`scope` relativos (`./`), íconos 192/512/maskable, atajos (`?nuevo=nota|mano|audio`) y `share_target` (`POST ./compartir`, multipart con `title`, `text`, `url`, `files`).
- El service worker precachea la app (incluido el worker de pdf.js), sirve `index.html` en cualquier navegación, guarda en caché los recursos de `pdfjs/` al primer uso, trae `config.json` primero de la red, y recibe lo compartido → `tinta-inbox` → redirige a `./?compartido=1`.
- Actualizaciones: aviso "Hay una versión nueva" con botón Actualizar (`registerType: 'prompt'`).
- Rutas: `#/` (raíz), `#/c/<lidCarpeta>`, `#/c/<lidCarpeta>/a/<lidArchivo>`. Navegación con `history.pushState({tinta: profundidad})`; los diálogos agregan una entrada `{dialog: true}` para que el botón Atrás de Android los cierre. `closeDialog()` devuelve una promesa: espérala antes de navegar.

## 9. Interfaz (`src/ui`, `src/styles/app.css`)

- Una columna por debajo de 760 px; dos paneles (explorador `clamp(280px, 36vw, 352px)` + archivo) por encima.
- `useQuery` repite las consultas cuando cambia `version` (se incrementa en cada `onChange` del motor y por `BroadcastChannel`).
- Ajustes por dispositivo: tema (automático/claro/oscuro), modo e-ink, renglones, tamaño de letra (15–26 px), solo lápiz, idioma del dictado, reducir fotos, orden (nombre/recientes), plantilla preferida.
- Modo e-ink: `data-eink="1"` en `<html>`; tokens en blanco y negro, objetivos de 52 px, sin animaciones, botones de página (`PageButtons`) que desplazan una pantalla de golpe.
- Archivos > 60 MB sin caché piden confirmación antes de descargarse.

## 10. Modo demo

`createDemoServices()` usa un `FakeDrive` persistido en `tinta-demo-drive` (latencia simulada de 90 ms) sembrado con notas, un PNG generado y un cuaderno PDF con trazos. En modo demo existe `window.__tinta` (servicios) para las pruebas e2e: `__tinta.fake` (FakeDrive), `__tinta.engine`, `__tinta.demoRootId`.

## 11. Pruebas

- **Unitarias (`tests/`, vitest + fake-indexeddb, entorno Node):** `sync.test.ts` (dos dispositivos sobre un FakeDrive: carga, CRUD, carpetas sin conexión, cambios externos, eco, fusiones, copias de conflicto, borrados con cambios locales, binarios, escritura durante la subida, permisos, carpeta raíz borrada); `merge.test.ts`; `googleDrive.test.ts` (peticiones y errores con `fetch` simulado); `pdfInk.test.ts` (ida y vuelta del formato de tinta, plantillas, anotaciones ajenas); `editing.test.ts` (Markdown, vista previa, comandos de voz).
- **E2E (`e2e/`, Playwright):** `app.spec.ts` en modo demo (notas, búsqueda, mover/destacar/eliminar, tinta con lápiz sintético, imágenes, grabación con micrófono falso de Chromium, compartir vía service worker, cambios remotos, conflictos, sin conexión, botón Atrás, e-ink). `google.spec.ts` + `googleMock.ts`: intercepta `accounts.google.com` (redirige con un token) y `www.googleapis.com` (API REST respaldada por FakeDrive, incluido multipart) para probar OAuth, elegir carpeta, subir, crear, renovar sesión y recuperarse de un 401.
- Helpers útiles: `penStroke` (eventos `pointerType: 'pen'` con presión), `inkPixels`, `remoteText`/`remoteBytes`/`remoteFile`, `syncNow`.
