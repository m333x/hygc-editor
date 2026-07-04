/**
 * useTimeline — hook for timeline state and track/clip operations.
 *
 * Provides a focused interface to the editor Zustand store for components
 * that need to read timeline data and perform clip/track mutations. This
 * hook acts as a thin selector layer over the store, grouping related
 * state slices and actions into a cohesive return object.
 *
 * Why a separate hook instead of using useEditorStore directly:
 *   - Encapsulates store selector logic so components don't couple to
 *     the store's internal shape
 *   - Groups related state + actions by concern (timeline vs. playback)
 *   - Makes component dependencies explicit and testable
 *   - Follows the same hook pattern used throughout the codebase
 *     (useVideoGeneration, useGenerationJobs, etc.)
 *
 * Returns:
 *   - tracks: ordered track array
 *   - selectedClipIds: currently selected clip IDs
 *   - zoomLevel, snapEnabled: timeline UI settings
 *   - Clip operations: addClip, moveClip, trimClip, splitClip, deleteClips
 *   - Track operations: addTrack, removeTrack, reorderTracks, renameTrack
 *   - Selection: selectClip, deselectAll, toggleClipSelection
 *   - Undo/redo: undo, redo, canUndo, canRedo
 *
 * SOLID: SRP — only exposes timeline-related state and actions.
 *   Playback is in usePlayback. Persistence is in useEditorPersistence.
 * SOLID: ISP — components that only need track data don't receive
 *   playback or persistence APIs.
 *
 * @example
 *   const { tracks, addClip, selectedClipIds } = useTimeline()
 *
 * @see src/features/editor/store/editor-store.ts for the Zustand store
 * @see PLAN.md Phase 3.3 for store requirements
 */

import { useCallback } from 'react'
import { useEditorStore } from '../store/editor-store'
import { useSelectionStore } from '../store/selection-store'
import { useUIStore } from '../store/ui-store'
import type { Clip, Track, TrackType, ClipTransform, TrimEdge } from '../types'

// ─── Return Type ─────────────────────────────────────────────────────────────

export interface UseTimelineReturn {
  // ── State ──

  /** All timeline tracks, ordered by display position. */
  tracks: Track[]

  /** IDs of currently selected clips. */
  selectedClipIds: string[]

  /** Timeline zoom level (pixels per second). */
  zoomLevel: number

  /** Whether snap-to-edges is enabled. */
  snapEnabled: boolean

  // ── Clip Operations ──

  addClip: (trackId: string, clip: Clip) => void
  moveClip: (clipId: string, newTrackId: string, newStartTime: number) => void
  trimClip: (clipId: string, edge: TrimEdge, newTime: number) => void
  splitClip: (clipId: string, atTime: number) => void
  deleteClips: (clipIds: string[]) => void
  updateClipTransform: (clipId: string, transform: Partial<ClipTransform>) => void
  updateClipSpeed: (clipId: string, speed: number) => void

  // ── Track Operations ──

  addTrack: (label: string, type: TrackType) => void
  removeTrack: (trackId: string) => void
  reorderTracks: (orderedTrackIds: string[]) => void
  renameTrack: (trackId: string, label: string) => void
  toggleTrackMute: (trackId: string) => void
  toggleTrackLock: (trackId: string) => void

  // ── Selection ──

  selectClip: (clipId: string) => void
  deselectAll: () => void
  toggleClipSelection: (clipId: string) => void

  // ── Timeline Controls ──

  setZoomLevel: (level: number) => void
  toggleSnap: () => void

  // ── Undo/Redo ──

  undo: () => void
  redo: () => void
  canUndo: boolean
  canRedo: boolean

  // ── Derived Helpers ──

  /** Delete currently selected clips. Convenience for keyboard shortcut handlers. */
  deleteSelected: () => void
}

// ─── Hook Implementation ─────────────────────────────────────────────────────

export function useTimeline(): UseTimelineReturn {
  // Select state slices from the store
  const tracks = useEditorStore((s) => s.tracks)
  const selectedClipIds = useSelectionStore((s) => s.selectedClipIds)
  const zoomLevel = useUIStore((s) => s.zoomLevel)
  const snapEnabled = useUIStore((s) => s.snapEnabled)

  // Select actions from the store
  const addClip = useEditorStore((s) => s.addClip)
  const moveClip = useEditorStore((s) => s.moveClip)
  const trimClip = useEditorStore((s) => s.trimClip)
  const splitClip = useEditorStore((s) => s.splitClip)
  const deleteClips = useEditorStore((s) => s.deleteClips)
  const updateClipTransform = useEditorStore((s) => s.updateClipTransform)
  const updateClipSpeed = useEditorStore((s) => s.updateClipSpeed)
  const addTrack = useEditorStore((s) => s.addTrack)
  const removeTrack = useEditorStore((s) => s.removeTrack)
  const reorderTracks = useEditorStore((s) => s.reorderTracks)
  const renameTrack = useEditorStore((s) => s.renameTrack)
  const toggleTrackMute = useEditorStore((s) => s.toggleTrackMute)
  const toggleTrackLock = useEditorStore((s) => s.toggleTrackLock)
  const selectClip = useSelectionStore((s) => s.selectClip)
  const deselectAll = useSelectionStore((s) => s.deselectAll)
  const toggleClipSelection = useSelectionStore((s) => s.toggleClipSelection)
  const setZoomLevel = useUIStore((s) => s.setZoomLevel)
  const toggleSnap = useUIStore((s) => s.toggleSnap)
  const undo = useEditorStore((s) => s.undo)
  const redo = useEditorStore((s) => s.redo)
  const canUndoFn = useEditorStore((s) => s.canUndo)
  const canRedoFn = useEditorStore((s) => s.canRedo)

  // Derived helpers
  const deleteSelected = useCallback(() => {
    if (selectedClipIds.length > 0) {
      deleteClips(selectedClipIds)
    }
  }, [selectedClipIds, deleteClips])

  return {
    tracks,
    selectedClipIds,
    zoomLevel,
    snapEnabled,
    addClip,
    moveClip,
    trimClip,
    splitClip,
    deleteClips,
    updateClipTransform,
    updateClipSpeed,
    addTrack,
    removeTrack,
    reorderTracks,
    renameTrack,
    toggleTrackMute,
    toggleTrackLock,
    selectClip,
    deselectAll,
    toggleClipSelection,
    setZoomLevel,
    toggleSnap,
    undo,
    redo,
    canUndo: canUndoFn(),
    canRedo: canRedoFn(),
    deleteSelected,
  }
}
