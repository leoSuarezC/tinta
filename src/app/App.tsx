import { useEffect, useState } from 'react';
import { NotebookPen } from 'lucide-react';
import { ServicesContext, setMode, saveClientId, type AppConfig, type Services } from './services';
import { go, initRouter, useApp } from './state';
import { flushAll, msSinceInput, reauthHeld, useMediaQuery, WIDE_QUERY } from './hooks';
import { createInk, createNote } from './actions';
import { describeAuthError, GoogleAuth } from '../auth/googleAuth';
import { ROOT_LID } from '../sync/SyncEngine';
import type { RemoteFile } from '../drive/types';
import { readShared } from '../share/inbox';
import { Explorer } from '../ui/Explorer';
import { FileView } from '../ui/FileView';
import { Dialogs } from '../ui/Dialogs';
import { RootPicker } from '../ui/RootPicker';
import { Toasts } from '../ui/Toasts';
import { cls } from '../ui/common';
import { Logo } from '../ui/Logo';

export interface BootState {
  config: AppConfig;
  services?: Services;
  authError?: string;
  justSignedIn?: boolean;
}

export function App({ boot }: { boot: BootState }) {
  if (!boot.services) return <Welcome config={boot.config} error={boot.authError} />;
  return (
    <ServicesContext.Provider value={boot.services}>
      <Root services={boot.services} justSignedIn={boot.justSignedIn} authError={boot.authError} />
    </ServicesContext.Provider>
  );
}

function Root({ services, justSignedIn, authError }: { services: Services; justSignedIn?: boolean; authError?: string }) {
  const [hasRoot, setHasRoot] = useState<boolean | null>(null);
  const pickRoot = useApp((s) => s.pickRoot);
  const toast = useApp((s) => s.toast);

  useEffect(() => {
    void services.engine.rootDriveId().then((id) => setHasRoot(!!id));
  }, [services, pickRoot]);

  // Gancho para las pruebas automáticas (solo en modo demo).
  useEffect(() => {
    if (services.mode === 'demo') (window as unknown as { __tinta?: Services }).__tinta = services;
  }, [services]);

  useEffect(() => {
    if (authError) toast(authError, { tone: 'error' });
    // Guarda el correo para renovar la sesión sin preguntar la cuenta.
    if (justSignedIn && services.auth) {
      services.drive
        .about()
        .then((u) => {
          if (u.emailAddress && services.auth) services.auth.loginHint = u.emailAddress;
        })
        .catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (hasRoot === null) return <div className="boot" aria-busy="true" />;
  if (!hasRoot || pickRoot) return <RootSetup services={services} canCancel={hasRoot && pickRoot} onDone={() => setHasRoot(true)} />;
  return <Main services={services} />;
}

function RootSetup({ services, canCancel, onDone }: { services: Services; canCancel: boolean; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string>();
  const [error, setError] = useState<string>();
  const setPickRoot = useApp((s) => s.setPickRoot);

  const pick = async (f: RemoteFile) => {
    setBusy(true);
    setError(undefined);
    try {
      await services.engine.initRoot(f.id, (n) => setProgress(`Leyendo… ${n} archivos`));
      setPickRoot(false);
      go({ folder: ROOT_LID }, { replace: true });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="setup">
      <header className="setup-head">
        <Logo size={44} />
        <div>
          <h1>Elige la carpeta de tus notas</h1>
          <p>Tinta muestra y sincroniza todo lo que haya dentro: subcarpetas, notas, PDF, imágenes y audios.</p>
        </div>
      </header>
      {error && <p className="form-error">{error}</p>}
      <RootPicker drive={services.drive} onPick={(f) => void pick(f)} busy={busy} progress={progress} />
      {canCancel && !busy && (
        <button className="btn ghost setup-cancel" onClick={() => setPickRoot(false)}>
          Cancelar
        </button>
      )}
    </main>
  );
}

function Main({ services }: { services: Services }) {
  const { engine, auth } = services;
  const route = useApp((s) => s.route);
  const status = useApp((s) => s.status);
  const wide = useMediaQuery(WIDE_QUERY);
  const file = route.file;

  // Estado de sincronización → interfaz
  useEffect(() => {
    const st = useApp.getState();
    const offStatus = engine.onStatus((s) => st.setStatus(s));
    // Otras pestañas de la app en el mismo dispositivo comparten la base local: se avisan entre sí.
    const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('tinta') : null;
    let fromPeer = false;
    if (channel)
      channel.onmessage = () => {
        fromPeer = true;
        useApp.getState().bump();
        void engine.refreshPending();
        fromPeer = false;
      };
    const offChange = engine.onChange(() => {
      useApp.getState().bump();
      if (!fromPeer) channel?.postMessage('change');
    });
    const offRouter = initRouter();
    void engine.refreshPending();
    void engine.sync();
    const tick = setInterval(() => {
      if (document.visibilityState === 'visible' && navigator.onLine) void engine.sync();
    }, 60_000);
    const onOnline = () => void engine.sync();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void engine.sync();
    };
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisible);
    void navigator.storage?.persist?.().catch(() => undefined);
    return () => {
      offStatus();
      offChange();
      channel?.close();
      offRouter();
      clearInterval(tick);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [engine]);

  // Sesión de Google vencida: se renueva sola (redirección silenciosa) cuando no estás escribiendo.
  useEffect(() => {
    if (status.state !== 'auth' || !auth || !navigator.onLine || auth.recentlyFailedSilently()) return;
    let cancelled = false;
    const attempt = async () => {
      if (cancelled) return;
      if (msSinceInput() < 4000 || reauthHeld() || useApp.getState().dialog) {
        setTimeout(attempt, 2000);
        return;
      }
      await flushAll();
      if (!cancelled) auth.signIn({ silent: true, returnTo: location.hash });
    };
    const t = setTimeout(attempt, 1200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [status.state, auth]);

  // Cosas compartidas desde otras apps y accesos directos del ícono (?nuevo=…)
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const nuevo = params.get('nuevo');
    const shared = params.has('compartido');
    if (nuevo || shared) history.replaceState(history.state, '', location.pathname + location.hash);
    void readShared().then((entries) => {
      if (entries.length) useApp.getState().openDialog({ type: 'share' });
    });
    const folder = useApp.getState().route.folder || ROOT_LID;
    if (nuevo === 'nota') void createNote(services, folder, 'md');
    else if (nuevo === 'mano') void createInk(services, folder, useApp.getState().settings.template);
    else if (nuevo === 'audio') useApp.getState().openDialog({ type: 'recorder', folder });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // "/" enfoca la búsqueda (teclado de computador)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || (e.target as HTMLElement)?.closest('input, textarea, select, [contenteditable]')) return;
      const input = document.querySelector<HTMLInputElement>('.search input');
      if (input) {
        e.preventDefault();
        input.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const showExplorer = wide || !file;
  return (
    <div className={cls('shell', file && 'has-file', wide && 'is-wide')}>
      {showExplorer && <Explorer />}
      {file ? (
        <main className="pane">
          <FileView lid={file} />
        </main>
      ) : (
        wide && (
          <main className="pane pane-empty">
            <div className="pane-hint">
              <NotebookPen size={44} strokeWidth={1.4} aria-hidden="true" />
              <p>Abre una nota o crea una con el botón +</p>
            </div>
          </main>
        )
      )}
      {status.state === 'auth' && auth && (auth.recentlyFailedSilently() || !navigator.onLine) && (
        <div className="banner" role="status">
          <span>La sesión de Google venció. Tus cambios están guardados aquí.</span>
          <button className="btn small" onClick={() => auth.signIn({ returnTo: location.hash })}>
            Reconectar
          </button>
        </div>
      )}
      <Dialogs />
      <Toasts />
    </div>
  );
}

function Welcome({ config, error }: { config: AppConfig; error?: string }) {
  const [clientId, setClientId] = useState('');
  const [showSetup, setShowSetup] = useState(!config.googleClientId);
  const connect = () => {
    if (!config.googleClientId) return;
    const auth = new GoogleAuth(config.googleClientId);
    auth.signIn({ selectAccount: true, returnTo: '' });
  };
  const demo = () => {
    setMode('demo');
    location.reload();
  };
  return (
    <main className="welcome">
      <div className="welcome-card">
        <Logo size={64} />
        <h1>Tinta</h1>
        <p className="welcome-lead">Notas, escritura a mano, audios y PDF en una carpeta de tu Google Drive. Funciona sin conexión y se sincroniza en el teléfono, la tableta y el computador.</p>
        {error && <p className="form-error">{describeAuthError(error)}</p>}
        {config.googleClientId && (
          <button className="btn primary wide" onClick={connect}>
            Conectar Google Drive
          </button>
        )}
        {showSetup ? (
          <form
            className="client-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!clientId.trim()) return;
              saveClientId(clientId);
              location.reload();
            }}
          >
            <p>
              Para conectar Drive, la app necesita un <strong>Client ID de OAuth</strong> de Google Cloud. La guía de instalación explica cómo crearlo en unos minutos. Después ponlo en <code>config.json</code> o pégalo aquí:
            </p>
            <input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="123456-abc.apps.googleusercontent.com" aria-label="Client ID de Google" />
            <button className="btn wide" type="submit" disabled={!clientId.trim()}>
              Guardar Client ID
            </button>
          </form>
        ) : (
          <button className="link-btn" onClick={() => setShowSetup(true)}>
            Usar otro Client ID
          </button>
        )}
        <button className="btn ghost wide" onClick={demo}>
          Probar sin cuenta (modo demo)
        </button>
        <p className="welcome-foot">
          Dirección para registrar en Google Cloud: <code>{location.origin + location.pathname.replace(/index\.html$/, '')}</code>
        </p>
      </div>
    </main>
  );
}
