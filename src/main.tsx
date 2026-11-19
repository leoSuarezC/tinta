import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import './styles/app.css';
import { App, type BootState } from './app/App';
import { applyTheme } from './app/settings';
import { useApp } from './app/state';
import { createDemoServices, createGoogleServices, getMode, loadConfig, setMode } from './app/services';
import { GoogleAuth } from './auth/googleAuth';

async function boot(): Promise<BootState | null> {
  applyTheme(useApp.getState().settings);
  const config = await loadConfig();

  if (config.googleClientId) {
    const auth = new GoogleAuth(config.googleClientId);
    const result = auth.handleRedirect();
    if (result?.ok) setMode('google');
    if (getMode() === 'google') {
      const services = await createGoogleServices(auth);
      const hasRoot = !!(await services.engine.rootDriveId());
      // Sesión vencida al abrir la app: se renueva antes de mostrar nada (vuelve en un instante).
      if (!result && !auth.hasValidToken() && navigator.onLine && hasRoot && !auth.recentlyFailedSilently()) {
        auth.signIn({ silent: true, returnTo: location.search + location.hash });
        return null;
      }
      // Sin sesión y sin carpeta elegida: volver a la bienvenida.
      if (!auth.hasValidToken() && !hasRoot) {
        if (!result?.ok) setMode(null);
        if (getMode() !== 'google') return { config, authError: result?.error };
      }
      return { config, services, justSignedIn: !!result?.ok, authError: result && !result.ok && !result.silent ? result.error : undefined };
    }
    if (result && !result.ok) return { config, authError: result.error };
  }

  if (getMode() === 'demo') {
    const services = await createDemoServices();
    return { config, services };
  }
  return { config };
}

function showFatal(e: unknown) {
  const el = document.getElementById('root');
  if (el) el.innerHTML = `<div class="fatal"><p>No se pudo iniciar Tinta.</p><pre></pre><button onclick="location.reload()">Reintentar</button></div>`;
  const pre = el?.querySelector('pre');
  if (pre) pre.textContent = String((e as Error)?.stack ?? e);
}

boot()
  .then((state) => {
    if (!state) return;
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <App boot={state} />
      </StrictMode>,
    );
  })
  .catch(showFatal);

// Service worker: funciona sin conexión y avisa cuando hay una versión nueva.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  const update = registerSW({
    onNeedRefresh() {
      useApp.getState().toast('Hay una versión nueva de Tinta.', { action: { label: 'Actualizar', run: () => void update(true) } });
    },
  });
}

// Cambio de tema del sistema
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(useApp.getState().settings));
