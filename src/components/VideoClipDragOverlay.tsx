/**
 * VideoClipDragOverlay — draggable + resizable handle for selected video clips.
 *
 * Sibling of CaptionDragOverlay. When the selected clip is on a video track and
 * its time window contains the playhead, this renders a dashed bounding box
 * over the rendered video extent inside PreviewCanvas's scaled wrapper. The
 * box behaves like a transform manipulator:
 *
 *   - Drag the body to translate the clip (updates `transform.x` and `transform.y`).
 *   - Drag a corner circle to scale the clip uniformly (updates `transform.scale`).
 *   - Double-click to reset translation to (0, 0).
 *
 * Coordinate model:
 *   The overlay lives inside the scaled composition wrapper, so we work in
 *   composition pixels (1080 × 1920). Pointer deltas come back in screen
 *   pixels and are divided by `scale` to translate them back.
 *
 * Sizing math:
 *   The bounding box represents where the clip is laid out before viewport
 *   clipping: center = (W/2 + transform.x, H/2 + transform.y); width/height =
 *   composition × transform.scale. This matches the visible video bounds for a
 *   clip that fills the frame at scale 1.
 */

import { useEffect, useRef, useState } from 'react'
import { useEditorStore } from '../store/editor-store'
import { useSelectionStore } from '../store/selection-store'
import { usePlaybackStore } from '../store/playback-store'
import { DEFAULT_CLIP_TRANSFORM } from '../types'
import { snapMove, snapScale, type SnapLine } from './snapping'

export interface VideoClipDragOverlayProps {
  /** Composition width in native pixels (e.g. 1080). */
  compositionWidth: number

  /** Composition height in native pixels (e.g. 1920). */
  compositionHeight: number

  /** Current CSS scale factor applied by PreviewCanvas's wrapper. */
  scale: number

  /**
   * assetId → URL map. Used to look up the natural dimensions of an image clip
   * so the selection box hugs the contained image instead of stretching to the
   * full canvas. Optional — when missing, the box falls back to canvas bounds
   * (correct for video clips that fill the canvas via object-fit: cover).
   */
  assetUrlMap?: Record<string, string>

  /**
   * Push active snap-guide lines up to PreviewCanvas so SnapGuidesOverlay can
   * paint them. Called with `[]` on pointer-up to clear the overlay.
   */
  onSnapGuidesChange?: (lines: SnapLine[]) => void
}

/**
 * Resolve the natural pixel dimensions of an image URL by loading it once and
 * caching the result for the lifetime of the component. Returns `null` until
 * the load completes (or fails), so callers can fall back to defaults during
 * the brief loading window.
 *
 * Cache lives at module scope rather than in a context so multiple overlays
 * (or a remount of this overlay across selection changes) reuse the same
 * resolution. Keys are URLs; values are the loaded dimensions or `null` if the
 * load errored.
 */
const naturalSizeCache = new Map<string, { width: number; height: number } | null>()

function useImageNaturalSize(url: string | null) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(() =>
    url ? naturalSizeCache.get(url) ?? null : null,
  )

  useEffect(() => {
    if (!url) {
      setSize(null)
      return
    }
    const cached = naturalSizeCache.get(url)
    if (cached !== undefined) {
      setSize(cached)
      return
    }

    let cancelled = false
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => {
      if (cancelled) return
      const dims = { width: img.naturalWidth, height: img.naturalHeight }
      naturalSizeCache.set(url, dims)
      setSize(dims)
    }
    img.onerror = () => {
      if (cancelled) return
      naturalSizeCache.set(url, null)
      setSize(null)
    }
    img.src = url
    return () => {
      cancelled = true
    }
  }, [url])

  return size
}

const MIN_TRANSFORM_SCALE = 0.1
const MAX_TRANSFORM_SCALE = 4.0

/** Snap zone half-width in screen pixels — divided by CSS scale before use. */
const SNAP_THRESHOLD_SCREEN_PX = 8

export function VideoClipDragOverlay({
  compositionWidth,
  compositionHeight,
  scale,
  assetUrlMap,
  onSnapGuidesChange,
}: VideoClipDragOverlayProps) {
  const selectedClipIds = useSelectionStore((s) => s.selectedClipIds)
  const tracks = useEditorStore((s) => s.tracks)
  const playheadPosition = usePlaybackStore((s) => s.playheadPosition)
  const updateClipTransform = useEditorStore((s) => s.updateClipTransform)

  const [dragging, setDragging] = useState(false)
  const [resizing, setResizing] = useState(false)

  const moveStartRef = useRef<{
    pointerX: number
    pointerY: number
    x: number
    y: number
  } | null>(null)

  const resizeStartRef = useRef<{
    pointerX: number
    pointerY: number
    originalScale: number
    originalHeight: number
    /** +1 for bottom corners (drag-down grows), -1 for top corners (drag-up grows). */
    ySign: 1 | -1
  } | null>(null)

  // Find a single-selected video clip whose time window contains the playhead.
  let selected: {
    clipId: string
    transform: typeof DEFAULT_CLIP_TRANSFORM
    isImage: boolean
    assetId: string
  } | null = null
  if (selectedClipIds.length === 1) {
    const id = selectedClipIds[0]
    for (const track of tracks) {
      if (track.type !== 'video') continue
      const clip = track.clips.find((c) => c.id === id)
      if (!clip) continue
      if (
        playheadPosition >= clip.startTime &&
        playheadPosition < clip.startTime + clip.duration
      ) {
        selected = {
          clipId: clip.id,
          transform: { ...DEFAULT_CLIP_TRANSFORM, ...clip.transform },
          isImage: clip.kind === 'image',
          assetId: clip.assetId,
        }
      }
      break
    }
  }

  const imageUrl =
    selected && selected.isImage ? assetUrlMap?.[selected.assetId] ?? null : null
  const naturalSize = useImageNaturalSize(imageUrl)

  if (!selected) return null

  const transform = selected.transform

  // Image clips render with object-fit: contain, so their bounding box is the
  // contained rectangle inside the canvas — not the full canvas. Compute the
  // contain-fit rectangle once natural dimensions resolve; until then fall back
  // to canvas bounds (matches the video selection behaviour). Video clips skip
  // this entirely and keep the full-canvas box because they render with cover.
  let contentWidth = compositionWidth
  let contentHeight = compositionHeight
  if (selected.isImage && naturalSize && naturalSize.width > 0 && naturalSize.height > 0) {
    const canvasRatio = compositionWidth / compositionHeight
    const imageRatio = naturalSize.width / naturalSize.height
    if (imageRatio > canvasRatio) {
      // Image wider than canvas → letterbox top/bottom.
      contentWidth = compositionWidth
      contentHeight = compositionWidth / imageRatio
    } else {
      // Image taller than canvas → pillarbox left/right.
      contentHeight = compositionHeight
      contentWidth = compositionHeight * imageRatio
    }
  }

  const boxWidth = contentWidth * transform.scale
  const boxHeight = contentHeight * transform.scale
  const cx = compositionWidth / 2 + transform.x
  const cy = compositionHeight / 2 + transform.y

  // ── Body drag (translate) ────────────────────────────────────────────────

  function handleBodyPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    moveStartRef.current = {
      pointerX: e.clientX,
      pointerY: e.clientY,
      x: transform.x,
      y: transform.y,
    }
    setDragging(true)
  }

  function handleBodyPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!moveStartRef.current || scale <= 0) return
    const dx = (e.clientX - moveStartRef.current.pointerX) / scale
    const dy = (e.clientY - moveStartRef.current.pointerY) / scale

    const rawX = moveStartRef.current.x + dx
    const rawY = moveStartRef.current.y + dy

    // Alt held → temporarily disable snapping (standard "free move" gesture).
    if (e.altKey) {
      onSnapGuidesChange?.([])
      updateClipTransform(selected!.clipId, { x: rawX, y: rawY })
      return
    }

    // snapMove operates on box-center coordinates; transform offsets are
    // relative to canvas center, so add/subtract the half-canvas to bridge.
    const candidateCenterX = compositionWidth / 2 + rawX
    const candidateCenterY = compositionHeight / 2 + rawY

    const snapped = snapMove({
      centerX: candidateCenterX,
      centerY: candidateCenterY,
      width: boxWidth,
      height: boxHeight,
      compositionWidth,
      compositionHeight,
      threshold: SNAP_THRESHOLD_SCREEN_PX / scale,
    })

    onSnapGuidesChange?.(snapped.lines)
    updateClipTransform(selected!.clipId, {
      x: snapped.centerX - compositionWidth / 2,
      y: snapped.centerY - compositionHeight / 2,
    })
  }

  function handleBodyPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    moveStartRef.current = null
    setDragging(false)
    onSnapGuidesChange?.([])
  }

  function handleDoubleClick(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    updateClipTransform(selected!.clipId, { x: 0, y: 0 })
  }

  // ── Corner resize (scale) ────────────────────────────────────────────────

  function handleCornerPointerDown(
    e: React.PointerEvent<HTMLDivElement>,
    ySign: 1 | -1,
  ) {
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    resizeStartRef.current = {
      pointerX: e.clientX,
      pointerY: e.clientY,
      originalScale: transform.scale,
      originalHeight: boxHeight,
      ySign,
    }
    setResizing(true)
  }

  function handleCornerPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!resizeStartRef.current || scale <= 0) return
    const start = resizeStartRef.current
    const dyComposition = (e.clientY - start.pointerY) / scale
    const heightDelta = start.ySign * dyComposition
    const newHeight = Math.max(1, start.originalHeight + heightDelta)
    const scaleFactor = newHeight / start.originalHeight
    const rawScale = Math.max(
      MIN_TRANSFORM_SCALE,
      Math.min(MAX_TRANSFORM_SCALE, start.originalScale * scaleFactor),
    )
    // Snap to common scale values (0.25, 0.5, 1.0, …) unless Alt is held.
    const newScale = e.altKey ? rawScale : snapScale(rawScale)
    updateClipTransform(selected!.clipId, { scale: newScale })
  }

  function handleCornerPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    resizeStartRef.current = null
    setResizing(false)
    onSnapGuidesChange?.([])
  }

  // ── Visual sizing — keep on-screen pixel sizes constant regardless of zoom ─

  const borderWidth = Math.max(4, Math.round(2 / Math.max(scale, 0.01)))
  const cornerSizePx = Math.max(10, Math.round(14 / Math.max(scale, 0.01)))
  const cornerBorderPx = Math.max(2, Math.round(2 / Math.max(scale, 0.01)))

  const cornerCommonStyle: React.CSSProperties = {
    position: 'absolute',
    width: cornerSizePx,
    height: cornerSizePx,
    borderRadius: '50%',
    background: '#ffffff',
    border: `${cornerBorderPx}px solid rgba(99,102,241,0.95)`,
    boxSizing: 'border-box',
    zIndex: 6,
    touchAction: 'none',
    userSelect: 'none',
  }

  return (
    <div
      onPointerDown={handleBodyPointerDown}
      onPointerMove={handleBodyPointerMove}
      onPointerUp={handleBodyPointerUp}
      onPointerCancel={handleBodyPointerUp}
      onDoubleClick={handleDoubleClick}
      role="button"
      tabIndex={-1}
      aria-label="Drag to reposition video • Drag a corner to scale"
      title="Drag to move • Double-click to recenter • Drag a corner to resize"
      style={{
        position: 'absolute',
        left: cx - boxWidth / 2,
        top: cy - boxHeight / 2,
        width: boxWidth,
        height: boxHeight,
        cursor: dragging ? 'grabbing' : resizing ? 'default' : 'grab',
        border: `${borderWidth}px dashed rgba(99,102,241,0.95)`,
        borderRadius: 12,
        background: dragging ? 'rgba(99,102,241,0.08)' : 'transparent',
        boxSizing: 'border-box',
        zIndex: 4,
        touchAction: 'none',
        userSelect: 'none',
      }}
    >
      <div
        onPointerDown={(e) => handleCornerPointerDown(e, -1)}
        onPointerMove={handleCornerPointerMove}
        onPointerUp={handleCornerPointerUp}
        onPointerCancel={handleCornerPointerUp}
        role="button"
        aria-label="Resize video"
        title="Drag to resize"
        style={{
          ...cornerCommonStyle,
          left: -cornerSizePx / 2,
          top: -cornerSizePx / 2,
          cursor: 'nwse-resize',
        }}
      />
      <div
        onPointerDown={(e) => handleCornerPointerDown(e, -1)}
        onPointerMove={handleCornerPointerMove}
        onPointerUp={handleCornerPointerUp}
        onPointerCancel={handleCornerPointerUp}
        role="button"
        aria-label="Resize video"
        title="Drag to resize"
        style={{
          ...cornerCommonStyle,
          right: -cornerSizePx / 2,
          top: -cornerSizePx / 2,
          cursor: 'nesw-resize',
        }}
      />
      <div
        onPointerDown={(e) => handleCornerPointerDown(e, 1)}
        onPointerMove={handleCornerPointerMove}
        onPointerUp={handleCornerPointerUp}
        onPointerCancel={handleCornerPointerUp}
        role="button"
        aria-label="Resize video"
        title="Drag to resize"
        style={{
          ...cornerCommonStyle,
          left: -cornerSizePx / 2,
          bottom: -cornerSizePx / 2,
          cursor: 'nesw-resize',
        }}
      />
      <div
        onPointerDown={(e) => handleCornerPointerDown(e, 1)}
        onPointerMove={handleCornerPointerMove}
        onPointerUp={handleCornerPointerUp}
        onPointerCancel={handleCornerPointerUp}
        role="button"
        aria-label="Resize video"
        title="Drag to resize"
        style={{
          ...cornerCommonStyle,
          right: -cornerSizePx / 2,
          bottom: -cornerSizePx / 2,
          cursor: 'nwse-resize',
        }}
      />
    </div>
  )
}
