/// <reference lib="webworker" />
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { putShared } from './share/inbox';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: (string | { url: string; revision: string | null })[] };

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// Toda navegación dentro de la app abre index.html (también sin conexión).
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html'), { denylist: [/\/compartir$/, /\/pdfjs\//, /config\.json$/] }));

const RUNTIME = 'tinta-runtime-v1';

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Menú Compartir de Android → guarda en la bandeja y abre la app.
  if (req.method === 'POST' && url.pathname.endsWith('/compartir')) {
    event.respondWith(
      (async () => {
        try {
          const form = await req.formData();
          const files = form
            .getAll('files')
            .filter((f): f is File => typeof f === 'object' && f !== null && 'arrayBuffer' in f)
            .map((f) => ({ name: f.name || 'archivo', type: f.type, blob: f as Blob }));
          const str = (k: string) => {
            const v = form.get(k);
            return typeof v === 'string' && v.trim() ? v : undefined;
          };
          await putShared({ files, title: str('title'), text: str('text'), url: str('url') });
        } catch {
          /* se abre la app igual */
        }
        return Response.redirect(new URL('./?compartido=1', self.registration.scope).href, 303);
      })(),
    );
    return;
  }

  if (req.method !== 'GET') return;

  // Recursos de pdf.js (fuentes, cmaps, wasm): se guardan la primera vez que se usan.
  if (url.pathname.includes('/pdfjs/')) {
    event.respondWith(
      caches.open(RUNTIME).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) void cache.put(req, res.clone());
        return res;
      }),
    );
    return;
  }

  // config.json: primero la red (puede cambiar), y si no hay conexión, la última copia.
  if (url.pathname.endsWith('/config.json')) {
    event.respondWith(
      caches.open(RUNTIME).then(async (cache) => {
        try {
          const res = await fetch(req, { cache: 'no-cache' });
          if (res.ok) void cache.put(req, res.clone());
          return res;
        } catch {
          return (await cache.match(req)) ?? new Response('{}', { headers: { 'Content-Type': 'application/json' } });
        }
      }),
    );
  }
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') void self.skipWaiting();
});
