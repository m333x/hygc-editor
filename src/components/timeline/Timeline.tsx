/**
 * Timeline — top-level scrollable timeline shell.
 *
 * Responsibilities:
 *   - Outer dark NLE rail and overflow container
 *   - Sticky ruler row at the top, with Ctrl/Cmd + wheel zoom and pointer-aware
 *     centering
 *   - Viewport bookkeeping (scroll/clientWidth tracked in state so children get
 *     a visible-range window for clip culling)
 *   - Slice-tool mouse-tracking preview line
 *   - Add-track row at the bottom
 *
 * Track DnD + the per-track rows live in {@link TimelineTrackList}. The vertical
 * playhead line + its auto-scroll-into-view behaviour live in
 * {@link TimelinePlayhead}. Each clip's interactive surface lives in
 * {@link TimelineClip}.
 *
 * Layout (top to bottom):
 *   - Outer rail (`bg-editor-chrome`) sets the dark NLE chrome in both themes
 *   - A single `overflow-auto` scroll container drives BOTH ruler and rows
 *     (sticky top keeps the ruler visible; sticky left keeps the track headers
 *     visible). No scroll synchronization needed because everything shares the
 *     same scroll context.
 *   - Inside that, an `isolate` content wrapper sized to the full content width
 *     hosts the ruler row, track list, add-track row, playhead, and slice
 *     preview line. `isolate` forces a stacking context so the playhead's
 *     z-index resolves above clips painted later in DOM order.
 *
 * SOLID: SRP — orchestrates timeline layout only. DnD, per-track rendering,
 *   and clip interactions live in dedicated child components.
 */

import { useRef, useEffect, useCallback, useMemo, useState } from 'react'

import { useEditorStore } from '../../store/editor-store'
import { useUIStore } from '../../store/ui-store'
import { usePlaybackStore } from '../../store/playback-store'
import { useSelectionStore } from '../../store/selection-store'
import { useAssetUrlMap } from '../../hooks/useAssetUrlMap'
import { TimelineRuler } from './TimelineRuler'
import { AddTrackDropdown } from './AddTrackDropdown'
import { TimelinePlayhead } from './TimelinePlayhead'
import { TimelineTrackList } from './TimelineTrackList'
import {
  collectClipIdsByDirection,
  computeFitZoomLevel,
  computeTimelineContentWidth,
  RULER_HEIGHT,
  TRACK_HEADER_WIDTH,
} from './timeline-utils'
import { getSnapPoints } from '../../engine/composition-utils'

/**
 * Threshold (in pixels) the pointer must travel before a press starts a
 * marquee selection. Below this, the press is treated as a click — letting the
 * existing per-track empty-area deselect logic still fire.
 */
const MARQUEE_ACTIVATION_PX = 4

/**
 * Timeline — the full interactive multi-track NLE timeline.
 *
 * Reads all state from the Zustand editor/playback/UI stores. No props.
 * Mount this inside a container with a defined height.
 *
 * @example
 *   <div className="h-[400px]">
 *     <Timeline />
 *   </div>
 */
export function Timeline() {
  // ── Store state ──

  const tracks = useEditorStore((s) => s.tracks)
  const composition = useEditorStore((s) => s.composition)
  const addTrack = useEditorStore((s) => s.addTrack)
  const { assetUrlMap } = useAssetUrlMap(tracks)
  // Note: we deliberately do NOT subscribe to `playheadPosition` here. The
  // ruler and the vertical playhead line both subscribe to it directly, so
  // keeping the subscription out of this parent avoids re-rendering the entire
  // timeline tree ~30×/sec during playback. For one-shot reads (slice tool,
  // keyboard shortcuts) we use `usePlaybackStore.getState()` below.
  const setPlayhead = usePlaybackStore((s) => s.setPlayhead)
  const zoomLevel = useUIStore((s) => s.zoomLevel)
  const setZoomLevel = useUIStore((s) => s.setZoomLevel)
  const activeToolMode = useUIStore((s) => s.activeToolMode)
  const setTimelineViewportWidth = useUIStore((s) => s.setTimelineViewportWidth)
  const fitTimelineRequestId = useUIStore((s) => s.fitTimelineRequestId)

  // ── Derived values ──

  /**
   * Pixels per millisecond at the current zoom level.
   * `zoomLevel` is in pixels/second, so divide by 1000 for px/ms.
   */
  const pxPerMs = zoomLevel / 1000

  /** Total pixel width of the scrollable content area. */
  const contentWidth = useMemo(
    () => computeTimelineContentWidth(tracks, composition.durationMs, zoomLevel),
    [tracks, composition.durationMs, zoomLevel],
  )

  /**
   * Cut points across all tracks (clip start/end times in ms) — used by the
   * ruler for shift-snap scrubbing. Sorted, deduped, and includes the timeline
   * origin so users can always snap back to 0.
   */
  const cutPoints = useMemo(() => [0, ...getSnapPoints(tracks)], [tracks])

  // ── Refs ──

  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const contentWrapperRef = useRef<HTMLDivElement>(null)
  const scrollRafRef = useRef<number | null>(null)

  /**
   * Set to true by zoom sources that already anchor scroll themselves
   * (wheel = pointer anchor, Fit View = scrollLeft 0). The playhead-anchor
   * effect below reads and resets the flag, so any *other* zoom source (the
   * header chrome's slider/buttons, the keyboard +/- shortcuts) automatically
   * re-anchors scrollLeft to keep the playhead pinned to its current screen X.
   */
  const skipPlayheadZoomAnchorRef = useRef(false)

  /**
   * Tracks the previous pxPerMs so the playhead-anchor effect can do the
   * "where was the playhead on screen before this zoom change?" math without
   * needing the old value from a prop or capturing it in a closure.
   */
  const prevPxPerMsRef = useRef(0)

  // ── Marquee selection state ──────────────────────────────────────────────
  //
  // Drag-from-empty-area selection. The press starts a tentative drag; once
  // the pointer travels past MARQUEE_ACTIVATION_PX, we lock in marquee mode,
  // paint the rectangle, and continuously recompute the selected clip set by
  // hit-testing against every `[data-clip-id]` element in the DOM. Below the
  // threshold the press falls through to the empty-area click handler so the
  // existing "click to deselect" behaviour is preserved.

  const setSelection = useSelectionStore((s) => s.setSelection)

  /** Live drag info; null when no marquee is in progress. */
  const marqueeDragRef = useRef<{
    startClientX: number
    startClientY: number
    additiveBase: ReadonlySet<string>
    active: boolean
    pointerId: number
    rafId: number | null
    pendingClientX: number
    pendingClientY: number
  } | null>(null)

  /** The visible rectangle in content-wrapper-local coords; null when inactive. */
  const [marqueeRect, setMarqueeRect] = useState<
    | {
        left: number
        top: number
        width: number
        height: number
      }
    | null
  >(null)

  /**
   * Set briefly after a marquee ends so the trailing click event (synthesized
   * from the pointerdown/up pair) doesn't run TrackContent's "click empty area
   * to deselect" path and wipe the freshly-painted selection.
   */
  const suppressNextClickRef = useRef(false)

  /** In slice mode: X position (px) of the slice preview line in content coordinates, or null. */
  const [slicePreviewLeft, setSlicePreviewLeft] = useState<number | null>(null)
  const [viewport, setViewport] = useState({
    scrollLeft: 0,
    scrollTop: 0,
    clientWidth: 0,
    clientHeight: 0,
  })

  const visibleStartMs = Math.max(0, (viewport.scrollLeft / pxPerMs) - 2_000)
  const visibleEndMs =
    ((viewport.scrollLeft + Math.max(0, viewport.clientWidth - TRACK_HEADER_WIDTH)) / pxPerMs) +
    2_000

  const renderedSlicePreviewLeft = activeToolMode === 'slice' ? slicePreviewLeft : null

  /** In slice mode, track mouse X over the timeline to show where the cut would occur. */
  const handleTimelineMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (activeToolMode !== 'slice') return
      const wrapper = contentWrapperRef.current
      if (!wrapper) return
      const rect = wrapper.getBoundingClientRect()
      const scrollLeft = scrollContainerRef.current?.scrollLeft ?? 0
      const x = e.clientX - rect.left + scrollLeft
      const clamped = Math.max(TRACK_HEADER_WIDTH, Math.min(contentWidth, x))
      setSlicePreviewLeft(clamped)
    },
    [activeToolMode, contentWidth],
  )

  const handleTimelineMouseLeave = useCallback(() => {
    setSlicePreviewLeft(null)
  }, [])

  // ── Mouse wheel zoom ──

  /**
   * Ctrl+Wheel (or Cmd+Wheel on macOS) adjusts zoom level. Normal wheel scroll
   * is handled by the browser (scrolls the container).
   *
   * Zoom is centered on the pointer: after zooming, the timeline position under
   * the pointer stays at the same screen position. Done by capturing the time
   * under the pointer before zoom, then re-scrolling after to keep it pinned.
   *
   * Attached via a native `addEventListener('wheel', …, { passive: false })`
   * because React registers `onWheel` as a passive listener — `preventDefault`
   * inside a passive listener is silently rejected and spams the console.
   */
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return

    const handler = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()

      const containerRect = container.getBoundingClientRect()
      const pointerX = e.clientX - containerRect.left - TRACK_HEADER_WIDTH
      const scrollLeft = container.scrollLeft
      const timeAtPointer = (pointerX + scrollLeft) / pxPerMs

      const zoomDelta = e.deltaY > 0 ? 0.85 : 1 / 0.85
      const newZoom = Math.max(10, Math.min(500, zoomLevel * zoomDelta))
      // Wheel zoom does its own pointer-anchor in the rAF below — tell the
      // playhead-anchor effect to stand down so the two don't fight.
      skipPlayheadZoomAnchorRef.current = true
      setZoomLevel(newZoom)

      const newPxPerMs = newZoom / 1000
      const newScrollLeft = timeAtPointer * newPxPerMs - pointerX
      requestAnimationFrame(() => {
        container.scrollLeft = Math.max(0, newScrollLeft)
      })
    }

    container.addEventListener('wheel', handler, { passive: false })
    return () => container.removeEventListener('wheel', handler)
  }, [zoomLevel, pxPerMs, setZoomLevel])

  // ── Playhead-anchored zoom ──
  //
  // When zoom changes from a source that *doesn't* anchor scroll itself
  // (the header chrome slider, the +/- buttons, the keyboard shortcuts),
  // pin the playhead to its current on-screen X so the user feels like
  // they're zooming "around" the playhead rather than around scrollLeft=0.
  //
  // Wheel zoom and Fit View opt out by setting `skipPlayheadZoomAnchorRef`
  // before calling setZoomLevel — they manage scroll themselves.
  useEffect(() => {
    const prevPxPerMs = prevPxPerMsRef.current
    prevPxPerMsRef.current = pxPerMs
    if (prevPxPerMs === 0 || prevPxPerMs === pxPerMs) return
    if (skipPlayheadZoomAnchorRef.current) {
      skipPlayheadZoomAnchorRef.current = false
      return
    }
    const container = scrollContainerRef.current
    if (!container) return
    const playheadMs = usePlaybackStore.getState().playheadPosition
    // playhead's screen X within the scroll content (relative to its left edge)
    const playheadScreenX = playheadMs * prevPxPerMs - container.scrollLeft
    // hold that screen X constant by solving for the new scrollLeft
    const newScrollLeft = playheadMs * pxPerMs - playheadScreenX
    container.scrollLeft = Math.max(0, newScrollLeft)
  }, [pxPerMs])

  const handleScroll = useCallback(() => {
    if (scrollRafRef.current !== null) return
    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = null
      const container = scrollContainerRef.current
      if (!container) return
      const next = {
        scrollLeft: container.scrollLeft,
        scrollTop: container.scrollTop,
        clientWidth: container.clientWidth,
        clientHeight: container.clientHeight,
      }
      setViewport((prev) =>
        prev.scrollLeft === next.scrollLeft &&
        prev.scrollTop === next.scrollTop &&
        prev.clientWidth === next.clientWidth &&
        prev.clientHeight === next.clientHeight
          ? prev
          : next,
      )
    })
  }, [])

  useEffect(() => {
    handleScroll()
    return () => {
      if (scrollRafRef.current !== null) {
        window.cancelAnimationFrame(scrollRafRef.current)
        scrollRafRef.current = null
      }
    }
  }, [handleScroll, contentWidth])

  // The scroll container doesn't fire `scroll` on resize, so a ResizeObserver
  // is needed to keep `viewport.clientWidth` current when the timeline panel is
  // resized via the splitter. Without this, Fit View / `\` would compute zoom
  // against a stale width after any panel resize.
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return
    const observer = new ResizeObserver(() => handleScroll())
    observer.observe(container)
    return () => observer.disconnect()
  }, [handleScroll])

  // Mirror the measured viewport width into the UI store so the Fit View button
  // and `\` shortcut can compute a real fit zoom without holding a ref to this
  // component.
  useEffect(() => {
    if (viewport.clientWidth > 0) {
      setTimelineViewportWidth(viewport.clientWidth)
    }
  }, [viewport.clientWidth, setTimelineViewportWidth])

  // React to a Fit-to-window request from the toolbar / shortcut. Skip the
  // initial id of 0 — the store boots at 0 and we only want to fit on an
  // explicit user action.
  useEffect(() => {
    if (fitTimelineRequestId === 0) return
    const width = viewport.clientWidth
    if (width <= 0) return
    const nextZoom = computeFitZoomLevel(tracks, composition.durationMs, width)
    // Fit View resets scroll to 0 explicitly below; suppress the playhead
    // anchor for this zoom change so it doesn't immediately scroll back to
    // the playhead and undo the reset.
    skipPlayheadZoomAnchorRef.current = true
    setZoomLevel(nextZoom)
    // Reset scroll so the fitted content actually starts at the left edge —
    // fitting to width is pointless if the viewport is scrolled past the start.
    const container = scrollContainerRef.current
    if (container) {
      container.scrollLeft = 0
    }
    // Deps intentionally narrow to `fitTimelineRequestId` so the effect runs
    // once per request, not on every tracks/zoom change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitTimelineRequestId])

  // ── Marquee selection handlers ───────────────────────────────────────────

  /**
   * Hit-test every clip in the DOM against the marquee rectangle in client
   * coords. Returns the set of clip ids that overlap the rectangle. We use
   * `getBoundingClientRect()` for both sides so the math doesn't depend on
   * scroll offsets or zoom factors — whatever the user can see on screen is
   * what the rectangle catches.
   */
  const hitTestMarquee = useCallback(
    (clientLeft: number, clientTop: number, clientRight: number, clientBottom: number) => {
      const ids: string[] = []
      const wrapper = contentWrapperRef.current
      if (!wrapper) return ids
      // Scope the query to the timeline so unrelated `data-clip-id` usages
      // elsewhere in the app don't bleed in.
      const clipEls = wrapper.querySelectorAll<HTMLElement>('[data-clip-id]')
      for (const el of clipEls) {
        const id = el.dataset.clipId
        if (!id) continue
        const r = el.getBoundingClientRect()
        if (
          r.right < clientLeft ||
          r.left > clientRight ||
          r.bottom < clientTop ||
          r.top > clientBottom
        ) {
          continue
        }
        ids.push(id)
      }
      return ids
    },
    [],
  )

  /**
   * Recompute the marquee rectangle from a live pointer position and apply
   * the resulting selection. RAF-throttled so a fast drag doesn't fire a
   * setState per pixel — we coalesce updates onto the animation frame.
   */
  const runMarqueeFrame = useCallback(() => {
    const drag = marqueeDragRef.current
    if (!drag || !drag.active) return
    drag.rafId = null

    const wrapper = contentWrapperRef.current
    if (!wrapper) return
    const wrapperRect = wrapper.getBoundingClientRect()

    const clientLeft = Math.min(drag.startClientX, drag.pendingClientX)
    const clientTop = Math.min(drag.startClientY, drag.pendingClientY)
    const clientRight = Math.max(drag.startClientX, drag.pendingClientX)
    const clientBottom = Math.max(drag.startClientY, drag.pendingClientY)

    setMarqueeRect({
      left: clientLeft - wrapperRect.left,
      top: clientTop - wrapperRect.top,
      width: clientRight - clientLeft,
      height: clientBottom - clientTop,
    })

    const hits = hitTestMarquee(clientLeft, clientTop, clientRight, clientBottom)
    if (drag.additiveBase.size === 0) {
      setSelection(hits)
    } else {
      const union = new Set(drag.additiveBase)
      for (const id of hits) union.add(id)
      setSelection([...union])
    }
  }, [hitTestMarquee, setSelection])

  const handleMarqueePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Right/middle clicks shouldn't start a marquee or trigger track-select.
      if (e.button !== 0) return
      const target = e.target as HTMLElement

      // Track Select Forward / Backward: clicking anywhere in the timeline
      // content sweeps every (unlocked) track on the chosen side of the
      // cursor into the selection. Clip and lane clicks are already handled
      // by TimelineClip and TrackContent respectively; this wrapper-level
      // path catches the empty areas they don't cover — section separators
      // between video and audio tracks, and the spacer next to "Add Track".
      // Tool stays active after the click so the user can keep re-sweeping
      // until they switch tools.
      if (
        activeToolMode === 'track-select-forward' ||
        activeToolMode === 'track-select-backward'
      ) {
        if (target.closest('[data-clip-id]')) return
        if (target.closest('[data-track-content-id]')) return

        const wrapper = contentWrapperRef.current
        if (!wrapper) return
        const wrapperRect = wrapper.getBoundingClientRect()
        const contentY = e.clientY - wrapperRect.top
        // Don't trigger from clicks in the ruler row.
        if (contentY < RULER_HEIGHT) return
        const timelineX = e.clientX - wrapperRect.left - TRACK_HEADER_WIDTH
        // Clicked in the sticky header column — leave it to header buttons.
        if (timelineX < 0) return

        const timeMs = Math.max(0, timelineX / pxPerMs)
        const direction =
          activeToolMode === 'track-select-forward' ? 'forward' : 'backward'
        const ids = collectClipIdsByDirection(
          useEditorStore.getState().tracks,
          timeMs,
          direction,
        )
        useSelectionStore.getState().setSelection(ids)
        return
      }

      if (activeToolMode !== 'select') return
      // Press on a clip, ruler, or track header → not an empty-area press.
      if (target.closest('[data-clip-id]')) return
      if (target.closest('[data-keyframe-graph-clip-id]')) return
      if (target.closest('[data-clip-drag-ghost]')) return

      const wrapper = contentWrapperRef.current
      const container = scrollContainerRef.current
      if (!wrapper || !container) return

      const wrapperRect = wrapper.getBoundingClientRect()
      const contentX = e.clientX - wrapperRect.left
      const contentY = e.clientY - wrapperRect.top
      // Skip presses in the sticky track-header column and ruler row — those
      // are reserved for header/scrub interactions.
      if (contentX < TRACK_HEADER_WIDTH) return
      if (contentY < RULER_HEIGHT) return

      const base: ReadonlySet<string> = e.shiftKey
        ? new Set(useSelectionStore.getState().selectedClipIds)
        : new Set()

      marqueeDragRef.current = {
        startClientX: e.clientX,
        startClientY: e.clientY,
        additiveBase: base,
        active: false,
        pointerId: e.pointerId,
        rafId: null,
        pendingClientX: e.clientX,
        pendingClientY: e.clientY,
      }
    },
    [activeToolMode, pxPerMs],
  )

  const handleMarqueePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = marqueeDragRef.current
      if (!drag) return

      drag.pendingClientX = e.clientX
      drag.pendingClientY = e.clientY

      if (!drag.active) {
        const dx = e.clientX - drag.startClientX
        const dy = e.clientY - drag.startClientY
        if (Math.hypot(dx, dy) < MARQUEE_ACTIVATION_PX) return
        drag.active = true
        // Once we're past the threshold this is a marquee, not a click.
        // Capture the pointer so the user can drag outside the wrapper
        // (e.g. past the bottom of the last track) without losing the drag.
        try {
          contentWrapperRef.current?.setPointerCapture(drag.pointerId)
        } catch {
          // Some browsers throw if the pointer has already been released.
        }
        // If the user shift-pressed without first clicking on a clip, the
        // additiveBase is whatever was already selected; otherwise we wipe
        // the slate before the marquee accumulates new ids.
        if (drag.additiveBase.size === 0) {
          setSelection([])
        }
      }

      if (drag.rafId === null) {
        drag.rafId = window.requestAnimationFrame(runMarqueeFrame)
      }
    },
    [runMarqueeFrame, setSelection],
  )

  const endMarquee = useCallback(() => {
    const drag = marqueeDragRef.current
    marqueeDragRef.current = null
    if (drag?.rafId !== null && drag?.rafId !== undefined) {
      window.cancelAnimationFrame(drag.rafId)
    }
    if (drag?.active) {
      try {
        contentWrapperRef.current?.releasePointerCapture(drag.pointerId)
      } catch {
        // Pointer may already be released.
      }
      // A click event always follows the pointerdown/up pair on the common
      // ancestor; swallow that one click so TrackContent's "empty-area click
      // = deselect" path doesn't wipe what the marquee just painted.
      suppressNextClickRef.current = true
    }
    setMarqueeRect(null)
  }, [])

  const handleWrapperClickCapture = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!suppressNextClickRef.current) return
    suppressNextClickRef.current = false
    e.stopPropagation()
  }, [])

  const handleMarqueePointerUp = useCallback(() => {
    endMarquee()
  }, [endMarquee])

  // ── Render ──

  return (
    // Timeline rail is dark in both light + dark themes (`--editor-chrome`)
    // so it reads as an NLE rail, not a settings panel. See globals.css.
    <div className="flex flex-col h-full bg-editor-chrome text-editor-on-chrome overflow-hidden">
      {/*
       * Single scrollable container holds both the ruler and the track rows.
       * Sticky positioning (top for the ruler, left for track headers) keeps
       * the right things visible without scroll synchronization.
       *
       * Ctrl/Cmd+wheel zoom is attached via a non-passive native listener in
       * the effect above; React's onWheel can't preventDefault.
       */}
      <div
        ref={scrollContainerRef}
        className={`flex-1 overflow-auto ${
          activeToolMode === 'track-select-forward'
            ? 'cursor-e-resize'
            : activeToolMode === 'track-select-backward'
              ? 'cursor-w-resize'
              : ''
        }`}
        onScroll={handleScroll}
        aria-label="Timeline — scroll horizontally to see more, Ctrl+Scroll to zoom"
      >
        {/*
         * Inner container sized to full content width. `relative` + `isolate`
         * is required so the absolutely-positioned playhead resolves its
         * z-index in the same stacking context as the clips below it.
         */}
        <div
          ref={contentWrapperRef}
          className="relative isolate min-w-full"
          style={{ width: Math.max(contentWidth, 0) }}
          onMouseMove={handleTimelineMouseMove}
          onMouseLeave={handleTimelineMouseLeave}
          onPointerDown={handleMarqueePointerDown}
          onPointerMove={handleMarqueePointerMove}
          onPointerUp={handleMarqueePointerUp}
          onPointerCancel={endMarquee}
          onClickCapture={handleWrapperClickCapture}
        >
          {/* ── Ruler row ── */}
          <div
            className="flex"
            style={{ position: 'sticky', top: 0, zIndex: 30, height: RULER_HEIGHT }}
          >
            {/* Corner cell: sticky on both axes so the dividing line under
                the ruler doesn't drift during horizontal scroll. */}
            <div
              className="bg-editor-chrome-soft border-r border-b border-editor-border"
              style={{
                width: TRACK_HEADER_WIDTH,
                flexShrink: 0,
                position: 'sticky',
                left: 0,
                zIndex: 40,
              }}
            />
            <div
              className="flex-1 overflow-hidden border-b border-editor-border"
              style={{ height: RULER_HEIGHT }}
            >
              <TimelineRuler
                contentWidth={Math.max(contentWidth - TRACK_HEADER_WIDTH, 0)}
                pxPerMs={pxPerMs}
                onSeek={setPlayhead}
                scrollLeft={viewport.scrollLeft}
                viewportWidth={Math.max(0, viewport.clientWidth - TRACK_HEADER_WIDTH)}
                cutPoints={cutPoints}
              />
            </div>
          </div>

          {/* ── Track rows + DnD ── */}
          <TimelineTrackList
            contentWidth={contentWidth - TRACK_HEADER_WIDTH}
            pxPerMs={pxPerMs}
            visibleStartMs={visibleStartMs}
            visibleEndMs={visibleEndMs}
            assetUrlMap={assetUrlMap}
          />

          {/* ── Add Track row ── */}
          <div className="flex" style={{ minHeight: 36 }}>
            <div
              className="bg-editor-chrome-soft border-r border-t border-editor-border flex items-center"
              style={{
                width: TRACK_HEADER_WIDTH,
                flexShrink: 0,
                position: 'sticky',
                left: 0,
                zIndex: 34,
              }}
            >
              <AddTrackDropdown onAddTrack={addTrack} />
            </div>
            <div className="flex-1 border-t border-editor-border" />
          </div>

          {/* ── Playhead vertical line + auto-scroll ── */}
          <TimelinePlayhead pxPerMs={pxPerMs} scrollContainerRef={scrollContainerRef} />

          {/* ── Slice preview line (slice tool only) ──
              Styled distinctly from the playhead (red) and only visible while
              the slice tool is active. */}
          {renderedSlicePreviewLeft !== null && (
            <div
              className="absolute top-0 bottom-0 pointer-events-none bg-destructive"
              style={{ left: renderedSlicePreviewLeft, width: 2, zIndex: 35 }}
              aria-hidden
            />
          )}

          {/* ── Marquee selection rectangle ──
              Rendered in content-wrapper-local coords so it tracks naturally
              with horizontal scroll. pointer-events-none lets pointer events
              keep flowing to the underlying wrapper handlers. */}
          {marqueeRect && (
            <div
              className="absolute pointer-events-none border border-primary/70 bg-primary/15"
              style={{
                left: marqueeRect.left,
                top: marqueeRect.top,
                width: marqueeRect.width,
                height: marqueeRect.height,
                zIndex: 36,
              }}
              aria-hidden
            />
          )}
        </div>
      </div>
    </div>
  )
}
