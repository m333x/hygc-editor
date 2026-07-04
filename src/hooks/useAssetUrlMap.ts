/**
 * useAssetUrlMap — resolves timeline asset IDs to fetchable URLs for preview
 * and export.
 *
 * Collects all asset IDs from video and audio clips (excluding caption virtual
 * IDs) and asks the host to resolve them (see EditorHost.resolveAssetUrls).
 * Returns a map of assetId → URL plus a map of assetId → media kind.
 *
 * Used by PreviewCanvas to pass assetUrlMap to ShortComposition so real
 * video/audio render instead of placeholders.
 *
 * @see ShortComposition.tsx — consumes assetUrlMap for OffthreadVideo and Audio
 */

import { useEffect, useState, useMemo } from 'react'
import { useEditorHost } from '../host'
import { getMediaAssetIds } from '../engine/composition-utils'
import type { Track } from '../types'
import type { AssetUrlMap, AssetTypeMap } from '../engine/ShortComposition'

export { getMediaAssetIds }

export interface UseAssetUrlMapReturn {
  assetUrlMap: AssetUrlMap
  assetTypeMap: AssetTypeMap
}

/**
 * Resolve asset IDs to URLs and types. Returns assetUrlMap and assetTypeMap.
 */
export function useAssetUrlMap(tracks: Track[]): UseAssetUrlMapReturn {
  const host = useEditorHost()
  const [urlMap, setUrlMap] = useState<AssetUrlMap>({})
  const [typeMap, setTypeMap] = useState<AssetTypeMap>({})
  const assetIdsKey = useMemo(() => getMediaAssetIds(tracks).sort().join(','), [tracks])
  const assetIds = useMemo(
    () => assetIdsKey.split(',').filter(Boolean),
    [assetIdsKey],
  )

  useEffect(() => {
    let cancelled = false

    // Resolve through the host; the empty case (clears stale URLs) flows
    // through the same async path — no synchronous setState in the effect body.
    const resolve = assetIds.length
      ? host.resolveAssetUrls(assetIds)
      : Promise.resolve({ assetUrlMap: {}, assetTypeMap: {} })

    resolve.then((result) => {
      if (cancelled) return
      setUrlMap(result.assetUrlMap)
      setTypeMap(result.assetTypeMap)
    })

    return () => {
      cancelled = true
    }
  }, [assetIds, assetIdsKey, host])

  return { assetUrlMap: urlMap, assetTypeMap: typeMap }
}
