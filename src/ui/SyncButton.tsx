import { Droplet, TriangleAlert } from 'lucide-react';
import { useApp } from '../app/state';
import { cls } from './common';

/** La gota de tinta: estado de la sincronización con Drive. Toca para ver detalles. */
export function SyncButton() {
  const status = useApp((s) => s.status);
  const openDialog = useApp((s) => s.openDialog);
  const { state, pending } = status;

  let label = 'Todo guardado en Drive';
  let text = '';
  if (state === 'syncing') label = 'Sincronizando con Drive';
  else if (state === 'offline') {
    label = pending ? `Sin conexión: ${pending} cambios esperan` : 'Sin conexión';
    text = pending ? String(pending) : '';
  } else if (state === 'auth') {
    label = 'Hay que reconectar con Google';
    text = 'Reconectar';
  } else if (state === 'error') {
    label = 'Hubo un problema al sincronizar';
  } else if (pending) {
    label = `${pending} cambios por subir`;
    text = String(pending);
  }

  const hollow = state === 'offline' || state === 'auth' || (state === 'idle' && pending > 0);
  return (
    <button
      className={cls('sync-btn', `is-${state}`, hollow && 'is-hollow', text && 'has-text')}
      onClick={() => openDialog({ type: 'sync' })}
      aria-label={label}
      title={label}
    >
      <span className="sync-drop" aria-hidden="true">
        {state === 'error' ? <TriangleAlert size={20} strokeWidth={2} /> : <Droplet size={20} strokeWidth={2} />}
      </span>
      {text && <span className="sync-text">{text}</span>}
    </button>
  );
}
