/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  // Rutas relativas: la app funciona igual en la raíz de un dominio o en una subcarpeta (GitHub Pages).
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    // El Boox Note2 (Android 9) se quedó en Chrome 138: no se usa nada más nuevo.
    target: ['es2022', 'chrome110', 'edge110', 'firefox115', 'safari16'],
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
  },
  worker: { format: 'es' },
  plugins: [
    react(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectRegister: false,
      registerType: 'prompt',
      includeManifestIcons: false,
      injectManifest: {
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,woff2,webmanifest}'],
        globIgnores: ['pdfjs/**', 'config.json'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
      },
      manifest: {
        id: './',
        name: 'Tinta — notas en Google Drive',
        short_name: 'Tinta',
        description: 'Notas, escritura a mano, audio y PDFs sincronizados con una carpeta de Google Drive.',
        lang: 'es',
        dir: 'ltr',
        start_url: './',
        scope: './',
        display: 'standalone',
        orientation: 'any',
        background_color: '#f6f3ec',
        theme_color: '#f6f3ec',
        categories: ['productivity', 'utilities'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        shortcuts: [
          { name: 'Nueva nota', short_name: 'Nota', url: './?nuevo=nota', icons: [{ src: 'icons/icon-192.png', sizes: '192x192' }] },
          { name: 'Nota a mano', short_name: 'A mano', url: './?nuevo=mano', icons: [{ src: 'icons/icon-192.png', sizes: '192x192' }] },
          { name: 'Grabar audio', short_name: 'Audio', url: './?nuevo=audio', icons: [{ src: 'icons/icon-192.png', sizes: '192x192' }] },
        ],
        share_target: {
          action: './compartir',
          method: 'POST',
          enctype: 'multipart/form-data',
          params: {
            title: 'title',
            text: 'text',
            url: 'url',
            files: [
              {
                name: 'files',
                accept: ['image/*', 'application/pdf', 'audio/*', 'video/*', 'text/*', '.md', '.txt', '.pdf'],
              },
            ],
          },
        },
      },
    }),
  ],
  test: {
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
  },
});
