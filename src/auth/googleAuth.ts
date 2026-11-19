import { AuthRequiredError } from '../drive/types';
import type { TokenSource } from '../drive/GoogleDrive';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

const TOKEN_KEY = 'tinta.token';
const STATE_KEY = 'tinta.oauth';
const HINT_KEY = 'tinta.loginHint';
const SILENT_FAIL_KEY = 'tinta.silentFailAt';

interface StoredToken {
  accessToken: string;
  expiresAt: number;
  scope: string;
}

export interface RedirectResult {
  ok: boolean;
  error?: string;
  silent?: boolean;
  returnTo?: string;
}

function read<T>(storage: Storage, key: string): T | null {
  try {
    const v = storage.getItem(key);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}
function write(storage: Storage, key: string, value: unknown) {
  try {
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(value));
  } catch {
    /* almacenamiento no disponible */
  }
}

/** La URL a la que Google devuelve al usuario: la de la app, sin index.html ni hash. */
export function defaultRedirectUri(): string {
  return location.origin + location.pathname.replace(/index\.html$/, '');
}

/**
 * Inicio de sesión con Google por redirección (flujo de token para apps web sin servidor).
 * El token dura una hora; se renueva con una redirección silenciosa (prompt=none), que vuelve
 * a la app al instante si la sesión de Google sigue activa.
 */
export class GoogleAuth implements TokenSource {
  private token: StoredToken | null;

  constructor(
    public clientId: string,
    public redirectUri = defaultRedirectUri(),
  ) {
    this.token = read<StoredToken>(localStorage, TOKEN_KEY);
  }

  get loginHint(): string | null {
    return read<string>(localStorage, HINT_KEY);
  }
  set loginHint(v: string | null) {
    write(localStorage, HINT_KEY, v);
  }

  hasValidToken(marginMs = 60_000): boolean {
    return !!this.token && this.token.expiresAt - marginMs > Date.now();
  }

  get expiresAt(): number | undefined {
    return this.token?.expiresAt;
  }

  async getToken(): Promise<string> {
    if (this.token && this.token.expiresAt - 30_000 > Date.now()) return this.token.accessToken;
    throw new AuthRequiredError('Tu sesión de Google venció');
  }

  invalidate() {
    this.token = null;
    write(localStorage, TOKEN_KEY, null);
  }

  /** ¿Falló hace poco un intento silencioso? (evita bucles de redirección) */
  recentlyFailedSilently(windowMs = 10 * 60_000): boolean {
    const at = read<number>(localStorage, SILENT_FAIL_KEY);
    return !!at && Date.now() - at < windowMs;
  }

  /** Lleva al usuario a Google. `silent` no muestra pantallas si ya hay sesión y permiso. */
  signIn(opts: { silent?: boolean; returnTo?: string; selectAccount?: boolean } = {}) {
    const state = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    write(sessionStorage, STATE_KEY, { state, silent: !!opts.silent, returnTo: opts.returnTo ?? location.search + location.hash, at: Date.now() });
    const p = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'token',
      scope: DRIVE_SCOPE,
      include_granted_scopes: 'true',
      state,
    });
    if (opts.silent) p.set('prompt', 'none');
    else if (opts.selectAccount) p.set('prompt', 'select_account');
    const hint = this.loginHint;
    if (hint && !opts.selectAccount) p.set('login_hint', hint);
    location.assign(`${AUTH_URL}?${p.toString()}`);
  }

  /** Procesa la respuesta de Google en el fragmento de la URL. Devuelve null si no hay respuesta. */
  handleRedirect(): RedirectResult | null {
    const hash = location.hash.replace(/^#/, '');
    if (!/(^|&)(access_token|error)=/.test(hash)) return null;
    const p = new URLSearchParams(hash);
    const saved = read<{ state: string; silent: boolean; returnTo?: string }>(sessionStorage, STATE_KEY);
    write(sessionStorage, STATE_KEY, null);
    const returnTo = saved?.returnTo && !/access_token|error=/.test(saved.returnTo) ? saved.returnTo : '';
    history.replaceState(null, '', location.pathname + (returnTo.startsWith('?') ? '' : location.search) + returnTo);

    if (!saved || p.get('state') !== saved.state) return { ok: false, error: 'state_mismatch', returnTo };
    const error = p.get('error');
    if (error) {
      if (saved.silent) write(localStorage, SILENT_FAIL_KEY, Date.now());
      return { ok: false, error, silent: saved.silent, returnTo };
    }
    const accessToken = p.get('access_token');
    const scope = p.get('scope') ?? '';
    if (!accessToken) return { ok: false, error: 'no_token', silent: saved.silent, returnTo };
    if (!scope.split(' ').includes(DRIVE_SCOPE)) {
      return { ok: false, error: 'scope_denied', silent: saved.silent, returnTo };
    }
    this.token = { accessToken, scope, expiresAt: Date.now() + Number(p.get('expires_in') ?? 3599) * 1000 };
    write(localStorage, TOKEN_KEY, this.token);
    write(localStorage, SILENT_FAIL_KEY, null);
    return { ok: true, silent: saved.silent, returnTo };
  }

  /** Cierra la sesión en esta app y revoca el permiso del token actual. */
  signOut() {
    const t = this.token?.accessToken;
    this.invalidate();
    this.loginHint = null;
    if (t) {
      // El endpoint de revocación no admite CORS: se envía como formulario "simple", sin leer la respuesta.
      void fetch(REVOKE_URL, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `token=${encodeURIComponent(t)}`,
      }).catch(() => undefined);
    }
  }
}

export function describeAuthError(error?: string): string {
  switch (error) {
    case 'access_denied':
      return 'No se dio permiso para usar Google Drive.';
    case 'scope_denied':
      return 'Hace falta marcar el permiso de Google Drive para que la app vea tus notas.';
    case 'state_mismatch':
      return 'La respuesta de Google no coincide con la solicitud. Inténtalo otra vez.';
    case 'interaction_required':
    case 'login_required':
    case 'consent_required':
      return 'Google necesita que vuelvas a iniciar sesión.';
    default:
      return error ? `Google respondió: ${error}` : 'No se pudo iniciar sesión.';
  }
}
