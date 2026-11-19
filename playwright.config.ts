import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

// En algunos entornos Chromium viene preinstalado; si no, usa `npx playwright install chromium`.
const preinstalled = process.env.PW_CHROMIUM ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

const PORT = 4174;
export default defineConfig({
  testDir: 'e2e',
  testMatch: /.*\.spec\.ts/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 2,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}/`,
    locale: 'es-CO',
    launchOptions: {
      executablePath: preinstalled,
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    },
    trace: 'retain-on-failure',
  },
  // Compila antes de servir: así las pruebas nunca corren contra una versión vieja de dist/.
  webServer: {
    command: `npm run build && npx vite preview --port ${PORT} --strictPort`,
    port: PORT,
    reuseExistingServer: false,
    timeout: 180_000,
  },
  projects: [
    { name: 'telefono', use: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true } },
    { name: 'escritorio', use: { viewport: { width: 1280, height: 800 } } },
  ],
});
