/**
 * ClipKeyframeGraph — advanced keyframe editing panel anchored beneath a clip
 * on the timeline.
 *
 * Renders one stacked sub-row per keyframed property on the clip, with an SVG
 * curve sampled from the actual interpolator (so what the user sees is what
 * Remotion plays back), draggable diamond markers that move along BOTH axes
 * (time × value), a synced playhead line, and a Add-property menu for putting
 * a new transform property under animation directly from the graph.
 *
 * Coordinate system:
 *   The graph component is positioned at `left: clip.startTime * pxPerMs` with
 *   `width: clip.duration * pxPerMs` by its parent (`TrackContent`). That means
 *   the X axis is *literally* the clip's time range — the playhead, every
 *   diamond, the ruler ticks above, and the clip body all share one pixel
 *   coordinate. This is the thing that makes the graph read as a cross-section
 *   of the clip in time rather than a detached graph viewer.
 *
 * Y axis:
 *   Auto-fits per property to the value range present on its keyframes, plus
 *   15% headroom and always including the property's default value so the
 *   neutral guideline (scale=1, opacity=1, …) is always on-screen.
 *
 * Interactions:
 *   - Drag a diamond on X = retime (clamped to clip duration).
 *   - Drag on Y = revalue (clamped to the property's registered min/max).
 *   - Shift-drag locks to the dominant axis (X or Y).
 *   - Click a diamond = select (Shift toggles multi-select). Mirrors the
 *     Inspector ribbon's selection store, so selecting in either place
 *     highlights both.
 *   - Right-click a diamond = the existing EasingMenu (no rework).
 *   - Double-click empty area of a sub-row = insert a keyframe at that
 *     time/value via `setPropertyAtPlayhead` (which upserts by time).
 *
 * Selection store coupling:
 *   The graph reads and writes the same `selectionStore.selectedKeyframes` as
 *   the Inspector. Keyframes selected on the timeline can be deleted with the
 *   global Delete shortcut already wired in `useEditorKeyboard`.
 *
 * SOLID: SRP — this file owns graph rendering + per-diamond interaction. All
 *   keyframe mutations go through the editor store; the component does not
 *   reach into clip data itself.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Plus, X } from 'lucide-react'

import { useEditorStore } from '../../store/editor-store'
import { usePlaybackStore } from '../../store/playback-store'
import { useSelectionStore } from '../../store/selection-store'
import { useUIStore } from '../../store/ui-store'
import {
  ANIMATABLE_PROPERTIES,
  getAnimatableProperty,
  getAnimatablePropertiesForTrackType,
} from '../../engine/animatable-properties'
import { resolveKeyframedValue } from '../../engine/keyframe-interpolator'
import type {
  AnimatablePropertyId,
  Clip,
  Keyframe,
  KeyframeTrack,
  Track,
} from '../../types'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { EasingMenu } from '../inspector/EasingMenu'
import { KeyframeShape } from '../inspector/keyframe-shapes'
import {
  KEYFRAME_GRAPH_HEADER_HEIGHT as HEADER_HEIGHT,
  KEYFRAME_GRAPH_ROW_HEIGHT as ROW_HEIGHT,
} from './keyframe-graph-utils'

// ─── Sizing ───────────────────────────────────────────────────────────────────

/** Vertical padding inside a sub-row so curves don't kiss the borders. */
const ROW_PADDING_Y = 8

/**
 * Half the diamond marker's footprint, plus 1px of breathing. The diamond is
 * positioned by its center, so its visible extent reaches `DIAMOND_HALF` past
 * the position on each axis. Reserving this inside the curve area guarantees a
 * marker at yFraction 0 or 1 still sits fully inside the row instead of
 * clipping against the row border.
 */
const DIAMOND_HALF = 8

/** Number of curve samples per pixel — denser at high zoom, capped for perf. */
const SAMPLES_PER_PX = 0.5

// ─── Responsive thresholds ────────────────────────────────────────────────────
//
// The graph's width is the clip's width on the timeline, so at low zoom levels
// it can shrink below the size needed for the full header + chips + axis
// labels. Below each threshold we progressively hide non-essential affordances
// instead of letting them wrap or overlap.

/** Below this width the header drops its "Keyframes / N properties" caption. */
const HIDE_HEADER_CAPTION_BELOW = 260
/** Below this width the "Add property" button collapses to icon-only. */
const COLLAPSE_ADD_BUTTON_BELOW = 200
/** Below this width the per-row Y-range labels (yMin / yMax) are hidden. */
const HIDE_RANGE_LABELS_BELOW = 220
/** Below this width the per-row property chip drops its value readout. */
const HIDE_CHIP_VALUE_BELOW = 180
/** Below this width the per-row property chip is hidden entirely. */
const HIDE_CHIP_BELOW = 100

// ─── Component ────────────────────────────────────────────────────────────────

interface ClipKeyframeGraphProps {
  clip: Clip
  track: Track
  pxPerMs: number
}

export function ClipKeyframeGraph({ clip, track, pxPerMs }: ClipKeyframeGraphProps) {
  const enableKeyframing = useEditorStore((s) => s.enableKeyframing)
  const setKeyframeGraphOpen = useUIStore((s) => s.setKeyframeGraphOpen)
  const playheadPosition = usePlaybackStore((s) => s.playheadPosition)

  const tracks = clip.keyframeTracks ?? []

  // ── Add-property menu ──

  const [addMenuOpen, setAddMenuOpen] = useState(false)

  // ── Easing menu (right-click on a diamond) ──

  const [easingMenu, setEasingMenu] = useState<{
    propertyId: AnimatablePropertyId
    keyframeId: string
    position: { x: number; y: number }
  } | null>(null)

  // Only show properties relevant to this clip's track type — caption.* on
  // caption clips, transform.* on video clips. Mixing them would let users
  // keyframe values that have no rendering effect on the wrong clip type.
  const availablePropertiesToAdd = getAnimatablePropertiesForTrackType(track.type).filter(
    (id) => !tracks.some((t) => t.propertyId === id),
  )

  // Playhead inside this clip's time window? Sub-rows draw their own playhead line.
  const clipLocalMs = Math.max(0, Math.min(clip.duration, playheadPosition - clip.startTime))
  const playheadFraction = clip.duration > 0 ? clipLocalMs / clip.duration : 0
  const playheadVisible =
    playheadPosition >= clip.startTime && playheadPosition <= clip.startTime + clip.duration

  // Graph width follows the clip body on the timeline. At low zoom levels this
  // can drop to <100px; the header and per-row chips need to know about that
  // so they can hide secondary text instead of wrapping.
  const graphWidthPx = clip.duration * pxPerMs
  const showHeaderCaption = graphWidthPx >= HIDE_HEADER_CAPTION_BELOW
  const showAddButtonLabel = graphWidthPx >= COLLAPSE_ADD_BUTTON_BELOW

  const handleAddProperty = useCallback(
    (propertyId: AnimatablePropertyId) => {
      setAddMenuOpen(false)
      // Seed at the playhead if it's inside the clip; otherwise at the start.
      const seedTime = playheadVisible ? clipLocalMs : 0
      enableKeyframing(clip.id, propertyId, seedTime)
    },
    [enableKeyframing, clip.id, playheadVisible, clipLocalMs],
  )

  return (
    <div
      className="relative h-full bg-editor-chrome-strong/70 border-t border-editor-border"
      // The graph's top inner highlight reads as a hairline of reflected light
      // off the edge — the same trick the rest of the editor glass uses.
      style={{
        boxShadow: 'inset 0 1px 0 0 rgba(255,255,255,0.04)',
      }}
      onPointerDown={(e) => {
        // Eat pointer events so the parent track lane's "click empty area to
        // deselect clips" handler doesn't fire when interacting inside the graph.
        e.stopPropagation()
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* ── Header strip ── */}
      {/* `whitespace-nowrap` + `min-w-0` on children keeps the row a single
          line even when the clip is too narrow for everything to fit; the X
          close button always wins the remaining space so the graph can still
          be dismissed. */}
      <div
        className="flex items-center justify-between gap-2 px-2 border-b border-editor-border/60 whitespace-nowrap overflow-hidden"
        style={{ height: HEADER_HEIGHT }}
      >
        <div className="flex items-center gap-1.5 min-w-0 overflow-hidden">
          {showHeaderCaption && (
            <>
              <span className="text-[9px] uppercase tracking-[0.08em] text-editor-on-chrome-muted/80">
                Keyframes
              </span>
              {tracks.length > 0 && (
                <span className="text-[9px] text-editor-on-chrome-muted/60 tabular-nums">
                  {tracks.length} {tracks.length === 1 ? 'property' : 'properties'}
                </span>
              )}
            </>
          )}
        </div>

        <div className="flex items-center gap-0.5 shrink-0">
          {availablePropertiesToAdd.length > 0 && (
            <Popover open={addMenuOpen} onOpenChange={setAddMenuOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className={`flex items-center gap-1 h-[18px] rounded text-[9px] font-medium text-editor-on-chrome/80 hover:bg-editor-chrome-soft hover:text-editor-on-chrome transition-colors data-[state=open]:bg-editor-chrome-soft data-[state=open]:text-editor-on-chrome ${
                    showAddButtonLabel ? 'px-1.5' : 'justify-center size-[18px] px-0'
                  }`}
                  aria-label="Add property to graph"
                  title={showAddButtonLabel ? undefined : 'Add property'}
                >
                  <Plus className="size-2.5" />
                  {showAddButtonLabel && <span>Add property</span>}
                </button>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                side="bottom"
                sideOffset={4}
                className="z-[200] min-w-[140px] w-auto p-1"
              >
                {availablePropertiesToAdd.map((propertyId) => {
                  const prop = ANIMATABLE_PROPERTIES[propertyId]
                  return (
                    <button
                      key={propertyId}
                      type="button"
                      onClick={() => handleAddProperty(propertyId)}
                      className="flex w-full items-center rounded-sm px-2 py-1 text-[11px] text-popover-foreground/90 hover:bg-muted hover:text-popover-foreground transition-colors"
                    >
                      {prop.label}
                    </button>
                  )
                })}
              </PopoverContent>
            </Popover>
          )}
          <button
            type="button"
            onClick={() => setKeyframeGraphOpen(clip.id, false)}
            className="flex items-center justify-center size-[18px] rounded text-editor-on-chrome-muted hover:bg-editor-chrome-soft hover:text-editor-on-chrome transition-colors"
            aria-label="Close keyframe graph"
            title="Close graph (G)"
          >
            <X className="size-3" />
          </button>
        </div>
      </div>

      {/* ── Sub-rows ── */}
      {tracks.length === 0 ? (
        <div
          className="flex items-center justify-center text-[10px] text-editor-on-chrome-muted/70"
          style={{ height: ROW_HEIGHT }}
        >
          {availablePropertiesToAdd.length > 0
            ? 'Add a property to start animating'
            : 'No animatable properties left'}
        </div>
      ) : (
        tracks.map((kfTrack) => (
          <PropertySubRow
            key={kfTrack.propertyId}
            clip={clip}
            track={track}
            kfTrack={kfTrack}
            pxPerMs={pxPerMs}
            graphWidthPx={graphWidthPx}
            playheadVisible={playheadVisible}
            playheadFraction={playheadFraction}
            onOpenEasingMenu={(keyframeId, x, y) =>
              setEasingMenu({ propertyId: kfTrack.propertyId, keyframeId, position: { x, y } })
            }
          />
        ))
      )}

      {/* ── Easing menu (right-click on a diamond) ── */}
      {easingMenu && (() => {
        const liveTrack = tracks.find((t) => t.propertyId === easingMenu.propertyId)
        const liveKf = liveTrack?.keyframes.find((k) => k.id === easingMenu.keyframeId)
        if (!liveKf) return null
        return (
          <EasingMenu
            clipId={clip.id}
            propertyId={easingMenu.propertyId}
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

// ─── Property sub-row ─────────────────────────────────────────────────────────

interface PropertySubRowProps {
  clip: Clip
  track: Track
  kfTrack: KeyframeTrack
  pxPerMs: number
  /** Full graph width in pixels — used to decide which labels to show. */
  graphWidthPx: number
  playheadVisible: boolean
  playheadFraction: number
  onOpenEasingMenu: (keyframeId: string, x: number, y: number) => void
}

function PropertySubRow({
  clip,
  kfTrack,
  pxPerMs,
  graphWidthPx,
  playheadVisible,
  playheadFraction,
  onOpenEasingMenu,
}: PropertySubRowProps) {
  const prop = getAnimatableProperty(kfTrack.propertyId)
  const disableKeyframing = useEditorStore((s) => s.disableKeyframing)
  const setPropertyAtPlayhead = useEditorStore((s) => s.setPropertyAtPlayhead)
  const beginHistoryTransaction = useEditorStore((s) => s.beginHistoryTransaction)
  const commitHistoryTransaction = useEditorStore((s) => s.commitHistoryTransaction)
  const moveKeyframe = useEditorStore((s) => s.moveKeyframe)
  const selectedKeyframes = useSelectionStore((s) => s.selectedKeyframes)
  const selectKeyframe = useSelectionStore((s) => s.selectKeyframe)
  const toggleKeyframeSelection = useSelectionStore((s) => s.toggleKeyframeSelection)
  const [hovered, setHovered] = useState(false)
  const [draggingId, setDraggingId] = useState<string | null>(null)

  const curveAreaRef = useRef<HTMLDivElement>(null)

  // ── Compute Y axis range (auto-fit, includes default value + 15% headroom) ──

  const { yMin, yMax } = useMemo(() => {
    const values = kfTrack.keyframes.map((k) => k.value)
    values.push(prop.defaultValue)
    let lo = Math.min(...values)
    let hi = Math.max(...values)
    if (lo === hi) {
      const pad = Math.max(0.5, Math.abs(lo) * 0.1)
      lo -= pad
      hi += pad
    } else {
      const range = hi - lo
      lo -= range * 0.15
      hi += range * 0.15
    }
    // Deliberately *do not* clamp the view range to prop.min/max here. The
    // keyframe values themselves are already clamped on write, so the data
    // can never exceed the bounds — but the view needs to keep the 15%
    // headroom so a marker sitting at the property limit still has visible
    // breathing room above/below it instead of kissing the row border.
    if (hi - lo < 1e-6) {
      // Degenerate range — push them apart by 1 unit so the curve is visible
      // rather than a single horizontal line.
      hi = lo + 1
    }
    return { yMin: lo, yMax: hi }
  }, [kfTrack.keyframes, prop.defaultValue])

  // ── Helpers: convert between data space ↔ pixel space ──

  const valueToFraction = useCallback(
    (v: number) => 1 - (v - yMin) / (yMax - yMin),
    [yMin, yMax],
  )

  // The curve area is the inner band where curves and markers actually live.
  // We inset by ROW_PADDING_Y (so the curve doesn't kiss the row borders) AND
  // by DIAMOND_HALF (so a marker at yFraction 0 or 1 still sits fully inside
  // the row). The curve path, default-value guideline and diamond markers all
  // map their yFraction into this same inner band so they stay aligned.
  const curveAreaTop = ROW_PADDING_Y + DIAMOND_HALF
  const curveHeight = ROW_HEIGHT - ROW_PADDING_Y * 2 - DIAMOND_HALF * 2

  /** Convert a clip-local time in ms to an X fraction (0..1 of curve area). */
  const timeToFraction = useCallback(
    (timeMs: number) => (clip.duration > 0 ? timeMs / clip.duration : 0),
    [clip.duration],
  )

  // ── Sample the curve to build the SVG path ──

  const curvePath = useMemo(() => {
    if (kfTrack.keyframes.length === 0) return ''
    const widthPx = Math.max(1, clip.duration * pxPerMs)
    const sampleCount = Math.max(32, Math.min(800, Math.floor(widthPx * SAMPLES_PER_PX)))
    const baseline = prop.read(clip)
    let path = ''
    for (let i = 0; i <= sampleCount; i++) {
      const t = i / sampleCount
      const timeMs = t * clip.duration
      const v = resolveKeyframedValue(kfTrack, timeMs, baseline)
      const x = t * 100 // viewBox uses 0..100 for X
      const y = valueToFraction(v) * 100 // 0..100 for Y, top = max
      path += `${i === 0 ? 'M' : 'L'}${x.toFixed(3)},${y.toFixed(3)} `
    }
    return path
  }, [kfTrack, clip, pxPerMs, prop, valueToFraction])

  // ── Default-value guideline position ──

  const defaultLineY = useMemo(() => {
    const v = prop.defaultValue
    if (v < yMin || v > yMax) return null
    return valueToFraction(v) * 100
  }, [prop.defaultValue, yMin, yMax, valueToFraction])

  // ── Add a keyframe by double-clicking empty area ──

  const handleAreaDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // Ignore double-clicks that originate on a diamond — those are select.
      if ((e.target as HTMLElement).closest('[data-keyframe-id]')) return
      const rect = curveAreaRef.current?.getBoundingClientRect()
      if (!rect) return
      const fx = (e.clientX - rect.left) / rect.width
      // Map the click into the same inset band that the curve and markers
      // use, so double-clicking at the top of the band gives a value of yMax
      // (not the row's top padding).
      const yRel = (e.clientY - rect.top - curveAreaTop) / curveHeight
      const fy = Math.max(0, Math.min(1, yRel))
      const timeMs = Math.max(0, Math.min(clip.duration, fx * clip.duration))
      const rawValue = yMax - fy * (yMax - yMin)
      const clamped = clampToPropertyBounds(prop, rawValue)
      setPropertyAtPlayhead(clip.id, kfTrack.propertyId, timeMs, clamped)
    },
    [clip.id, clip.duration, curveAreaTop, curveHeight, kfTrack.propertyId, prop, setPropertyAtPlayhead, yMax, yMin],
  )

  // ── Display value at playhead (the live value, label-column readout) ──

  const valueAtPlayhead = useMemo(() => {
    if (!playheadVisible) return null
    const baseline = prop.read(clip)
    return resolveKeyframedValue(kfTrack, playheadFraction * clip.duration, baseline)
  }, [playheadVisible, playheadFraction, clip, prop, kfTrack])

  return (
    <div
      ref={curveAreaRef}
      className="relative border-b border-editor-border/40 last:border-b-0 overflow-hidden cursor-crosshair"
      style={{ height: ROW_HEIGHT }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onDoubleClick={handleAreaDoubleClick}
    >
      {/* Grid (subtle horizontal thirds) — drawn first so everything else stacks on top. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            'repeating-linear-gradient(to bottom, transparent 0, transparent calc(33.33% - 1px), color-mix(in oklch, var(--editor-on-chrome-muted) 8%, transparent) calc(33.33% - 1px), color-mix(in oklch, var(--editor-on-chrome-muted) 8%, transparent) 33.33%)',
        }}
      />

      {/* SVG curve, stretched to the FULL clip width so its X axis matches
          the clip body 1-to-1. preserveAspectRatio=none deforms the curve in
          the same way every other clip-aligned overlay (peaks, captions) does. */}
      <svg
        className="absolute pointer-events-none"
        style={{
          left: 0,
          right: 0,
          top: curveAreaTop,
          height: curveHeight,
          width: '100%',
        }}
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden
      >
        {defaultLineY !== null && (
          <line
            x1={0}
            y1={defaultLineY}
            x2={100}
            y2={defaultLineY}
            stroke="color-mix(in oklch, var(--editor-on-chrome-muted) 35%, transparent)"
            strokeWidth={0.4}
            strokeDasharray="1.2 1.2"
            vectorEffect="non-scaling-stroke"
          />
        )}
        <path
          d={curvePath}
          fill="none"
          stroke={hovered ? 'var(--ring)' : 'color-mix(in oklch, var(--editor-on-chrome) 60%, transparent)'}
          strokeWidth={hovered ? 1.6 : 1.3}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      {/* Floating property chip — top-left, anchored inside the curve area
          so it scrolls with the clip. Pointer-events-none on the wrapper so
          the curve area can still receive double-clicks (to add a keyframe)
          underneath the chip; the X button explicitly re-enables events.
          The chip is hidden entirely at very narrow widths so the curve and
          markers can read clearly without textual overlap. */}
      {graphWidthPx >= HIDE_CHIP_BELOW && (
        <div
          className={`pointer-events-none absolute left-1.5 top-1.5 flex items-center gap-1 rounded-sm px-1.5 h-[14px] bg-editor-chrome-strong/80 backdrop-blur-[2px] border border-editor-border/50 transition-colors whitespace-nowrap overflow-hidden ${
            hovered ? 'border-editor-border' : ''
          }`}
          // Cap chip width so it can never overlap the Y-range labels on the
          // right side. Leaves ~36px on the right for "yMax/yMin" + padding.
          style={{ maxWidth: `calc(100% - 44px)` }}
        >
          <span className="text-[9px] font-medium leading-none text-editor-on-chrome/85 truncate">
            {prop.label}
          </span>
          {graphWidthPx >= HIDE_CHIP_VALUE_BELOW && (
            <span className="text-[9px] leading-none tabular-nums text-editor-on-chrome-muted/80">
              {formatValue(prop.id, valueAtPlayhead ?? prop.read(clip))}
            </span>
          )}
          {hovered && (
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                disableKeyframing(clip.id, kfTrack.propertyId)
              }}
              className="pointer-events-auto ml-0.5 flex items-center justify-center size-[12px] rounded-[3px] text-editor-on-chrome-muted/70 hover:bg-editor-on-chrome/15 hover:text-editor-on-chrome shrink-0"
              aria-label={`Remove ${prop.label} keyframes`}
              title="Remove all keyframes for this property"
            >
              <X className="size-[8px]" />
            </button>
          )}
        </div>
      )}

      {/* Y-range labels (top-right + bottom-right corners). Hidden when the
          row is too narrow for both the chip and the label to fit without
          overlap. */}
      {graphWidthPx >= HIDE_RANGE_LABELS_BELOW && (
        <>
          <div className="pointer-events-none absolute right-1.5 top-1 text-[8px] tabular-nums leading-none text-editor-on-chrome-muted/45">
            {formatValue(prop.id, yMax)}
          </div>
          <div className="pointer-events-none absolute right-1.5 bottom-1 text-[8px] tabular-nums leading-none text-editor-on-chrome-muted/45">
            {formatValue(prop.id, yMin)}
          </div>
        </>
      )}

      {/* Playhead bar inside the sub-row — soft, so the global timeline
          playhead (drawn above all rows) can still dominate visually but the
          local one anchors the curve's "now" point against the diamonds. */}
      {playheadVisible && (
        <div
          className="absolute top-0 bottom-0 w-px bg-primary/45 pointer-events-none"
          style={{ left: `${playheadFraction * 100}%` }}
          aria-hidden
        />
      )}

      {/* Diamonds */}
      {kfTrack.keyframes.map((kf) => {
        const xFrac = timeToFraction(kf.timeMs)
        const yFrac = valueToFraction(kf.value)
        const isSelected = selectedKeyframes.some(
          (ref) =>
            ref.clipId === clip.id &&
            ref.propertyId === kfTrack.propertyId &&
            ref.keyframeId === kf.id,
        )
        return (
          <GraphDiamond
            key={kf.id}
            keyframe={kf}
            propertyId={kfTrack.propertyId}
            clip={clip}
            prop={prop}
            xFraction={xFrac}
            yFraction={yFrac}
            yMin={yMin}
            yMax={yMax}
            curveAreaTop={curveAreaTop}
            curveHeight={curveHeight}
            curveAreaRef={curveAreaRef}
            selected={isSelected}
            dragging={draggingId === kf.id}
            onSelect={(additive) => {
              const ref = {
                clipId: clip.id,
                propertyId: kfTrack.propertyId,
                keyframeId: kf.id,
              }
              if (additive) toggleKeyframeSelection(ref)
              else selectKeyframe(ref)
            }}
            onDragStart={() => {
              beginHistoryTransaction('Edit keyframe')
              setDraggingId(kf.id)
            }}
            onDrag={(newTimeMs, newValue) => {
              // Move time first (preserves the keyframe's id), then upsert
              // the value at the new time. Both run inside the open
              // transaction → one undo entry per drag.
              moveKeyframe(clip.id, kfTrack.propertyId, kf.id, newTimeMs)
              setPropertyAtPlayhead(clip.id, kfTrack.propertyId, newTimeMs, newValue)
            }}
            onDragEnd={() => {
              commitHistoryTransaction()
              setDraggingId(null)
            }}
            onContextMenu={(x, y) => onOpenEasingMenu(kf.id, x, y)}
          />
        )
      })}
    </div>
  )
}

// ─── Draggable diamond ────────────────────────────────────────────────────────

interface GraphDiamondProps {
  keyframe: Keyframe
  propertyId: AnimatablePropertyId
  clip: Clip
  prop: ReturnType<typeof getAnimatableProperty>
  /** Position in the curve area, 0..1 along each axis. */
  xFraction: number
  yFraction: number
  yMin: number
  yMax: number
  /** Pixel y of the inner curve band's top edge inside the row. */
  curveAreaTop: number
  /** Pixel height of the inner curve band. */
  curveHeight: number
  curveAreaRef: React.RefObject<HTMLDivElement | null>
  selected: boolean
  dragging: boolean
  onSelect: (additive: boolean) => void
  onDragStart: () => void
  onDrag: (newTimeMs: number, newValue: number) => void
  onDragEnd: () => void
  onContextMenu: (clientX: number, clientY: number) => void
}

function GraphDiamond({
  keyframe,
  clip,
  prop,
  xFraction,
  yFraction,
  yMin,
  yMax,
  curveAreaTop,
  curveHeight,
  curveAreaRef,
  selected,
  dragging,
  onSelect,
  onDragStart,
  onDrag,
  onDragEnd,
  onContextMenu,
}: GraphDiamondProps) {
  const [hovered, setHovered] = useState(false)
  const dragStateRef = useRef<{
    startClientX: number
    startClientY: number
    startTimeMs: number
    startValue: number
    moved: boolean
    axisLock: 'x' | 'y' | null
  } | null>(null)

  // Stash the latest callbacks in a ref so the pointermove listener captures
  // up-to-date closures without re-attaching window listeners every render.
  const callbacksRef = useRef({ onDrag, onDragEnd })
  useEffect(() => {
    callbacksRef.current = { onDrag, onDragEnd }
  }, [onDrag, onDragEnd])

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0) return
      e.stopPropagation()
      e.preventDefault()
      const area = curveAreaRef.current
      if (!area) return
      const rect = area.getBoundingClientRect()

      dragStateRef.current = {
        startClientX: e.clientX,
        startClientY: e.clientY,
        startTimeMs: keyframe.timeMs,
        startValue: keyframe.value,
        moved: false,
        axisLock: null,
      }
      onDragStart()

      function handleMove(ev: PointerEvent) {
        const state = dragStateRef.current
        if (!state) return
        const dx = ev.clientX - state.startClientX
        const dy = ev.clientY - state.startClientY

        if (!state.moved && Math.hypot(dx, dy) > 2) {
          state.moved = true
        }

        // Shift = axis lock to whichever axis the pointer moved more on first.
        let lockedAxis = state.axisLock
        if (ev.shiftKey && lockedAxis === null && state.moved) {
          lockedAxis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
          state.axisLock = lockedAxis
        }
        if (!ev.shiftKey) {
          state.axisLock = null
          lockedAxis = null
        }

        const effectiveDx = lockedAxis === 'y' ? 0 : dx
        const effectiveDy = lockedAxis === 'x' ? 0 : dy

        // Map pixel deltas back into data space. X uses the full row width
        // (X axis is the clip's time range). Y uses curveHeight — the inner
        // band the curve and markers occupy — so the marker tracks the
        // pointer 1:1 instead of lagging behind in the larger row rectangle.
        const newTimeMs =
          rect.width > 0 ? state.startTimeMs + (effectiveDx / rect.width) * clip.duration : state.startTimeMs
        const newValueRaw =
          curveHeight > 0
            ? state.startValue - (effectiveDy / curveHeight) * (yMax - yMin)
            : state.startValue

        const clampedTime = Math.max(0, Math.min(clip.duration, newTimeMs))
        const clampedValue = clampToPropertyBounds(prop, newValueRaw)
        callbacksRef.current.onDrag(clampedTime, clampedValue)
      }

      function handleUp(ev: PointerEvent) {
        window.removeEventListener('pointermove', handleMove)
        window.removeEventListener('pointerup', handleUp)
        window.removeEventListener('pointercancel', handleUp)
        const state = dragStateRef.current
        callbacksRef.current.onDragEnd()
        if (state && !state.moved) {
          onSelect(ev.shiftKey)
        }
        dragStateRef.current = null
      }

      window.addEventListener('pointermove', handleMove)
      window.addEventListener('pointerup', handleUp)
      window.addEventListener('pointercancel', handleUp)
    },
    [keyframe.timeMs, keyframe.value, clip.duration, prop, yMin, yMax, curveHeight, onDragStart, onSelect, curveAreaRef],
  )

  function handleContextMenu(e: React.MouseEvent<HTMLButtonElement>) {
    e.preventDefault()
    e.stopPropagation()
    onContextMenu(e.clientX, e.clientY)
  }

  return (
    <button
      type="button"
      data-keyframe-id={keyframe.id}
      onPointerDown={handlePointerDown}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onContextMenu={handleContextMenu}
      title={`Keyframe — drag to retime/revalue (Shift to lock axis), right-click for easing\n${prop.label}: ${formatValue(prop.id, keyframe.value)} @ ${(keyframe.timeMs / 1000).toFixed(2)}s\nIn: ${keyframe.easingIn} → Out: ${keyframe.easingOut}`}
      className={`absolute w-[14px] h-[14px] -translate-x-1/2 -translate-y-1/2 cursor-grab active:cursor-grabbing grid place-items-center rounded-[3px] outline-none focus-visible:ring-1 focus-visible:ring-primary/60 ${
        dragging ? '' : 'transition-transform duration-100'
      } ${hovered && !dragging ? 'scale-[1.18]' : ''} ${
        selected ? 'shadow-[0_0_0_1px_var(--ring),0_0_8px_color-mix(in_oklch,var(--primary)_55%,transparent)]' : ''
      }`}
      style={{
        left: `${xFraction * 100}%`,
        // Position the marker's CENTER inside the same inner band the curve
        // and default-line use. The band is already inset by DIAMOND_HALF on
        // top and bottom, so even at yFraction 0 or 1 the marker (-translate-
        // y-1/2) sits fully inside the row instead of clipping the border.
        // yFraction is clamped defensively in case keyframe values briefly
        // race ahead of the auto-fit memo during a drag.
        top: `${curveAreaTop + Math.max(0, Math.min(1, yFraction)) * curveHeight}px`,
      }}
      aria-label={`Keyframe at ${(keyframe.timeMs / 1000).toFixed(2)}s, value ${formatValue(
        prop.id,
        keyframe.value,
      )}`}
    >
      <KeyframeShape
        easingIn={keyframe.easingIn}
        easingOut={keyframe.easingOut}
        selected={selected}
        hovered={hovered}
        size={12}
        variant="graph"
      />
    </button>
  )
}

// ─── Formatting + clamping helpers ────────────────────────────────────────────

function clampToPropertyBounds(
  prop: ReturnType<typeof getAnimatableProperty>,
  value: number,
): number {
  let v = value
  if (prop.min !== undefined) v = Math.max(prop.min, v)
  if (prop.max !== undefined) v = Math.min(prop.max, v)
  return v
}

/**
 * Format a value with a unit/precision appropriate for its property. Keeps the
 * label column compact (no "px"/"°" suffix at 8px — implied by the property
 * name) but rounds correctly so e.g. opacity reads as `0.85` not `0.85000`.
 */
function formatValue(propertyId: AnimatablePropertyId, value: number): string {
  switch (propertyId) {
    case 'transform.opacity':
      return value.toFixed(2)
    case 'transform.scale':
      return value.toFixed(2) + '×'
    case 'transform.rotation':
      return Math.round(value) + '°'
    case 'transform.x':
    case 'transform.y':
    case 'caption.xOffset':
    case 'caption.yOffset':
    case 'caption.fontSizePx':
      return Math.round(value) + 'px'
    default:
      return String(value)
  }
}
