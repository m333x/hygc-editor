/**
 * TimelinePlayhead — the vertical playhead line inside the timeline content area.
 *
 * Two responsibilities, both narrow:
 *   1. Render an absolutely-positioned 1px vertical bar at the current playhead
 *      X (`var(--ring)` so it matches the rest of the editor's focus language).
 *   2. While the composition is playing, scroll the timeline horizontally to
 *      keep the playhead visible — when it crosses 80% of the visible width,
 *      jump back to 30%. Standard NLE "follow the playhead" behaviour.
 *
 * Lives as its own component (not inline in `Timeline.tsx`) so the auto-scroll
 * effect can subscribe to `isPlaying` from `usePlaybackStore` directly without
 * forcing the whole Timeline tree to re-render on play/pause toggles.
 */

import { useEffect } from 'react'

import { usePlaybackStore } from '../../store/playback-store'
import { RULER_HEIGHT, TRACK_HEADER_WIDTH } from './timeline-utils'

interface TimelinePlayheadProps {
  /** Pixels per millisecond at the current zoom level. */
  pxPerMs: number
  /** Ref to the outer scrollable container — used to drive auto-scroll. */
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
}

export function TimelinePlayhead({ pxPerMs, scrollContainerRef }: TimelinePlayheadProps) {
  // Subscribe locally so the parent `Timeline` doesn't have to re-render
  // ~30×/sec during playback purely to forward `playheadLeft` down to us.
  const playheadMs = usePlaybackStore((s) => s.playheadPosition)
  const isPlaying = usePlaybackStore((s) => s.isPlaying)
  const playheadLeft = playheadMs * pxPerMs

  useEffect(() => {
    if (!isPlaying || !scrollContainerRef.current) return

    const container = scrollContainerRef.current
    const containerWidth = container.clientWidth - TRACK_HEADER_WIDTH
    const scrollLeft = container.scrollLeft
    const playheadVisible = playheadLeft - scrollLeft

    if (playheadVisible > containerWidth * 0.8) {
      container.scrollLeft = playheadLeft - containerWidth * 0.3
    }
  }, [playheadLeft, isPlaying, scrollContainerRef])

  return (
    <div
      className="absolute bottom-0 pointer-events-none bg-ring"
      style={{
        top: RULER_HEIGHT,
        left: TRACK_HEADER_WIDTH + playheadLeft,
        width: 1,
        zIndex: 32,
      }}
      aria-hidden
    />
  )
}
