/**
 * SlipPreviewOverlay — keeps the preview from flashing black during a slip drag.
 *
 * Why the Player alone isn't enough
 * ----------------------------------
 * The Slip tool changes a clip's `inPoint`/`outPoint`, which translates to a
 * new `trimBefore` on Remotion's `Html5Video`. Each change forces the
 * underlying `<video>` to seek, and depending on the browser the element
 * either blanks during the seek or transitions through a black presented
 * frame. With the user dragging at 60Hz the result is a strobe of black
 * flashes covering the very frame the slip is trying to preview.
 *
 * Our approach
 * ------------
 * We mount an *independent* hidden `<video>` element pointing at the same
 * asset URL the Player uses. We then drive it ourselves: set `currentTime`
 * to the target source time on every `liveSlip` change, and use
 * `requestVideoFrameCallback` to draw each *presented* frame into a canvas
 * that sits on top of the Player. Since browsers only fire `rVFC` when a
 * frame has actually been decoded and is ready to paint, the canvas only
 * ever receives good frames — and because we *never* clear it, the previous
 * good frame stays visible during the next seek's blanking interval.
 *
 * The Player keeps tracking the slip via `displayTracks` (see EditorPage) so
 * that when the drag ends and this overlay unmounts, the Player is already
 * showing the committed frame underneath. No additional seek-and-flash at
 * release.
 *
 * Notes
 * -----
 *   - The first paint is seeded synchronously in `useLayoutEffect` by
 *     snapshotting whatever the Player is currently showing — without this
 *     the canvas would mount transparent for one frame and the user would
 *     see the Player begin to black-flash through it.
 *   - We don't set `crossOrigin`. Signed URLs from Supabase storage often
 *     omit CORS headers, and `crossOrigin="anonymous"` would refuse to load
 *     them. Without it, `drawImage` silently taints the canvas — but only
 *     pixel-read operations (`getImageData`, `toBlob`) throw, and we only
 *     paint, so this is fine.
 *   - We mirror `Html5Video`'s `objectFit: cover` crop so the canvas frame
 *     lines up with the Player paint underneath; clips with custom
 *     transforms (translate/scale keyframes) briefly look off-position
 *     until the Player catches up, which is the same trade-off the existing
 *     preview already makes during scrubbing.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from 'react'
import { useUIStore } from '../store/ui-store'
import { useEditorStore } from '../store/editor-store'
import { usePlaybackStore } from '../store/playback-store'
import type { Clip } from '../types'

export interface SlipPreviewOverlayProps {
  /** Composition width in CSS pixels (matches the scaled wrapper). */
  compositionWidth: number
  /** Composition height in CSS pixels (matches the scaled wrapper). */
  compositionHeight: number
  /**
   * Ref to an ancestor element that contains the Remotion Player's `<video>`.
   * Used only for the initial frame snapshot so the canvas is opaque before
   * the hidden video produces its first decoded frame.
   */
  rootRef: RefObject<HTMLDivElement | null>
  /**
   * Resolved URLs for every clip's media asset. We read the slipped clip's
   * URL from this map so the hidden video element pulls from the same
   * source (and, when available, the same prefetched blob URL) as the
   * Player — making in-RAM seeking near-instant.
   */
  assetUrlMap: Record<string, string | undefined>
}

function drawCoverFrame(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource & { videoWidth?: number; videoHeight?: number },
  destWidth: number,
  destHeight: number,
) {
  const vw = source.videoWidth ?? 0
  const vh = source.videoHeight ?? 0
  if (vw === 0 || vh === 0) return
  const vAR = vw / vh
  const cAR = destWidth / destHeight
  let sx: number, sy: number, sw: number, sh: number
  if (vAR > cAR) {
    // Source is wider than the composition — crop sides to match cover.
    sh = vh
    sw = sh * cAR
    sx = (vw - sw) / 2
    sy = 0
  } else {
    // Source is taller — crop top/bottom.
    sw = vw
    sh = sw / cAR
    sx = 0
    sy = (vh - sh) / 2
  }
  try {
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, destWidth, destHeight)
  } catch {
    // Element transient — drop this frame. The canvas keeps its last good
    // frame, which is the whole point.
  }
}

export function SlipPreviewOverlay({
  compositionWidth,
  compositionHeight,
  rootRef,
  assetUrlMap,
}: SlipPreviewOverlayProps) {
  const liveSlip = useUIStore((s) => s.liveSlip)
  const tracks = useEditorStore((s) => s.tracks)
  const playheadMs = usePlaybackStore((s) => s.playheadPosition)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)

  // Locate the clip being slipped. Memoed by clipId so we don't re-find on
  // every delta tick during the drag — the clip's host track and basic
  // shape don't change mid-slip.
  const slipClipId = liveSlip?.clipId ?? null
  const slippedClip = useMemo<Clip | null>(() => {
    if (!slipClipId) return null
    for (const track of tracks) {
      const found = track.clips.find((c) => c.id === slipClipId)
      if (found) return found
    }
    return null
  }, [slipClipId, tracks])

  const assetUrl =
    slippedClip && slippedClip.kind !== 'image'
      ? assetUrlMap[slippedClip.assetId]
      : undefined

  // Source-time we want the hidden video parked on right now. Recomputed
  // every slip tick: it factors in the live delta, the user's playhead
  // position inside the clip, and the clip's playback speed.
  const targetTimeSec = useMemo(() => {
    if (!liveSlip || !slippedClip) return null
    const clip = slippedClip
    const clipEnd = clip.startTime + clip.duration
    // Clamp playhead to the clip's own span so we never ask the hidden
    // video for a frame outside the clip's visible range (which would just
    // show the wrong source moment).
    const clamped = Math.max(clip.startTime, Math.min(clipEnd - 1, playheadMs))
    const timeIntoClip = clamped - clip.startTime
    const slippedInPoint = clip.inPoint + liveSlip.sourceDeltaMs
    const sourceMs = slippedInPoint + timeIntoClip * clip.speed
    return Math.max(0, sourceMs) / 1000
  }, [liveSlip, slippedClip, playheadMs])

  // ── Initial snapshot ────────────────────────────────────────────────────
  // Runs synchronously the first time the overlay mounts so the canvas
  // is non-transparent before the next paint. Snapshots whatever the
  // Player currently has on screen — that's the correct "before" frame.
  const slipActive = Boolean(liveSlip)
  useLayoutEffect(() => {
    if (!slipActive) return
    const canvas = canvasRef.current
    const root = rootRef.current
    if (!canvas || !root) return

    canvas.width = compositionWidth
    canvas.height = compositionHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const videos = Array.from(
      root.querySelectorAll('video'),
    ) as HTMLVideoElement[]
    for (const v of videos) {
      if (v === videoRef.current) continue // skip our own hidden one
      if (v.readyState < 2 || v.videoWidth === 0) continue
      const rect = v.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue
      drawCoverFrame(ctx, v, compositionWidth, compositionHeight)
      break
    }
    // We deliberately don't depend on `playheadMs` here — this effect is
    // a one-shot at slip start. Subsequent draws come from the hidden video.
  }, [slipActive, compositionWidth, compositionHeight, rootRef])

  // ── Hidden video → canvas draw loop ─────────────────────────────────────
  // The hidden video runs its own seek pipeline. Each time we re-seek it
  // the browser will, when it's ready, present a new frame; `rVFC` fires
  // exactly when that happens, and we paint it onto the canvas.
  useEffect(() => {
    if (!liveSlip || !assetUrl || targetTimeSec === null) return
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let cancelled = false
    let rvfcHandle: number | null = null
    let rafHandle: number | null = null

    const paint = () => {
      if (cancelled) return
      drawCoverFrame(ctx, video, compositionWidth, compositionHeight)
    }

    const scheduleNext = () => {
      if (cancelled) return
      if (typeof video.requestVideoFrameCallback === 'function') {
        rvfcHandle = video.requestVideoFrameCallback(() => {
          paint()
          scheduleNext()
        })
      } else {
        // Fallback for browsers without rVFC (older Safari). rAF is coarser
        // but still better than nothing — the canvas updates whenever the
        // browser paints, which is usually when the seek has resolved.
        rafHandle = requestAnimationFrame(() => {
          paint()
          scheduleNext()
        })
      }
    }

    const applyTime = () => {
      if (cancelled) return
      if (video.readyState < 1) return // metadata not loaded yet
      // Skip a no-op seek — assigning the same currentTime still fires
      // `seeking`/`seeked` in some browsers and would re-paint identical
      // frames for no benefit.
      if (Math.abs(video.currentTime - targetTimeSec) < 1e-3) {
        paint()
        return
      }
      try {
        video.currentTime = targetTimeSec
      } catch {
        // ignore — invalid currentTime (NaN/negative) gets re-clamped on
        // the next tick when targetTimeSec recomputes.
      }
    }

    const onLoadedMetadata = () => applyTime()

    if (video.readyState >= 1) {
      applyTime()
    } else {
      video.addEventListener('loadedmetadata', onLoadedMetadata, { once: true })
    }
    scheduleNext()

    return () => {
      cancelled = true
      video.removeEventListener('loadedmetadata', onLoadedMetadata)
      if (rvfcHandle != null && video.cancelVideoFrameCallback) {
        try {
          video.cancelVideoFrameCallback(rvfcHandle)
        } catch {
          // ignore — element may have detached
        }
      }
      if (rafHandle != null) cancelAnimationFrame(rafHandle)
    }
  }, [liveSlip, assetUrl, targetTimeSec, compositionWidth, compositionHeight])

  if (!liveSlip || !slippedClip || !assetUrl) return null

  return (
    <>
      {/*
       * Hidden seek-only video. We render it inside the scaled wrapper but
       * sized down to 1×1 and made non-visible so layout cost stays trivial
       * while still keeping the element decoding (most browsers throttle or
       * skip decoding for `display: none` videos, which would defeat the
       * whole pipeline). `muted` is required for autoplay-policy reasons in
       * some browsers even when we never call play().
       */}
      <video
        ref={videoRef}
        src={assetUrl}
        muted
        playsInline
        preload="auto"
        aria-hidden
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          opacity: 0,
          pointerEvents: 'none',
          left: 0,
          top: 0,
        }}
      />
      <canvas
        ref={canvasRef}
        className="absolute inset-0 pointer-events-none"
        style={{ width: '100%', height: '100%' }}
        aria-hidden
      />
    </>
  )
}
