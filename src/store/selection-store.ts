/**
 * Selection Store — transient state for what's currently selected.
 *
 * Owns:
 *   - `selectedClipIds`     — clip multi-selection
 *   - `selectedTransition`  — transition pinned for editing in the inspector
 *
 * Why a separate store: selection is transient UI state. It doesn't participate
 * in undo/redo (intentional — see editor-store history machinery) and isn't
 * persisted. Splitting it out of the main store lets components subscribe to
 * selection changes without re-rendering on every clip mutation.
 *
 * The project store (editor-store.ts) calls into this store from clip-deletion
 * actions to keep selection in sync with the model.
 */

import { create } from 'zustand'

import type { AnimatablePropertyId, SelectedTransition } from '../types'

/**
 * A reference to one keyframe on one property of one clip. Used by the
 * Inspector's keyframe ribbon for selection state. Keyframes are always
 * referenced by id, not by index — they reshuffle when the user drags them.
 */
export interface SelectedKeyframe {
  clipId: string
  propertyId: AnimatablePropertyId
  keyframeId: string
}

export interface SelectionState {
  selectedClipIds: string[]
  /**
   * The transition currently selected for editing. Clip and transition
   * selection are mutually exclusive — only one can be active at a time.
   */
  selectedTransition: SelectedTransition | null
  /**
   * Keyframes currently selected in the Inspector ribbon. When non-empty,
   * the Delete key removes them instead of removing the parent clip.
   * Cleared automatically when the underlying clip is deselected.
   */
  selectedKeyframes: SelectedKeyframe[]
}

export interface SelectionActions {
  /** Replace the selection with a single clip; clears any transition selection. */
  selectClip(clipId: string): void
  /**
   * Replace the entire clip selection with the given ids in a single update.
   * Used by marquee selection so dragging the rectangle doesn't churn through
   * a long tail of toggle calls. Clears transition and keyframe selection.
   */
  setSelection(clipIds: string[]): void
  /**
   * Replace the clip selection with every id in `allClipIds`. Identical to
   * `setSelection` but kept as its own entry point so the Ctrl/Cmd+A shortcut
   * has a self-documenting call site and so future "select all of type X"
   * variants can branch off it.
   */
  selectAll(allClipIds: string[]): void
  /** Clear both clip and transition selections. */
  deselectAll(): void
  /** Add/remove a clip from the selection; clears any transition selection. */
  toggleClipSelection(clipId: string): void
  /** Pin a transition for inspector editing; clears clip selection. */
  selectTransition(selection: SelectedTransition | null): void
  /**
   * Drop any selected clip IDs that are in the removed set. Called by the
   * project store after `deleteClips`/`removeTrack` to keep selection coherent
   * with the model.
   */
  removeFromSelection(removedClipIds: ReadonlySet<string>): void
  /**
   * Replace keyframe selection with a single keyframe. Used on click in the
   * Inspector ribbon.
   */
  selectKeyframe(ref: SelectedKeyframe): void
  /** Add/remove a keyframe from the selection. Used on shift-click. */
  toggleKeyframeSelection(ref: SelectedKeyframe): void
  /** Clear keyframe selection. */
  clearKeyframeSelection(): void
  /** Reset transient selection state (called on project load/reset). */
  reset(): void
}

export type SelectionStore = SelectionState & SelectionActions

const INITIAL_STATE: SelectionState = {
  selectedClipIds: [],
  selectedTransition: null,
  selectedKeyframes: [],
}

function sameKeyframeRef(a: SelectedKeyframe, b: SelectedKeyframe): boolean {
  return a.clipId === b.clipId && a.propertyId === b.propertyId && a.keyframeId === b.keyframeId
}

export const useSelectionStore = create<SelectionStore>((set, get) => ({
  ...INITIAL_STATE,

  selectClip: (clipId) => {
    set({ selectedClipIds: [clipId], selectedTransition: null, selectedKeyframes: [] })
  },

  setSelection: (clipIds) => {
    const { selectedClipIds } = get()
    // Skip the set if the new selection is identical to the current one so
    // marquee drags that don't change the hit-set don't trigger re-renders.
    if (
      clipIds.length === selectedClipIds.length &&
      clipIds.every((id, i) => id === selectedClipIds[i])
    ) {
      return
    }
    set({ selectedClipIds: clipIds, selectedTransition: null, selectedKeyframes: [] })
  },

  selectAll: (allClipIds) => {
    set({ selectedClipIds: allClipIds, selectedTransition: null, selectedKeyframes: [] })
  },

  deselectAll: () => {
    set({ selectedClipIds: [], selectedTransition: null, selectedKeyframes: [] })
  },

  toggleClipSelection: (clipId) => {
    const { selectedClipIds } = get()
    const isSelected = selectedClipIds.includes(clipId)
    set({
      selectedClipIds: isSelected
        ? selectedClipIds.filter((id) => id !== clipId)
        : [...selectedClipIds, clipId],
      selectedTransition: null,
      selectedKeyframes: [],
    })
  },

  selectTransition: (selection) => {
    if (selection === null) {
      set({ selectedTransition: null })
      return
    }
    // Settings live in the right Inspector. Clear clip selection so the
    // Inspector swaps to the transition section.
    set({ selectedTransition: selection, selectedClipIds: [], selectedKeyframes: [] })
  },

  removeFromSelection: (removedClipIds) => {
    const { selectedClipIds, selectedKeyframes } = get()
    const patch: Partial<SelectionState> = {}
    if (selectedClipIds.length > 0) {
      const remaining = selectedClipIds.filter((id) => !removedClipIds.has(id))
      if (remaining.length !== selectedClipIds.length) patch.selectedClipIds = remaining
    }
    if (selectedKeyframes.length > 0) {
      const remaining = selectedKeyframes.filter((k) => !removedClipIds.has(k.clipId))
      if (remaining.length !== selectedKeyframes.length) patch.selectedKeyframes = remaining
    }
    if (Object.keys(patch).length > 0) set(patch)
  },

  selectKeyframe: (ref) => {
    set({ selectedKeyframes: [ref] })
  },

  toggleKeyframeSelection: (ref) => {
    const { selectedKeyframes } = get()
    const isSelected = selectedKeyframes.some((k) => sameKeyframeRef(k, ref))
    set({
      selectedKeyframes: isSelected
        ? selectedKeyframes.filter((k) => !sameKeyframeRef(k, ref))
        : [...selectedKeyframes, ref],
    })
  },

  clearKeyframeSelection: () => {
    set({ selectedKeyframes: [] })
  },

  reset: () => {
    set({ ...INITIAL_STATE })
  },
}))
