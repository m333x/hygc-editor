/**
 * KeyframeMarker — a single marker on the Inspector keyframe ribbon.
 *
 * Click selects (or with shift, toggles in/out of the selection). Pointer-drag
 * moves the keyframe along the ribbon. Right-click is handled by the parent
 * ribbon (so the easing menu lives there, not duplicated per marker).
 *
 * Visual: the diamond rotation has been replaced by `KeyframeShape`, a split
 * SVG whose left half encodes `easingIn` and right half encodes `easingOut`.
 * A linear-linear keyframe still reads as a full diamond, so existing muscle
 * memory is preserved while the new shape language carries the easing info
 * directly on the marker.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import type { EasingKind } from '../../types'
import { KeyframeShape } from './keyframe-shapes'

export interface KeyframeMarkerProps {
  /** Position along the ribbon, expressed as 0..1 of the clip's duration. */
  positionFraction: number
  easingIn: EasingKind
  easingOut: EasingKind
  selected: boolean
  /** True if the keyframe is currently being dragged (suppresses transition). */
  dragging: boolean
  /**
   * Total ribbon width in pixels — needed to translate pointer dx into a time
   * delta. The ribbon measures itself and passes this in.
   */
  ribbonWidthPx: number
  /** Total clip duration in ms — converts pixel deltas back into time. */
  clipDurationMs: number
  onSelect: (additive: boolean) => void
  /**
   * Called while dragging — receives the new clip-local time (clamped).
   * The parent ribbon decides whether to dispatch a store mutation per move
   * (live preview) or only on release.
   */
  onDrag: (newTimeMs: number) => void
  onDragStart: () => void
  onDragEnd: () => void
  onContextMenu: (clientX: number, clientY: number) => void
}

const EASING_LABEL: Record<EasingKind, string> = {
  linear: 'Linear',
  easeIn: 'Ease In',
  easeOut: 'Ease Out',
  easeInOut: 'Ease In-Out',
  hold: 'Hold',
}

export function KeyframeMarker({
  positionFraction,
  easingIn,
  easingOut,
  selected,
  dragging,
  ribbonWidthPx,
  clipDurationMs,
  onSelect,
  onDrag,
  onDragStart,
  onDragEnd,
  onContextMenu,
}: KeyframeMarkerProps) {
  const [hovered, setHovered] = useState(false)

  // Stash callbacks in a ref so the pointermove listener captures the latest
  // closures without needing to re-attach the global listener every render.
  const callbacksRef = useRef({ onDrag, onDragEnd })
  useEffect(() => {
    callbacksRef.current = { onDrag, onDragEnd }
  }, [onDrag, onDragEnd])

  // Track whether the pointer actually moved during this press — purely a
  // click should select; a drag should NOT also fire a selection on release.
  const dragStateRef = useRef<{
    startClientX: number
    startTimeMs: number
    moved: boolean
  } | null>(null)

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0) return // only left click drags
      e.stopPropagation()
      const startTimeMs = positionFraction * clipDurationMs
      dragStateRef.current = {
        startClientX: e.clientX,
        startTimeMs,
        moved: false,
      }
      onDragStart()

      const pxPerMs = ribbonWidthPx > 0 && clipDurationMs > 0 ? ribbonWidthPx / clipDurationMs : 0

      function handleMove(ev: PointerEvent) {
        const state = dragStateRef.current
        if (!state || pxPerMs === 0) return
        const dxPx = ev.clientX - state.startClientX
        if (Math.abs(dxPx) > 2) state.moved = true
        const newTime = state.startTimeMs + dxPx / pxPerMs
        callbacksRef.current.onDrag(Math.max(0, Math.min(clipDurationMs, newTime)))
      }

      function handleUp(ev: PointerEvent) {
        window.removeEventListener('pointermove', handleMove)
        window.removeEventListener('pointerup', handleUp)
        window.removeEventListener('pointercancel', handleUp)
        const state = dragStateRef.current
        callbacksRef.current.onDragEnd()
        // If pointer didn't actually move, treat as a click → select.
        if (state && !state.moved) {
          onSelect(ev.shiftKey)
        }
        dragStateRef.current = null
      }

      window.addEventListener('pointermove', handleMove)
      window.addEventListener('pointerup', handleUp)
      window.addEventListener('pointercancel', handleUp)
    },
    [clipDurationMs, ribbonWidthPx, positionFraction, onDragStart, onSelect],
  )

  // Defensive cleanup if the component unmounts mid-drag.
  useEffect(() => {
    return () => {
      dragStateRef.current = null
    }
  }, [])

  function handleContextMenu(e: React.MouseEvent<HTMLButtonElement>) {
    e.preventDefault()
    e.stopPropagation()
    onContextMenu(e.clientX, e.clientY)
  }

  const tooltip = `${EASING_LABEL[easingIn]} → ${EASING_LABEL[easingOut]} — drag to move, right-click for easing`

  return (
    <button
      type="button"
      onPointerDown={handlePointerDown}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onContextMenu={handleContextMenu}
      title={tooltip}
      className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 grid place-items-center w-3 h-3 rounded-[2px] cursor-grab active:cursor-grabbing outline-none focus-visible:ring-1 focus-visible:ring-primary/60 ${
        dragging ? '' : 'transition-transform duration-100'
      } ${hovered && !dragging ? 'scale-[1.15]' : ''}`}
      style={{ left: `${positionFraction * 100}%` }}
    >
      <KeyframeShape
        easingIn={easingIn}
        easingOut={easingOut}
        selected={selected}
        hovered={hovered}
        size={11}
        variant="inspector"
      />
    </button>
  )
}
