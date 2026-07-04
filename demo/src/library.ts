/**
 * Demo asset library — the reactive store behind `EditorHost.useAssetLibrary`
 * and `EditorHost.resolveAssetUrls`.
 *
 * Library = bundled stock assets (stock.ts) + user uploads (IndexedDB).
 * Uploads are served to the editor through object URLs created lazily and
 * cached per asset id.
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type {
  AssetLibrary,
  AssetLibraryOptions,
  EditorAsset,
  EditorAssetSource,
  EditorAssetType,
  ResolvedAssetUrls,
} from '@hygc/editor'
import { idbDeleteUpload, idbGetAllUploads, idbPutUpload, type StoredUpload } from './idb'
import { STOCK_ASSETS, stockUrl, toEditorAsset } from './stock'

const HIDDEN_STOCK_KEY = 'hygc-editor-demo:hidden-stock'

interface LibrarySnapshot {
  assets: EditorAsset[]
  loading: boolean
}

let uploads: StoredUpload[] = []
let hiddenStock = new Set<string>(readHiddenStock())
let snapshot: LibrarySnapshot = { assets: [], loading: true }
let loadPromise: Promise<void> | null = null
const listeners = new Set<() => void>()
const objectUrls = new Map<string, string>()

function readHiddenStock(): string[] {
  try {
    return JSON.parse(localStorage.getItem(HIDDEN_STOCK_KEY) ?? '[]') as string[]
  } catch {
    return []
  }
}

function uploadUrl(upload: StoredUpload): string {
  let url = objectUrls.get(upload.id)
  if (!url) {
    url = URL.createObjectURL(upload.blob)
    objectUrls.set(upload.id, url)
  }
  return url
}

function uploadToEditorAsset(upload: StoredUpload): EditorAsset {
  return {
    id: upload.id,
    type: upload.type,
    public_url: uploadUrl(upload),
    metadata: {
      filename: upload.filename,
      duration_ms: upload.duration_ms ?? undefined,
      source: 'uploaded',
    },
  }
}

function rebuildSnapshot(loading: boolean) {
  snapshot = {
    loading,
    assets: [
      ...uploads.map(uploadToEditorAsset),
      ...STOCK_ASSETS.filter((s) => !hiddenStock.has(s.id)).map(toEditorAsset),
    ],
  }
  listeners.forEach((l) => l())
}

function ensureLoaded(): Promise<void> {
  if (!loadPromise) {
    loadPromise = idbGetAllUploads()
      .then((stored) => {
        uploads = stored.sort((a, b) => b.created_at.localeCompare(a.created_at))
      })
      .catch(() => {
        uploads = []
      })
      .then(() => rebuildSnapshot(false))
  }
  return loadPromise
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Probe media duration (ms) via a detached media element. Images → null. */
function probeDurationMs(file: File, type: EditorAssetType): Promise<number | null> {
  if (type === 'image') return Promise.resolve(null)
  return new Promise((resolve) => {
    const el = document.createElement(type === 'video' ? 'video' : 'audio')
    const url = URL.createObjectURL(file)
    const done = (value: number | null) => {
      URL.revokeObjectURL(url)
      resolve(value)
    }
    el.preload = 'metadata'
    el.onloadedmetadata = () =>
      done(Number.isFinite(el.duration) ? Math.round(el.duration * 1000) : null)
    el.onerror = () => done(null)
    el.src = url
    setTimeout(() => done(null), 10_000)
  })
}

export async function addUpload(
  file: File,
  type: EditorAssetType,
  metadata?: Record<string, unknown>,
): Promise<EditorAsset> {
  await ensureLoaded()
  const upload: StoredUpload = {
    id: crypto.randomUUID(),
    type,
    filename: typeof metadata?.filename === 'string' ? metadata.filename : file.name,
    duration_ms:
      typeof metadata?.duration_ms === 'number'
        ? metadata.duration_ms
        : await probeDurationMs(file, type),
    created_at: new Date().toISOString(),
    blob: file,
  }
  await idbPutUpload(upload)
  uploads = [upload, ...uploads]
  rebuildSnapshot(false)
  return uploadToEditorAsset(upload)
}

export async function removeAsset(assetId: string): Promise<boolean> {
  await ensureLoaded()
  if (STOCK_ASSETS.some((s) => s.id === assetId)) {
    hiddenStock.add(assetId)
    localStorage.setItem(HIDDEN_STOCK_KEY, JSON.stringify([...hiddenStock]))
  } else {
    await idbDeleteUpload(assetId)
    uploads = uploads.filter((u) => u.id !== assetId)
    const url = objectUrls.get(assetId)
    if (url) {
      URL.revokeObjectURL(url)
      objectUrls.delete(assetId)
    }
  }
  rebuildSnapshot(false)
  return true
}

export async function resolveDemoAssetUrls(assetIds: string[]): Promise<ResolvedAssetUrls> {
  await ensureLoaded()
  const assetUrlMap: Record<string, string> = {}
  const assetTypeMap: Record<string, EditorAssetType> = {}
  for (const id of assetIds) {
    const stock = STOCK_ASSETS.find((s) => s.id === id)
    if (stock) {
      assetUrlMap[id] = stockUrl(stock)
      assetTypeMap[id] = stock.type
      continue
    }
    const upload = uploads.find((u) => u.id === id)
    if (upload) {
      assetUrlMap[id] = uploadUrl(upload)
      assetTypeMap[id] = upload.type
    }
  }
  return { assetUrlMap, assetTypeMap }
}

/** Wipe every trace of the demo (uploads, hidden stock) short of the project. */
export async function resetLibrary(): Promise<void> {
  await ensureLoaded()
  for (const upload of uploads) {
    await idbDeleteUpload(upload.id)
  }
  uploads = []
  hiddenStock = new Set()
  localStorage.removeItem(HIDDEN_STOCK_KEY)
  rebuildSnapshot(false)
}

/** `EditorHost.useAssetLibrary` implementation. */
export function useDemoAssetLibrary(
  _editorProjectId?: string,
  _options?: AssetLibraryOptions,
): AssetLibrary {
  const { assets: allAssets, loading } = useSyncExternalStore(subscribe, () => snapshot)
  const [typeFilter, setTypeFilter] = useState<EditorAssetType | 'all'>('all')
  const [sourceFilter, setSourceFilter] = useState<EditorAssetSource | 'all'>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void ensureLoaded()
  }, [])

  const assets = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    return allAssets.filter((asset) => {
      if (typeFilter !== 'all' && asset.type !== typeFilter) return false
      if (sourceFilter !== 'all' && asset.metadata?.source !== sourceFilter) return false
      if (query) {
        const name = String(asset.metadata?.filename ?? '')
        if (!name.toLowerCase().includes(query)) return false
      }
      return true
    })
  }, [allAssets, typeFilter, sourceFilter, searchQuery])

  return {
    assets,
    loading,
    uploading,
    error,
    typeFilter,
    setTypeFilter,
    sourceFilter,
    setSourceFilter,
    searchQuery,
    setSearchQuery,
    upload: async (file, _projectId, type, metadata) => {
      setUploading(true)
      setError(null)
      try {
        return await addUpload(file, type, metadata)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Upload failed')
        return null
      } finally {
        setUploading(false)
      }
    },
    remove: (assetId) => removeAsset(assetId),
    refetch: () => ensureLoaded(),
  }
}
