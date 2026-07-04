/**
 * Editor Store barrel export.
 *
 * The editor's state is split across four focused Zustand stores:
 *
 *   - {@link useEditorStore}     — persistent project model (tracks, captions,
 *                                  composition, global volume) + history +
 *                                  persistence. The only store that participates
 *                                  in undo/redo and auto-save.
 *   - {@link useSelectionStore}  — clip and transition selection.
 *   - {@link usePlaybackStore}   — playhead position + play/pause.
 *   - {@link useUIStore}         — tool mode, asset tab, zoom, snap, transient
 *                                  drag flags.
 *
 * Splitting transient UI state out keeps per-frame UI updates from re-rendering
 * components that only care about the project model. Persistent state stays
 * co-located so history snapshots remain atomic.
 */

export { useEditorStore } from './editor-store'
export type { EditorStore, EditorActions } from './editor-store'

export { useSelectionStore } from './selection-store'
export type { SelectionStore, SelectionState, SelectionActions } from './selection-store'

export { usePlaybackStore } from './playback-store'
export type { PlaybackStore, PlaybackState, PlaybackActions } from './playback-store'

export { useUIStore } from './ui-store'
export type { UIStore, UIState, UIActions } from './ui-store'
