import { useEffect, useState } from 'react';
import { FileText, Link2 } from 'lucide-react';
import { useServices } from '../app/services';
import { go, useApp } from '../app/state';
import { saveFiles } from '../app/actions';
import { clearShared, readShared, type SharedEntry } from '../share/inbox';
import { kindOf, stamp } from '../model/fileTypes';
import { ROOT_LID } from '../sync/SyncEngine';
import { KindIcon, Sheet } from './common';
import { FolderBrowser } from './FolderBrowser';

function noteFrom(e: SharedEntry): string {
  const parts: string[] = [];
  const title = e.title?.trim();
  if (title) parts.push(`# ${title}`);
  if (e.text?.trim()) parts.push(e.text.trim());
  if (e.url?.trim() && !e.text?.includes(e.url.trim())) parts.push(e.url.trim());
  return parts.join('\n\n') + '\n';
}

export function ShareSheet({ onClose }: { onClose: () => void }) {
  const s = useServices();
  const settings = useApp((st) => st.settings);
  const update = useApp((st) => st.updateSettings);
  const toast = useApp((st) => st.toast);
  const [entries, setEntries] = useState<SharedEntry[] | null>(null);
  const [start, setStart] = useState<string>(ROOT_LID);

  useEffect(() => {
    void readShared().then(setEntries);
    void (async () => {
      const last = settings.lastShareFolder;
      if (last && (await s.store.getItem(last))?.isFolder) setStart(last);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async (folder: string) => {
    if (!entries) return;
    const created: string[] = [];
    for (const e of entries) {
      if (e.files.length) {
        const files = e.files.map((f) => new File([f.blob], f.name, { type: f.type || f.blob.type }));
        const items = await saveFiles(s, folder, files);
        created.push(...items.map((i) => i.lid));
      }
      if (e.text?.trim() || e.url?.trim()) {
        const name = (e.title?.trim() || `Compartido ${stamp()}`).slice(0, 80);
        const item = await s.engine.createFile(folder, `${name.replace(/[\\/]/g, '-')}.md`, 'text/markdown', noteFrom(e));
        created.push(item.lid);
      }
    }
    await clearShared();
    update({ lastShareFolder: folder });
    await useApp.getState().closeDialog();
    if (created.length === 1) go({ folder, file: created[0] });
    else go({ folder });
    toast(created.length === 1 ? 'Guardado en Drive' : `${created.length} elementos guardados`);
  };

  const discard = async () => {
    await clearShared();
    onClose();
  };

  return (
    <Sheet
      title="Guardar lo compartido"
      onClose={onClose}
      footer={
        <button className="btn ghost" onClick={() => void discard()}>
          Descartar
        </button>
      }
    >
      {entries === null ? (
        <div className="list-loading" aria-busy="true" />
      ) : entries.length === 0 ? (
        <p className="settings-note">No hay nada pendiente por guardar.</p>
      ) : (
        <>
          <ul className="shared-list">
            {entries.flatMap((e) => [
              ...e.files.map((f) => (
                <li key={`${e.id}-${f.name}`}>
                  <KindIcon kind={kindOf(f.name, f.type)} size={20} />
                  <span>{f.name}</span>
                </li>
              )),
              ...(e.text || e.url
                ? [
                    <li key={`${e.id}-t`}>
                      {e.url && !e.text ? <Link2 size={20} /> : <FileText size={20} />}
                      <span className="shared-text">{(e.title || e.text || e.url || '').slice(0, 140)}</span>
                    </li>,
                  ]
                : []),
            ])}
          </ul>
          <FolderBrowser key={start} start={start} onChoose={(f) => void save(f)} chooseLabel={(n) => `Guardar en «${n}»`} />
        </>
      )}
    </Sheet>
  );
}
