/**
 * useClipFilmstrip — decode a handful of thumbnails across a video clip's
 * trimmed window for the timeline filmstrip background.
 *
 * Mirrors useAudioPeaks: a module-level cache + in-flight dedupe keyed by the
 * URL pathname (so rotating Supabase signed-URL tokens don't bust the cache)
 * plus the sampled window and thumbnail count. Frames are decoded once via
 * Mediabunny (engine/video-source) and returned as JPEG data URLs for cheap
 * <img> rendering that survives re-renders without holding decoder resources.
 *
 * @see useAudioPeaks.ts — the audio-waveform analogue this follows
 * @see engine/video-source.ts — Mediabunny-backed frame decoding
 */

import { useEffect, useState } from 'react'
import { generateFilmstrip } from '../engine/video-source'
import { urlCacheKey } from '../lib/asset-cache'

const filmstripCache = new Map<string, string[]>()
const inflight = new Map<string, Promise<string[]>>()

function cacheKey(url: string, count: number, startSec: number, endSec: number): string {
  return `${urlCacheKey(url)}:${count}:${startSec.toFixed(2)}:${endSec.toFixed(2)}`
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

/** Canvas → JPEG data URL, handling both HTMLCanvasElement and OffscreenCanvas. */
async function canvasToThumb(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<string> {
  if ('convertToBlob' in canvas) {
    return blobToDataUrl(await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 }))
  }
  return canvas.toDataURL('image/jpeg', 0.7)
}

async function buildFilmstrip(
  url: string,
  count: number,
  startSec: number,
  endSec: number,
): Promise<string[]> {
  const canvases = await generateFilmstrip(url, { count, thumbWidth: 96, startSec, endSec })
  return Promise.all(canvases.map(canvasToThumb))
}

export interface UseClipFilmstripOptions {
  /** Video URL (e.g. assetUrlMap[clip.assetId]). Undefined → no filmstrip. */
  url: string | undefined
  /** Number of thumbnails. Derive from clip duration, NOT zoom width, so the
   *  strip doesn't re-decode on every zoom/drag. */
  count: number
  /** Trimmed window start in seconds (clip.inPoint / 1000). */
  startSec: number
  /** Trimmed window end in seconds (clip.outPoint / 1000). */
  endSec: number
}

/**
 * Decode the clip's filmstrip thumbnails. Returns [] while loading, on error,
 * or when the browser can't decode the codec (graceful fallback to the plain
 * colored clip block).
 */
export function useClipFilmstrip({
  url,
  count,
  startSec,
  endSec,
}: UseClipFilmstripOptions): string[] {
  const [thumbs, setThumbs] = useState<string[]>(() =>
    url ? (filmstripCache.get(cacheKey(url, count, startSec, endSec)) ?? []) : [],
  )

  useEffect(() => {
    if (!url || count <= 0) {
      setThumbs([])
      return
    }
    const key = cacheKey(url, count, startSec, endSec)
    const hit = filmstripCache.get(key)
    if (hit) {
      setThumbs(hit)
      return
    }

    let cancelled = false
    let promise = inflight.get(key)
    if (!promise) {
      promise = buildFilmstrip(url, count, startSec, endSec)
        .then((t) => {
          filmstripCache.set(key, t)
          if (filmstripCache.size > 120) {
            const oldest = filmstripCache.keys().next().value as string | undefined
            if (oldest) filmstripCache.delete(oldest)
          }
          return t
        })
        .finally(() => inflight.delete(key))
      inflight.set(key, promise)
    }

    promise
      .then((t) => {
        if (!cancelled) setThumbs(t)
      })
      .catch(() => {
        if (!cancelled) setThumbs([])
      })

    return () => {
      cancelled = true
    }
  }, [url, count, startSec, endSec])

  return thumbs
}
