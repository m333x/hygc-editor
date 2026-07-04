/**
 * CaptionDragOverlay — draggable handle for free caption placement.
 *
 * Renders an absolutely-positioned bounding box over the currently selected
 * caption clip when that clip is active at the playhead. Dragging the box
 * updates `clip.captionStyle.xOffset / yOffset`, allowing users to place
 * captions anywhere on the canvas — not just at the top/center/bottom anchor.
 *
 * Coordinate model:
 *   - The overlay lives inside the scaled composition wrapper (see PreviewCanvas),
 *     so we work in native composition pixels (1080 × 1920). The browser's
 *     transform: scale(...) on the wrapper handles screen-space rendering.
 *   - Pointer deltas come back in screen pixels, so we divide by `scale` to
 *     translate them back into composition pixels.
 *
 * Anchor model:
 *   - The user's `position` (top/center/bottom) defines the baseline anchor.
 *   - xOffset / yOffset translate the rendered text from that anchor in pixels.
 *   - The drag handle's screen position is derived from the same anchor math
 *     so it stays glued to whatever the renderer paints.
 *
 * The overlay only mounts when:
 *   1. Exactly one clip is selected,
 *   2. That clip is on a caption track, and
 *   3. The playhead falls inside the clip's time window.
 *
 * Outside those conditions it returns null (no DOM, no event handlers).
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { PlayerRef } from '@remotion/player'
import { useEditorStore } from '../store/editor-store'
import { useSelectionStore } from '../store/selection-store'
import { usePlaybackStore } from '../store/playback-store'
import { DEFAULT_CAPTION_STYLE } from '../types'
import type { AnimatablePropertyId, CaptionStyle } from '../types'
import { resolveAnimatedCaptionStyle } from '../engine/keyframe-interpolator'
import { snapMove, type SnapLine } from './snapping'

/**
 * Caption style fields with a paired animatable property. When the drag /
 * resize overlay writes one of these and the clip already has a keyframe
 * track for that property, the write becomes a keyframe-at-playhead so the
 * animation reflects the new dragged position. Without this routing, an
 * animated caption would visibly snap back to its keyframed value the instant
 * the drag commits a baseline write the renderer ignores.
 */
const KEYFRAMABLE_CAPTION_FIELDS: Partial<Record<keyof CaptionStyle, AnimatablePropertyId>> = {
  fontSizePx: 'caption.fontSizePx',
  xOffset: 'caption.xOffset',
  yOffset: 'caption.yOffset',
}

// ── Constants mirrored from ShortComposition ──────────────────────────────────
// Keep these in sync with ShortComposition.tsx so the drag box matches the
// rendered caption position pixel-for-pixel.

const FONT_SIZE_MAP: Record<string, number> = {
  S: 36,
  M: 48,
  L: 64,
  XL: 80,
}

const CAPTION_SAFE_AREA_PX = 160

// ── Props ────────────────────────────────────────────────────────────────────

export interface CaptionDragOverlayProps {
  /** Composition width in native pixels (e.g. 1080). */
  compositionWidth: number

  /** Composition height in native pixels (e.g. 1920). */
  compositionHeight: number

  /**
   * Current CSS scale factor applied to the wrapper. Pointer movement deltas
   * are divided by this to convert screen pixels back to composition pixels.
   */
  scale: number

  /**
   * Composition framerate. Used to translate the Remotion player's frame events
   * into milliseconds for the keyframe interpolator.
   */
  fps: number

  /**
   * Ref to the Remotion Player. The overlay subscribes to the player's
   * `frameupdate` event directly so the drag box tracks keyframed motion at
   * frame rate instead of at the throttled store cadence (PreviewCanvas only
   * pushes playhead to the store every ~100ms during playback).
   */
  playerRef: React.RefObject<PlayerRef | null>

  /**
   * Push active snap-guide lines up to PreviewCanvas so SnapGuidesOverlay can
   * paint them. Called with `[]` on pointer-up to clear the overlay.
   */
  onSnapGuidesChange?: (lines: SnapLine[]) => void
}

/** Snap zone half-width in screen pixels — divided by CSS scale before use. */
const SNAP_THRESHOLD_SCREEN_PX = 8

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Estimate the rendered text block's size in composition pixels.
 *
 * We don't have access to the actual rendered bounding rect (the text lives
 * inside the Remotion Player, which we don't reach into). Instead we estimate
 * width by character count and height by line count + font metrics. The
 * estimate doesn't need to be perfect — the drag box just needs to roughly
 * match the visible text so the grab cursor lands where users expect.
 */
function estimateTextSize(text: string, fontSize: number, maxWidth: number) {
  const lines = text.split('\n').reduce((sum, line) => {
    // Approximate characters that fit on one line at this font size.
    const charsPerLine = Math.floor(maxWidth / (fontSize * 0.5))
    return sum + Math.max(1, Math.ceil(line.length / Math.max(1, charsPerLine)))
  }, 0)
  const safeLines = Math.max(1, lines)
  const height = safeLines * fontSize * 1.3 + 16 // matches lineHeight + padding
  // Width: take the longest line, clamped to maxWidth.
  const longestLine = text.split('\n').reduce((max, line) => Math.max(max, line.length), 0)
  const width = Math.min(maxWidth, Math.max(240, longestLine * fontSize * 0.55 + 48))
  return { width, height: Math.max(80, height) }
}

/**
 * Resolve the caption text's center (in composition pixels) for a given
 * style + estimated text size. Mirrors the layout in ShortComposition.tsx:
 * vertically anchored within a safe-area-padded flex column.
 */
function resolveCenter(
  style: CaptionStyle,
  compositionWidth: number,
  compositionHeight: number,
  textHeight: number,
) {
  const xOffset = style.xOffset ?? 0
  const yOffset = style.yOffset ?? 0

  const cx = compositionWidth / 2 + xOffset

  let cy: number
  switch (style.position) {
    case 'top':
      cy = CAPTION_SAFE_AREA_PX + textHeight / 2
      break
    case 'center':
      cy = compositionHeight / 2
      break
    case 'bottom':
    default:
      cy = compositionHeight - CAPTION_SAFE_AREA_PX - textHeight / 2
      break
  }
  cy += yOffset

  return { cx, cy }
}

// ── Live playhead hook ───────────────────────────────────────────────────────

/**
 * Tracks the Remotion Player's current frame at full frame rate.
 *
 * PreviewCanvas throttles `frameupdate → store.setPlayhead` to ~100ms (see
 * `PLAYHEAD_SYNC_INTERVAL_MS`) so the timeline ruler, timecode readout, and
 * other store-subscribed surfaces aren't re-rendered 30 times a second. That
 * throttle is fine for read-out UI but visibly wrong for a manipulator handle
 * laid over keyframed motion — the rendered caption advances every ~33ms while
 * the box only catches up every ~100ms, producing perceptible lag/jitter.
 *
 * We bypass the throttle by subscribing to the same player event directly.
 * The subscription is local to the overlay that mounts the hook, so the
 * per-frame re-renders never escape this subtree. Scrubs / seeks / timecode
 * writes all flow store → playback-engine → `player.seekTo()` → `frameupdate`,
 * so the player's event is the canonical "currently rendered frame" signal;
 * the store is only read once as a seed for first paint.
 */
function useLivePlayheadMs(
  playerRef: React.RefObject<PlayerRef | null>,
  fps: number,
): number {
  // Lazy seed from the store so the first paint is at the right frame, in
  // case the overlay mounts after playback has already advanced. After mount
  // the player's frameupdate events drive `liveMs` exclusively.
  const initialStoreMs = usePlaybackStore.getState().playheadPosition
  const [liveMs, setLiveMs] = useState(initialStoreMs)

  useEffect(() => {
    const player = playerRef.current
    if (!player) return

    const onFrameUpdate = (event: { detail: { frame: number } }) => {
      const nextMs = (event.detail.frame * 1000) / fps
      setLiveMs((prev) => (prev === nextMs ? prev : nextMs))
    }

    player.addEventListener('frameupdate', onFrameUpdate)
    return () => {
      player.removeEventListener('frameupdate', onFrameUpdate)
    }
  }, [playerRef, fps])

  return liveMs
}

// ── Component ────────────────────────────────────────────────────────────────

export function CaptionDragOverlay({
  compositionWidth,
  compositionHeight,
  scale,
  fps,
  playerRef,
  onSnapGuidesChange,
}: CaptionDragOverlayProps) {
  const selectedClipIds = useSelectionStore((s) => s.selectedClipIds)
  const tracks = useEditorStore((s) => s.tracks)
  const playheadPosition = useLivePlayheadMs(playerRef, fps)
  const globalCaptionStyle = useEditorStore((s) => s.captionStyle)
  const updateClipCaptionStyle = useEditorStore((s) => s.updateClipCaptionStyle)
  const updateCaptionText = useEditorStore((s) => s.updateCaptionText)
  const setPropertyAtPlayhead = useEditorStore((s) => s.setPropertyAtPlayhead)
  const beginHistoryTransaction = useEditorStore((s) => s.beginHistoryTransaction)
  const commitHistoryTransaction = useEditorStore((s) => s.commitHistoryTransaction)

  const selected = useMemo(() => {
    if (selectedClipIds.length !== 1) return null
    const id = selectedClipIds[0]
    for (const track of tracks) {
      if (track.type !== 'caption') continue
      const clip = track.clips.find((c) => c.id === id)
      if (clip) return clip
    }
    return null
  }, [selectedClipIds, tracks])

  const [dragging, setDragging] = useState(false)
  const [resizing, setResizing] = useState(false)
  const [editing, setEditing] = useState(false)
  /** Snapshot of the clip's text at the moment edit mode was entered, used for
   *  Escape-to-cancel. We write edits live to the store so the preview reflects
   *  typing in real time; on Escape we restore this. */
  const originalTextRef = useRef<string>('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const dragStartRef = useRef<{
    pointerX: number
    pointerY: number
    xOffset: number
    yOffset: number
  } | null>(null)
  const resizeStartRef = useRef<{
    pointerX: number
    pointerY: number
    originalFontSize: number
    originalTextHeight: number
    /**
     * Sign of the y-axis component that *grows* the box for this corner.
     * Bottom corners grow downward (+1); top corners grow upward (-1).
     */
    ySign: 1 | -1
  } | null>(null)

  // Autofocus + select-all when entering edit mode. Must run unconditionally
  // (Rules of Hooks): the early returns below depend on selection state.
  useEffect(() => {
    if (!editing) return
    const el = textareaRef.current
    if (!el) return
    el.focus()
    el.select()
  }, [editing])

  // If the active clip disappears, exit edit mode so we never edit something
  // the user can no longer see.
  useEffect(() => {
    if (editing && !selected) {
      setEditing(false)
    }
  }, [editing, selected])

  if (!selected) return null

  // Only show the drag handle while the clip is "live" — i.e. the playhead is
  // inside its time window. Outside that range there's no text to drag.
  const active =
    playheadPosition >= selected.startTime &&
    playheadPosition < selected.startTime + selected.duration
  if (!active) return null

  // Base = per-clip override > global > built-in default. The renderer overlays
  // any caption.* keyframes on top of this base, so we mirror that resolution
  // here too — otherwise the drag box would sit at the static baseline position
  // while the rendered text moves around with the animation.
  const baseStyle = selected.captionStyle ?? globalCaptionStyle ?? DEFAULT_CAPTION_STYLE
  const clipLocalMs = Math.max(
    0,
    Math.min(selected.duration, playheadPosition - selected.startTime),
  )
  const style = resolveAnimatedCaptionStyle(selected, baseStyle, clipLocalMs)
  const fontSize = style.fontSizePx ?? FONT_SIZE_MAP[style.fontSize] ?? 64

  /**
   * Write a caption-style patch in the way the renderer will respect:
   *   - Keyframable fields (xOffset / yOffset / fontSizePx) on a clip that
   *     already has a keyframe track for that property go through the
   *     property registry so they upsert a keyframe at the playhead.
   *   - Everything else (and keyframable fields when there's no track) writes
   *     to the static per-clip override via `updateClipCaptionStyle`.
   *
   * Caller is responsible for wrapping high-frequency drags in a history
   * transaction so all the per-pointer-move writes collapse to one undo step.
   */
  function writeCaptionStyleUpdate(update: Partial<CaptionStyle>) {
    if (!selected) return
    const tracksOnClip = selected.keyframeTracks ?? []
    const staticPatch: Partial<CaptionStyle> = {}
    for (const key of Object.keys(update) as (keyof CaptionStyle)[]) {
      const propertyId = KEYFRAMABLE_CAPTION_FIELDS[key]
      const newValue = update[key]
      const isKeyframed =
        propertyId !== undefined && tracksOnClip.some((t) => t.propertyId === propertyId)
      if (isKeyframed && typeof newValue === 'number') {
        setPropertyAtPlayhead(selected.id, propertyId!, clipLocalMs, newValue)
      } else {
        ;(staticPatch as Record<string, unknown>)[key] = newValue
      }
    }
    if (Object.keys(staticPatch).length > 0) {
      updateClipCaptionStyle(selected.id, staticPatch)
    }
  }

  const displayText =
    (selected.captionText && selected.captionText.trim().length > 0)
      ? selected.captionText
      : 'Caption text…'

  const maxTextWidth = compositionWidth * 0.9
  const { width: textWidth, height: textHeight } = estimateTextSize(
    displayText,
    fontSize,
    maxTextWidth,
  )

  const { cx, cy } = resolveCenter(style, compositionWidth, compositionHeight, textHeight)

  // ── Pointer handlers ───────────────────────────────────────────────────────

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    dragStartRef.current = {
      pointerX: e.clientX,
      pointerY: e.clientY,
      xOffset: style.xOffset ?? 0,
      yOffset: style.yOffset ?? 0,
    }
    // One history transaction per drag — collapses the per-move writes into a
    // single undo step regardless of whether they go to the baseline or to
    // keyframe upserts. Committed on pointerup; rolled into the next undo on
    // cancel via the same commit.
    beginHistoryTransaction('Move caption')
    setDragging(true)
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragging || !dragStartRef.current || scale <= 0) return
    const dx = (e.clientX - dragStartRef.current.pointerX) / scale
    const dy = (e.clientY - dragStartRef.current.pointerY) / scale

    const rawXOffset = dragStartRef.current.xOffset + dx
    const rawYOffset = dragStartRef.current.yOffset + dy

    // Alt held → temporarily disable snapping.
    if (e.altKey) {
      onSnapGuidesChange?.([])
      writeCaptionStyleUpdate({
        xOffset: rawXOffset,
        yOffset: rawYOffset,
      })
      return
    }

    // Caption offsets are deltas from the anchor (top/center/bottom). Snap the
    // resulting box-center in canvas space, then convert back to offsets so the
    // store contract is preserved.
    const anchorStyle: CaptionStyle = { ...style, xOffset: 0, yOffset: 0 }
    const { cx: anchorCx, cy: anchorCy } = resolveCenter(
      anchorStyle,
      compositionWidth,
      compositionHeight,
      textHeight,
    )

    const snapped = snapMove({
      centerX: anchorCx + rawXOffset,
      centerY: anchorCy + rawYOffset,
      width: textWidth,
      height: textHeight,
      compositionWidth,
      compositionHeight,
      threshold: SNAP_THRESHOLD_SCREEN_PX / scale,
    })

    onSnapGuidesChange?.(snapped.lines)
    writeCaptionStyleUpdate({
      xOffset: snapped.centerX - anchorCx,
      yOffset: snapped.centerY - anchorCy,
    })
  }

  function handlePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    dragStartRef.current = null
    setDragging(false)
    onSnapGuidesChange?.([])
    commitHistoryTransaction()
  }

  function handleDoubleClick(e: React.MouseEvent) {
    // Double-click enters inline edit mode (Premiere Pro behaviour). The user
    // can revert with Escape or commit with Enter/blur.
    e.preventDefault()
    e.stopPropagation()
    originalTextRef.current = selected!.captionText ?? ''
    setEditing(true)
  }

  function commitEdit() {
    setEditing(false)
  }

  function cancelEdit() {
    if (selected) {
      updateCaptionText(selected.id, originalTextRef.current)
    }
    setEditing(false)
  }

  // ── Corner resize handlers ─────────────────────────────────────────────────
  // Each corner captures its own pointer so the body's move-drag never sees the
  // event. The vertical pointer delta (scaled to composition pixels) drives a
  // proportional change in fontSizePx; bottom corners scale up when dragged
  // down, top corners scale up when dragged up.

  const MIN_FONT_SIZE_PX = 16
  const MAX_FONT_SIZE_PX = 240

  function handleCornerPointerDown(
    e: React.PointerEvent<HTMLDivElement>,
    ySign: 1 | -1,
  ) {
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    beginHistoryTransaction('Resize caption')
    resizeStartRef.current = {
      pointerX: e.clientX,
      pointerY: e.clientY,
      originalFontSize: fontSize,
      originalTextHeight: textHeight,
      ySign,
    }
    setResizing(true)
  }

  function handleCornerPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!resizeStartRef.current || scale <= 0) return
    const start = resizeStartRef.current
    const dyComposition = (e.clientY - start.pointerY) / scale
    const heightDelta = start.ySign * dyComposition
    const newHeight = Math.max(1, start.originalTextHeight + heightDelta)
    const scaleFactor = newHeight / start.originalTextHeight
    const newFontSize = Math.round(
      Math.max(
        MIN_FONT_SIZE_PX,
        Math.min(MAX_FONT_SIZE_PX, start.originalFontSize * scaleFactor),
      ),
    )
    writeCaptionStyleUpdate({ fontSizePx: newFontSize })
  }

  function handleCornerPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    resizeStartRef.current = null
    setResizing(false)
    onSnapGuidesChange?.([])
    commitHistoryTransaction()
  }

  // Outline thickness scaled so the dashed marker reads as ~2px on screen.
  const borderWidth = Math.max(4, Math.round(2 / Math.max(scale, 0.01)))

  // Corner handles are sized so they read as ~14px on screen regardless of zoom.
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

  if (editing) {
    // In-place text editor. The textarea is positioned and styled to match the
    // rendered caption as closely as possible so typing feels WYSIWYG. Live
    // changes go straight to the store, so the underlying renderer reflects
    // every keystroke and the box snaps to whatever the new text would occupy.
    return (
      <textarea
        ref={textareaRef}
        value={selected.captionText ?? ''}
        onChange={(e) => updateCaptionText(selected.id, e.target.value)}
        onBlur={commitEdit}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            cancelEdit()
          } else if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            commitEdit()
          }
          // All other keys (including Space) need to stay scoped to the textarea —
          // the global editor shortcuts would otherwise toggle playback etc.
          e.stopPropagation()
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        aria-label="Edit caption text"
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: textWidth,
          height: textHeight,
          // Compositor-only position update — layout doesn't re-run when the
          // caption animates between keyframes.
          transform: `translate3d(${cx - textWidth / 2}px, ${cy - textHeight / 2}px, 0)`,
          willChange: 'transform',
          fontFamily: style.fontFamily,
          fontSize,
          fontWeight: style.fontWeight ?? 700,
          fontStyle: style.fontStyle ?? 'normal',
          textTransform: style.textTransform ?? 'none',
          letterSpacing: `${style.letterSpacing ?? 0}px`,
          color: style.color,
          textAlign: 'center',
          lineHeight: style.lineHeight ?? 1.3,
          padding: '8px 24px',
          background: 'rgba(0,0,0,0.55)',
          border: `${borderWidth}px solid rgba(99,102,241,0.95)`,
          borderRadius: 12,
          outline: 'none',
          resize: 'none',
          overflow: 'hidden',
          boxSizing: 'border-box',
          zIndex: 7,
          touchAction: 'auto',
          // Override the parent's no-select; allow text-select while editing.
          userSelect: 'text',
          wordBreak: 'break-word',
        }}
      />
    )
  }

  return (
    <div
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onDoubleClick={handleDoubleClick}
      role="button"
      tabIndex={-1}
      aria-label="Drag to reposition caption"
      title="Drag to move • Double-click to edit text • Drag a corner to resize"
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: textWidth,
        height: textHeight,
        // Position via translate3d so keyframed x/y offsets stay on the
        // compositor — layout doesn't re-run when the caption animates.
        transform: `translate3d(${cx - textWidth / 2}px, ${cy - textHeight / 2}px, 0)`,
        willChange: 'transform',
        cursor: dragging ? 'grabbing' : resizing ? 'default' : 'grab',
        border: `${borderWidth}px dashed rgba(99,102,241,0.95)`,
        borderRadius: 12,
        background: dragging ? 'rgba(99,102,241,0.08)' : 'transparent',
        boxSizing: 'border-box',
        zIndex: 5,
        // touch-action: prevents the browser from interpreting drag as a scroll.
        touchAction: 'none',
        userSelect: 'none',
      }}
    >
      {/* Top-left handle — drag up-left to enlarge. */}
      <div
        onPointerDown={(e) => handleCornerPointerDown(e, -1)}
        onPointerMove={handleCornerPointerMove}
        onPointerUp={handleCornerPointerUp}
        onPointerCancel={handleCornerPointerUp}
        role="button"
        aria-label="Resize caption"
        title="Drag to resize"
        style={{
          ...cornerCommonStyle,
          left: -cornerSizePx / 2,
          top: -cornerSizePx / 2,
          cursor: 'nwse-resize',
        }}
      />
      {/* Top-right handle — drag up-right to enlarge. */}
      <div
        onPointerDown={(e) => handleCornerPointerDown(e, -1)}
        onPointerMove={handleCornerPointerMove}
        onPointerUp={handleCornerPointerUp}
        onPointerCancel={handleCornerPointerUp}
        role="button"
        aria-label="Resize caption"
        title="Drag to resize"
        style={{
          ...cornerCommonStyle,
          right: -cornerSizePx / 2,
          top: -cornerSizePx / 2,
          cursor: 'nesw-resize',
        }}
      />
      {/* Bottom-left handle — drag down-left to enlarge. */}
      <div
        onPointerDown={(e) => handleCornerPointerDown(e, 1)}
        onPointerMove={handleCornerPointerMove}
        onPointerUp={handleCornerPointerUp}
        onPointerCancel={handleCornerPointerUp}
        role="button"
        aria-label="Resize caption"
        title="Drag to resize"
        style={{
          ...cornerCommonStyle,
          left: -cornerSizePx / 2,
          bottom: -cornerSizePx / 2,
          cursor: 'nesw-resize',
        }}
      />
      {/* Bottom-right handle — drag down-right to enlarge. */}
      <div
        onPointerDown={(e) => handleCornerPointerDown(e, 1)}
        onPointerMove={handleCornerPointerMove}
        onPointerUp={handleCornerPointerUp}
        onPointerCancel={handleCornerPointerUp}
        role="button"
        aria-label="Resize caption"
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
