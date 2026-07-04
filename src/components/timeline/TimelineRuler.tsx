/**
 * TimelineRuler — the time ruler displayed above the track rows.
 *
 * Renders adaptive tick marks and time labels based on the current zoom level.
 * Provides click-to-seek (click ruler → move playhead) and drag-to-scrub
 * (drag on ruler → scrub playhead in real-time) interactions.
 *
 * Key features:
 *   - Adaptive tick intervals: tick density adjusts automatically as the user
 *     zooms in/out. At low zoom a major tick every 5s; at high zoom every 0.1s.
 *     Minor ticks subdivide major ticks into 5 equal parts.
 *   - Playhead indicator: a triangular downward-pointing marker tracks the
 *     current playhead position. This marker is positioned absolutely within
 *     the ruler, so it scrolls with the timeline content.
 *   - Click-to-seek: a single click on any ruler position seeks to that time.
 *   - Drag-to-scrub: holding the pointer and dragging scrubs the playhead
 *     in real-time for rapid timeline navigation.
 *
 * Layout relationship:
 *   The ruler receives the current `scrollLeft` of the outer scroll container
 *   and renders ticks starting from 0. It does NOT handle its own scroll —
 *   it sits inside the scrollable inner container and scrolls with it.
 *
 * SOLID: SRP — only handles time ruler display and seek interactions.
 *   Playhead state is managed by the Zustand store; the ruler just calls
 *   `onSeek` to trigger state updates.
 *
 * @see README.md Section 7.3 for timeline state specification
 * @see PLAN.md Phase 3.4 "Time ruler at top with tick marks (adaptive intervals based on zoom)"
 * @see PLAN.md Phase 3.4 "Playhead line (vertical, draggable)"
 */

import { memo, useRef, useCallback, useMemo } from 'react'
import { computeRulerInterval, formatRulerTime } from './timeline-utils'
import { usePlaybackStore } from '../../store/playback-store'

// ─── Component Props ──────────────────────────────────────────────────────────

export interface TimelineRulerProps {
  /**
   * Total pixel width of the timeline content area.
   * The ruler renders tick marks up to this width.
   */
  contentWidth: number

  /**
   * Pixels per millisecond at the current zoom level.
   * Computed as: zoomLevel (px/s) / 1000
   */
  pxPerMs: number

  /**
   * Callback invoked when the user clicks or drags the ruler to seek.
   *
   * @param timeMs - New playhead position in milliseconds
   */
  onSeek: (timeMs: number) => void

  /** Current horizontal scroll offset of the timeline content. */
  scrollLeft?: number

  /** Visible width of the scroll viewport. */
  viewportWidth?: number

  /**
   * Cut points (clip start/end times in ms) to snap to while scrubbing with
   * Shift held. Should also include 0 if the timeline origin is a desired
   * snap target. Sorted order is not required — we scan linearly.
   */
  cutPoints?: number[]
}

// ─── TimelineRuler Component ──────────────────────────────────────────────────

/**
 * TimelineRuler — renders the time ruler bar with tick marks and a playhead.
 *
 * Subscribes to `playheadPosition` itself rather than receiving it as a prop:
 * the parent `Timeline` would otherwise have to re-render ~30×/sec during
 * playback just to forward the new value. Reading it locally keeps the cascade
 * contained — only the ruler's playhead indicator re-renders per frame.
 *
 * @example
 *   <TimelineRuler
 *     contentWidth={6000}
 *     pxPerMs={0.1}
 *     onSeek={(ms) => store.setPlayhead(ms)}
 *   />
 */
export const TimelineRuler = memo(function TimelineRuler({
  contentWidth,
  pxPerMs,
  onSeek,
  scrollLeft = 0,
  viewportWidth = contentWidth,
  cutPoints,
}: TimelineRulerProps) {
  const rulerRef = useRef<HTMLDivElement>(null)
  const playheadMs = usePlaybackStore((s) => s.playheadPosition)

  /** Whether a pointer drag is currently in progress on the ruler. */
  const isDraggingRef = useRef(false)

  // ── Ruler interval computation ──

  /**
   * Convert pxPerMs back to zoomLevel (px/s) for the interval computation.
   * `computeRulerInterval` expects pixels-per-second.
   */
  const zoomLevel = pxPerMs * 1000
  const { major: majorIntervalSec, minor: minorIntervalSec } = computeRulerInterval(zoomLevel)

  /** Total composition duration covered by the ruler (in seconds). */
  const totalSec = contentWidth / zoomLevel

  // ── Tick generation ──

  /**
   * Generate tick positions for the ruler.
   *
   * We generate ticks up to `totalSec`. For performance, we skip rendering
   * ticks that would be at < 1px apart (degenerate case at extreme zoom).
   *
   * Returns two arrays: major ticks (with labels) and minor ticks (no labels).
   */
  const { majorTicks, minorTicks } = useMemo(() => {
    const major: number[] = []
    const minor: number[] = []

    if (majorIntervalSec <= 0) return { majorTicks: major, minorTicks: minor }

    const startSec = Math.max(0, scrollLeft / zoomLevel - majorIntervalSec * 2)
    const endSec = Math.min(
      totalSec,
      (scrollLeft + viewportWidth) / zoomLevel + majorIntervalSec * 2,
    )
    const firstMajor = Math.floor(startSec / majorIntervalSec) * majorIntervalSec
    for (let s = firstMajor; s <= endSec + majorIntervalSec / 2; s += majorIntervalSec) {
      if (s >= 0) major.push(s)
    }

    if (minorIntervalSec > 0) {
      const firstMinor = Math.floor(startSec / minorIntervalSec) * minorIntervalSec
      for (let s = firstMinor; s <= endSec + minorIntervalSec / 2; s += minorIntervalSec) {
        const isMajor = Math.abs(s % majorIntervalSec) < minorIntervalSec * 0.01
        if (s >= 0 && !isMajor) minor.push(s)
      }
    }

    return { majorTicks: major, minorTicks: minor }
  }, [majorIntervalSec, minorIntervalSec, scrollLeft, totalSec, viewportWidth, zoomLevel])

  // ── Seek interaction ──

  /**
   * Convert a pointer event's clientX to a timeline position in milliseconds.
   * Accounts for the ruler element's left position in the viewport.
   */
  const clientXToMs = useCallback(
    (clientX: number): number => {
      const rect = rulerRef.current?.getBoundingClientRect()
      if (!rect) return 0
      const x = clientX - rect.left
      return Math.max(0, x / pxPerMs)
    },
    [pxPerMs],
  )

  /**
   * Snap a time to the nearest cut point. Holding Shift while scrubbing
   * activates this — there's no distance threshold because the user has
   * explicitly opted in, so we always jump to the closest cut. Includes 0
   * implicitly so the very start of the timeline is always snappable.
   */
  const snapToNearestCut = useCallback(
    (timeMs: number): number => {
      if (!cutPoints || cutPoints.length === 0) return Math.max(0, timeMs)
      let nearest = 0
      let nearestDist = timeMs
      for (const p of cutPoints) {
        const d = Math.abs(timeMs - p)
        if (d < nearestDist) {
          nearestDist = d
          nearest = p
        }
      }
      return nearest
    },
    [cutPoints],
  )

  const resolveSeekMs = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): number => {
      const raw = clientXToMs(e.clientX)
      return e.shiftKey ? snapToNearestCut(raw) : raw
    },
    [clientXToMs, snapToNearestCut],
  )

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault()
    isDraggingRef.current = true
    ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
    onSeek(resolveSeekMs(e))
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!isDraggingRef.current) return
    onSeek(resolveSeekMs(e))
  }

  function handlePointerUp() {
    isDraggingRef.current = false
  }

  // ── Playhead indicator ──

  const playheadLeft = playheadMs * pxPerMs

  return (
    <div
      ref={rulerRef}
      className="relative h-full cursor-col-resize select-none"
      style={{ width: contentWidth }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      aria-label="Timeline ruler — click to seek"
      role="slider"
      aria-valuenow={Math.round(playheadMs)}
      aria-valuemin={0}
      aria-valuemax={Math.round(totalSec * 1000)}
    >
      {/* ── Background ── */}
      <div className="absolute inset-0 bg-editor-chrome-soft" />

      {/* ── Minor tick marks ── */}
      {minorTicks.map((s) => (
        <div
          key={`minor-${s}`}
          className="absolute bottom-0 w-px bg-editor-on-chrome-muted/40 pointer-events-none"
          style={{
            left: s * zoomLevel,
            height: '30%',
          }}
          aria-hidden
        />
      ))}

      {/* ── Major tick marks + labels ── */}
      {majorTicks.map((s) => (
        <div
          key={`major-${s}`}
          className="absolute bottom-0 flex flex-col items-start pointer-events-none"
          style={{ left: s * zoomLevel }}
          aria-hidden
        >
          {/* Tick line */}
          <div
            className="absolute bottom-0 w-px bg-editor-on-chrome/40"
            style={{ height: '60%' }}
          />
          {/* Time label (slightly above the tick) */}
          {s > 0 && (
            <span
              className="absolute bottom-full mb-0.5 text-[9px] leading-none text-editor-on-chrome-muted tabular-nums whitespace-nowrap pl-0.5"
              style={{ transform: 'translateX(-50%)' }}
            >
              {formatRulerTime(s)}
            </span>
          )}
        </div>
      ))}

      {/* ── Playhead triangle indicator ──
          Color: `--ring` (cyan-teal) so playhead, selection ring, and input
          focus all speak one "current focus" language. Previously used
          `hsl(var(--primary))` — silently invalid because `--primary` is
          declared as an OKLCH color, not HSL components. */}
      <div
        className="absolute top-0 bottom-0 pointer-events-none text-ring"
        style={{ left: playheadLeft, transform: 'translateX(-50%)' }}
        aria-hidden
      >
        {/* Triangle pointing down — marks the playhead position */}
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          className="absolute top-0 -translate-x-1/2 translate-y-0"
          fill="currentColor"
        >
          <path d="M5 0L10 10H0L5 0Z" transform="scale(1,-1) translate(0,-10)" />
        </svg>
        {/* Vertical playhead line extending into the ruler */}
        <div className="absolute top-0 bottom-0 w-px bg-ring/70" />
      </div>
    </div>
  )
})
