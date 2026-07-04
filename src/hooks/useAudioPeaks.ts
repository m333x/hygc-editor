/**
 * useAudioPeaks — decode an audio URL and return normalized peak values for a segment.
 *
 * Used by TimelineClip to draw waveform bars inside audio clips. Fetches the
 * audio file, decodes it with the Web Audio API, and downsamples the segment
 * [inPointMs, outPointMs] to `numBars` peak values (0..1) for SVG rendering.
 *
 * Decoded buffers are cached in-memory and in IndexedDB (keyed by URL pathname
 * so rotating Supabase signed-URL tokens don't bust the cache). Repeated use
 * across clips and across page reloads avoids re-fetching + re-decoding.
 *
 * @see TimelineClip.tsx — consumes peaks for waveform rendering
 * @see asset-cache.ts — IndexedDB-backed persistence
 */

import { useEffect, useMemo, useState } from 'react'
import {
  getCachedAudioDecode,
  putCachedAudioDecode,
  urlCacheKey,
} from '../lib/asset-cache'

// ─── Decode cache (module-level so shared across all clips) ───────────────────

interface CachedDecode {
  /** Mono or left-channel samples, full length. */
  samples: Float32Array
  /** Duration of the decoded audio in seconds. */
  durationSec: number
}

const decodeCache = new Map<string, CachedDecode>()
const inflightDecodes = new Map<string, Promise<CachedDecode>>()
const peaksCache = new Map<string, { peak: number[]; rms: number[] }>()

async function getDecodedSamples(url: string): Promise<CachedDecode> {
  const existing = decodeCache.get(url)
  if (existing) return existing
  const inflight = inflightDecodes.get(url)
  if (inflight) return inflight

  const key = urlCacheKey(url)
  const promise = (async () => {
    const persisted = await getCachedAudioDecode(key)
    if (persisted) {
      decodeCache.set(url, persisted)
      return persisted
    }

    const res = await fetch(url)
    if (!res.ok) throw new Error(`Failed to fetch audio: ${res.status}`)
    const arrayBuffer = await res.arrayBuffer()

    const ctx = new (window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext)()
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer)
    ctx.close()

    const channel = audioBuffer.getChannelData(0)
    const samples = new Float32Array(channel.length)
    samples.set(channel)
    const durationSec = audioBuffer.duration

    const cached: CachedDecode = { samples, durationSec }
    decodeCache.set(url, cached)
    void putCachedAudioDecode(key, samples, durationSec)
    return cached
  })()

  inflightDecodes.set(url, promise)
  try {
    return await promise
  } finally {
    inflightDecodes.delete(url)
  }
}

/**
 * Extract peak + RMS values for a time segment by downsampling to numBars bins.
 * For each bin we compute both the max absolute sample (envelope) and the
 * root-mean-square (perceptual loudness). Both series are normalized 0..1
 * against the segment's max peak so silence ↔ loudest stay anchored.
 *
 * Returning two series lets the renderer draw a soft "body" (RMS) under a
 * sharper "envelope" (peak), which reads as a real audio waveform instead
 * of disjointed bars.
 */
function getPeaksForSegment(
  samples: Float32Array,
  durationSec: number,
  inPointMs: number,
  outPointMs: number,
  numBars: number,
): { peak: number[]; rms: number[] } {
  if (numBars <= 0 || durationSec <= 0) return { peak: [], rms: [] }
  const inSec = inPointMs / 1000
  const outSec = outPointMs / 1000
  const startSample = Math.floor((inSec / durationSec) * samples.length)
  const endSample = Math.ceil((outSec / durationSec) * samples.length)
  const segmentLength = Math.max(0, endSample - startSample)
  if (segmentLength === 0) {
    return {
      peak: Array.from({ length: numBars }, () => 0),
      rms: Array.from({ length: numBars }, () => 0),
    }
  }

  const barWidth = segmentLength / numBars
  const peak: number[] = new Array(numBars)
  const rms: number[] = new Array(numBars)
  let maxPeak = 0

  for (let i = 0; i < numBars; i++) {
    const binStart = startSample + Math.floor(i * barWidth)
    const binEnd = Math.min(
      startSample + Math.floor((i + 1) * barWidth),
      endSample,
    )
    let max = 0
    let sumSq = 0
    let count = 0
    for (let j = binStart; j < binEnd; j++) {
      const s = samples[j]!
      const abs = s < 0 ? -s : s
      if (abs > max) max = abs
      sumSq += s * s
      count++
    }
    peak[i] = max
    rms[i] = count > 0 ? Math.sqrt(sumSq / count) : 0
    if (max > maxPeak) maxPeak = max
  }

  const norm = maxPeak > 0 ? maxPeak : 1
  for (let i = 0; i < numBars; i++) {
    peak[i] = peak[i]! / norm
    rms[i] = rms[i]! / norm
  }
  return { peak, rms }
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export interface UseAudioPeaksOptions {
  /** Audio URL (e.g. from assetUrlMap[clip.assetId]). */
  url: string | undefined
  /** Source duration in ms (clip.sourceDurationMs or clip.outPoint). */
  sourceDurationMs: number
  /** Segment start in ms (clip.inPoint). */
  inPointMs: number
  /** Segment end in ms (clip.outPoint). */
  outPointMs: number
  /** Number of bars to produce (e.g. from clip width in px). */
  numBars: number
}

export interface UseAudioPeaksResult {
  /** Normalized peak (envelope) values 0..1, one per bar. Empty while loading or on error. */
  peaks: number[]
  /** Normalized RMS (perceptual body) values 0..1, one per bar. Always ≤ corresponding peak. */
  rms: number[]
  loading: boolean
  error: Error | null
}

/**
 * Decode audio at `url` and return peak values for the segment [inPointMs, outPointMs].
 * Returns empty peaks while loading or if url is missing; normalizes to 0..1.
 */
export function useAudioPeaks({
  url,
  sourceDurationMs,
  inPointMs,
  outPointMs,
  numBars,
}: UseAudioPeaksOptions): UseAudioPeaksResult {
  const [samples, setSamples] = useState<CachedDecode | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    if (!url || url.trim() === '') {
      return
    }

    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) {
        setLoading(true)
        setError(null)
      }
    })

    getDecodedSamples(url)
      .then((cached) => {
        if (!cancelled) {
          setSamples(cached)
          setError(null)
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)))
          setSamples(null)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [url])

  const { peaks, rms } = useMemo(() => {
    if (!url || !samples || numBars <= 0 || sourceDurationMs <= 0) {
      return { peaks: [] as number[], rms: [] as number[] }
    }
    const cacheKey = [
      url,
      Math.round(inPointMs),
      Math.round(outPointMs),
      Math.max(1, Math.round(numBars)),
    ].join(':')
    const cached = peaksCache.get(cacheKey)
    if (cached) {
      return { peaks: cached.peak, rms: cached.rms }
    }
    const result = getPeaksForSegment(
      samples.samples,
      samples.durationSec,
      inPointMs,
      outPointMs,
      numBars,
    )
    peaksCache.set(cacheKey, result)
    if (peaksCache.size > 200) {
      const oldest = peaksCache.keys().next().value as string | undefined
      if (oldest) peaksCache.delete(oldest)
    }
    return { peaks: result.peak, rms: result.rms }
  }, [samples, sourceDurationMs, inPointMs, outPointMs, numBars, url])

  if (!url || url.trim() === '') {
    return { peaks: [], rms: [], loading: false, error: null }
  }

  return { peaks, rms, loading, error }
}
