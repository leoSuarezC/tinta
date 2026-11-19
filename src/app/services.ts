import { createContext, useContext } from 'react';
import { openStore, Store } from '../db/db';
import type { DriveApi } from '../drive/types';
import { GoogleDrive } from '../drive/GoogleDrive';
import type { FakeDrive } from '../drive/FakeDrive';
import { GoogleAuth } from '../auth/googleAuth';
import { SyncEngine } from '../sync/SyncEngine';

export type Mode = 'google' | 'demo';

export interface Services {
  mode: Mode;
  store: Store;
  drive: DriveApi;
  engine: SyncEngine;
  auth?: GoogleAuth;
  fake?: FakeDrive;
  demoRootId?: string;
}

export interface AppConfig {
  googleClientId?: string;
}

const MODE_KEY = 'tinta.mode';
const CLIENT_KEY = 'tinta.clientId';

export function getMode(): Mode | null {
  try {
    const m = localStorage.getItem(MODE_KEY);
    return m === 'google' || m === 'demo' ? m : null;
  } catch {
    return null;
  }
}
export function setMode(m: Mode | null) {
  try {
    if (m) localStorage.setItem(MODE_KEY, m);
    else localStorage.removeItem(MODE_KEY);
  } catch {
    /* sin almacenamiento */
  }
}

/** Lee config.json (se puede editar después de compilar) o el Client ID guardado en este dispositivo. */
export async function loadConfig(): Promise<AppConfig> {
  let cfg: AppConfig = {};
  try {
    const res = await fetch('./config.json', { cache: 'no-cache' });
    if (res.ok) cfg = (await res.json()) as AppConfig;
  } catch {
    /* sin conexión: se usa lo guardado */
  }
  let local: string | null = null;
  try {
    local = localStorage.getItem(CLIENT_KEY);
    if (cfg.googleClientId) localStorage.setItem(CLIENT_KEY, cfg.googleClientId);
  } catch {
    /* ignore */
  }
  return { googleClientId: cfg.googleClientId?.trim() || local || undefined };
}

export function saveClientId(id: string) {
  try {
    localStorage.setItem(CLIENT_KEY, id.trim());
  } catch {
    /* ignore */
  }
}

export async function createGoogleServices(auth: GoogleAuth): Promise<Services> {
  const store = new Store(await openStore('tinta'));
  const drive = new GoogleDrive(auth);
  const engine = new SyncEngine(store, drive);
  return { mode: 'google', store, drive, engine, auth };
}

export async function createDemoServices(): Promise<Services> {
  const { openDemoDrive } = await import('../drive/demo');
  const { drive, rootId } = await openDemoDrive();
  drive.latencyMs = 90;
  const store = new Store(await openStore('tinta-demo'));
  const engine = new SyncEngine(store, drive);
  if (!(await engine.rootDriveId())) await engine.initRoot(rootId);
  return { mode: 'demo', store, drive, engine, fake: drive, demoRootId: rootId };
}

export const ServicesContext = createContext<Services | null>(null);

export function useServices(): Services {
  const s = useContext(ServicesContext);
  if (!s) throw new Error('Servicios no inicializados');
  return s;
}
