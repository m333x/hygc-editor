/**
 * TimelineTrackList — DnD-Kit sortable wrapper around all track rows.
 *
 * Owns the multi-track reordering surface: sensors, DnD context, the
 * visual/audio separators, and the per-track `SortableTrackRow` rendering.
 * Also owns the cross-cutting actions that need toast affordances
 * (`handleAssetDrop`, `handleDeleteTrack`).
 *
 * Pulled out of `Timeline.tsx` so the parent file can focus on the scroll
 * container, ruler, viewport math, and layout chrome. A new track-level
 * affordance lands here without touching the timeline layout code.
 *
 * Visual layers (video, caption) live above a separator; audio layers
 * (audio, clip_audio) live below. Reorder is constrained to the same group.
 *
 * SOLID: SRP — only handles track-list DnD + per-track row composition.
 */

import { memo, useCallback, useMemo } from 'react'

import { editorToast } from '../EditorToast'
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
} from '@dnd-kit/core'
import type { DragEndEvent } from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  sortableKeyboardCoordinates,
  arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

import { useEditorStore } from '../../store/editor-store'
import { useSelectionStore } from '../../store/selection-store'
import { useUIStore } from '../../store/ui-store'
import type { Track, ClipTransition, ToolMode } from '../../types'
import type { DraggedAssetPayload } from '../../host'

import { TrackHeader } from './TrackHeader'
import { TrackContent } from './TrackContent'
import { computeGraphHeightForClip } from './keyframe-graph-utils'
import { RULER_HEIGHT, TRACK_HEADER_WIDTH, TRACK_ROW_HEIGHT } from './timeline-utils'

/** Visual track types render above the separator; everything else (audio) below. */
function isVisualTrack(track: Track): boolean {
  return track.type === 'video' || track.type === 'caption'
}

interface TimelineTrackListProps {
  /** Pixel width of the timeline content area minus the fixed track header column. */
  contentWidth: number
  /** Pixels per millisecond at the current zoom level. */
  pxPerMs: number
  /** Lower bound of the visible window in milliseconds (with a small buffer). */
  visibleStartMs: number
  /** Upper bound of the visible window in milliseconds (with a small buffer). */
  visibleEndMs: number
  /** assetId → URL map used for waveform and preview rendering. */
  assetUrlMap: Record<string, string>
}

export function TimelineTrackList({
  contentWidth,
  pxPerMs,
  visibleStartMs,
  visibleEndMs,
  assetUrlMap,
}: TimelineTrackListProps) {
  // ── Store ──

  const tracks = useEditorStore((s) => s.tracks)
  const reorderTracks = useEditorStore((s) => s.reorderTracks)
  const addAssetClipToTrack = useEditorStore((s) => s.addAssetClipToTrack)
  const moveClip = useEditorStore((s) => s.moveClip)
  const moveClips = useEditorStore((s) => s.moveClips)
  const trimClip = useEditorStore((s) => s.trimClip)
  const rateStretchClip = useEditorStore((s) => s.rateStretchClip)
  const slipClip = useEditorStore((s) => s.slipClip)
  const splitClip = useEditorStore((s) => s.splitClip)
  const setClipAudioLinked = useEditorStore((s) => s.setClipAudioLinked)
  const setClipTransition = useEditorStore((s) => s.setClipTransition)
  const setSeamTransition = useEditorStore((s) => s.setSeamTransition)
  const resizeTransition = useEditorStore((s) => s.resizeTransition)
  const removeTrack = useEditorStore((s) => s.removeTrack)
  const renameTrack = useEditorStore((s) => s.renameTrack)
  const toggleTrackMute = useEditorStore((s) => s.toggleTrackMute)
  const toggleTrackVisibility = useEditorStore((s) => s.toggleTrackVisibility)
  const toggleTrackLock = useEditorStore((s) => s.toggleTrackLock)
  const soloTrack = useEditorStore((s) => s.soloTrack)
  const undo = useEditorStore((s) => s.undo)

  const selectedClipIds = useSelectionStore((s) => s.selectedClipIds)
  const selectClip = useSelectionStore((s) => s.selectClip)
  const deselectAll = useSelectionStore((s) => s.deselectAll)
  const toggleClipSelection = useSelectionStore((s) => s.toggleClipSelection)

  const snapEnabled = useUIStore((s) => s.snapEnabled)
  const activeToolMode = useUIStore((s) => s.activeToolMode)

  // ── Derived ──

  // Storage uses `order` ascending where higher = renders later (on top). The
  // timeline UI flips that for visual tracks so the topmost row corresponds to
  // the topmost layer in the preview — standard NLE convention (V2 over V1).
  // Captions still anchor to the top of the visual section because the
  // composition always paints them last regardless of order.
  const sortedTracks = [...tracks].sort((a, b) => a.order - b.order)
  const audioTracks = sortedTracks.filter((t) => !isVisualTrack(t))
  const captionTracks = sortedTracks
    .filter((t) => t.type === 'caption')
  const videoTracks = [...sortedTracks]
    .filter((t) => t.type === 'video')
    .sort((a, b) => b.order - a.order)
  const visualTracks = [...captionTracks, ...videoTracks]

  // ── DnD sensors + drag-end handler ──

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return

    const activeTrack = sortedTracks.find((t) => t.id === active.id)
    const overTrack = sortedTracks.find((t) => t.id === over.id)
    if (!activeTrack || !overTrack) return

    const activeVisual = isVisualTrack(activeTrack)
    const overVisual = isVisualTrack(overTrack)
    if (activeVisual !== overVisual) return

    const groupTracks = activeVisual ? visualTracks : audioTracks
    const otherIds = activeVisual
      ? audioTracks.map((t) => t.id)
      : visualTracks.map((t) => t.id)
    const groupIds = groupTracks.map((t) => t.id)
    const oldIndex = groupIds.indexOf(active.id as string)
    const newIndex = groupIds.indexOf(over.id as string)
    if (oldIndex === -1 || newIndex === -1) return

    const reorderedGroupIds = arrayMove(groupIds, oldIndex, newIndex)
    // `reorderTracks` assigns each track's stored `order` to its index in the
    // input list (0 = lowest stacking layer in the renderer). For visual tracks
    // we display top-to-bottom in *descending* order so the topmost row matches
    // the topmost layer in the preview — so we reverse the visible visual list
    // before handing it back, otherwise the visible drag would silently invert
    // its effect on the rendered stack.
    const persistedVisualIds = activeVisual ? [...reorderedGroupIds].reverse() : null
    const fullOrder = activeVisual
      ? [...persistedVisualIds!, ...otherIds]
      : [...otherIds, ...reorderedGroupIds]
    reorderTracks(fullOrder)
  }

  // ── Asset drop ──

  const handleAssetDrop = useCallback(
    (trackId: string, payload: DraggedAssetPayload, startTimeMs: number) => {
      const targetTrack = tracks.find((t) => t.id === trackId)
      if (!targetTrack) return

      const isVideoOrImage = payload.type === 'video' || payload.type === 'image'
      const isAudioAsset = payload.type === 'audio'

      // Drop-rejection feedback: surface a non-fatal toast so the user
      // understands why the drop bounced rather than thinking it broke.
      if (targetTrack.type === 'clip_audio') {
        editorToast.info('This track is managed automatically — drop video on the Video lane instead.')
        return
      }
      if (targetTrack.type === 'video' && !isVideoOrImage) {
        editorToast.info('Video lane only accepts video and image assets.')
        return
      }
      if (targetTrack.type === 'audio' && !isAudioAsset) {
        editorToast.info('Audio lane only accepts audio assets.')
        return
      }
      if (targetTrack.type === 'caption' && (isVideoOrImage || isAudioAsset)) {
        editorToast.info('Caption lane is for text only — add captions from the toolbar.')
        return
      }

      const duration = payload.duration_ms ?? 5_000
      addAssetClipToTrack(trackId, {
        assetId: payload.id,
        assetType: payload.type,
        startTime: startTimeMs,
        duration,
        sourceDurationMs: duration,
      })
    },
    [addAssetClipToTrack, tracks],
  )

  // ── Delete track ──
  //
  // Optimistic delete + sonner undo affordance. `removeTrack` already pushes
  // to the history stack, so undo is one `store.undo()` away.

  const handleDeleteTrack = useCallback(
    (trackId: string) => {
      const track = tracks.find((t) => t.id === trackId)
      if (!track) return
      const clipCount = track.clips.length
      const label = track.label

      removeTrack(trackId)

      const message =
        clipCount > 0
          ? `Deleted "${label}" and ${clipCount} clip${clipCount !== 1 ? 's' : ''}`
          : `Deleted "${label}"`
      editorToast.undo({
        message,
        durationMs: clipCount > 0 ? 6000 : 4000,
        onUndo: () => undo(),
      })
    },
    [removeTrack, tracks, undo],
  )

  // ── Render ──

  const rowProps = {
    allTracks: tracks,
    contentWidth,
    pxPerMs,
    snapEnabled,
    activeToolMode,
    selectedClipIds,
    visibleStartMs,
    visibleEndMs,
    onSelectClip: selectClip,
    onToggleSelectClip: toggleClipSelection,
    onDeselectAll: deselectAll,
    onMoveClip: moveClip,
    onMoveClips: moveClips,
    onTrimClip: trimClip,
    onRateStretchClip: rateStretchClip,
    onSlipClip: slipClip,
    onSplitClip: splitClip,
    onSetClipAudioLinked: setClipAudioLinked,
    onSetClipTransition: setClipTransition,
    onSetSeamTransition: setSeamTransition,
    onResizeTransition: resizeTransition,
    onRename: renameTrack,
    onToggleMute: toggleTrackMute,
    onToggleSolo: soloTrack,
    onToggleVisibility: toggleTrackVisibility,
    onToggleLock: toggleTrackLock,
    onDelete: handleDeleteTrack,
    onAssetDrop: handleAssetDrop,
    assetUrlMap,
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext
        items={sortedTracks.map((t) => t.id)}
        strategy={verticalListSortingStrategy}
      >
        <SectionSeparator label="Video tracks" />
        {visualTracks.map((track) => (
          <SortableTrackRow key={track.id} track={track} {...rowProps} />
        ))}
        <SectionSeparator label="Audio tracks" />
        {audioTracks.map((track) => (
          <SortableTrackRow key={track.id} track={track} {...rowProps} />
        ))}
      </SortableContext>
    </DndContext>
  )
}

/**
 * Sticky-top separator that labels the visual / audio sections of the timeline.
 * border-b sits on the flex children (not the parent) so the dividing line in
 * the sticky-left header column doesn't drift during horizontal scroll.
 */
function SectionSeparator({ label }: { label: string }) {
  return (
    <div className="flex" style={{ minHeight: 28 }} aria-label={`${label} start below`}>
      <div
        className="shrink-0 flex items-center px-3 text-[10px] font-medium tracking-wide text-editor-on-chrome-muted/80 border-r border-b border-editor-border bg-editor-chrome-soft"
        style={{
          width: TRACK_HEADER_WIDTH,
          position: 'sticky',
          top: RULER_HEIGHT,
          left: 0,
          zIndex: 34,
        }}
      >
        {label}
      </div>
      <div
        className="flex-1 border-b border-editor-border bg-editor-chrome-soft"
        style={{ position: 'sticky', top: RULER_HEIGHT, zIndex: 28 }}
      />
    </div>
  )
}

// ─── SortableTrackRow ──────────────────────────────────────────────────────────
//
// One row in the sortable list: header column (sticky-left when not dragging) +
// content area with clips. The DnD-Kit `useSortable` hook wires this row into
// the parent SortableContext so reordering works.

interface SortableTrackRowProps {
  track: Track
  allTracks: Track[]
  contentWidth: number
  pxPerMs: number
  snapEnabled: boolean
  activeToolMode: ToolMode
  selectedClipIds: string[]
  visibleStartMs: number
  visibleEndMs: number
  onSelectClip: (id: string) => void
  onToggleSelectClip: (id: string) => void
  onDeselectAll: () => void
  onMoveClip: (clipId: string, newTrackId: string, newStartTime: number) => void
  onMoveClips: (
    moves: ReadonlyArray<{ clipId: string; newTrackId: string; newStartTime: number }>,
  ) => void
  onTrimClip: (clipId: string, edge: 'start' | 'end', newTime: number) => void
  onRateStretchClip: (clipId: string, edge: 'start' | 'end', newTime: number) => void
  onSlipClip: (clipId: string, sourceDeltaMs: number) => void
  onSplitClip: (clipId: string, atTime: number) => void
  onSetClipAudioLinked: (videoClipId: string, linked: boolean) => void
  onSetClipTransition: (
    clipId: string,
    edge: 'in' | 'out',
    transition: ClipTransition | null,
  ) => void
  onSetSeamTransition: (
    leftClipId: string,
    rightClipId: string,
    transition: ClipTransition,
  ) => void
  onResizeTransition: (
    clipId: string,
    edge: 'in' | 'out',
    newDurationMs: number,
  ) => void
  onRename: (trackId: string, label: string) => void
  onToggleMute: (trackId: string) => void
  onToggleSolo: (trackId: string) => void
  onToggleVisibility: (trackId: string) => void
  onToggleLock: (trackId: string) => void
  onDelete: (trackId: string) => void
  onAssetDrop: (trackId: string, payload: DraggedAssetPayload, startTimeMs: number) => void
  assetUrlMap: Record<string, string>
}

const SortableTrackRow = memo(function SortableTrackRow({
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
  onRename,
  onToggleMute,
  onToggleSolo,
  onToggleVisibility,
  onToggleLock,
  onDelete,
  onAssetDrop,
  assetUrlMap,
}: SortableTrackRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: track.id,
  })

  // ── Expanded keyframe graphs ───────────────────────────────────────────────
  //
  // Each clip on this track can opt-in to an expanded graph view that lives
  // directly below the clip in the same lane. When any clip on this row is
  // expanded, the row grows by the tallest expanded clip's graph height. Two
  // clips on the same row can be expanded at once — their graphs share the
  // same Y band because they're at different X positions.
  const expandedGraphClipIds = useUIStore((s) => s.keyframeGraphClipIds)
  const expandedClipsOnTrack = useMemo(
    () => track.clips.filter((c) => expandedGraphClipIds.includes(c.id)),
    [track.clips, expandedGraphClipIds],
  )
  const graphExtraHeight = useMemo(
    () =>
      expandedClipsOnTrack.reduce(
        (max, c) => Math.max(max, computeGraphHeightForClip(c)),
        0,
      ),
    [expandedClipsOnTrack],
  )
  const rowHeight = TRACK_ROW_HEIGHT + graphExtraHeight

  // "Soloed" = this is the only un-muted audio track. Derived from allTracks
  // (already passed in) so we don't add another store subscription per row.
  const isSoloed = useMemo(() => {
    if (track.type !== 'audio' && track.type !== 'clip_audio') return false
    if (track.muted) return false
    return allTracks.every(
      (t) => (t.type !== 'audio' && t.type !== 'clip_audio') || t.id === track.id || t.muted,
    )
  }, [track, allTracks])

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : undefined,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex ${isDragging ? 'shadow-lg opacity-90' : ''}`}
      aria-roledescription="Track row"
      data-track-id={track.id}
    >
      {/* Track header — sticky-left when not dragging. CSS transform breaks
          sticky during drag, so we drop the sticky class while dragging and
          let the whole row travel under the transform. */}
      <div
        className={`shrink-0 bg-editor-chrome-soft border-r border-b border-editor-border ${
          !isDragging ? 'sticky left-0' : ''
        }`}
        style={{ width: TRACK_HEADER_WIDTH, height: rowHeight, zIndex: 34 }}
      >
        <TrackHeader
          track={track}
          dragHandleProps={{ listeners, attributes }}
          isDragging={isDragging}
          onRename={onRename}
          onToggleMute={onToggleMute}
          onToggleSolo={onToggleSolo}
          isSoloed={isSoloed}
          onToggleVisibility={onToggleVisibility}
          onToggleLock={onToggleLock}
          onDelete={onDelete}
        />
      </div>

      <div
        className="flex-1 overflow-hidden border-b border-editor-border"
        style={{ height: rowHeight }}
      >
        <TrackContent
          track={track}
          allTracks={allTracks}
          contentWidth={contentWidth}
          pxPerMs={pxPerMs}
          snapEnabled={snapEnabled}
          activeToolMode={activeToolMode}
          selectedClipIds={selectedClipIds}
          visibleStartMs={visibleStartMs}
          visibleEndMs={visibleEndMs}
          onSelectClip={onSelectClip}
          onToggleSelectClip={onToggleSelectClip}
          onDeselectAll={onDeselectAll}
          onMoveClip={onMoveClip}
          onMoveClips={onMoveClips}
          onTrimClip={onTrimClip}
          onRateStretchClip={onRateStretchClip}
          onSlipClip={onSlipClip}
          onSplitClip={onSplitClip}
          onSetClipAudioLinked={onSetClipAudioLinked}
          onSetClipTransition={onSetClipTransition}
          onSetSeamTransition={onSetSeamTransition}
          onResizeTransition={onResizeTransition}
          onAssetDrop={(payload, startTimeMs) => onAssetDrop(track.id, payload, startTimeMs)}
          assetUrlMap={assetUrlMap}
        />
      </div>
    </div>
  )
})
