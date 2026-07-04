/**
 * KeyframeRibbon — per-property mini-timeline shown beneath a keyframed
 * Inspector row.
 *
 * Responsibilities:
 *   - Measures its own width so each `KeyframeMarker` can convert pointer
 *     deltas into time deltas.
 *   - Renders a diamond for each keyframe and a thin vertical playhead bar.
 *   - Owns the drag history transaction: one undo step per drag gesture.
 *   - Forwards right-click on a marker up to the parent (Phase 5 will plug
 *     the easing menu in here; v1 leaves it as a no-op).
 *
 * The ribbon does not own any state of its own — keyframe data lives in the
 * clip, selection lives in the selection store, and the playhead lives in the
 * playback store. Pointer state during drag is the one exception.
 */

import { useLayoutEffect, useRef, useState } from 'react'

import { useEditorStore } from '../../store/editor-store'
import { usePlaybackStore } from '../../store/playback-store'
import { useSelectionStore } from '../../store/selection-store'
import type { AnimatablePropertyId, Clip, KeyframeTrack } from '../../types'
import { EasingMenu } from './EasingMenu'
import { KeyframeMarker } from './KeyframeMarker'

interface EasingMenuState {
  keyframeId: string
  position: { x: number; y: number }
}

export function KeyframeRibbon({
  clip,
  propertyId,
  track,
}: {
  clip: Clip
  propertyId: AnimatablePropertyId
  track: KeyframeTrack
}) {
  const playheadPosition = usePlaybackStore((s) => s.playheadPosition)
  const moveKeyframe = useEditorStore((s) => s.moveKeyframe)
  const beginHistoryTransaction = useEditorStore((s) => s.beginHistoryTransaction)
  const commitHistoryTransaction = useEditorStore((s) => s.commitHistoryTransaction)
  const selectedKeyframes = useSelectionStore((s) => s.selectedKeyframes)
  const selectKeyframe = useSelectionStore((s) => s.selectKeyframe)
  const toggleKeyframeSelection = useSelectionStore((s) => s.toggleKeyframeSelection)

  const containerRef = useRef<HTMLDivElement>(null)
  const [ribbonWidthPx, setRibbonWidthPx] = useState(0)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [easingMenu, setEasingMenu] = useState<EasingMenuState | null>(null)

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = () => setRibbonWidthPx(el.getBoundingClientRect().width)
    update()
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(update)
      ro.observe(el)
      return () => ro.disconnect()
    }
    return undefined
  }, [])

  const clipLocalMs = Math.max(0, Math.min(clip.duration, playheadPosition - clip.startTime))
  const playheadFraction = clip.duration > 0 ? clipLocalMs / clip.duration : 0
  const playheadVisible =
    playheadPosition >= clip.startTime && playheadPosition <= clip.startTime + clip.duration

  return (
    <div className="flex items-center gap-2 mb-2 -mt-1 pl-7">
      {/* Spacer matches the label column above so markers align with the slider track. */}
      <div className="w-10 shrink-0" />
      <div
        ref={containerRef}
        className="relative flex-1 h-3.5 rounded-md min-w-0 border border-border/50 bg-gradient-to-b from-muted/30 to-muted/60 shadow-[inset_0_1px_0_0_color-mix(in_oklch,white_8%,transparent)]"
      >
        {playheadVisible && (
          <div
            className="absolute top-0 bottom-0 w-px bg-primary/85 pointer-events-none shadow-[0_0_4px_var(--primary)]"
            style={{ left: `${playheadFraction * 100}%` }}
          />
        )}
        {track.keyframes.map((kf) => {
          const fraction = clip.duration > 0 ? kf.timeMs / clip.duration : 0
          const isSelected = selectedKeyframes.some(
            (s) =>
              s.clipId === clip.id && s.propertyId === propertyId && s.keyframeId === kf.id,
          )
          return (
            <KeyframeMarker
              key={kf.id}
              positionFraction={fraction}
              easingIn={kf.easingIn}
              easingOut={kf.easingOut}
              selected={isSelected}
              dragging={draggingId === kf.id}
              ribbonWidthPx={ribbonWidthPx}
              clipDurationMs={clip.duration}
              onSelect={(additive) => {
                const ref = { clipId: clip.id, propertyId, keyframeId: kf.id }
                if (additive) {
                  toggleKeyframeSelection(ref)
                } else {
                  selectKeyframe(ref)
                }
              }}
              onDragStart={() => {
                beginHistoryTransaction('Move keyframe')
                setDraggingId(kf.id)
              }}
              onDrag={(newTimeMs) => {
                moveKeyframe(clip.id, propertyId, kf.id, newTimeMs)
              }}
              onDragEnd={() => {
                commitHistoryTransaction()
                setDraggingId(null)
              }}
              onContextMenu={(x, y) =>
                setEasingMenu({ keyframeId: kf.id, position: { x, y } })
              }
            />
          )
        })}
      </div>
      {/* Reserve the nav-button slot from KeyframedSliderRow so widths line up. */}
      <div className="w-[44px] shrink-0" />
      {easingMenu && (() => {
        // Resolve from the live track so the active marker updates as the
        // user picks easings without closing the menu.
        const liveKf = track.keyframes.find((k) => k.id === easingMenu.keyframeId)
        if (!liveKf) return null
        return (
          <EasingMenu
            clipId={clip.id}
            propertyId={propertyId}
            keyframeId={liveKf.id}
            currentIn={liveKf.easingIn}
            currentOut={liveKf.easingOut}
            position={easingMenu.position}
            onClose={() => setEasingMenu(null)}
          />
        )
      })()}
    </div>
  )
}
