export interface Settings {
  theme: 'system' | 'light' | 'dark';
  /** Pantalla de tinta electrónica (Boox): blanco y negro, sin animaciones, botones de página. */
  eink: boolean;
  /** Solo el lápiz dibuja; el dedo desplaza. null = automático (se activa al detectar un lápiz). */
  penOnly: boolean | null;
  /** Renglones de cuaderno detrás del texto de las notas. */
  ruled: boolean;
  dictationLang: string;
  /** Reducir fotos grandes antes de guardarlas en Drive. */
  shrinkPhotos: boolean;
  sort: 'name' | 'modified';
  noteSize: number;
  /** Plantilla para notas a mano nuevas. */
  template: 'rayado' | 'cuadriculado' | 'puntos' | 'blanco';
  /** Carpeta elegida la última vez al guardar algo compartido. */
  lastShareFolder?: string;
}

const KEY = 'tinta.settings';

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  eink: false,
  penOnly: null,
  ruled: true,
  dictationLang: 'es-CO',
  shrinkPhotos: true,
  sort: 'name',
  noteSize: 18,
  template: 'rayado',
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) } : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* sin almacenamiento */
  }
}

/** Aplica tema y modo e-ink al documento (también se hace antes del primer pintado, en index.html). */
export function applyTheme(s: Settings) {
  const root = document.documentElement;
  const dark = s.theme === 'dark' || (s.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  root.dataset.theme = s.eink ? 'light' : dark ? 'dark' : 'light';
  root.dataset.eink = s.eink ? '1' : '0';
  root.style.setProperty('--note-size', `${s.noteSize}px`);
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute('content', s.eink ? '#ffffff' : dark ? '#10142a' : '#f0f3f8');
}
