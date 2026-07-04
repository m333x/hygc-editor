/**
 * asset-cache — IndexedDB-backed persistent cache for editor binary assets.
 *
 * Two stores live in a single database:
 *   - `audioDecodes` — decoded waveform samples (`Float32Array` as `ArrayBuffer`)
 *     keyed by a stable audio identifier (URL pathname or asset id). Avoids
 *     re-fetching + re-decoding the same audio across reloads when drawing
 *     waveforms in the timeline.
 *   - `assetBlobs` — raw fetched asset blobs (video/audio/image) keyed by
 *     `assetId`. Avoids re-downloading timeline assets on reload; the consumer
 *     calls `URL.createObjectURL(blob)` to feed Remotion / video elements.
 *
 * Eviction:
 *   After every write, if the store exceeds `MAX_STORE_BYTES` we delete the
 *   least-recently-used rows (by `lastAccess`) until under budget. Reads bump
 *   `lastAccess` so frequently-used items stick around.
 *
 * Errors are swallowed — the cache is a soft accelerator. If IDB is
 * unavailable (private mode, quota errors, etc.) callers transparently fall
 * back to the network path.
 */

const DB_NAME = 'hygc-editor-cache'
const DB_VERSION = 1

const STORE_AUDIO_DECODES = 'audioDecodes'
const STORE_ASSET_BLOBS = 'assetBlobs'

const MAX_AUDIO_DECODE_BYTES = 256 * 1024 * 1024 // 256 MB of decoded PCM
const MAX_ASSET_BLOB_BYTES = 512 * 1024 * 1024 // 512 MB of raw assets

interface AudioDecodeRow {
  key: string
  samples: ArrayBuffer
  durationSec: number
  size: number
  lastAccess: number
}

interface AssetBlobRow {
  key: string
  blob: Blob
  mimeType: string
  size: number
  lastAccess: number
}

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDB(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null)
      return
    }
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION)
    } catch {
      resolve(null)
      return
    }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_AUDIO_DECODES)) {
        const store = db.createObjectStore(STORE_AUDIO_DECODES, { keyPath: 'key' })
        store.createIndex('lastAccess', 'lastAccess')
      }
      if (!db.objectStoreNames.contains(STORE_ASSET_BLOBS)) {
        const store = db.createObjectStore(STORE_ASSET_BLOBS, { keyPath: 'key' })
        store.createIndex('lastAccess', 'lastAccess')
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
    req.onblocked = () => resolve(null)
  })
  return dbPromise
}

function tx(
  db: IDBDatabase,
  store: string,
  mode: IDBTransactionMode,
): IDBObjectStore {
  return db.transaction(store, mode).objectStore(store)
}

function promisifyRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

// ─── Stable key helpers ───────────────────────────────────────────────────────

/**
 * Build a stable cache key from a (possibly signed) asset URL. We strip the
 * query string so rotating signed-URL tokens don't invalidate the cache, and
 * fall back to the raw url if it can't be parsed (e.g. blob: URLs).
 */
export function urlCacheKey(url: string): string {
  try {
    const u = new URL(url, window.location.origin)
    return u.origin + u.pathname
  } catch {
    return url
  }
}

// ─── Audio decode cache ───────────────────────────────────────────────────────

export interface CachedAudioDecode {
  samples: Float32Array
  durationSec: number
}

export async function getCachedAudioDecode(
  key: string,
): Promise<CachedAudioDecode | null> {
  const db = await openDB()
  if (!db) return null
  try {
    const store = tx(db, STORE_AUDIO_DECODES, 'readonly')
    const row = (await promisifyRequest(store.get(key))) as AudioDecodeRow | undefined
    if (!row) return null
    // Fire-and-forget LRU bump.
    void bumpLastAccess(STORE_AUDIO_DECODES, key)
    return {
      samples: new Float32Array(row.samples),
      durationSec: row.durationSec,
    }
  } catch {
    return null
  }
}

export async function putCachedAudioDecode(
  key: string,
  samples: Float32Array,
  durationSec: number,
): Promise<void> {
  const db = await openDB()
  if (!db) return
  try {
    // Copy underlying buffer slice — Float32Array may be a view over a larger
    // buffer or backed by a SharedArrayBuffer, and structuredClone-into-IDB
    // wants a plain ArrayBuffer.
    const buffer = new ArrayBuffer(samples.byteLength)
    new Float32Array(buffer).set(samples)
    const row: AudioDecodeRow = {
      key,
      samples: buffer,
      durationSec,
      size: buffer.byteLength,
      lastAccess: Date.now(),
    }
    await promisifyRequest(tx(db, STORE_AUDIO_DECODES, 'readwrite').put(row))
    void evictIfOversize(STORE_AUDIO_DECODES, MAX_AUDIO_DECODE_BYTES)
  } catch {
    // Ignore quota / serialization errors.
  }
}

// ─── Asset blob cache ─────────────────────────────────────────────────────────

export interface CachedAssetBlob {
  blob: Blob
  mimeType: string
}

export async function getCachedAssetBlob(
  key: string,
): Promise<CachedAssetBlob | null> {
  const db = await openDB()
  if (!db) return null
  try {
    const store = tx(db, STORE_ASSET_BLOBS, 'readonly')
    const row = (await promisifyRequest(store.get(key))) as AssetBlobRow | undefined
    if (!row) return null
    void bumpLastAccess(STORE_ASSET_BLOBS, key)
    return { blob: row.blob, mimeType: row.mimeType }
  } catch {
    return null
  }
}

export async function putCachedAssetBlob(
  key: string,
  blob: Blob,
): Promise<void> {
  const db = await openDB()
  if (!db) return
  try {
    const row: AssetBlobRow = {
      key,
      blob,
      mimeType: blob.type,
      size: blob.size,
      lastAccess: Date.now(),
    }
    await promisifyRequest(tx(db, STORE_ASSET_BLOBS, 'readwrite').put(row))
    void evictIfOversize(STORE_ASSET_BLOBS, MAX_ASSET_BLOB_BYTES)
  } catch {
    // Ignore quota errors — caller still has the in-memory blob URL.
  }
}

// ─── LRU bookkeeping ──────────────────────────────────────────────────────────

async function bumpLastAccess(storeName: string, key: string): Promise<void> {
  const db = await openDB()
  if (!db) return
  try {
    const store = tx(db, storeName, 'readwrite')
    const row = (await promisifyRequest(store.get(key))) as
      | (AudioDecodeRow | AssetBlobRow)
      | undefined
    if (!row) return
    row.lastAccess = Date.now()
    await promisifyRequest(store.put(row))
  } catch {
    // Ignore.
  }
}

async function evictIfOversize(storeName: string, maxBytes: number): Promise<void> {
  const db = await openDB()
  if (!db) return
  try {
    const readStore = tx(db, storeName, 'readonly')
    let totalBytes = 0
    const rows: { key: string; size: number; lastAccess: number }[] = []
    await new Promise<void>((resolve, reject) => {
      const cursorReq = readStore.openCursor()
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result
        if (cursor) {
          const value = cursor.value as { key: string; size: number; lastAccess: number }
          totalBytes += value.size
          rows.push({ key: value.key, size: value.size, lastAccess: value.lastAccess })
          cursor.continue()
        } else {
          resolve()
        }
      }
      cursorReq.onerror = () => reject(cursorReq.error)
    })

    if (totalBytes <= maxBytes) return

    rows.sort((a, b) => a.lastAccess - b.lastAccess)
    const writeStore = tx(db, storeName, 'readwrite')
    for (const row of rows) {
      if (totalBytes <= maxBytes) break
      writeStore.delete(row.key)
      totalBytes -= row.size
    }
  } catch {
    // Ignore.
  }
}
