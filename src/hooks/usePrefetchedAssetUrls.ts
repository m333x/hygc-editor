/**
 * usePrefetchedAssetUrls — prefetches remote asset URLs to blob URLs for playback.
 *
 * When the Remotion Player uses a remote URL (e.g. Supabase signed URL), the
 * browser can make many requests during playback (e.g. one per seek). Prefetching
 * downloads each asset once and creates a blob URL so playback reads from memory
 * and triggers zero additional network requests.
 *
 * Two layers of caching keep playback snappy:
 *   1. **In-memory blob URL cache** (per page) — assetId → blob URL, LRU-capped
 *      so we don't leak object URLs while the editor is open.
 *   2. **IndexedDB blob cache** (across reloads) — assetId → Blob via
 *      `asset-cache.ts`. On hydration we hand the cached Blob to
 *      `URL.createObjectURL` so playback starts with zero network requests.
 *
 * If prefetch fails (e.g. CORS not configured on the bucket), we keep the
 * original URL so playback still works (but may still cause many requests).
 *
 * @see PreviewCanvas.tsx — uses this so the Player receives blob URLs when possible
 * @see asset-cache.ts — IndexedDB-backed persistence
 */

import { useEffect, useRef, useState, useMemo } from 'react'
import type { AssetUrlMap } from '../engine/ShortComposition'
import { getCachedAssetBlob, putCachedAssetBlob } from '../lib/asset-cache'

const PREFETCH_CONCURRENCY = 2
/**
 * How many fresh (network) prefetches we'll do per timeline render. Items
 * served from IndexedDB don't count against this — they're instant — so a
 * large timeline with a warm cache hydrates fully even though the live
 * download budget stays small.
 */
const PREFETCH_NETWORK_LIMIT = 12
/**
 * How many blob URLs we keep alive in memory at once. URL.createObjectURL
 * pins the underlying blob, so we revoke the LRU tail to release memory.
 * The IndexedDB blob itself sticks around either way.
 */
const BLOB_URL_LRU_LIMIT = 24
const EMPTY_PRIORITY_ASSET_IDS: string[] = []

const blobUrlCache = new Map<string, string>()

function rememberBlobUrl(assetId: string, blobUrl: string) {
  const existing = blobUrlCache.get(assetId)
  if (existing && existing !== blobUrl) {
    URL.revokeObjectURL(existing)
    blobUrlCache.delete(assetId)
  }
  blobUrlCache.set(assetId, blobUrl)
  while (blobUrlCache.size > BLOB_URL_LRU_LIMIT) {
    const oldest = blobUrlCache.entries().next().value as
      | [string, string]
      | undefined
    if (!oldest) break
    blobUrlCache.delete(oldest[0])
    URL.revokeObjectURL(oldest[1])
  }
}

function touchBlobUrl(assetId: string): string | undefined {
  const blobUrl = blobUrlCache.get(assetId)
  if (!blobUrl) return undefined
  // Re-insert to mark as most-recently-used.
  blobUrlCache.delete(assetId)
  blobUrlCache.set(assetId, blobUrl)
  return blobUrl
}

export interface PrefetchProgress {
  /** Total number of assets to prefetch. */
  total: number
  /** Number of assets that have finished (success or failure). */
  loaded: number
  /** True when all assets are done (all blob URLs or fallbacks). */
  done: boolean
  /** Number of assets that successfully became blob URLs. */
  blobCount: number
}

/**
 * Prefetch remote URLs to blob URLs. Returns the map to use for playback and
 * progress so the UI can show a loading state until prefetch is done.
 */
export function usePrefetchedAssetUrls(
  assetUrlMap: AssetUrlMap,
  priorityAssetIds: string[] = EMPTY_PRIORITY_ASSET_IDS,
): {
  assetUrlMap: AssetUrlMap
  progress: PrefetchProgress
} {
  const [prefetchedMap, setPrefetchedMap] = useState<AssetUrlMap>({})
  const [progress, setProgress] = useState<PrefetchProgress>({
    total: 0,
    loaded: 0,
    done: true,
    blobCount: 0,
  })
  // Only re-run effect when the set of asset IDs changes (stable dependency).
  const effectKey = useMemo(
    () => Object.keys(assetUrlMap).filter((k) => assetUrlMap[k]).sort().join(','),
    [assetUrlMap],
  )
  const priorityKey = useMemo(
    () => priorityAssetIds.filter((id) => assetUrlMap[id]).join(','),
    [assetUrlMap, priorityAssetIds],
  )

  // The effect below intentionally depends only on the stable {effectKey,
  // priorityKey} pair so that prefetch isn't restarted every time the caller
  // hands us a new (but content-identical) `assetUrlMap` object or
  // `priorityAssetIds` array. We still need access to the latest values inside
  // the effect, so mirror them through refs that update on every render.
  const assetUrlMapRef = useRef(assetUrlMap)
  const priorityAssetIdsRef = useRef(priorityAssetIds)
  assetUrlMapRef.current = assetUrlMap
  priorityAssetIdsRef.current = priorityAssetIds

  useEffect(() => {
    const currentAssetUrlMap = assetUrlMapRef.current
    const currentPriorityAssetIds = priorityAssetIdsRef.current
    const entries = Object.entries(currentAssetUrlMap).filter(
      (entry): entry is [string, string] => Boolean(entry[1]),
    )
    if (entries.length === 0) {
      setPrefetchedMap({})
      setProgress({ total: 0, loaded: 0, done: true, blobCount: 0 })
      return
    }
    const priorityIndex = new Map(
      currentPriorityAssetIds.map((assetId, index) => [assetId, index]),
    )
    const orderedEntries = [...entries].sort(([a], [b]) => {
      const ai = priorityIndex.get(a) ?? Number.POSITIVE_INFINITY
      const bi = priorityIndex.get(b) ?? Number.POSITIVE_INFINITY
      return ai - bi
    })

    setProgress({ total: entries.length, loaded: 0, done: false, blobCount: 0 })
    let cancelled = false

    async function prefetchAll() {
      const blobUrlsByAssetId = new Map<string, string>()
      let loaded = 0
      let blobCount = 0

      const reportProgress = () => {
        if (cancelled) return
        setProgress({
          total: entries.length,
          loaded,
          blobCount,
          done: loaded >= entries.length,
        })
      }

      const recordHit = (assetId: string, blobUrl: string) => {
        blobUrlsByAssetId.set(assetId, blobUrl)
        blobCount = blobUrlsByAssetId.size
      }

      // ── Pass 1: instant hits (in-memory + IndexedDB) ──────────────────────
      // Network-bound items get queued for pass 2 so they share the
      // concurrency-limited downloader.
      const needsNetwork: [string, string][] = []
      for (const [assetId, url] of orderedEntries) {
        if (cancelled) return
        const memHit = touchBlobUrl(assetId)
        if (memHit) {
          recordHit(assetId, memHit)
          loaded++
          reportProgress()
          continue
        }
        const persisted = await getCachedAssetBlob(assetId)
        if (cancelled) return
        if (persisted) {
          const blobUrl = URL.createObjectURL(persisted.blob)
          rememberBlobUrl(assetId, blobUrl)
          recordHit(assetId, blobUrl)
          loaded++
          reportProgress()
          continue
        }
        needsNetwork.push([assetId, url])
      }

      // ── Pass 2: network downloads (concurrency- and count-limited) ────────
      const networkBudget = needsNetwork.slice(0, PREFETCH_NETWORK_LIMIT)
      let cursor = 0

      async function fetchNext() {
        while (!cancelled) {
          const entry = networkBudget[cursor]
          cursor++
          if (!entry) return
          const [assetId, url] = entry

          try {
            const res = await fetch(url, { mode: 'cors' })
            if (res.ok && !cancelled) {
              const blob = await res.blob()
              if (!cancelled) {
                const blobUrl = URL.createObjectURL(blob)
                rememberBlobUrl(assetId, blobUrl)
                recordHit(assetId, blobUrl)
                void putCachedAssetBlob(assetId, blob)
              }
            }
          } catch {
            // Keep original URL fallback below.
          }

          loaded++
          reportProgress()
        }
      }

      await Promise.all(
        Array.from(
          { length: Math.min(PREFETCH_CONCURRENCY, networkBudget.length) },
          () => fetchNext(),
        ),
      )

      // Any entries that exceeded the network budget are reported as "loaded"
      // (we won't try them this pass) so progress can complete.
      const skipped = needsNetwork.length - networkBudget.length
      if (skipped > 0) {
        loaded += skipped
        reportProgress()
      }

      if (cancelled) return

      const next: AssetUrlMap = {}
      for (const [assetId, url] of entries) {
        next[assetId] = blobUrlsByAssetId.get(assetId) ?? url
      }
      setPrefetchedMap(next)
      setProgress({
        total: entries.length,
        loaded: entries.length,
        done: true,
        blobCount: blobUrlsByAssetId.size,
      })
    }

    prefetchAll()

    return () => {
      cancelled = true
    }
    // Effect deps intentionally exclude `assetUrlMap` and `priorityAssetIds`
    // (the raw object/array) — both get new identity every render even when
    // their content is unchanged. The stable `effectKey`/`priorityKey` strings
    // are the actual change signal; the live values are read via refs above so
    // url rotations within an unchanged id set are still picked up.
  }, [effectKey, priorityKey])

  // Always provide a URL for every asset: use blob when ready, otherwise original.
  const merged: AssetUrlMap = {}
  for (const [id, url] of Object.entries(assetUrlMap)) {
    merged[id] = prefetchedMap[id] ?? url
  }

  return {
    assetUrlMap: merged,
    progress:
      progress.total === 0
        ? { total: 0, loaded: 0, done: true, blobCount: 0 }
        : progress,
  }
}
