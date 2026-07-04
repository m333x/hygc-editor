/**
 * Minimal IndexedDB wrapper for uploaded media blobs. localStorage can't hold
 * binary data of any real size, so uploads live here and project/timeline
 * JSON lives in localStorage (see host.tsx).
 */

import type { EditorAssetType } from '@hygc/editor'

export const DEMO_DB_NAME = 'hygc-editor-demo'
const STORE = 'uploads'

export interface StoredUpload {
  id: string
  type: EditorAssetType
  filename: string
  duration_ms: number | null
  created_at: string
  blob: Blob
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DEMO_DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'))
  })
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(STORE, mode).objectStore(STORE))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'))
    })
  } finally {
    db.close()
  }
}

export function idbGetAllUploads(): Promise<StoredUpload[]> {
  return withStore('readonly', (s) => s.getAll() as IDBRequest<StoredUpload[]>)
}

export function idbPutUpload(upload: StoredUpload): Promise<IDBValidKey> {
  return withStore('readwrite', (s) => s.put(upload))
}

export function idbDeleteUpload(id: string): Promise<undefined> {
  return withStore('readwrite', (s) => s.delete(id))
}
