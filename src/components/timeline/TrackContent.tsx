/**
 * TrackContent — the horizontally-scrollable clip area for a single timeline track.
 *
 * Renders all clips belonging to a track as absolutely-positioned blocks
 * within a container whose width matches the full timeline content width.
 * This creates the NLE "lane" layout where clips float at their `startTime`
 * position and can be freely moved along the time axis.
 *
 * Key responsibilities:
 *   - Renders `TimelineClip` for each clip on the track (sorted by startTime)
 *   - Shows an empty-state guide when no clips are present
 *   - Acts as a drop target for cross-track clip movement (detected via
 *     `data-track-content-id` attribute picked up by `TimelineClip`'s drag)
 *   - Acts as a drop target for assets dragged from the AssetPanel (Phase 3.7)
 *   - Handles clicks on empty areas to deselect all clips
 *
 * ─── Asset Drop (Phase 3.7) ─────────────────────────────────────────────────
 *
 *   When `onAssetDrop` is provided, this track lane becomes an HTML5 drop
 *   target for assets dragged from the AssetPanel sidebar. The flow:
 *
 *     1. User drags an asset card from the AssetPanel.
 *        AssetCard sets `dataTransfer.setData('application/hygc-asset', …)`.
 *
 *     2. The user hovers over a track lane. `onDragOver` reads the MIME type to
 *        verify a HyGC asset is being dragged (not a file from the OS or
 *        a DnD Kit clip drag). It sets `dropEffect = 'copy'` and adds a visual
 *        highlight via `isAssetDragOver` state.
 *
 *     3. On `onDrop`, the payload is parsed, the X coordinate is converted to
 *        a timeline position (ms), and `onAssetDrop(payload, startTimeMs)` is
 *        called. The Timeline component turns this into an `addClip` dispatch.
 *
 *   Visual feedback:
 *     - A blue highlight overlay appears on the track row while a compatible
 *       asset is hovering over it.
 *     - The "Drop clips here" empty-state text changes to "Release to add" when
 *       an asset hover is detected on an empty track.
 *
 *   Why HTML5 DnD instead of DnD Kit:
 *     DnD Kit is already used for track-reorder (SortableContext in Timeline.tsx)
 *     and for clip dragging within the timeline (pointer events in TimelineClip).
 *     Adding a third DnD Kit context for the sidebar-to-timeline drag would
 *     require restructuring the DnD context tree significantly. HTML5 DnD is
 *     independent of DnD Kit, uses a different event system (dataTransfer vs
 *     pointer events), and does not interfere with either existing DnD approach.
 *
 * Why absolute positioning over flexbox for clips:
 *   Clips have arbitrary `startTime` values and durations — they do not form
 *   a contiguous list. Absolute positioning is the only reasonable model for
 *   this. The container's total width is fixed to `contentWidth` so the CSS
 *   left values are meaningful.
 *
 * SOLID: SRP — only handles clip rendering within a track lane.
 *   No track metadata (label, mute, lock) — that's in TrackHeader.
 * SOLID: OCP — `onAssetDrop` is additive; the existing clip-drag pipeline
 *   is unchanged.
 *
 * @see PLAN.md Phase 3.4 "Track content (right): horizontally scrollable area
 *   with absolutely-positioned clip elements"
 * @see PLAN.md Phase 3.7 for asset panel drag-to-timeline requirements
 * @see TimelineClip.tsx for individual clip interaction handling
 * @see AssetBrowser.tsx for the drag source (ASSET_DRAG_MIME_TYPE, DraggedAssetPayload)
 */

import { memo, useCallback, useMemo, useState } from 'react'
import type { Track, TrimEdge, ClipTransition, ToolMode } from '../../types'
import { TimelineClip } from './TimelineClip'
import { TimelineTrackContextMenu } from './TimelineTrackContextMenu'
import { ClipKeyframeGraph } from './ClipKeyframeGraph'
import { PastePreviewGhost } from './PastePreviewGhost'
import { computeGraphHeightForClip } from './keyframe-graph-utils'
import { TRACK_ROW_HEIGHT, collectClipIdsByDirection } from './timeline-utils'
import { useUIStore } from '../../store/ui-store'
import { useSelectionStore } from '../../store/selection-store'
import { getSnapPoints, getClipAudioTrack, findClipById } from '../../engine/composition-utils'
import { ASSET_DRAG_MIME_TYPE } from '../../host'
import type { DraggedAssetPayload } from '../../host'

// ─── Component Props ──────────────────────────────────────────────────────────

export interface TrackContentProps {
  /** The track whose clips to render. */
  track: Track

  /** All timeline tracks (used to compute snap points across all tracks). */
  allTracks: Track[]

  /** Total pixel width of the timeline content area. */
  contentWidth: number

  /** Pixels per millisecond at the current zoom level. */
  pxPerMs: number

  /** Whether snap-to-edges is globally enabled. */
  snapEnabled: boolean

  /** The currently active tool mode. */
  activeToolMode: ToolMode

  /** IDs of currently selected clips. */
  selectedClipIds: string[]
  visibleStartMs: number
  visibleEndMs: number

  // ── Store callbacks ──

  onSelectClip: (clipId: string) => void
  onToggleSelectClip: (clipId: string) => void
  onDeselectAll: () => void
  onMoveClip: (clipId: string, newTrackId: string, newStartTime: number) => void
  onMoveClips: (
    moves: ReadonlyArray<{ clipId: string; newTrackId: string; newStartTime: number }>,
  ) => void
  onTrimClip: (clipId: string, edge: TrimEdge, newTime: number) => void
  onRateStretchClip: (clipId: string, edge: TrimEdge, newTime: number) => void
  onSlipClip: (clipId: string, sourceDeltaMs: number) => void
  onSplitClip: (clipId: string, atTime: number) => void

  /**
   * Set whether a video clip's audio is linked to its clip_audio.
   * Passed to TimelineClip for the link/unlink control.
   */
  onSetClipAudioLinked?: (videoClipId: string, linked: boolean) => void

  /** Apply or clear a transition on one edge of a clip. */
  onSetClipTransition?: (
    clipId: string,
    edge: 'in' | 'out',
    transition: ClipTransition | null,
  ) => void

  /** Apply a paired transition across the seam between two adjacent clips. */
  onSetSeamTransition?: (
    leftClipId: string,
    rightClipId: string,
    transition: ClipTransition,
  ) => void

  /** Resize an existing transition's duration (seam-aware). */
  onResizeTransition?: (clipId: string, edge: 'in' | 'out', newDurationMs: number) => void

  /**
   * Called when an asset is dropped from the AssetPanel sidebar onto this track.
   *
   * Phase 3.7: The Timeline component provides this callback, which creates a
   * clip from the asset data and dispatches `addClip(trackId, clip)`.
   *
   * @param payload     - The dragged asset's metadata (id, type, url, duration)
   * @param startTimeMs - The computed timeline position from the drop X coordinate
   */
  onAssetDrop?: (payload: DraggedAssetPayload, startTimeMs: number) => void

  /** Map of assetId -> URL for waveform rendering in audio clips. */
  assetUrlMap?: Record<string, string>
}

// ─── TrackContent Component ───────────────────────────────────────────────────

/**
 * TrackContent renders the clip lane for one track.
 *
 * @example
 *   <TrackContent
 *     track={track}
 *     allTracks={allTracks}
 *     contentWidth={6000}
 *     pxPerMs={0.1}
 *     snapEnabled={true}
 *     activeToolMode="select"
 *     selectedClipIds={[...]}
 *     onSelectClip={selectClip}
 *     onToggleSelectClip={toggleClipSelection}
 *     onDeselectAll={deselectAll}
 *     onMoveClip={moveClip}
 *     onTrimClip={trimClip}
 *     onSplitClip={splitClip}
 *     onAssetDrop={handleAssetDrop}
 *   />
 */
export const TrackContent = memo(function TrackContent({
  track,
  allTracks,
  contentWidth,
  pxPerMs,
  snapEnabled,
  activeToolMode,
  selectedClipIds,
  visibleStartMs,
  visibleEndMs,
  onSelectClip,
  onToggleSelectClip,
  onDeselectAll,
  onMoveClip,
  onMoveClips,
  onTrimClip,
  onRateStretchClip,
  onSlipClip,
  onSplitClip,
  onSetClipAudioLinked,
  onSetClipTransition,
  onSetSeamTransition,
  onResizeTransition,
  onAssetDrop,
  assetUrlMap,
}: TrackContentProps) {
  // ── Snap points ──

  // ── State ──

  const hasClips = track.clips.length > 0
  const isLocked = track.locked

  /**
   * Whether an asset from the sidebar is currently hovering over this lane.
   * Used to show a blue highlight overlay and update the empty-state text.
   */
  const [isAssetDragOver, setIsAssetDragOver] = useState(false)

  // ── Click handler for empty area ──

  const handleContentClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // Deselect when the click did not land on (or inside) a clip. The
      // background overlay sits above the data-attributed container, so we
      // can't gate on `data-track-content-id` of the target — check that no
      // ancestor up to currentTarget is a clip instead.
      const target = e.target as HTMLElement
      if (target.closest('[data-clip-id]')) return

      // Track Select Forward / Backward: clicking anywhere in a lane sweeps
      // every clip on every (unlocked) track that lies on the chosen side of
      // the cursor into the selection. The tool stays active so the user can
      // re-sweep at a different cursor position; switch back via the toolbar,
      // V, or Escape.
      if (
        activeToolMode === 'track-select-forward' ||
        activeToolMode === 'track-select-backward'
      ) {
        const rect = e.currentTarget.getBoundingClientRect()
        const timeMs = Math.max(0, (e.clientX - rect.left) / pxPerMs)
        const direction =
          activeToolMode === 'track-select-forward' ? 'forward' : 'backward'
        const ids = collectClipIdsByDirection(allTracks, timeMs, direction)
        useSelectionStore.getState().setSelection(ids)
        return
      }

      onDeselectAll()
    },
    [activeToolMode, allTracks, pxPerMs, onDeselectAll],
  )

  // ─── HTML5 Asset Drop Handlers (Phase 3.7) ────────────────────────────────

  /**
   * Verify that the dragged item is a HyGC asset (not an OS file or a
   * DnD Kit clip drag). DnD Kit uses pointer events exclusively and never
   * fires native dragover, so there is no risk of double-handling.
   *
   * We check `dataTransfer.types` here because `getData()` returns an empty
   * string during `dragover` in most browsers for security reasons (the data
   * is only readable in `drop` handlers). Checking the type string is
   * sufficient to verify intent without reading the payload early.
   */
  const handleDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!onAssetDrop || isLocked) return

      const hasAsset = e.dataTransfer.types.includes(ASSET_DRAG_MIME_TYPE)
      if (!hasAsset) return

      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      setIsAssetDragOver(true)
    },
    [onAssetDrop, isLocked],
  )

  /**
   * Clear the drag-over highlight when the drag exits this lane.
   *
   * The `relatedTarget` check prevents flickering when the drag passes
   * over child elements (clips, overlays) within the same lane: we only
   * clear the highlight when the drag truly leaves the track container.
   */
  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    const related = e.relatedTarget as HTMLElement | null
    if (related && e.currentTarget.contains(related)) return
    setIsAssetDragOver(false)
  }, [])

  /**
   * Handle asset drop from the AssetPanel sidebar.
   *
   * Converts the drop X coordinate to a timeline position using the current
   * zoom level (`pxPerMs`). The bounding rect of the container gives the
   * left offset, which is subtracted before dividing by `pxPerMs` to get ms.
   *
   * Result is clamped to 0 so clips cannot be placed before the timeline start.
   */
  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      setIsAssetDragOver(false)
      if (!onAssetDrop || isLocked) return

      const rawData = e.dataTransfer.getData(ASSET_DRAG_MIME_TYPE)
      if (!rawData) return

      e.preventDefault()

      let payload: DraggedAssetPayload
      try {
        payload = JSON.parse(rawData) as DraggedAssetPayload
      } catch {
        console.warn('[TrackContent] Failed to parse asset drag payload:', rawData)
        return
      }

      // Convert drop X position to timeline time
      const rect = e.currentTarget.getBoundingClientRect()
      const dropXRelative = e.clientX - rect.left
      const startTimeMs = Math.max(0, dropXRelative / pxPerMs)

      onAssetDrop(payload, startTimeMs)
    },
    [onAssetDrop, isLocked, pxPerMs],
  )

  // ── Sort clips by startTime for deterministic z-index (later clips on top) ──

  const sortedClips = useMemo(
    () =>
      [...track.clips]
        .sort((a, b) => a.startTime - b.startTime)
        .filter(
          (clip) =>
            clip.startTime + clip.duration >= visibleStartMs && clip.startTime <= visibleEndMs,
        ),
    [track.clips, visibleStartMs, visibleEndMs],
  )

  // Clips on this track whose keyframe graph is expanded under them.
  const expandedGraphClipIds = useUIStore((s) => s.keyframeGraphClipIds)
  const expandedGraphClips = useMemo(
    () => sortedClips.filter((c) => expandedGraphClipIds.includes(c.id)),
    [sortedClips, expandedGraphClipIds],
  )

  // Cross-track drag ghost — painted only when this lane is the active target
  // for a clip being dragged from a different lane. Driven by `TimelineClip`
  // via the UI store; cleared on pointer release.
  const liveClipDrag = useUIStore((s) => s.liveClipDrag)
  const ghost =
    liveClipDrag &&
    liveClipDrag.targetTrackId === track.id &&
    liveClipDrag.sourceTrackId !== track.id
      ? liveClipDrag
      : null

  return (
    <TimelineTrackContextMenu track={track}>
      <div
        /**
         * data-track-content-id is used by TimelineClip's cross-track detection.
         * When a clip is dragged, it calls document.elementsFromPoint() and looks
         * for this attribute to determine which track to drop into.
         *
         * data-track-type lets the drag source reject incompatible lanes (e.g.
         * a video clip hovering an audio track) without a store round-trip.
         */
        data-track-content-id={track.id}
        data-track-type={track.type}
        data-track-locked={isLocked ? 'true' : 'false'}
        className={`
        relative h-full overflow-hidden
        ${isLocked ? 'opacity-70 cursor-not-allowed' : ''}
      `}
        style={{ width: contentWidth }}
        onClick={handleContentClick}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        aria-label={`Track content for ${track.label}${isLocked ? ' (locked)' : ''}`}
      >
        {/* ── Background texture ── */}
        <div
          className={`
          absolute inset-0 transition-colors
          ${
            isAssetDragOver
              ? 'bg-primary/15 border-2 border-dashed border-primary/50'
              : isLocked
                ? 'bg-muted/5'
                : 'bg-muted/10 hover:bg-muted/15'
          }
        `}
          aria-hidden
        />

        {/* ── Empty state guide ──
            New users land on empty tracks and don't always know an asset drag
            is the way in. With nothing else to compete for attention on an
            empty lane, we center the hint and bump it past the previous
            barely-there opacity — readable, still subordinate to real clips
            (which never share this space). */}
        {!hasClips && !isLocked && (
          <div
            className="absolute inset-0 flex items-center justify-center pointer-events-none"
            aria-hidden
          >
            <span className="text-[10px] text-muted-foreground/55 select-none tracking-wide">
              {isAssetDragOver
                ? 'Release to add clip'
                : 'Drag an asset here — or right-click for track actions'}
            </span>
          </div>
        )}

        {/* ── Asset drop hint overlay (when dragging over a non-empty track) ── */}
        {hasClips && isAssetDragOver && (
          <div
            className="absolute inset-0 flex items-center justify-center pointer-events-none z-10"
            aria-hidden
          >
            <span className="text-[9px] text-primary/80 font-medium bg-primary/10 px-2 py-0.5 rounded">
              Release to add clip
            </span>
          </div>
        )}

        {/* ── Locked overlay ── */}
        {isLocked && (
          <div className="absolute inset-0 flex items-center pointer-events-none" aria-hidden>
            <span className="text-[9px] text-muted-foreground/40 pl-3 select-none font-medium">
              Locked
            </span>
          </div>
        )}

        {/*
         * ── Clips ────────────────────────────────────────────────────────────
         * Each clip is absolutely positioned at `startTime * pxPerMs`.
         * The TimelineClip component manages its own drag preview, so the
         * position here is only the committed (stored) position.
         */}
        {sortedClips.map((clip) => {
          // Build snap points excluding this clip's own edges
          const clipSnapPoints = getSnapPoints(allTracks, [clip.id])

          const clipAudioTrack = getClipAudioTrack(allTracks)
          const hasLinkedClipAudio =
            track.type === 'video' &&
            (clipAudioTrack?.clips.some((c) => c.sourceVideoClipId === clip.id) ?? false)
          const isClipAudioWithSource = track.type === 'clip_audio' && !!clip.sourceVideoClipId
          const showLinkControl = hasLinkedClipAudio || isClipAudioWithSource
          const videoClipForLink =
            track.type === 'video' ? clip : findClipById(allTracks, clip.sourceVideoClipId!)?.clip
          const isAudioLinked = showLinkControl ? videoClipForLink?.audioLinked !== false : true

          return (
            <TimelineClip
              key={clip.id}
              clip={clip}
              track={track}
              pxPerMs={pxPerMs}
              snapPoints={clipSnapPoints}
              snapEnabled={snapEnabled}
              activeToolMode={activeToolMode}
              isSelected={selectedClipIds.includes(clip.id)}
              onSelect={onSelectClip}
              onToggleSelect={onToggleSelectClip}
              onMoveClip={onMoveClip}
              onMoveClips={onMoveClips}
              onTrimClip={onTrimClip}
              onRateStretchClip={onRateStretchClip}
              onSlipClip={onSlipClip}
              onSplitClip={onSplitClip}
              showLinkControl={showLinkControl}
              isAudioLinked={isAudioLinked}
              onSetClipAudioLinked={onSetClipAudioLinked}
              onSetClipTransition={onSetClipTransition}
              onSetSeamTransition={onSetSeamTransition}
              onResizeTransition={onResizeTransition}
              assetUrlMap={assetUrlMap}
            />
          )
        })}

        {/*
         * ── Paste-preview ghost ─────────────────────────────────────────────
         * When the user has clips on the in-memory clipboard, paint dashed
         * silhouettes at the playhead in each compatible lane so they can see
         * where Ctrl+V will land before pressing it. Only the entries whose
         * source track type matches this lane render — the ghost component
         * filters internally.
         *
         * Hidden while a cross-track drag is in flight (`ghost`, below) to
         * avoid double-overlay confusion: the user is mid-operation, not
         * planning a paste.
         */}
        {!isLocked && !ghost && (
          <PastePreviewGhost trackType={track.type} pxPerMs={pxPerMs} />
        )}

        {/*
         * ── Cross-track drag ghost ──────────────────────────────────────────
         * Translucent silhouette of the clip being dragged from a different
         * lane. Shows the user where the pointer release will commit. The real
         * clip stays painted on its source lane during the drag, so the ghost
         * here is the only visual cue that this is the active drop target.
         */}
        {ghost && (
          <div
            data-clip-drag-ghost={ghost.clipId}
            className={`
              absolute pointer-events-none rounded border-2 border-dashed
              ${ghost.clipClass}
              ${ghost.clipSelectedClass}
              opacity-60
            `}
            style={{
              left: ghost.leftPx,
              width: ghost.widthPx,
              top: 6,
              height: TRACK_ROW_HEIGHT - 12,
              zIndex: 19,
            }}
            aria-hidden
          />
        )}

        {/*
         * ── Expanded keyframe graphs ────────────────────────────────────────
         * Each expanded clip's graph sits directly under its body, occupying
         * the same x-range. The parent row's height is already grown to
         * accommodate the tallest expanded graph (see TimelineTrackList).
         */}
        {expandedGraphClips.map((clip) => {
          const left = clip.startTime * pxPerMs
          const width = Math.max(8, clip.duration * pxPerMs)
          const height = computeGraphHeightForClip(clip)
          return (
            <div
              key={`graph-${clip.id}`}
              data-keyframe-graph-clip-id={clip.id}
              className="absolute z-[5]"
              style={{
                left,
                width,
                top: TRACK_ROW_HEIGHT,
                height,
              }}
            >
              <ClipKeyframeGraph clip={clip} track={track} pxPerMs={pxPerMs} />
            </div>
          )
        })}
      </div>
    </TimelineTrackContextMenu>
  )
})
