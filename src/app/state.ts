import { create } from 'zustand';
import { ROOT_LID, type SyncStatus } from '../sync/SyncEngine';
import { applyTheme, loadSettings, saveSettings, type Settings } from './settings';

export interface Route {
  folder: string;
  file?: string;
}

export function parseHash(hash: string): Route {
  const m = /^#\/c\/([^/?]+)(?:\/a\/([^/?]+))?/.exec(hash);
  if (m) return { folder: decodeURIComponent(m[1]), file: m[2] ? decodeURIComponent(m[2]) : undefined };
  return { folder: ROOT_LID };
}

export function routeHash(r: Route): string {
  if (r.folder === ROOT_LID && !r.file) return '#/';
  return `#/c/${encodeURIComponent(r.folder)}${r.file ? `/a/${encodeURIComponent(r.file)}` : ''}`;
}

export type Dialog =
  | { type: 'new'; folder: string }
  | { type: 'item'; lid: string }
  | { type: 'rename'; lid: string }
  | { type: 'move'; lid: string }
  | { type: 'delete'; lid: string }
  | { type: 'newFolder'; folder: string }
  | { type: 'newInk'; folder: string }
  | { type: 'settings' }
  | { type: 'sync' }
  | { type: 'recorder'; folder: string; onSaved?: (lid: string, seconds: number) => void }
  | { type: 'share' };

export interface Toast {
  id: number;
  text: string;
  tone?: 'info' | 'error';
  action?: { label: string; run: () => void };
}

interface AppState {
  route: Route;
  version: number;
  status: SyncStatus;
  settings: Settings;
  toasts: Toast[];
  dialog: Dialog | null;
  query: string;
  /** Pantalla para elegir (o cambiar) la carpeta principal de Drive. */
  pickRoot: boolean;
  setPickRoot(v: boolean): void;
  setRoute(r: Route): void;
  bump(): void;
  setStatus(s: SyncStatus): void;
  updateSettings(p: Partial<Settings>): void;
  toast(text: string, opts?: Omit<Toast, 'id' | 'text'>): void;
  dismissToast(id: number): void;
  openDialog(d: Dialog): void;
  /** Cierra la hoja; la promesa se resuelve cuando el historial ya volvió (seguro para navegar después). */
  closeDialog(): Promise<void>;
  setQuery(q: string): void;
}

let toastSeq = 0;

interface HistState {
  tinta?: number;
  dialog?: boolean;
}
const hstate = (): HistState => (history.state ?? {}) as HistState;

export const useApp = create<AppState>((set, get) => ({
  route: parseHash(location.hash),
  version: 0,
  status: { state: 'idle', pending: 0 },
  settings: loadSettings(),
  toasts: [],
  dialog: null,
  query: '',
  pickRoot: false,
  setPickRoot: (pickRoot) => set({ pickRoot }),
  setRoute: (route) => {
    const cur = get().route;
    if (cur.folder !== route.folder || cur.file !== route.file) set({ route });
  },
  bump: () => set((s) => ({ version: s.version + 1 })),
  setStatus: (status) => set({ status }),
  updateSettings: (p) => {
    const settings = { ...get().settings, ...p };
    saveSettings(settings);
    applyTheme(settings);
    set({ settings });
  },
  toast: (text, opts) => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts.slice(-2), { id, text, ...opts }] }));
    setTimeout(() => get().dismissToast(id), opts?.action ? 7000 : 3800);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  openDialog: (dialog) => {
    // Una entrada en el historial: el botón Atrás de Android cierra la hoja en vez de salir.
    if (!get().dialog && !hstate().dialog) history.pushState({ tinta: (hstate().tinta ?? 0) + 1, dialog: true }, '', location.href);
    set({ dialog });
  },
  closeDialog: () =>
    new Promise<void>((resolve) => {
      if (!get().dialog) return resolve();
      set({ dialog: null });
      if (!hstate().dialog) return resolve();
      const done = () => {
        window.removeEventListener('popstate', done);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, 400);
      window.addEventListener('popstate', done);
      history.back();
    }),
  setQuery: (query) => set({ query }),
}));

/** Navega agregando una entrada al historial (el botón Atrás vuelve a la pantalla anterior). */
export function go(r: Route, opts: { replace?: boolean } = {}) {
  const hash = routeHash(r);
  const st = hstate();
  if (opts.replace || location.hash === hash || (hash === '#/' && !location.hash)) {
    history.replaceState({ ...st, dialog: false }, '', hash);
  } else {
    history.pushState({ tinta: (st.tinta ?? 0) + 1 }, '', hash);
  }
  useApp.getState().setRoute(r);
}

/** Volver: usa el historial si la pantalla anterior es de la app; si no, va a `fallback`. */
export function back(fallback: Route) {
  if ((hstate().tinta ?? 0) > 0) history.back();
  else go(fallback, { replace: true });
}

export function initRouter() {
  const sync = () => {
    const app = useApp.getState();
    if (app.dialog && !hstate().dialog) useApp.setState({ dialog: null });
    app.setRoute(parseHash(location.hash));
  };
  window.addEventListener('popstate', sync);
  window.addEventListener('hashchange', sync);
  return () => {
    window.removeEventListener('popstate', sync);
    window.removeEventListener('hashchange', sync);
  };
}
