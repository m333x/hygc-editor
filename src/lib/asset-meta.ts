/** Metadata readers for host asset records (see EditorAsset in host/types). */

import type { EditorAsset } from '../host/types'

export function assetFilename(asset: EditorAsset): string {
  const fn = asset.metadata?.filename
  if (typeof fn === 'string' && fn.length > 0) return fn
  const last = asset.storage_path?.split('/').pop()
  return last && last.length > 0 ? last : 'Untitled'
}

export function assetDurationMs(asset: EditorAsset): number | undefined {
  const v = asset.metadata?.duration_ms
  return typeof v === 'number' ? v : undefined
}
