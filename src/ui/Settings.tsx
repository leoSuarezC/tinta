import { useEffect, useState } from 'react';
import { FolderCog, LogOut, Trash2 } from 'lucide-react';
import { useServices, setMode } from '../app/services';
import { useApp } from '../app/state';
import { flushAll } from '../app/hooks';
import { formatBytes } from '../model/fileTypes';
import { cls, Sheet, Toggle } from './common';

const LANGS = [
  { id: 'es-CO', label: 'Español (Colombia)' },
  { id: 'es-MX', label: 'Español (México)' },
  { id: 'es-ES', label: 'Español (España)' },
  { id: 'en-US', label: 'Inglés (EE. UU.)' },
  { id: 'pt-BR', label: 'Portugués (Brasil)' },
];

export function SettingsSheet({ onClose }: { onClose: () => void }) {
  const s = useServices();
  const settings = useApp((st) => st.settings);
  const update = useApp((st) => st.updateSettings);
  const toast = useApp((st) => st.toast);
  const pending = useApp((st) => st.status.pending);
  const [usage, setUsage] = useState<string>();
  const [rootName, setRootName] = useState<string>();

  useEffect(() => {
    void s.store.getMeta<string>('rootName').then(setRootName);
    navigator.storage
      ?.estimate?.()
      .then((e) => setUsage(e.usage !== undefined ? formatBytes(e.usage) : undefined))
      .catch(() => undefined);
  }, [s.store]);

  const free = async () => {
    const freed = await s.store.evictBinaries();
    toast(freed ? `Se liberaron ${formatBytes(freed)}. Los archivos se vuelven a descargar al abrirlos.` : 'No había archivos para liberar.');
    useApp.getState().bump();
  };

  const changeRoot = async () => {
    if (pending > 0) {
      toast(`Hay ${pending} cambios sin subir. Conéctate y sincroniza antes de cambiar de carpeta.`, { tone: 'error' });
      return;
    }
    await useApp.getState().closeDialog();
    useApp.getState().setPickRoot(true);
  };

  const signOut = async () => {
    if (pending > 0 && !confirm(`Hay ${pending} cambios que todavía no están en Drive y se perderán. ¿Cerrar sesión de todos modos?`)) return;
    await flushAll();
    s.auth?.signOut();
    await s.store.clearAll();
    setMode(null);
    location.replace(location.pathname);
  };

  const leaveDemo = async () => {
    setMode(null);
    location.replace(location.pathname);
  };

  const resetDemo = async () => {
    const { resetDemo } = await import('../drive/demo');
    s.store.db.close();
    await resetDemo();
    location.replace(location.pathname);
  };

  return (
    <Sheet title="Ajustes" onClose={onClose} className="settings">
      <section className="settings-group">
        <h3>Cuenta</h3>
        {s.mode === 'demo' ? (
          <>
            <p className="settings-note">Estás en modo demo: las notas solo existen en este navegador.</p>
            <div className="btn-row">
              <button className="btn" onClick={() => void leaveDemo()}>
                Conectar Google Drive
              </button>
              <button className="btn ghost" onClick={() => void resetDemo()}>
                Reiniciar demo
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="settings-note">
              {s.auth?.loginHint ?? 'Cuenta de Google'}
              <br />
              Carpeta: <strong>{rootName ?? '…'}</strong>
            </p>
            <div className="btn-row">
              <button className="btn" onClick={() => void changeRoot()}>
                <FolderCog size={18} /> Cambiar carpeta
              </button>
              <button className="btn ghost" onClick={() => void signOut()}>
                <LogOut size={18} /> Cerrar sesión
              </button>
            </div>
          </>
        )}
      </section>

      <section className="settings-group">
        <h3>Pantalla</h3>
        <div className="seg" role="radiogroup" aria-label="Tema">
          {(
            [
              ['system', 'Automático'],
              ['light', 'Claro'],
              ['dark', 'Oscuro'],
            ] as const
          ).map(([id, label]) => (
            <button key={id} role="radio" aria-checked={settings.theme === id} className={cls(settings.theme === id && 'is-on')} onClick={() => update({ theme: id })} disabled={settings.eink}>
              {label}
            </button>
          ))}
        </div>
        <Toggle checked={settings.eink} onChange={(v) => update({ eink: v })} label="Modo e-ink" hint="Para el Boox: blanco y negro, sin animaciones y con botones para pasar página." />
        <Toggle checked={settings.ruled} onChange={(v) => update({ ruled: v })} label="Renglones en las notas" hint="Líneas de cuaderno detrás del texto." />
        <label className="field range">
          <span>Tamaño de letra de las notas: {settings.noteSize} px</span>
          <input type="range" min={15} max={26} step={1} value={settings.noteSize} onChange={(e) => update({ noteSize: Number(e.target.value) })} />
        </label>
      </section>

      <section className="settings-group">
        <h3>Escritura y voz</h3>
        <Toggle
          checked={settings.penOnly === true}
          onChange={(v) => update({ penOnly: v })}
          label="Solo el lápiz escribe"
          hint={settings.penOnly === null ? 'Se activa sola cuando usas un lápiz por primera vez.' : 'Con el dedo te desplazas y haces zoom.'}
        />
        <label className="field">
          <span>Idioma del dictado</span>
          <select value={settings.dictationLang} onChange={(e) => update({ dictationLang: e.target.value })}>
            {LANGS.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        <Toggle checked={settings.shrinkPhotos} onChange={(v) => update({ shrinkPhotos: v })} label="Reducir fotos grandes" hint="Las guarda a 2560 px como máximo; ocupan menos en Drive y suben más rápido." />
      </section>

      <section className="settings-group">
        <h3>Almacenamiento en este dispositivo</h3>
        <p className="settings-note">Las notas de texto siempre quedan disponibles sin conexión. Imágenes, PDF y audios se guardan al abrirlos.{usage ? ` Ocupado ahora: ${usage}.` : ''}</p>
        <button className="btn ghost" onClick={() => void free()}>
          <Trash2 size={18} /> Liberar espacio
        </button>
      </section>

      <p className="settings-foot">Tinta {__APP_VERSION__}</p>
    </Sheet>
  );
}
