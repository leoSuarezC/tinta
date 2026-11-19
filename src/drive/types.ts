export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';
export const GOOGLE_APPS_PREFIX = 'application/vnd.google-apps.';

/** Subconjunto de los campos de un archivo de Drive v3 que usa la app. */
export interface RemoteFile {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  modifiedTime?: string;
  size?: string;
  md5Checksum?: string;
  version?: string;
  trashed?: boolean;
  starred?: boolean;
  webViewLink?: string;
  capabilities?: { canEdit?: boolean; canRename?: boolean; canTrash?: boolean };
  shortcutDetails?: { targetId?: string; targetMimeType?: string };
}

export interface RemoteChange {
  fileId: string;
  removed?: boolean;
  file?: RemoteFile;
  time?: string;
}

export interface ChangesPage {
  changes: RemoteChange[];
  nextPageToken?: string;
  newStartPageToken?: string;
}

export interface DriveUser {
  displayName?: string;
  emailAddress?: string;
  photoLink?: string;
}

export interface FilePatch {
  name?: string;
  addParents?: string[];
  removeParents?: string[];
  trashed?: boolean;
  starred?: boolean;
}

export interface NewFileMeta {
  name: string;
  mimeType: string;
  parents: string[];
}

/** Operaciones de Drive que necesita la app. Implementado por GoogleDrive (HTTP) y FakeDrive (memoria). */
export interface DriveApi {
  about(): Promise<DriveUser>;
  getFile(id: string): Promise<RemoteFile>;
  /** Hijos (no en la papelera) de una o varias carpetas. */
  listChildren(parentIds: string[], pageToken?: string, foldersOnly?: boolean): Promise<{ files: RemoteFile[]; nextPageToken?: string }>;
  download(id: string): Promise<Blob>;
  create(meta: NewFileMeta, content?: Blob): Promise<RemoteFile>;
  update(id: string, patch: FilePatch, content?: Blob): Promise<RemoteFile>;
  getStartPageToken(): Promise<string>;
  listChanges(pageToken: string): Promise<ChangesPage>;
  /** Carpetas cuyo nombre contiene el texto (para elegir la carpeta principal). */
  searchFolders(text: string): Promise<RemoteFile[]>;
}

export class DriveError extends Error {
  constructor(
    message: string,
    public status: number,
    public reason?: string,
  ) {
    super(message);
    this.name = 'DriveError';
  }
}

/** El token de acceso no existe, venció o fue rechazado (401). */
export class AuthRequiredError extends Error {
  constructor(message = 'Se requiere iniciar sesión en Google') {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

/** No hay conexión (o la petición no llegó al servidor). */
export class OfflineError extends Error {
  constructor(message = 'Sin conexión') {
    super(message);
    this.name = 'OfflineError';
  }
}

export const REMOTE_FIELDS =
  'id,name,mimeType,parents,modifiedTime,size,md5Checksum,version,trashed,starred,webViewLink,capabilities(canEdit,canRename,canTrash),shortcutDetails(targetId,targetMimeType)';
