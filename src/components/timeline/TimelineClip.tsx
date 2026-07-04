/**
 * TimelineClip — an interactive clip block on the timeline.
 *
 * Represents a single clip placed on a track. Handles all pointer-based
 * interactions for the clip:
 *
 *   - **Click/Shift-click**: select or multi-select the clip
 *   - **Drag (clip body)**: move the clip horizontally (change startTime) or
 *     vertically (move to a different track)
 *   - **Drag (left trim handle)**: resize clip from the start (adjusts inPoint)
 *   - **Drag (right trim handle)**: resize clip from the end (adjusts outPoint)
 *   - **Click in slice mode**: split the clip at the click position
 *
 * Interaction architecture:
 *   This component uses pointer events with `setPointerCapture` for drag
 *   operations rather than DnD Kit. This is intentional: timeline clip dragging
 *   requires precise sub-pixel time calculations and cross-track detection that
 *   are more naturally handled with raw pointer deltas than DnD Kit's abstract
 *   position model.
 *
 *   DnD Kit is used only for track *reordering* (in Timeline.tsx) where the
 *   sortable list abstraction fits perfectly.
 *
 * Drag preview:
 *   During drag, the clip renders at a "preview" position (local component
 *   state) for instant visual feedback. The store is only updated on pointer
 *   release to avoid batching hundreds of history entries while dragging.
 *   The one exception is trim handles — `trimClip` is called once on
 *   pointer-up with the final trim value.
 *
 * Cross-track detection:
 *   When dragging a clip, `document.elementsFromPoint(clientX, clientY)` is
 *   used to detect which track's content area is under the pointer. The first
 *   ancestor with a `data-track-content-id` attribute determines the drop target.
 *
 * Snap behavior:
 *   When `snapEnabled` is true, the drag preview snaps to nearby clip edges
 *   and the playhead position. The snap threshold is 8px (defined in
 *   `timeline-utils.ts`). Snap points are provided by the parent (all clip
 *   edges except the dragging clip itself).
 *
 * SOLID: SRP — this component only handles clip display and interactions.
 *   No routing, no API calls, no track management.
 * SOLID: DIP — all store mutations go through the action callbacks passed as
 *   props, decoupling the component from Zustand directly.
 *
 * @see PLAN.md Phase 3.4 for clip component requirements
 * @see timeline-utils.ts for snap, format utilities
 * @see TrackContent.tsx for how clips are rendered inside a track
 */

import { memo, useRef, useState, useCallback, useMemo } from 'react'
import { ChartSpline, Link, Unlink } from 'lucide-react'
import type { Clip, Track, TrimEdge, ClipTransition, ToolMode } from '../../types'
import {
  TRACK_ROW_HEIGHT,
  TRACK_TYPE_CONFIG,
  IMAGE_CLIP_STYLE,
  formatClipDuration,
  applySnap,
  applySnapMove,
  applySnapToEnd,
  collectClipIdsByDirection,
} from './timeline-utils'
import { useAudioPeaks } from '../../hooks/useAudioPeaks'
import { useClipFilmstrip } from '../../hooks/useClipFilmstrip'
import { useSelectionStore } from '../../store/selection-store'
import { usePlaybackStore } from '../../store/playback-store'
import { useUIStore } from '../../store/ui-store'
import { useEditorStore } from '../../store/editor-store'
import {
  TRANSITION_DRAG_MIME_TYPE,
  getTransitionPreset,
  type DraggedTransitionPayload,
} from '../../engine/transitions'
import {
  EFFECT_DRAG_MIME_TYPE,
  EFFECT_LABELS,
  createEffectInstance,
  type DraggedEffectPayload,
} from '../../engine/effects'
import { TimelineClipContextMenu } from './TimelineClipContextMenu'
import { editorToast } from '../EditorToast'

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * How close two clip edges must be (in ms) to count as touching for transition
 * seam pairing. Covers floating-point drift introduced by trims/moves so a
 * visually-touching seam still registers as a seam. Used by drop detection,
 * resize neighbour lookup, and seam-aware selection highlighting.
 */
const SEAM_TOLERANCE_MS = 50

/**
 * Progressive-disclosure thresholds for inner chrome (in CSS px of the rendered
 * clip width). Below each threshold the corresponding affordance is hidden so
 * tiny zoomed-out clips don't crowd unreadable icons and ungrabbable handles
 * against each other. Ordered so the most informative bits (type icon) survive
 * longest and the most space-hungry bits (label) drop first.
 */
const MIN_WIDTH_FOR_TRIM_HANDLES = 36
const MIN_WIDTH_FOR_LABEL = 96
const MIN_WIDTH_FOR_LINK_BUTTON = 56
const MIN_WIDTH_FOR_GRAPH_BUTTON = 72
const MIN_WIDTH_FOR_TYPE_ICON = 22

// ─── Drag State Types ─────────────────────────────────────────────────────────

/**
 * Internal drag state while a pointer operation is in progress.
 *
 * Stored in a `useRef` (not state) to avoid re-renders during drag — we use
 * separate `previewLeft`/`previewWidth` state values for the visual update.
 */
interface ClipDragState {
  /**
   * Type of drag operation in progress.
   *   - 'move'        — body drag in select mode (changes startTime and/or track)
   *   - 'trim-start'  — left handle drag (trim or rate-stretch on the in edge)
   *   - 'trim-end'    — right handle drag (trim or rate-stretch on the out edge)
   *   - 'slip'        — body drag in slip mode (slides inPoint/outPoint together
   *                     without moving the clip on the timeline)
   */
  type: 'move' | 'trim-start' | 'trim-end' | 'slip'

  /** ClientX at the moment the pointer was pressed. */
  startClientX: number

  /** Clip startTime at the beginning of the drag (ms). */
  originalStartTime: number

  /** Clip duration at the beginning of the drag (ms). */
  originalDuration: number

  /**
   * When this move drag is acting on a multi-selection, the other selected
   * clips and their starting positions. Empty for single-clip drags and for
   * trim drags. During pointer move we shift each sibling by the same
   * (snapped) time delta as the primary clip; on release we commit the whole
   * group through `onMoveClips` so the entire shift is one history entry.
   */
  groupSiblings: ReadonlyArray<{
    clipId: string
    sourceTrackId: string
    originalStartTime: number
  }>

  /**
   * Maximum amount (in ms) the group can be shifted left before the
   * left-most clip in the group would go negative. Used to clamp the live
   * delta during a group move drag so non-primary clips can never run off
   * the left edge of the timeline.
   */
  groupMaxNegativeDeltaMs: number
}

// ─── Component Props ──────────────────────────────────────────────────────────

export interface TimelineClipProps {
  /** The clip to render. */
  clip: Clip

  /** Parent track — provides type for color and locked state. */
  track: Track

  /** Pixels per millisecond at the current zoom level. */
  pxPerMs: number

  /**
   * All snap point positions (in ms) available for snapping.
   * Should exclude the current clip's own start/end so it doesn't snap to itself.
   */
  snapPoints: number[]

  /** Whether snap-to-edges is globally enabled. */
  snapEnabled: boolean

  /** The currently active tool mode. Affects pointer interaction behavior. */
  activeToolMode: ToolMode

  /** Whether this clip is currently selected. */
  isSelected: boolean

  // ── Store callbacks (ISP: only what the clip needs) ──

  onSelect: (clipId: string) => void
  onToggleSelect: (clipId: string) => void
  onMoveClip: (clipId: string, newTrackId: string, newStartTime: number) => void
  /**
   * Move multiple clips atomically in a single history entry.
   *
   * Used when this clip is dragged while part of a multi-selection: every
   * selected clip shifts by the same time delta, the primary clip drives
   * its own target lane, and the rest stay on their original tracks. The
   * store handles overlap trimming and linked-audio pair expansion.
   */
  onMoveClips: (
    moves: ReadonlyArray<{ clipId: string; newTrackId: string; newStartTime: number }>,
  ) => void
  onTrimClip: (clipId: string, edge: TrimEdge, newTime: number) => void
  /**
   * Commit a rate-stretch from one edge. Called on pointer-up while the
   * Rate Stretch tool is active. The store recomputes `speed` so the existing
   * source material plays back in the new duration without shifting inPoint /
   * outPoint.
   */
  onRateStretchClip: (clipId: string, edge: TrimEdge, newTime: number) => void
  /**
   * Commit a slip from the body drag. Called on pointer-up while the Slip
   * tool is active. The store shifts `inPoint` and `outPoint` together by
   * `sourceDeltaMs` without changing the clip's timeline position.
   */
  onSlipClip: (clipId: string, sourceDeltaMs: number) => void
  onSplitClip: (clipId: string, atTime: number) => void

  /**
   * When true, this clip is part of a video/clip_audio pair and the link control is shown.
   * When false/undefined, no link control is shown.
   */
  showLinkControl?: boolean

  /**
   * When true (default when linked), moving/trimming this clip also updates the linked clip.
   * When false, video and clip_audio can be edited independently.
   */
  isAudioLinked?: boolean

  /**
   * Toggle or set whether the video clip's audio is linked to its clip_audio.
   * Called with the video clip ID (this clip's id for video, or sourceVideoClipId for clip_audio).
   */
  onSetClipAudioLinked?: (videoClipId: string, linked: boolean) => void

  /**
   * Apply a transition to one edge of this clip.
   *
   * Called when the user drops a transition tile from the AssetPanel onto
   * the clip's left or right edge AND there is no adjacent clip on that
   * edge (so this is an isolated in/out animation, not a seam).
   */
  onSetClipTransition?: (
    clipId: string,
    edge: 'in' | 'out',
    transition: ClipTransition | null,
  ) => void

  /**
   * Apply a paired transition across a seam.
   *
   * Called when the dropped transition lands on a clip edge that touches
   * an adjacent clip on the same track. Sets `transitionOut` on the left
   * clip and `transitionIn` on the right clip.
   */
  onSetSeamTransition?: (
    leftClipId: string,
    rightClipId: string,
    transition: ClipTransition,
  ) => void

  /**
   * Resize the duration of an existing transition on one edge of this clip.
   *
   * Called on pointer release after the user drags the inner edge of a
   * transition badge. The store handles seam pairing — if the neighbour clip
   * has a matching transition, both halves are resized in lockstep.
   */
  onResizeTransition?: (clipId: string, edge: 'in' | 'out', newDurationMs: number) => void

  /** Map of assetId -> URL for waveform decoding in audio clips. */
  assetUrlMap?: Record<string, string>
}

// ─── TimelineClip Component ───────────────────────────────────────────────────

/**
 * TimelineClip — interactive clip block with drag, trim, snap, and selection.
 *
 * @example
 *   <TimelineClip
 *     clip={clip}
 *     track={track}
 *     pxPerMs={0.1}
 *     snapPoints={[0, 5000, 10000]}
 *     snapEnabled={true}
 *     activeToolMode="select"
 *     isSelected={selectedIds.includes(clip.id)}
 *     onSelect={selectClip}
 *     onToggleSelect={toggleClipSelection}
 *     onMoveClip={moveClip}
 *     onTrimClip={trimClip}
 *     onSplitClip={splitClip}
 *   />
 */
export const TimelineClip = memo(function TimelineClip({
  clip,
  track,
  pxPerMs,
  snapPoints,
  snapEnabled,
  activeToolMode,
  isSelected,
  onSelect,
  onToggleSelect,
  onMoveClip,
  onMoveClips,
  onTrimClip,
  onRateStretchClip,
  onSlipClip,
  onSplitClip,
  showLinkControl,
  isAudioLinked = true,
  onSetClipAudioLinked,
  onSetClipTransition,
  onSetSeamTransition,
  onResizeTransition,
  assetUrlMap,
}: TimelineClipProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  /**
   * Internal drag state (not React state — avoids re-renders during drag).
   * Pointer events update `previewLeft`/`previewWidth` for visual feedback.
   */
  const dragStateRef = useRef<ClipDragState | null>(null)

  /**
   * Target track ID during a move drag.
   * Updated by `document.elementsFromPoint` cross-track detection.
   */
  const targetTrackIdRef = useRef<string>(track.id)

  // Visual preview positions (React state for re-renders)
  const [previewLeft, setPreviewLeft] = useState<number | null>(null)
  const [previewWidth, setPreviewWidth] = useState<number | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [dragType, setDragType] = useState<ClipDragState['type'] | null>(null)
  /**
   * Pending source-time shift while a Slip drag is in flight, in ms.
   * Null when no slip is active. The clip's timeline position never changes
   * during a slip — this just feeds the on-clip badge so the user can see
   * how far they've slid the source window.
   */
  const [slipPreviewDeltaMs, setSlipPreviewDeltaMs] = useState<number | null>(null)

  /**
   * Drag-over state for transition drop targets.
   * 'in' = a transition tile is hovering the left edge,
   * 'out' = the right edge. Cleared on dragleave/drop.
   */
  const [transitionDropEdge, setTransitionDropEdge] = useState<'in' | 'out' | null>(null)

  /**
   * True while an effect tile from the Effects panel hovers this clip.
   * Unlike transitions (edge-targeted), effects drop anywhere on the clip
   * body — the whole clip highlights as one target.
   */
  const [effectDropActive, setEffectDropActive] = useState(false)

  /**
   * Live preview duration (ms) for whichever transition is being resized.
   * Set on pointermove during a resize drag, cleared on pointerup. While set,
   * the badge renders at this width instead of the persisted `durationMs` so
   * the resize feels instantaneous.
   */
  const [transitionResize, setTransitionResize] = useState<{
    edge: 'in' | 'out'
    durationMs: number
  } | null>(null)

  /**
   * Internal pointer state for a transition resize drag. Mirrors `dragStateRef`
   * but for transitions — kept in a ref to avoid per-move re-renders.
   */
  const transitionResizeRef = useRef<{
    edge: 'in' | 'out'
    startClientX: number
    originalDurationMs: number
  } | null>(null)

  /**
   * True while a transition tile is being dragged from the AssetPanel.
   *
   * Gates the drop zones' `pointer-events`: when false, the zones are
   * pointer-transparent so the trim handles below them still receive clicks.
   */
  const transitionDragActive = useUIStore((s) => s.transitionDragActive)

  /**
   * The transition currently selected for editing in the inspector, if any.
   * Used to highlight the badge with a ring when this clip's transition is
   * the selected one. Read directly from the store (rather than passed as a
   * prop) to keep the component's interface narrow.
   */
  /**
   * Selected transition reference from the store.
   *
   * We compute `isTransitionInSelected` / `isTransitionOutSelected` below so a
   * single click on a seam transition lights up *both* halves of the seam at
   * once — the user shouldn't have to mentally pair the two clips. The store
   * still only persists a single `(clipId, edge)` pointer; pairing is resolved
   * in render against the current track's clips.
   */
  const selectedTransition = useSelectionStore((s) => s.selectedTransition)
  const selectTransition = useSelectionStore((s) => s.selectTransition)
  const setLiveTransitionResize = useUIStore((s) => s.setLiveTransitionResize)
  const setLiveClipDrag = useUIStore((s) => s.setLiveClipDrag)
  const setLiveSlip = useUIStore((s) => s.setLiveSlip)

  /**
   * Whether this clip's in/out transition badge should render as selected.
   *
   * Highlights both halves of a seam at once: when the user clicks one badge,
   * the paired badge on the touching neighbour also lights up so the seam
   * reads as a single object. Falls back to the direct match for isolated
   * in/out animations.
   */
  const { isTransitionInSelected, isTransitionOutSelected } = useMemo(() => {
    if (!selectedTransition) {
      return { isTransitionInSelected: false, isTransitionOutSelected: false }
    }
    const directIn = selectedTransition.clipId === clip.id && selectedTransition.edge === 'in'
    const directOut = selectedTransition.clipId === clip.id && selectedTransition.edge === 'out'

    // Seam-pair highlight: the selected transition's clip sits on the same
    // track and touches this clip's matching edge with a paired transition.
    let pairedIn = false
    let pairedOut = false
    if (!directIn && !directOut) {
      const selected = track.clips.find((c) => c.id === selectedTransition.clipId)
      if (selected) {
        if (
          selectedTransition.edge === 'out' &&
          clip.transitionIn &&
          clip.transitionIn.type !== 'none'
        ) {
          const selectedEnd = selected.startTime + selected.duration
          if (Math.abs(selectedEnd - clip.startTime) <= SEAM_TOLERANCE_MS) {
            pairedIn = true
          }
        } else if (
          selectedTransition.edge === 'in' &&
          clip.transitionOut &&
          clip.transitionOut.type !== 'none'
        ) {
          const clipEnd = clip.startTime + clip.duration
          if (Math.abs(selected.startTime - clipEnd) <= SEAM_TOLERANCE_MS) {
            pairedOut = true
          }
        }
      }
    }
    return {
      isTransitionInSelected: directIn || pairedIn,
      isTransitionOutSelected: directOut || pairedOut,
    }
  }, [
    selectedTransition,
    clip.id,
    clip.startTime,
    clip.duration,
    clip.transitionIn,
    clip.transitionOut,
    track.clips,
  ])

  /**
   * Live resize broadcast: returns the raw store value so the selector is
   * referentially stable (returning a freshly-built object here would trigger
   * `getSnapshot should be cached` and an update loop in React 18).
   *
   * When this clip is the actively-dragged one, the local `transitionResize`
   * state drives the preview; when it's the seam neighbour, we derive the
   * preview edge + duration from this value in render.
   */
  const liveResize = useUIStore((s) => s.liveTransitionResize)
  const isGraphOpen = useUIStore((s) =>
    s.keyframeGraphClipIds.includes(clip.id),
  )
  const toggleKeyframeGraph = useUIStore((s) => s.toggleKeyframeGraph)

  /**
   * Whether the graph affordance is meaningful for this clip's track. The
   * animatable property registry is built around `clip.transform` — only
   * visual tracks render that, so audio clips don't get the toggle.
   */
  const supportsKeyframeGraph = track.type === 'video' || track.type === 'caption'
  const hasKeyframeData = (clip.keyframeTracks?.length ?? 0) > 0
  const liveNeighbourResize =
    liveResize && liveResize.neighbourClipId === clip.id && liveResize.neighbourEdge
      ? { edge: liveResize.neighbourEdge, durationMs: liveResize.durationMs }
      : null

  // ── Computed visual dimensions ──

  const nominalLeft = clip.startTime * pxPerMs
  const nominalWidth = Math.max(8, clip.duration * pxPerMs)

  const displayLeft = previewLeft ?? nominalLeft
  const displayWidth = previewWidth ?? nominalWidth

  // ── Progressive disclosure based on rendered clip width ──
  //
  // At small widths (heavily zoomed-out timelines) the inner chrome — trim
  // handles, label, accessory icons — overlaps into illegible clutter. Hide
  // each affordance once the clip is narrower than the space it actually
  // needs to render and be hit-tested cleanly. Trim handles drop first
  // because, below ~36px, both 8px hit zones together consume nearly half
  // the clip and the user can't grab them anyway.
  const showTrimHandles = displayWidth >= MIN_WIDTH_FOR_TRIM_HANDLES
  const showLabel = displayWidth >= MIN_WIDTH_FOR_LABEL
  const showLinkButton = displayWidth >= MIN_WIDTH_FOR_LINK_BUTTON
  const showGraphButton = displayWidth >= MIN_WIDTH_FOR_GRAPH_BUTTON
  const showTypeIcon = displayWidth >= MIN_WIDTH_FOR_TYPE_ICON

  // ── Audio waveform (for audio / clip_audio tracks when URL is available) ──

  const isAudioTrack = track.type === 'audio' || track.type === 'clip_audio'
  const audioUrl = assetUrlMap?.[clip.assetId]
  // ~1 bar per 1.5 CSS px gives a dense, continuous waveform without burning
  // too many cycles on long clips. Capped well above the previous 150 so wide
  // clips don't degrade into a row of spaced rectangles.
  const numBars = Math.min(900, Math.max(32, Math.ceil(displayWidth / 4)))
  const {
    peaks,
    rms,
    loading: peaksLoading,
  } = useAudioPeaks(
    isAudioTrack && audioUrl
      ? {
          url: audioUrl,
          sourceDurationMs: clip.sourceDurationMs ?? clip.outPoint ?? clip.duration,
          inPointMs: clip.inPoint,
          outPointMs: clip.outPoint,
          numBars,
        }
      : { url: undefined, sourceDurationMs: 0, inPointMs: 0, outPointMs: 0, numBars: 0 },
  )
  const showWaveform = isAudioTrack && peaks.length > 0
  // Decoded but truly silent: getPeaksForSegment leaves every bar at exactly 0
  // when maxPeak was 0 in the raw samples. Render a flat centerline so users
  // can tell "this clip has no audio" apart from "this clip is quiet".
  const isSilent = showWaveform && peaks.every((p) => p === 0)

  // Build the SVG path for a symmetric, filled waveform (top half mirrors
  // bottom half around y=0.5). Drawing as a single path avoids the per-bar
  // sub-pixel gaps that made the old <rect> grid look like disjointed dashes.
  const waveformPath = useMemo(() => {
    if (!showWaveform || isSilent) return { envelope: '', body: '' }
    const buildPath = (series: number[]) => {
      if (series.length === 0) return ''
      const n = series.length
      // Top edge left→right, then bottom edge right→left (mirrored).
      let top = ''
      let bottom = ''
      for (let i = 0; i < n; i++) {
        const h = Math.max(series[i]!, 0.04) // floor so silence still shows a hairline
        const yTop = 0.5 - h / 2
        const yBot = 0.5 + h / 2
        const x = i + 0.5 // sample at bin center for smoother joins
        top += `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${yTop.toFixed(3)} `
        bottom = `L${x.toFixed(2)} ${yBot.toFixed(3)} ` + bottom
      }
      return top + bottom + 'Z'
    }
    return { envelope: buildPath(peaks), body: buildPath(rms) }
  }, [showWaveform, isSilent, peaks, rms])

  // ── Video filmstrip (for moving-video clips when a URL is available) ──
  //
  // Decodes a few thumbnails across the clip's *trimmed* window via Mediabunny
  // and shows them as the clip background — the visual analogue of the audio
  // waveform. Count is derived from the source-window duration (one thumb per
  // ~1.2s, clamped 3–12) NOT the live pixel width, so zooming/dragging doesn't
  // trigger a re-decode. Still images and audio clips opt out.
  const isVideoClip = track.type === 'video' && clip.kind !== 'image'
  const filmstripUrl = isVideoClip ? assetUrlMap?.[clip.assetId] : undefined
  const srcWindowSec = Math.max(0, (clip.outPoint - clip.inPoint) / 1000)
  const filmstrip = useClipFilmstrip({
    url: filmstripUrl,
    count: filmstripUrl ? Math.min(12, Math.max(3, Math.round(srcWindowSec / 1.2))) : 0,
    startSec: clip.inPoint / 1000,
    endSec: clip.outPoint / 1000,
  })
  const showFilmstrip = filmstrip.length > 0

  // ── Track type styling ──

  const baseTypeConfig = TRACK_TYPE_CONFIG[track.type]
  const isImageClip = track.type === 'video' && clip.kind === 'image'
  const typeConfig = isImageClip
    ? {
        ...baseTypeConfig,
        clipClass: IMAGE_CLIP_STYLE.clipClass,
        clipSelectedClass: IMAGE_CLIP_STYLE.clipSelectedClass,
        clipRingClass: IMAGE_CLIP_STYLE.clipRingClass,
      }
    : baseTypeConfig

  /** When dragging a video clip: move the linked clip_audio horizontally. */
  const syncLinkedAudioPosition = useCallback(
    (videoClipId: string, leftPx: number) => {
      if (track.type !== 'video') return
      if (typeof document === 'undefined') return

      const audioEl = document.querySelector<HTMLElement>(
        `[data-source-video-clip-id="${videoClipId}"]`,
      )
      if (audioEl) {
        audioEl.style.left = `${leftPx}px`
      }
    },
    [track.type],
  )

  /** When dragging a video clip: resize the linked clip_audio horizontally. */
  const syncLinkedAudioWidth = useCallback(
    (videoClipId: string, widthPx: number) => {
      if (track.type !== 'video') return
      if (typeof document === 'undefined') return

      const audioEl = document.querySelector<HTMLElement>(
        `[data-source-video-clip-id="${videoClipId}"]`,
      )
      if (audioEl) {
        audioEl.style.width = `${widthPx}px`
      }
    },
    [track.type],
  )

  /** When dragging a clip_audio: move the linked video clip horizontally. */
  const syncLinkedVideoPosition = useCallback(
    (videoClipId: string, leftPx: number) => {
      if (track.type !== 'clip_audio') return
      if (typeof document === 'undefined') return

      const videoEl = document.querySelector<HTMLElement>(`[data-clip-id="${videoClipId}"]`)
      if (videoEl) {
        videoEl.style.left = `${leftPx}px`
      }
    },
    [track.type],
  )

  /** When dragging a clip_audio: resize the linked video clip horizontally. */
  const syncLinkedVideoWidth = useCallback(
    (videoClipId: string, widthPx: number) => {
      if (track.type !== 'clip_audio') return
      if (typeof document === 'undefined') return

      const videoEl = document.querySelector<HTMLElement>(`[data-clip-id="${videoClipId}"]`)
      if (videoEl) {
        videoEl.style.width = `${widthPx}px`
      }
    },
    [track.type],
  )

  // ── Shared pointer move / up handler ──

  /**
   * Compute the preview position during pointer move based on drag type and delta.
   */
  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragStateRef.current
      if (!drag) return
      e.preventDefault()

      const dx = e.clientX - drag.startClientX
      const deltaMs = dx / pxPerMs
      const playheadMs = usePlaybackStore.getState().playheadPosition

      if (drag.type === 'move') {
        // Compute new startTime with snap applied. A move keeps the clip's
        // duration rigid, so both the leading (end) and trailing (start)
        // edges are valid snap candidates — whichever is closer wins. Without
        // testing the end, butting the clip up against the next clip's start
        // (forward drag) wouldn't lock in.
        let newStartTime = Math.max(0, drag.originalStartTime + deltaMs)
        if (snapEnabled) {
          newStartTime = applySnapMove(
            newStartTime,
            clip.duration,
            snapPoints,
            playheadMs,
            pxPerMs,
          )
          newStartTime = Math.max(0, newStartTime)
        }
        // Group drag: clamp the resolved delta so no sibling can be pushed
        // past t=0. The clamp is applied after snap so the primary still
        // honours snap points whenever possible.
        if (drag.groupSiblings.length > 0) {
          const minPrimaryStart =
            drag.originalStartTime - drag.groupMaxNegativeDeltaMs
          if (newStartTime < minPrimaryStart) newStartTime = minPrimaryStart
        }
        const newLeftPx = newStartTime * pxPerMs
        setPreviewLeft(newLeftPx)
        if (isAudioLinked) {
          syncLinkedAudioPosition(clip.id, newLeftPx)
          if (clip.sourceVideoClipId) {
            syncLinkedVideoPosition(clip.sourceVideoClipId, newLeftPx)
          }
        }

        // Sync every other selected clip's DOM position by the same delta.
        // Pure DOM mutation (no React) so a dense selection doesn't burn a
        // re-render per pointer move. The store update on release lets React
        // catch up to the committed positions.
        if (drag.groupSiblings.length > 0) {
          const groupDeltaMs = newStartTime - drag.originalStartTime
          for (const sibling of drag.groupSiblings) {
            const el = document.querySelector<HTMLElement>(
              `[data-clip-id="${sibling.clipId}"]`,
            )
            if (!el) continue
            const siblingLeftPx =
              (sibling.originalStartTime + groupDeltaMs) * pxPerMs
            el.style.left = `${siblingLeftPx}px`
          }
        }

        // Cross-track detection: find the first lane under the pointer that
        // can actually accept this clip. The store rejects moves between
        // incompatible track types and won't drop into a locked lane, so we
        // gate the in-flight target the same way to keep the ghost honest:
        // hovering an invalid lane reads as "no drop target" rather than a
        // false-positive landing site that bounces on release.
        const elements = document.elementsFromPoint(e.clientX, e.clientY)
        let foundCompatibleId: string | null = null
        for (const el of elements) {
          const candidate = el as HTMLElement
          const foundId = candidate.dataset?.trackContentId
          if (!foundId) continue
          const foundType = candidate.dataset?.trackType
          const foundLocked = candidate.dataset?.trackLocked === 'true'
          // Same track is always valid (a horizontal-only move).
          if (foundId === track.id) {
            foundCompatibleId = foundId
            break
          }
          if (foundType === track.type && !foundLocked) {
            foundCompatibleId = foundId
            break
          }
          // First lane under the pointer is incompatible — don't keep looking
          // through stacked lanes underneath. Treat as "no valid target".
          break
        }
        // No valid lane under the pointer → fall back to the source so a
        // release commits a horizontal-only move (or nothing if start time
        // didn't change) instead of silently rejecting in the store.
        targetTrackIdRef.current = foundCompatibleId ?? track.id

        // Broadcast a ghost in the target lane when the pointer has crossed
        // out of the source track. The clip's own DOM stays parented to its
        // source row (which clips with overflow-hidden), so without this the
        // user has no visual cue that a different track is the drop target.
        const targetTrackId = targetTrackIdRef.current
        if (targetTrackId && targetTrackId !== track.id) {
          setLiveClipDrag({
            clipId: clip.id,
            sourceTrackId: track.id,
            targetTrackId,
            leftPx: newLeftPx,
            widthPx: Math.max(8, clip.duration * pxPerMs),
            clipClass: typeConfig.clipClass,
            clipSelectedClass: typeConfig.clipSelectedClass,
          })
        } else {
          setLiveClipDrag(null)
        }
      } else if (drag.type === 'trim-start') {
        // Trim from the left edge: move startTime forward and shrink duration,
        // or backward to reveal previously-trimmed source content. Media-backed
        // clips can extend left by up to `inPoint / speed` ms (the amount of
        // source that exists before the current in-point). Caption clips have
        // no source media, so they can extend freely down to t=0. Always clamp
        // at the nearest left neighbor on the same track to forbid overlap.
        //
        // Rate-stretch mode swaps the source cap for a speed-derived cap: the
        // source material is unchanged, so the duration range is sourceDuration
        // scaled by the [0.25×, 4×] speed bounds.
        const isCaption = track.type === 'caption'
        const isRateStretch = activeToolMode === 'rate-stretch'
        const minStartMs = 0
        const sourceDuration = clip.outPoint - clip.inPoint
        const minStartNoExtend = isRateStretch
          ? Math.max(0, drag.originalStartTime + drag.originalDuration - sourceDuration * 4)
          : isCaption
            ? 0
            : Math.max(0, drag.originalStartTime - clip.inPoint / clip.speed)
        const leftNeighborEndMs = track.clips.reduce((max, other) => {
          if (other.id === clip.id) return max
          const end = other.startTime + other.duration
          return end <= drag.originalStartTime && end > max ? end : max
        }, minStartMs)
        const minStart = Math.max(minStartNoExtend, leftNeighborEndMs)
        const speedMinDurationMs = isRateStretch ? sourceDuration / 4 : 1 / pxPerMs
        const maxStartMs = drag.originalStartTime + drag.originalDuration - speedMinDurationMs
        let newStart = Math.max(minStart, Math.min(maxStartMs, drag.originalStartTime + deltaMs))
        if (snapEnabled) {
          newStart = applySnap(newStart, snapPoints, playheadMs, pxPerMs)
          newStart = Math.max(minStart, Math.min(maxStartMs, newStart))
        }
        const newDuration = drag.originalStartTime + drag.originalDuration - newStart
        const newLeftPx = newStart * pxPerMs
        const newWidthPx = Math.max(8, newDuration * pxPerMs)
        setPreviewLeft(newLeftPx)
        setPreviewWidth(newWidthPx)

        // Keep linked clip (audio<->video) visually in sync while trimming start.
        if (isAudioLinked) {
          if (track.type === 'video') {
            syncLinkedAudioPosition(clip.id, newLeftPx)
            syncLinkedAudioWidth(clip.id, newWidthPx)
          } else if (track.type === 'clip_audio' && clip.sourceVideoClipId) {
            syncLinkedVideoPosition(clip.sourceVideoClipId, newLeftPx)
            syncLinkedVideoWidth(clip.sourceVideoClipId, newWidthPx)
          }
        }
      } else if (drag.type === 'trim-end') {
        // Trim from the right edge: only duration changes, startTime stays.
        // Media-backed clips are capped at source asset length. Captions have
        // no underlying media, so the right edge can be dragged out arbitrarily.
        // Always clamp at the nearest right neighbor on the same track to
        // forbid overlap.
        //
        // Rate-stretch mode replaces the source-bound cap with a speed-derived
        // cap: max duration corresponds to the slowest allowed speed (0.25×),
        // min duration to the fastest (4×).
        const isCaption = track.type === 'caption'
        const isRateStretch = activeToolMode === 'rate-stretch'
        const sourceDuration = clip.outPoint - clip.inPoint
        const minDurationMs = isRateStretch
          ? Math.max(1 / pxPerMs, sourceDuration / 4)
          : 1 / pxPerMs
        const maxOutPoint = clip.sourceDurationMs ?? clip.outPoint
        const sourceMaxDurationMs = isRateStretch
          ? sourceDuration * 4
          : isCaption
            ? Number.POSITIVE_INFINITY
            : (maxOutPoint - clip.inPoint) / clip.speed
        const originalEnd = drag.originalStartTime + drag.originalDuration
        const rightNeighborStartMs = track.clips.reduce((min, other) => {
          if (other.id === clip.id) return min
          return other.startTime >= originalEnd && other.startTime < min ? other.startTime : min
        }, Number.POSITIVE_INFINITY)
        const maxEndTime = Math.min(
          drag.originalStartTime + sourceMaxDurationMs,
          rightNeighborStartMs,
        )
        let newEndTime = Math.max(
          drag.originalStartTime + minDurationMs,
          Math.min(maxEndTime, drag.originalStartTime + drag.originalDuration + deltaMs),
        )
        if (snapEnabled) {
          newEndTime = applySnapToEnd(newEndTime, snapPoints, playheadMs, pxPerMs)
          newEndTime = Math.min(maxEndTime, newEndTime)
        }
        const newDuration = newEndTime - drag.originalStartTime
        const newWidthPx = Math.max(8, newDuration * pxPerMs)
        setPreviewWidth(newWidthPx)

        // Keep linked clip (audio<->video) visually in sync while trimming end.
        if (isAudioLinked) {
          if (track.type === 'video') {
            syncLinkedAudioWidth(clip.id, newWidthPx)
          } else if (track.type === 'clip_audio' && clip.sourceVideoClipId) {
            syncLinkedVideoWidth(clip.sourceVideoClipId, newWidthPx)
          }
        }
      } else if (drag.type === 'slip') {
        // Slip: pointer X drags the source window through the clip's fixed
        // timeline slot. Drag-right pulls earlier source in from the left
        // (inPoint decreases) — i.e. the content moves *with* the cursor.
        //
        // Translate timeline-pixel delta into source-time ms by multiplying
        // by the clip's playback speed (a 2× clip exposes 2 source-ms per
        // timeline-ms). Then clamp so the source window stays inside
        // `[0, sourceEnd]`; the store re-clamps as a safety net but mirroring
        // the bound here keeps the preview badge honest.
        const pixelDelta = e.clientX - drag.startClientX
        const sourceDeltaUnclamped = -(pixelDelta / pxPerMs) * clip.speed
        const sourceEnd = clip.sourceDurationMs ?? clip.outPoint
        const maxPositiveDelta = Math.max(0, sourceEnd - clip.outPoint)
        const maxNegativeDelta = -clip.inPoint
        const sourceDeltaMs = Math.max(
          maxNegativeDelta,
          Math.min(maxPositiveDelta, sourceDeltaUnclamped),
        )
        setSlipPreviewDeltaMs(sourceDeltaMs)
        // Broadcast the delta so PreviewCanvas can re-scrub to the new source
        // frame in real time. The clip's timeline position is unchanged, so
        // the only visible effect downstream is the frame swap on the canvas.
        setLiveSlip({ clipId: clip.id, sourceDeltaMs })
      }
    },
    [
      pxPerMs,
      snapEnabled,
      snapPoints,
      syncLinkedAudioPosition,
      syncLinkedAudioWidth,
      syncLinkedVideoPosition,
      syncLinkedVideoWidth,
      clip.id,
      clip.duration,
      clip.sourceVideoClipId,
      clip.sourceDurationMs,
      clip.outPoint,
      clip.inPoint,
      clip.speed,
      track.id,
      track.type,
      track.clips,
      isAudioLinked,
      setLiveClipDrag,
      setLiveSlip,
      typeConfig.clipClass,
      typeConfig.clipSelectedClass,
      activeToolMode,
    ],
  )

  /**
   * Commit the drag to the store on pointer release.
   */
  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragStateRef.current
      if (!drag) return
      e.preventDefault()

      if (drag.type === 'move') {
        const finalStartTime = previewLeft != null ? previewLeft / pxPerMs : drag.originalStartTime
        if (drag.groupSiblings.length > 0) {
          // Group move: commit the primary clip together with every sibling
          // shifted by the same delta. Siblings stay on their original
          // tracks; only the primary can change lanes. One history entry.
          const groupDeltaMs = finalStartTime - drag.originalStartTime
          const moves = [
            {
              clipId: clip.id,
              newTrackId: targetTrackIdRef.current,
              newStartTime: finalStartTime,
            },
            ...drag.groupSiblings.map((s) => ({
              clipId: s.clipId,
              newTrackId: s.sourceTrackId,
              newStartTime: Math.max(0, s.originalStartTime + groupDeltaMs),
            })),
          ]
          onMoveClips(moves)
        } else {
          onMoveClip(clip.id, targetTrackIdRef.current, finalStartTime)
        }
      } else if (drag.type === 'trim-start') {
        const finalStart = previewLeft != null ? previewLeft / pxPerMs : drag.originalStartTime
        if (activeToolMode === 'rate-stretch') {
          onRateStretchClip(clip.id, 'start', finalStart)
        } else {
          onTrimClip(clip.id, 'start', finalStart)
        }
      } else if (drag.type === 'trim-end') {
        const finalWidth = previewWidth != null ? previewWidth : nominalWidth
        const finalEnd = clip.startTime + finalWidth / pxPerMs
        if (activeToolMode === 'rate-stretch') {
          onRateStretchClip(clip.id, 'end', finalEnd)
        } else {
          onTrimClip(clip.id, 'end', finalEnd)
        }
      } else if (drag.type === 'slip') {
        // Commit the accumulated source shift. A zero delta short-circuits in
        // the store (no history entry) so a click-and-release with no movement
        // is a free no-op.
        const finalDelta = slipPreviewDeltaMs ?? 0
        if (finalDelta !== 0) onSlipClip(clip.id, finalDelta)
      }

      dragStateRef.current = null
      targetTrackIdRef.current = track.id
      setPreviewLeft(null)
      setPreviewWidth(null)
      setSlipPreviewDeltaMs(null)
      setIsDragging(false)
      setDragType(null)
      setLiveClipDrag(null)
      setLiveSlip(null)
    },
    [
      clip.id,
      clip.startTime,
      track.id,
      pxPerMs,
      previewLeft,
      previewWidth,
      nominalWidth,
      onMoveClip,
      onMoveClips,
      onTrimClip,
      onRateStretchClip,
      onSlipClip,
      slipPreviewDeltaMs,
      activeToolMode,
      setLiveClipDrag,
      setLiveSlip,
    ],
  )

  function cancelDrag() {
    const drag = dragStateRef.current
    dragStateRef.current = null
    targetTrackIdRef.current = track.id
    setPreviewLeft(null)
    setPreviewWidth(null)
    setSlipPreviewDeltaMs(null)
    setIsDragging(false)
    setDragType(null)
    setLiveClipDrag(null)
    setLiveSlip(null)

    // If a group drag was in flight, reset every sibling's inline left so
    // React's next render (still showing the unchanged store positions) lands
    // them back on their original spots instead of wherever the pointer last
    // dragged them to.
    if (drag && drag.type === 'move' && drag.groupSiblings.length > 0) {
      for (const sibling of drag.groupSiblings) {
        const el = document.querySelector<HTMLElement>(
          `[data-clip-id="${sibling.clipId}"]`,
        )
        if (!el) continue
        el.style.left = `${sibling.originalStartTime * pxPerMs}px`
      }
    }

    if (isAudioLinked) {
      if (track.type === 'video') {
        const resetLeft = clip.startTime * pxPerMs
        const resetWidth = Math.max(8, clip.duration * pxPerMs)
        syncLinkedAudioPosition(clip.id, resetLeft)
        syncLinkedAudioWidth(clip.id, resetWidth)
      }
      if (track.type === 'clip_audio' && clip.sourceVideoClipId) {
        const resetLeft = clip.startTime * pxPerMs
        const resetWidth = Math.max(8, clip.duration * pxPerMs)
        syncLinkedVideoPosition(clip.sourceVideoClipId, resetLeft)
        syncLinkedVideoWidth(clip.sourceVideoClipId, resetWidth)
      }
    }
  }

  // ── Clip body pointer down (move or slice) ──

  function handleBodyPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (track.locked) {
      // Surface why the click did nothing — otherwise locked tracks just feel
      // broken. Matches the slip/rate-stretch toast pattern below.
      editorToast.info('Track is locked — unlock it to edit clips.')
      return
    }
    e.stopPropagation()

    if (activeToolMode === 'slice') {
      // Slice mode: split the clip at the click position
      e.preventDefault()
      const clipRect = containerRef.current?.getBoundingClientRect()
      if (!clipRect) return
      const clickOffsetPx = e.clientX - clipRect.left
      const splitTimeMs = clip.startTime + clickOffsetPx / pxPerMs
      onSplitClip(clip.id, splitTimeMs)
      return
    }

    if (activeToolMode === 'rate-stretch') {
      // Rate-stretch operates on the edges, not the body. Clicking the body
      // just selects the clip so the user can see what they're targeting and
      // grab a handle — no move drag, otherwise the gesture would feel like
      // the tool isn't even active.
      if (e.shiftKey) {
        onToggleSelect(clip.id)
      } else if (!isSelected) {
        onSelect(clip.id)
      }
      return
    }

    if (activeToolMode === 'slip') {
      // Slip: drag the body to slide inPoint/outPoint together. Captions have
      // no source media to scrub, and image clips have no time dimension.
      // Reject both with a toast so the user understands why nothing happens.
      if (track.type === 'caption') {
        editorToast.info('Captions don’t have source content to slip — switch to the Select tool.')
        return
      }
      if (isImageClip) {
        editorToast.info('Still images have no source content to slip — switch to the Select tool.')
        return
      }
      e.preventDefault()
      onSelect(clip.id)
      containerRef.current?.setPointerCapture(e.pointerId)
      // If the playhead is parked outside this clip, the live slip preview on
      // the canvas would be invisible (the player is showing a different
      // clip's frame). Pull it onto the slipped clip — preferably to the
      // pointer's own time so the user sees the exact frame their cursor
      // anchors. Clamp inside the clip so the preview always reflects this
      // clip's source window, not its neighbours'.
      const playheadMs = usePlaybackStore.getState().playheadPosition
      const clipEnd = clip.startTime + clip.duration
      if (playheadMs < clip.startTime || playheadMs >= clipEnd) {
        const rect = containerRef.current?.getBoundingClientRect()
        const pointerTimeMs =
          rect && rect.width > 0
            ? clip.startTime + ((e.clientX - rect.left) / rect.width) * clip.duration
            : clip.startTime + clip.duration / 2
        const parkedMs = Math.max(
          clip.startTime,
          Math.min(clipEnd - 1, pointerTimeMs),
        )
        usePlaybackStore.getState().setPlayhead(parkedMs)
      }
      dragStateRef.current = {
        type: 'slip',
        startClientX: e.clientX,
        originalStartTime: clip.startTime,
        originalDuration: clip.duration,
        // Slip is single-clip — never grouped — even when multi-selected:
        // sliding source on one clip says nothing about what the others should
        // do, and applying the same offset to every selected clip would clamp
        // independently and produce inconsistent results.
        groupSiblings: [],
        groupMaxNegativeDeltaMs: 0,
      }
      setIsDragging(true)
      setDragType('slip')
      setSlipPreviewDeltaMs(0)
      return
    }

    if (
      activeToolMode === 'track-select-forward' ||
      activeToolMode === 'track-select-backward'
    ) {
      // Track-select: sweep every clip across every (unlocked) track on the
      // chosen side of the cursor into the selection. Tool stays active so
      // the user can re-sweep at a different cursor position; switch back via
      // the toolbar, V, or Escape. The cursor's X within the clip body
      // resolves to a global timeline ms — clicks on the clip use that exact
      // x rather than snapping to the clip edges, so a click near the middle
      // still selects everything from there outward.
      e.preventDefault()
      const clipRect = containerRef.current?.getBoundingClientRect()
      if (!clipRect) return
      const clickOffsetPx = e.clientX - clipRect.left
      const timeMs = Math.max(0, clip.startTime + clickOffsetPx / pxPerMs)
      const direction =
        activeToolMode === 'track-select-forward' ? 'forward' : 'backward'
      const allTracks = useEditorStore.getState().tracks
      const ids = collectClipIdsByDirection(allTracks, timeMs, direction)
      useSelectionStore.getState().setSelection(ids)
      return
    }

    // Select behavior
    if (e.shiftKey) {
      onToggleSelect(clip.id)
    } else if (!isSelected) {
      onSelect(clip.id)
    }

    // ── Group siblings ──
    //
    // Read selection AFTER the (possibly) selection-changing call above so the
    // siblings set reflects the user's intent for this gesture. A shift-click
    // that toggles this clip out of the selection naturally produces an empty
    // group; a plain click on an already-selected clip preserves the group.
    const selectionIds = useSelectionStore.getState().selectedClipIds
    const isGroupDrag = selectionIds.length > 1 && selectionIds.includes(clip.id)
    let groupSiblings: ClipDragState['groupSiblings'] = []
    let groupMaxNegativeDeltaMs = clip.startTime
    if (isGroupDrag) {
      const allTracks = useEditorStore.getState().tracks
      const captured: Array<{
        clipId: string
        sourceTrackId: string
        originalStartTime: number
      }> = []
      let minStart = clip.startTime
      for (const t of allTracks) {
        for (const c of t.clips) {
          if (!selectionIds.includes(c.id)) continue
          if (c.id === clip.id) {
            if (c.startTime < minStart) minStart = c.startTime
            continue
          }
          captured.push({
            clipId: c.id,
            sourceTrackId: t.id,
            originalStartTime: c.startTime,
          })
          if (c.startTime < minStart) minStart = c.startTime
        }
      }
      groupSiblings = captured
      groupMaxNegativeDeltaMs = minStart
    }

    // Begin move drag — capture on the container
    e.preventDefault()
    containerRef.current?.setPointerCapture(e.pointerId)
    dragStateRef.current = {
      type: 'move',
      startClientX: e.clientX,
      originalStartTime: clip.startTime,
      originalDuration: clip.duration,
      groupSiblings,
      groupMaxNegativeDeltaMs,
    }
    targetTrackIdRef.current = track.id
    setIsDragging(true)
    setDragType('move')
  }

  // ── Transition drop handlers (HTML5 DnD) ─────────────────────────────────
  //
  // Recognises an in-flight transition drag (MIME `application/hygc-transition`)
  // and shows a highlight on the affected clip edge. On drop, looks for an
  // adjacent clip on the same track that touches this edge (within ~50ms tolerance)
  // and dispatches `setSeamTransition` if found, otherwise `setClipTransition`.
  //
  // The tolerance covers floating-point drift introduced by trims/moves so a
  // visually-touching seam still registers as a seam.

  /**
   * Find a neighbor clip on the same track touching the given edge of this clip.
   * Returns the neighbor's id and timeline position relative to this clip.
   *
   * For `edge === 'in'`: looks for a clip whose end (startTime + duration)
   * is within tolerance of this clip's startTime.
   * For `edge === 'out'`: looks for a clip whose startTime is within
   * tolerance of this clip's endTime.
   */
  function findSeamNeighbor(edge: 'in' | 'out'): Clip | null {
    if (track.locked) return null
    if (edge === 'in') {
      const start = clip.startTime
      let best: Clip | null = null
      let bestGap = Infinity
      for (const other of track.clips) {
        if (other.id === clip.id) continue
        const otherEnd = other.startTime + other.duration
        const gap = Math.abs(otherEnd - start)
        if (otherEnd <= start + SEAM_TOLERANCE_MS && gap <= SEAM_TOLERANCE_MS && gap < bestGap) {
          best = other
          bestGap = gap
        }
      }
      return best
    }
    const end = clip.startTime + clip.duration
    let best: Clip | null = null
    let bestGap = Infinity
    for (const other of track.clips) {
      if (other.id === clip.id) continue
      const gap = Math.abs(other.startTime - end)
      if (other.startTime >= end - SEAM_TOLERANCE_MS && gap <= SEAM_TOLERANCE_MS && gap < bestGap) {
        best = other
        bestGap = gap
      }
    }
    return best
  }

  function handleTransitionDragOver(e: React.DragEvent<HTMLDivElement>, edge: 'in' | 'out') {
    if (track.locked || !onSetClipTransition) return
    if (track.type === 'caption') return
    const hasTransition = e.dataTransfer.types.includes(TRANSITION_DRAG_MIME_TYPE)
    if (!hasTransition) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
    setTransitionDropEdge(edge)
  }

  function handleTransitionDragLeave(e: React.DragEvent<HTMLDivElement>) {
    const related = e.relatedTarget as HTMLElement | null
    if (related && e.currentTarget.contains(related)) return
    setTransitionDropEdge(null)
  }

  function handleTransitionDrop(e: React.DragEvent<HTMLDivElement>, edge: 'in' | 'out') {
    setTransitionDropEdge(null)
    if (track.locked || !onSetClipTransition) return
    if (track.type === 'caption') return
    const raw = e.dataTransfer.getData(TRANSITION_DRAG_MIME_TYPE)
    if (!raw) return
    e.preventDefault()
    e.stopPropagation()
    let payload: DraggedTransitionPayload
    try {
      payload = JSON.parse(raw) as DraggedTransitionPayload
    } catch {
      return
    }

    const neighbor = findSeamNeighbor(edge)
    const isClear = payload.type === 'none'

    if (neighbor && onSetSeamTransition && !isClear) {
      // Seam: left clip's out + right clip's in
      const [leftId, rightId] = edge === 'in' ? [neighbor.id, clip.id] : [clip.id, neighbor.id]
      onSetSeamTransition(leftId, rightId, {
        type: payload.type,
        durationMs: payload.durationMs,
      })
      return
    }

    if (isClear) {
      onSetClipTransition(clip.id, edge, null)
      return
    }

    onSetClipTransition(clip.id, edge, {
      type: payload.type,
      durationMs: payload.durationMs,
    })
  }

  // ── Effect drop handlers (HTML5 DnD) ──────────────────────────────────────
  //
  // Recognises an in-flight effect drag (MIME `application/hygc-effect`) over
  // the whole clip body — effects aren't edge-targeted like transitions. On
  // drop, a fresh EffectInstance with default params is appended to the clip's
  // effect stack and the clip is selected so the Inspector shows the result.
  // Only video-track clips take visual effects.

  function handleEffectDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (track.locked || track.type !== 'video') return
    if (!e.dataTransfer.types.includes(EFFECT_DRAG_MIME_TYPE)) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
    setEffectDropActive(true)
  }

  function handleEffectDragLeave(e: React.DragEvent<HTMLDivElement>) {
    const related = e.relatedTarget as HTMLElement | null
    if (related && e.currentTarget.contains(related)) return
    setEffectDropActive(false)
  }

  function handleEffectDrop(e: React.DragEvent<HTMLDivElement>) {
    setEffectDropActive(false)
    if (track.locked || track.type !== 'video') return
    const raw = e.dataTransfer.getData(EFFECT_DRAG_MIME_TYPE)
    if (!raw) return
    e.preventDefault()
    e.stopPropagation()
    let payload: DraggedEffectPayload
    try {
      payload = JSON.parse(raw) as DraggedEffectPayload
    } catch {
      return
    }
    // Trust boundary: the payload came off the OS drag buffer — reject
    // anything that isn't a known effect type.
    if (!(payload.effectType in EFFECT_LABELS)) return
    useEditorStore.getState().addClipEffect(clip.id, createEffectInstance(payload.effectType))
    onSelect(clip.id)
  }

  // ── Transition resize handlers ─────────────────────────────────────────────
  //
  // Premiere-style: the inner edge of the checkered transition badge acts as
  // a resize handle. Dragging horizontally extends or shrinks the transition's
  // `durationMs`. While dragging we keep visual state local; on release we
  // commit through `onResizeTransition`, which the store handles by syncing
  // the paired half if this transition sits on a seam.

  /** Minimum transition duration in ms — one frame at 30fps. */
  const MIN_TRANSITION_MS = 33

  /**
   * Find the seam-paired neighbour clip for a given edge of this clip.
   *
   * For `edge === 'in'`: a clip whose end touches this clip's start AND that
   * has a `transitionOut` already set. For `edge === 'out'`: a clip whose
   * start touches this clip's end AND that has a `transitionIn` set. Returns
   * null when this is an isolated in/out animation (no paired half).
   */
  function findResizeSeamNeighbour(edge: 'in' | 'out'): Clip | null {
    if (edge === 'in') {
      const start = clip.startTime
      for (const other of track.clips) {
        if (other.id === clip.id) continue
        if (!other.transitionOut) continue
        const otherEnd = other.startTime + other.duration
        if (Math.abs(otherEnd - start) <= SEAM_TOLERANCE_MS) return other
      }
      return null
    }
    const end = clip.startTime + clip.duration
    for (const other of track.clips) {
      if (other.id === clip.id) continue
      if (!other.transitionIn) continue
      if (Math.abs(other.startTime - end) <= SEAM_TOLERANCE_MS) return other
    }
    return null
  }

  function handleTransitionResizePointerDown(
    e: React.PointerEvent<HTMLDivElement>,
    edge: 'in' | 'out',
  ) {
    if (track.locked) return
    const existing = edge === 'in' ? clip.transitionIn : clip.transitionOut
    if (!existing || existing.type === 'none') return
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    transitionResizeRef.current = {
      edge,
      startClientX: e.clientX,
      originalDurationMs: existing.durationMs,
    }
    setTransitionResize({ edge, durationMs: existing.durationMs })

    // Broadcast immediately so the paired neighbour (if any) picks up the
    // active resize highlight even before the cursor moves.
    const neighbour = findResizeSeamNeighbour(edge)
    setLiveTransitionResize({
      clipId: clip.id,
      edge,
      neighbourClipId: neighbour?.id ?? null,
      neighbourEdge: neighbour ? (edge === 'in' ? 'out' : 'in') : null,
      durationMs: existing.durationMs,
    })
  }

  function handleTransitionResizePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = transitionResizeRef.current
    if (!drag) return
    e.preventDefault()
    const dx = e.clientX - drag.startClientX
    // For the 'in' edge, dragging the inner (right) side of the badge to the
    // right grows the duration. For the 'out' edge, dragging the inner (left)
    // side to the left grows the duration. So we flip the sign for 'out'.
    const deltaMs = (drag.edge === 'in' ? dx : -dx) / pxPerMs

    // Find the paired neighbour (if any) for max-duration clamping so the
    // preview never overshoots what the store will accept.
    const neighbour = findResizeSeamNeighbour(drag.edge)

    const halfClip = clip.duration / 2
    const halfNeighbour = neighbour ? neighbour.duration / 2 : Infinity
    const maxDuration = Math.max(MIN_TRANSITION_MS, Math.min(halfClip, halfNeighbour))
    const next = Math.max(
      MIN_TRANSITION_MS,
      Math.min(maxDuration, drag.originalDurationMs + deltaMs),
    )
    setTransitionResize({ edge: drag.edge, durationMs: next })

    // Broadcast so the seam neighbour's badge previews in lockstep.
    setLiveTransitionResize({
      clipId: clip.id,
      edge: drag.edge,
      neighbourClipId: neighbour?.id ?? null,
      neighbourEdge: neighbour ? (drag.edge === 'in' ? 'out' : 'in') : null,
      durationMs: next,
    })
  }

  function handleTransitionResizePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const drag = transitionResizeRef.current
    if (!drag) return
    e.preventDefault()
    const preview = transitionResize
    transitionResizeRef.current = null
    setTransitionResize(null)
    setLiveTransitionResize(null)
    if (!preview || !onResizeTransition) return
    if (preview.durationMs === drag.originalDurationMs) return
    onResizeTransition(clip.id, drag.edge, preview.durationMs)
  }

  function handleTransitionResizePointerCancel() {
    transitionResizeRef.current = null
    setTransitionResize(null)
    setLiveTransitionResize(null)
  }

  // ── Trim handle pointer down ──

  function handleTrimPointerDown(e: React.PointerEvent<HTMLDivElement>, edge: TrimEdge) {
    if (track.locked) return
    e.preventDefault()
    e.stopPropagation()

    // Rate-stretch is only meaningful when the clip has a real source duration.
    // Captions are pure text and image clips have arbitrary length — neither
    // has a playback speed to scale. Bail with a toast so the user understands
    // why the drag was rejected instead of seeing a silent no-op.
    if (activeToolMode === 'rate-stretch') {
      if (track.type === 'caption') {
        editorToast.info('Captions don’t have a playback speed — use the regular trim instead.')
        return
      }
      if (isImageClip) {
        editorToast.info('Still images don’t have a playback speed — drag their edge with the Select tool instead.')
        return
      }
    }

    onSelect(clip.id)

    // Capture on the trim handle so pointer events route here during drag
    e.currentTarget.setPointerCapture(e.pointerId)
    dragStateRef.current = {
      type: edge === 'start' ? 'trim-start' : 'trim-end',
      startClientX: e.clientX,
      originalStartTime: clip.startTime,
      originalDuration: clip.duration,
      // Trim is never a group operation — only the dragged edge changes.
      groupSiblings: [],
      groupMaxNegativeDeltaMs: clip.startTime,
    }
    setIsDragging(true)
    setDragType(edge === 'start' ? 'trim-start' : 'trim-end')
  }

  // ── Visual type indicators inside the clip ──

  /** Small type-specific icon inside the clip body. */
  const clipTypeIcon = useMemo(() => {
    if (track.type === 'video') {
      if (isImageClip) {
        return (
          <svg
            width="9"
            height="9"
            viewBox="0 0 9 9"
            fill="none"
            stroke="currentColor"
            strokeWidth="0.9"
            className="shrink-0 opacity-70"
            aria-hidden
          >
            {/* Picture icon: framed rectangle with a hill + sun */}
            <rect x="0.6" y="0.9" width="7.8" height="7.2" rx="0.8" />
            <circle cx="2.7" cy="3" r="0.8" fill="currentColor" stroke="none" />
            <path d="M0.9 7.6 L3.6 4.7 L5.5 6.4 L7 5 L8.1 7.6 Z" fill="currentColor" stroke="none" />
          </svg>
        )
      }
      return (
        <svg
          width="9"
          height="9"
          viewBox="0 0 9 9"
          fill="currentColor"
          className="shrink-0 opacity-60"
          aria-hidden
        >
          {/* Film icon: rectangle with notches */}
          <rect x="0" y="1" width="6" height="7" rx="0.5" />
          <polygon points="6,3 9,1.5 9,7.5 6,6" />
        </svg>
      )
    }
    if (track.type === 'audio' || track.type === 'clip_audio') {
      return (
        <svg
          width="9"
          height="9"
          viewBox="0 0 9 9"
          fill="currentColor"
          className="shrink-0 opacity-60"
          aria-hidden
        >
          {/* Simplified waveform bars */}
          <rect x="0" y="3" width="1.2" height="3" rx="0.4" />
          <rect x="1.9" y="1.5" width="1.2" height="6" rx="0.4" />
          <rect x="3.8" y="0.5" width="1.2" height="8" rx="0.4" />
          <rect x="5.7" y="2" width="1.2" height="5" rx="0.4" />
          <rect x="7.6" y="3.5" width="1.2" height="2" rx="0.4" />
        </svg>
      )
    }
    // Caption: text "T" symbol
    return <span className="text-[8px] font-bold shrink-0 opacity-70 leading-none">T</span>
  }, [track.type, isImageClip])

  /** Label text: caption text for caption clips, formatted duration otherwise. */
  const clipLabel = clip.captionText
    ? clip.captionText.slice(0, 40)
    : formatClipDuration(clip.duration)

  return (
    <TimelineClipContextMenu clip={clip} track={track}>
      <div
        ref={containerRef}
        data-clip-id={clip.id}
        data-source-video-clip-id={clip.sourceVideoClipId}
        style={{
          left: displayLeft,
          width: displayWidth,
          // Pin the clip body to a fixed pixel height (independent of its
          // track row's height). Keyframe-graph expansion makes the row taller;
          // the clip itself must stay at its original visual size.
          top: 6,
          height: TRACK_ROW_HEIGHT - 12,
        }}
        className={`
        absolute rounded border flex items-center select-none
        transition-none
        ${typeConfig.clipClass}
        ${isSelected ? `ring-2 ${typeConfig.clipRingClass} ring-offset-0 ${typeConfig.clipSelectedClass}` : ''}
        ${isDragging && dragType === 'move' ? 'opacity-75 shadow-lg z-20 cursor-grabbing' : ''}
        ${activeToolMode === 'select' && !track.locked && !isDragging ? 'cursor-grab' : ''}
        ${activeToolMode === 'slice' && !track.locked ? 'cursor-crosshair' : ''}
        ${activeToolMode === 'track-select-forward' && !track.locked ? 'cursor-e-resize' : ''}
        ${activeToolMode === 'track-select-backward' && !track.locked ? 'cursor-w-resize' : ''}
        ${activeToolMode === 'slip' && !track.locked ? (dragType === 'slip' ? 'cursor-grabbing' : 'cursor-grab') : ''}
        ${track.locked ? 'cursor-not-allowed' : ''}
        ${effectDropActive ? 'ring-2 ring-primary ring-offset-0 bg-primary/20' : ''}
      `}
        onPointerDown={handleBodyPointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={cancelDrag}
        onDragOver={handleEffectDragOver}
        onDragLeave={handleEffectDragLeave}
        onDrop={handleEffectDrop}
        role="button"
        aria-selected={isSelected}
        aria-label={`${isImageClip ? 'image' : track.type} clip, ${formatClipDuration(clip.duration)}`}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            if (e.shiftKey) onToggleSelect(clip.id)
            else onSelect(clip.id)
          }
        }}
      >
        {/*
         * ── Video filmstrip background ─────────────────────────────────────────
         * Decoded thumbnails stretched edge-to-edge behind the clip chrome. The
         * gradient overlay darkens the frames just enough that the type icon and
         * label (lifted to z-[1] below) stay legible over bright footage.
         */}
        {showFilmstrip && (
          <div
            className="absolute inset-0 z-0 flex overflow-hidden rounded pointer-events-none"
            aria-hidden
          >
            {filmstrip.map((src, i) => (
              <img
                key={i}
                src={src}
                alt=""
                draggable={false}
                className="h-full min-w-0 flex-1 object-cover"
              />
            ))}
            <div className="absolute inset-0 bg-gradient-to-t from-black/45 via-black/10 to-black/25" />
          </div>
        )}

        {/*
         * ── Slip preview badge ────────────────────────────────────────────────
         * While the Slip tool is dragging, show the source-time delta as a
         * floating chip. The clip body itself doesn't move (that's the point
         * of slip), so without this the user has no on-screen confirmation
         * that anything is happening. Centered over the clip and pointer-
         * transparent so it can never block the in-flight pointer events.
         */}
        {slipPreviewDeltaMs !== null && (
          <div
            className="absolute inset-0 flex items-center justify-center pointer-events-none z-30"
            aria-hidden
          >
            <span className="px-1.5 py-0.5 rounded bg-background/85 text-foreground text-[10px] font-medium tabular-nums shadow-sm">
              Slip {slipPreviewDeltaMs >= 0 ? '+' : ''}
              {formatClipDuration(Math.abs(slipPreviewDeltaMs))}
              {slipPreviewDeltaMs < 0 ? ' back' : slipPreviewDeltaMs > 0 ? ' fwd' : ''}
            </span>
          </div>
        )}

        {/*
         * ── Applied transition badges ──────────────────────────────────────────
         * When the clip has a transition on its in or out edge, show a small
         * diagonal-hatched marker mirroring Premiere's visual language. The
         * marker sits above the trim handle but below the transition drop zone
         * so the user can still trim once a transition has been applied.
         */}
        {clip.transitionIn &&
          clip.transitionIn.type !== 'none' &&
          (() => {
            const liveDuration =
              transitionResize?.edge === 'in'
                ? transitionResize.durationMs
                : liveNeighbourResize?.edge === 'in'
                  ? liveNeighbourResize.durationMs
                  : clip.transitionIn.durationMs
            const badgeWidth = Math.max(12, Math.min(displayWidth / 2, liveDuration * pxPerMs))
            const isResizing = transitionResize?.edge === 'in' || liveNeighbourResize?.edge === 'in'
            return (
              <div
                className={`absolute left-0 top-0 bottom-0 z-[11] rounded-l overflow-hidden pointer-events-none ${
                  isTransitionInSelected ? 'ring-2 ring-ring ring-inset' : ''
                }`}
                style={{ width: badgeWidth }}
                title={`${getTransitionPreset(clip.transitionIn.type)?.label ?? clip.transitionIn.type} in · ${(liveDuration / 1000).toFixed(2)}s — click to edit, drag inner edge to resize`}
              >
                <div
                  className={`absolute inset-0 ${
                    isTransitionInSelected
                      ? 'bg-primary/45'
                      : isResizing
                        ? 'bg-primary/40'
                        : 'bg-primary/25'
                  }`}
                  style={{
                    backgroundImage:
                      'repeating-linear-gradient(-45deg, rgba(255,255,255,0.18) 0 2px, transparent 2px 5px)',
                  }}
                />
                <div className="absolute left-0 top-0 bottom-0 w-[2px] bg-primary/80" />
                {/*
                 * Click target: covers the body of the badge but leaves the inner
                 * 6px strip free for the resize handle. Selects the transition for
                 * editing in the inspector. pointer-events-auto re-enables events
                 * inside the otherwise pass-through wrapper.
                 *
                 * We act on pointerdown (not click) and stopPropagation so the parent
                 * clip body's pointerdown — which calls setPointerCapture — never
                 * runs. With capture set on the parent, pointerup gets redirected
                 * away from this element and the synthetic click never fires.
                 */}
                <div
                  className="absolute left-0 top-0 bottom-0 cursor-pointer pointer-events-auto"
                  style={{ right: 6 }}
                  onPointerDown={(e) => {
                    if (track.locked) return
                    e.preventDefault()
                    e.stopPropagation()
                    selectTransition({ clipId: clip.id, edge: 'in' })
                  }}
                  aria-label="Select in-transition"
                />
                {/* Resize handle on the inner (right) edge of the in-transition. */}
                <div
                  className="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-primary/50 touch-none pointer-events-auto"
                  onPointerDown={(e) => handleTransitionResizePointerDown(e, 'in')}
                  onPointerMove={handleTransitionResizePointerMove}
                  onPointerUp={handleTransitionResizePointerUp}
                  onPointerCancel={handleTransitionResizePointerCancel}
                  aria-label="Resize in-transition"
                />
              </div>
            )
          })()}
        {clip.transitionOut &&
          clip.transitionOut.type !== 'none' &&
          (() => {
            const liveDuration =
              transitionResize?.edge === 'out'
                ? transitionResize.durationMs
                : liveNeighbourResize?.edge === 'out'
                  ? liveNeighbourResize.durationMs
                  : clip.transitionOut.durationMs
            const badgeWidth = Math.max(12, Math.min(displayWidth / 2, liveDuration * pxPerMs))
            const isResizing =
              transitionResize?.edge === 'out' || liveNeighbourResize?.edge === 'out'
            return (
              <div
                className={`absolute right-0 top-0 bottom-0 z-[11] rounded-r overflow-hidden pointer-events-none ${
                  isTransitionOutSelected ? 'ring-2 ring-ring ring-inset' : ''
                }`}
                style={{ width: badgeWidth }}
                title={`${getTransitionPreset(clip.transitionOut.type)?.label ?? clip.transitionOut.type} out · ${(liveDuration / 1000).toFixed(2)}s — click to edit, drag inner edge to resize`}
              >
                <div
                  className={`absolute inset-0 ${
                    isTransitionOutSelected
                      ? 'bg-primary/45'
                      : isResizing
                        ? 'bg-primary/40'
                        : 'bg-primary/25'
                  }`}
                  style={{
                    backgroundImage:
                      'repeating-linear-gradient(-45deg, rgba(255,255,255,0.18) 0 2px, transparent 2px 5px)',
                  }}
                />
                <div className="absolute right-0 top-0 bottom-0 w-[2px] bg-primary/80" />
                {/* Click target — leaves 6px on the inner (left) edge for the resize handle.
                 * See the in-transition click target above for the pointerdown rationale. */}
                <div
                  className="absolute right-0 top-0 bottom-0 cursor-pointer pointer-events-auto"
                  style={{ left: 6 }}
                  onPointerDown={(e) => {
                    if (track.locked) return
                    e.preventDefault()
                    e.stopPropagation()
                    selectTransition({ clipId: clip.id, edge: 'out' })
                  }}
                  aria-label="Select out-transition"
                />
                {/* Resize handle on the inner (left) edge of the out-transition. */}
                <div
                  className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-primary/50 touch-none pointer-events-auto"
                  onPointerDown={(e) => handleTransitionResizePointerDown(e, 'out')}
                  onPointerMove={handleTransitionResizePointerMove}
                  onPointerUp={handleTransitionResizePointerUp}
                  onPointerCancel={handleTransitionResizePointerCancel}
                  aria-label="Resize out-transition"
                />
              </div>
            )
          })()}

        {/*
         * ── Transition drop zones ─────────────────────────────────────────────
         * Sit on top of the trim handles, but only intercept *drag* events
         * (dragover/drop). Pointer events (used for trim) pass straight through
         * because we don't subscribe to them here. So trim still works even
         * when a transition has already been applied.
         *
         * Width is generous (16px) so a transition tile is easy to drop. While
         * the user hovers, a chip with the transition's destination edge appears
         * inside the zone to confirm the action before release.
         */}
        <div
          className={`
          absolute left-0 top-0 bottom-0 w-4 z-[12] rounded-l
          ${transitionDropEdge === 'in' ? 'bg-primary/30 ring-1 ring-primary' : ''}
        `}
          style={{
            pointerEvents: transitionDragActive && track.type !== 'caption' ? 'auto' : 'none',
          }}
          onDragOver={(e) => handleTransitionDragOver(e, 'in')}
          onDragLeave={handleTransitionDragLeave}
          onDrop={(e) => handleTransitionDrop(e, 'in')}
          aria-hidden={transitionDropEdge !== 'in'}
        >
          {transitionDropEdge === 'in' && (
            <div className="absolute top-1/2 -translate-y-1/2 left-full ml-1 text-[9px] font-medium text-primary bg-background/95 px-1.5 py-0.5 rounded shadow-sm whitespace-nowrap pointer-events-none">
              {findSeamNeighbor('in') ? 'Drop on seam' : 'Drop at start'}
            </div>
          )}
        </div>
        <div
          className={`
          absolute right-0 top-0 bottom-0 w-4 z-[12] rounded-r
          ${transitionDropEdge === 'out' ? 'bg-primary/30 ring-1 ring-primary' : ''}
        `}
          style={{
            pointerEvents: transitionDragActive && track.type !== 'caption' ? 'auto' : 'none',
          }}
          onDragOver={(e) => handleTransitionDragOver(e, 'out')}
          onDragLeave={handleTransitionDragLeave}
          onDrop={(e) => handleTransitionDrop(e, 'out')}
          aria-hidden={transitionDropEdge !== 'out'}
        >
          {transitionDropEdge === 'out' && (
            <div className="absolute top-1/2 -translate-y-1/2 right-full mr-1 text-[9px] font-medium text-primary bg-background/95 px-1.5 py-0.5 rounded shadow-sm whitespace-nowrap pointer-events-none">
              {findSeamNeighbor('out') ? 'Drop on seam' : 'Drop at end'}
            </div>
          )}
        </div>

        {/*
         * ── Left trim handle ──────────────────────────────────────────────────
         * 8px wide hit target on the left edge. Cursor changes to ew-resize.
         * Has higher z-index than the body so it receives clicks near the edge.
         * Hidden when the clip is too narrow to grab a handle anyway — the
         * body's pointer events still fire across the full width, so the user
         * can move the clip; trimming requires zooming in first.
         */}
        {showTrimHandles && (
          <div
            className="
          absolute left-0 top-0 bottom-0 w-2 z-10
          cursor-ew-resize hover:bg-editor-on-chrome/20
          rounded-l
        "
            onPointerDown={(e) => handleTrimPointerDown(e, 'start')}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={cancelDrag}
            aria-label="Trim clip start"
            title="Drag to trim from start"
          >
            {/* Visual trim indicator — 2px vertical bar */}
            <div className="absolute left-0.5 top-1 bottom-1 w-0.5 rounded-full bg-editor-on-chrome/40" />
          </div>
        )}

        {/*
         * ── Clip body (content + drag area) ──────────────────────────────────
         * Padded to avoid overlapping the trim handles (8px on each side).
         * For audio/clip_audio with a resolved URL, show decoded waveform bars;
         * otherwise show type icon + label.
         */}
        <div
          className={`relative z-[1] flex-1 flex items-center gap-1 overflow-hidden min-w-0 ${
            showTrimHandles ? 'px-1.5 mx-1' : 'px-0.5'
          }`}
        >
          {showWaveform ? (
            <svg
              className="shrink-0 w-full h-6"
              viewBox={`0 0 ${peaks.length} 1`}
              preserveAspectRatio="none"
              aria-hidden
            >
              {!isSilent && (
                <>
                  {/* Envelope (peak): faint outer silhouette */}
                  <path d={waveformPath.envelope} fill="currentColor" opacity={0.35} />
                  {/* Body (RMS): solid inner shape — what the ear actually hears */}
                  <path d={waveformPath.body} fill="currentColor" opacity={0.85} />
                </>
              )}
              {/* Center line: anchors the eye on near-silent regions, and is
                  the only mark drawn when the clip has no audio at all. */}
              <line
                x1={0}
                x2={peaks.length}
                y1={0.5}
                y2={0.5}
                stroke="currentColor"
                strokeWidth={isSilent ? 0.04 : 0.01}
                opacity={isSilent ? 0.7 : 0.25}
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          ) : (
            <>
              {showTypeIcon && clipTypeIcon}
              {showLabel && (
                <span className="text-[9px] font-medium truncate leading-none pointer-events-none">
                  {clipLabel}
                </span>
              )}
              {isAudioTrack && peaksLoading && audioUrl && showLabel && (
                <span className="text-[8px] text-muted-foreground/70 shrink-0 pointer-events-none">
                  …
                </span>
              )}
            </>
          )}
          {supportsKeyframeGraph && showGraphButton && (
            <button
              type="button"
              className={`shrink-0 p-0.5 rounded pointer-events-auto touch-none transition-colors ${
                isGraphOpen
                  ? 'bg-primary/90 text-primary-foreground hover:bg-primary'
                  : hasKeyframeData
                    ? 'text-editor-on-chrome/80 hover:bg-editor-on-chrome/20'
                    : 'text-editor-on-chrome/40 hover:bg-editor-on-chrome/20 hover:text-editor-on-chrome/80'
              }`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                toggleKeyframeGraph(clip.id)
              }}
              title={
                isGraphOpen
                  ? 'Hide keyframe graph (G)'
                  : hasKeyframeData
                    ? 'Show keyframe graph (G)'
                    : 'Open keyframe graph (G)'
              }
              aria-label={isGraphOpen ? 'Hide keyframe graph' : 'Show keyframe graph'}
              aria-pressed={isGraphOpen}
            >
              <ChartSpline size={10} aria-hidden />
            </button>
          )}
          {showLinkControl && onSetClipAudioLinked && showLinkButton && (
            <button
              type="button"
              className="shrink-0 p-0.5 rounded hover:bg-editor-on-chrome/20 pointer-events-auto touch-none"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                const videoClipId = track.type === 'video' ? clip.id : clip.sourceVideoClipId
                if (videoClipId) onSetClipAudioLinked(videoClipId, !isAudioLinked)
              }}
              title={
                isAudioLinked
                  ? 'Unlink from clip audio — edit independently'
                  : 'Link to clip — move/trim together'
              }
              aria-label={isAudioLinked ? 'Unlink clip audio' : 'Link clip audio'}
            >
              {isAudioLinked ? (
                <Link size={10} className="opacity-80" aria-hidden />
              ) : (
                <Unlink size={10} className="opacity-60" aria-hidden />
              )}
            </button>
          )}
        </div>

        {/*
         * ── Right trim handle ─────────────────────────────────────────────────
         */}
        {showTrimHandles && (
          <div
            className="
          absolute right-0 top-0 bottom-0 w-2 z-10
          cursor-ew-resize hover:bg-editor-on-chrome/20
          rounded-r
        "
            onPointerDown={(e) => handleTrimPointerDown(e, 'end')}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={cancelDrag}
            aria-label="Trim clip end"
            title="Drag to trim from end"
          >
            {/* Visual trim indicator */}
            <div className="absolute right-0.5 top-1 bottom-1 w-0.5 rounded-full bg-editor-on-chrome/40" />
          </div>
        )}
      </div>
    </TimelineClipContextMenu>
  )
})
