# Decisiones de diseño

Registro de por qué Tinta es como es, para no deshacer algo sin conocer el motivo. Cada entrada: contexto, decisión, alternativas descartadas y qué la haría cambiar.

## D1 — PWA en React + TypeScript
- **Contexto:** una sola app para Android (Fold y Boox) y Windows.
- **Decisión:** PWA instalable (Vite + React 19 + TypeScript), elegida por Leonardo entre tres opciones.
- **Descartado:** Blazor WASM PWA (arranque lento en el teléfono); .NET MAUI (requiere compilar e instalar APK y app de Windows).
- **Cambiaría si:** la latencia del lápiz en el Boox resulta inaceptable; la única salida es una app nativa con el SDK de Onyx (al menos para el Boox).

## D2 — OAuth por redirección, sin servidor
- **Decisión:** flujo de token de Google (`response_type=token`) por redirección completa; el token (1 h) vive en `localStorage`; renovación con `prompt=none` + `login_hint`.
- **Por qué:** sin backend; funciona igual en la PWA instalada en Android (las ventanas emergentes son poco fiables en modo standalone) y en escritorio. Google sigue documentando el flujo, aunque recomienda código + PKCE.
- **Descartado:** Google Identity Services con ventana emergente (necesita un toque del usuario para cada renovación y falla en PWAs instaladas); código + PKCE en el navegador (Google exige `client_secret` para clientes web); backend propio (más infraestructura; ver abajo).
- **Costo:** una redirección breve cada hora de uso activo (se hace cuando no estás escribiendo ni grabando).
- **Cambiaría si:** las redirecciones molestan → backend mínimo (p. ej. Azure Function o la API de Azure Static Web Apps) que cambie el código por tokens y guarde el refresh token cifrado.

## D3 — Alcance de Drive completo (`auth/drive`)
- **Contexto:** Leonardo pidió ver y editar **todo** lo que hay en la carpeta, incluidos archivos creados por otras apps (Boox, celular, Drive web, transcripciones).
- **Decisión:** alcance restringido `drive`; el código solo opera dentro de la carpeta raíz elegida.
- **Descartado:** `drive.file` + Google Picker (no está claro que conceda acceso al contenido de una carpeta ni a archivos que otras apps agreguen después).
- **Consecuencia:** Google muestra "app no verificada". Para uso personal: publicar la app (advertencia una sola vez) o dejarla en prueba (hay que volver a dar permiso cada 7 días).

## D4 — Sincronización por estado con feed de cambios
- **Decisión:** cada elemento guarda estado local + `base` (último estado sincronizado) + `remoteMd5`; banderas de pendientes y contadores `rev`/`metaRev`. Lo remoto llega por `changes.list` (incremental); la carga inicial lista el árbol.
- **Descartado:** cola de operaciones (más frágil ante reintentos y reordenamientos); listar todo el árbol en cada ciclo (demasiadas peticiones).
- **Detalle importante:** `base.md5` describe el contenido base que tenemos de verdad (no el último que vimos en Drive). Así una edición sin conexión sobre una copia vieja se detecta como conflicto y se fusiona en vez de pisar lo remoto.

## D5 — Conflictos: fusionar texto, copiar lo demás, metadatos gana lo local
- **Texto:** fusión de 3 vías por líneas; inserciones en el mismo punto se conservan ambas (caso típico: dos dispositivos agregan líneas al final). Choques reales → copia "(conflicto fecha)".
- **Binarios** (PDF, imágenes, audio): copia de conflicto siempre.
- **Nombre/carpeta/estrella:** gana el cambio local (se aplica sobre la base remota).
- **Borrado remoto con cambios locales:** se vuelve a crear. Principio: nunca perder lo que el usuario escribió.

## D6 — Escritura a mano como PDF con anotaciones /Ink
- **Decisión:** cuadernos = PDF; los trazos son anotaciones `/Ink` estándar con apariencia (`/AP`), más los trazos originales con presión en un flujo propio `/TintaInk` (JSON comprimido, versionado con `v`).
- **Por qué:** se ven en Drive, en el lector del Boox y en cualquier visor; se pueden seguir editando trazo por trazo en Tinta; el mismo motor sirve para anotar cualquier PDF sin tocar su contenido original.
- **Descartado:** SVG o JSON propio (no se ven bien fuera de la app; varias páginas complican); aplanar los trazos en el contenido del PDF (no se podrían borrar después).

## D7 — Imágenes: anotar fundiendo sobre la original
- **Decisión:** durante la sesión se puede deshacer y borrar; al guardar se funde siempre desde la imagen original de la sesión. Al cerrar, los trazos quedan en la imagen. Drive conserva las versiones anteriores del archivo.

## D8 — Compatibilidad con Chrome 138
- **Contexto:** el Boox Note2 tiene Android 9 y Chrome dejó de actualizarse ahí a mediados de 2025 (versión 138).
- **Decisión:** `build.target` `chrome110`; pdf.js desde la build `legacy` (con polyfills); revisar cada API/CSS nuevo contra Chrome 138. En el Boox se usa el Chrome de la Play Store: con el navegador propio de Onyx el inicio de sesión de Google puede fallar (no se ha probado).

## D9 — Modo e-ink manual
- **Decisión:** interruptor en Ajustes (por dispositivo), no detección automática.
- **Por qué:** el user agent de Chrome ya no trae el modelo del dispositivo y la pantalla e-ink no se reporta como `monochrome`.
- **Qué hace:** blanco y negro puro, sin animaciones ni inercia, botones de página, objetivos de 52 px, sin margen rojo en las notas.

## D10 — El lápiz nunca desplaza la página
- **Decisión:** en el visor de tinta `touch-action: none` y gestos propios (un dedo desplaza, dos hacen zoom).
- **Por qué:** en Chrome Android el lápiz se trata como un dedo para desplazar; con desplazamiento nativo el lápiz no podría escribir.
- **Extra:** "Solo lápiz" se activa solo al detectar el primer evento de lápiz (rechazo de palma).

## D11 — Adjuntos en `_adjuntos` junto a la nota
- **Decisión:** fotos y audios de una nota van a `_adjuntos/` en la misma carpeta, con enlaces Markdown relativos (compatible con Obsidian y legible en cualquier editor). Si la nota se mueve, la vista previa busca el archivo por nombre.

## D12 — "Destacar" = estrella de Drive
- Se sincroniza sola entre dispositivos y se ve igual en Drive. Las destacadas aparecen arriba en la carpeta principal.

## D13 — Navegación con `#` y rutas relativas
- **Por qué:** GitHub Pages no permite reescrituras; con `#/c/…` cualquier hosting estático sirve. El fragmento de la respuesta de OAuth (`#access_token=…`) se procesa al arrancar antes del enrutador, y la ruta se restaura desde `sessionStorage`.

## D14 — Qué se guarda en el dispositivo
- Textos de hasta 2 MB siempre (búsqueda y uso sin conexión). Binarios al abrirlos ("Liberar espacio" en Ajustes los borra). Archivos de más de 60 MB piden confirmación. Se pide almacenamiento persistente (`navigator.storage.persist()`).

## D15 — Audio en WebM/Opus
- Es lo que Chrome graba de forma fiable en Android y escritorio. Se le agrega la duración al terminar (`fix-webm-duration`) para poder adelantar. Si hiciera falta compatibilidad con reproductores de Windows, evaluar MP4/AAC donde `MediaRecorder` lo soporte.

## D16 — Identidad visual propia
- **Decisión:** el motivo del cuaderno colombiano (renglones azules, margen rojo, tinta azul-negra) en vez de una plantilla genérica; Atkinson Hyperlegible Next para la interfaz (muy legible, buena en e-ink) y Literata para el texto de las notas (diseñada para leer en pantalla y e-ink). Fuentes auto-alojadas para funcionar sin conexión.
- **Regla:** la personalidad está en la hoja de la nota; el resto de la interfaz es sobria.
