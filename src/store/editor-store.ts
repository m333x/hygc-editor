/**
 * Editor (Project) Zustand Store — persistent project state + history.
 *
 * Owns the part of the editor state that is saved to Supabase and participates
 * in undo/redo: tracks (and the clips inside them), the global caption style,
 * the composition config, and the global audio volume. Every mutating action
 * routes through this store and through the snapshot-based history machinery.
 *
 * Transient UI state lives in its own focused stores so per-frame updates
 * don't trigger re-renders on consumers of the persistent model:
 *   - selection state → store/selection-store.ts (useSelectionStore)
 *   - playback state  → store/playback-store.ts (usePlaybackStore)
 *   - tool/UI state   → store/ui-store.ts (useUIStore)
 *
 * Cross-store coordination: a few persistent actions (addAssetClipToTrack,
 * deleteClips, removeTrack, loadState, resetState) reach into the transient
 * stores to keep them in sync with the model. This direction of coupling is
 * intentional — the transient stores stay unaware of the project store, so
 * they can be tested and reused in isolation.
 *
 * Undo/redo strategy:
 *   Every mutating action pushes a snapshot of the persistent state onto the
 *   undo stack before applying the change. Undo restores the previous snapshot
 *   and pushes the current state onto the redo stack. Snapshots capture only
 *   the persistent slice — transient UI state is intentionally not restored.
 *
 * Auto-save:
 *   `useEditorPersistence` subscribes to `getSerializableState()` and debounces
 *   writes to Supabase `projects.editor_state`. The store itself is not
 *   responsible for persistence — that's handled by the hook.
 *
 * SOLID: SRP — only owns persistent project state, history, and persistence
 *   helpers. UI/playback/selection are split into their own stores.
 * SOLID: OCP — new persistent actions can be added without modifying existing
 *   action implementations.
 */

import { create } from 'zustand'
import type {
  EditorState,
  Track,
  Clip,
  ClipTransform,
  EffectInstance,
  LegacyClipEffects,
  CaptionStyle,
  ClipTransition,
  SerializedEditorState,
  HistoryEntry,
  TrimEdge,
  TrackType,
  AnimatablePropertyId,
  EasingKind,
  KeyframeTrack,
} from '../types'
import {
  DEFAULT_COMPOSITION_CONFIG,
  DEFAULT_CAPTION_STYLE,
  DEFAULT_CLIP_TRANSFORM,
  DEFAULT_AUDIO_DUCKING,
  createDefaultTracks,
} from '../types'
import { findClipById, findClipBySourceVideoClipId } from '../engine/composition-utils'
import { migrateLegacyEffects } from '../engine/effects'
import { ANIMATABLE_PROPERTIES } from '../engine/animatable-properties'
import {
  createKeyframe,
  deleteKeyframesById,
  moveAndResort,
  scaleTimes,
  setKeyframeEasing as setKeyframeEasingPure,
  shiftAndClamp,
  splitKeyframesAt,
  upsertKeyframe,
} from '../engine/keyframe-mutations'
import { useSelectionStore } from './selection-store'
import { usePlaybackStore } from './playback-store'
import { useUIStore } from './ui-store'

// ─── Constants ───────────────────────────────────────────────────────────────

/** Maximum undo/redo history depth. Limits memory usage. */
const MAX_HISTORY_SIZE = 50

interface AddAssetClipParams {
  assetId: string
  assetType: string
  startTime: number
  duration: number
  sourceDurationMs?: number
}

/**
 * In-memory scratch buffer for copy/paste. Lives outside Zustand state so it
 * doesn't drive re-renders and doesn't participate in undo/redo. Lost on page
 * reload — intentionally; the system clipboard is reserved for text and we'd
 * rather not collide with the user's word-processor clipboard.
 */
interface ClipboardEntry {
  clip: Clip
  /** Original track type, used to route the paste onto a compatible track. */
  sourceTrackType: TrackType
  /** Optional linked clip_audio peer captured at copy time. */
  sourceAudioPeer: Clip | null
}

let clipboardBuffer: {
  entries: ClipboardEntry[]
  /**
   * Earliest `startTime` across the copied clips, used as the anchor when
   * pasting so relative offsets between the clips are preserved.
   */
  baselineStartMs: number
} | null = null

// ─── Store Actions Interface ─────────────────────────────────────────────────

/**
 * All actions available on the editor store.
 *
 * Actions are grouped by concern:
 *   - Clip operations: addClip, moveClip, trimClip, splitClip, deleteClips, updateClipTransform
 *   - Track operations: addTrack, removeTrack, reorderTracks, renameTrack, toggleTrackMute, toggleTrackLock
 *   - Playback: setPlayhead, togglePlayback, setPlaying
 *   - Selection: selectClip, deselectAll, toggleClipSelection
 *   - Timeline: setZoomLevel, toggleSnap
 *   - Caption: setCaptionStyle
 *   - Undo/Redo: undo, redo
 *   - Persistence: getSerializableState, loadState, resetState
 */
export interface EditorActions {
  // ── Clip Operations ──

  /**
   * Add a new clip to a track.
   *
   * Creates the clip with the provided properties and inserts it into the
   * specified track's clips array. The clip ID should be pre-generated
   * (crypto.randomUUID()) by the caller.
   *
   * @param trackId - Target track ID
   * @param clip    - Complete clip object to add
   */
  addClip: (trackId: string, clip: Clip) => void

  /**
   * Add a media asset to a compatible track. Video assets dropped/added to a
   * video track also create their linked clip_audio in the same undo step.
   */
  addAssetClipToTrack: (trackId: string, params: AddAssetClipParams) => void

  /**
   * Move a clip to a new position and/or track.
   *
   * @param clipId      - Clip to move
   * @param newTrackId  - Target track (can be same track)
   * @param newStartTime - New start position in milliseconds
   */
  moveClip: (clipId: string, newTrackId: string, newStartTime: number) => void

  /**
   * Move multiple clips in a single pass, as one history entry.
   *
   * All clips in the move set are treated as a unit: they do not trim or
   * split each other on landing. Non-moving clips on each target track still
   * get trimmed/split against the moved ranges (same overlap rules as
   * {@link moveClip}). Moves with an incompatible target track type are
   * dropped silently — the caller is responsible for filtering at the UI
   * layer if it wants different behaviour. Linked-audio pairs are expanded
   * automatically: moving a video clip with `audioLinked` shifts its
   * clip_audio counterpart by the same delta, and vice versa, unless that
   * counterpart is already in the move set.
   */
  moveClips: (
    moves: ReadonlyArray<{ clipId: string; newTrackId: string; newStartTime: number }>,
  ) => void

  /**
   * Trim a clip from one edge.
   *
   * Adjusts the clip's inPoint (start edge) or outPoint (end edge) and
   * recalculates the duration accordingly.
   *
   * @param clipId  - Clip to trim
   * @param edge    - Which edge to trim ('start' or 'end')
   * @param newTime - New boundary time in milliseconds (timeline-relative for 'start', source-relative for inPoint/outPoint adjustment)
   */
  trimClip: (clipId: string, edge: TrimEdge, newTime: number) => void

  /**
   * Rate-stretch a clip from one edge — adjust playback speed so the existing
   * source material fits a new timeline duration without changing inPoint /
   * outPoint.
   *
   * For `edge === 'end'`: the clip's startTime stays fixed; duration becomes
   * `newTime - startTime`; speed becomes `(outPoint - inPoint) / newDuration`.
   *
   * For `edge === 'start'`: the clip's end stays fixed; startTime becomes
   * newTime; duration becomes `originalEnd - newTime`; speed updates the same
   * way. Linked clip_audio mirrors the change so audio stays time-aligned
   * with the video it was extracted from.
   *
   * Speed is clamped to [0.25, 4.0] — the same range as `updateClipSpeed`.
   * Captions and image clips reject the call (no meaningful source duration);
   * the timeline UI guards against issuing the call for those clip types.
   *
   * @param clipId  - Clip to rate-stretch
   * @param edge    - Which edge is being dragged ('start' or 'end')
   * @param newTime - The new timeline position of the dragged edge, in ms
   */
  rateStretchClip: (clipId: string, edge: TrimEdge, newTime: number) => void

  /**
   * Slip the clip's source content — shift `inPoint` and `outPoint` together
   * by `sourceDeltaMs` (in source-time milliseconds), leaving `startTime` and
   * `duration` on the timeline unchanged.
   *
   * Positive `sourceDeltaMs` advances both points (later in the source — the
   * visible window slides forward through the source). Negative pulls them
   * earlier. Both points are clamped together so the window can't escape
   * `[0, sourceDurationMs]`, which preserves the clip's visible duration.
   *
   * Linked clip_audio mirrors the slip so audio stays in sync with the video
   * frames it was captured against. Caption and image clips reject the call —
   * neither has a source window to scrub through.
   *
   * @param clipId        - Clip to slip
   * @param sourceDeltaMs - Signed shift to apply to inPoint and outPoint (ms)
   */
  slipClip: (clipId: string, sourceDeltaMs: number) => void

  /**
   * Split a clip into two clips at the specified timeline position.
   *
   * The original clip is shortened to end at the split point, and a new
   * clip is created starting at the split point with the remainder.
   *
   * @param clipId - Clip to split
   * @param atTime - Timeline position in milliseconds to split at
   */
  splitClip: (clipId: string, atTime: number) => void

  /**
   * Delete one or more clips by their IDs.
   *
   * Removes the clips from their tracks. If the clips are currently selected,
   * they are also removed from the selection.
   *
   * @param clipIds - Array of clip IDs to delete
   */
  deleteClips: (clipIds: string[]) => void

  /**
   * Duplicate one or more clips on their own tracks. Each duplicate lands
   * immediately after the source clip (offset by `clip.duration`). Linked
   * `clip_audio` peers of duplicated video clips are duplicated alongside so
   * the new clip keeps its audio. Transitions on duplicates are stripped —
   * the new clip's neighbours are different from the source's, so seam
   * transitions wouldn't make sense.
   *
   * One history entry. The new clips become the selection on return.
   */
  duplicateClips: (clipIds: string[]) => void

  /**
   * Copy one or more clips into an in-memory scratch buffer used by
   * {@link pasteClips}. Not persisted across reloads; not synced with the
   * system clipboard. Returns silently when there are no eligible clips.
   */
  copyClips: (clipIds: string[]) => void

  /**
   * Paste whatever's in the scratch buffer onto the timeline, anchored at
   * `playheadMs`. Relative offsets between the copied clips are preserved
   * (so a multi-clip copy lands as a group). Each pasted clip routes onto
   * the first unlocked track of its original type. Linked clip_audio peers
   * are recreated alongside paired video clips. Transitions on pastes are
   * stripped for the same reason as {@link duplicateClips}.
   *
   * One history entry. The pasted clips become the selection on return.
   */
  pasteClips: (playheadMs: number) => void

  /**
   * Shift each clip's `startTime` by `deltaMs`, clamped to 0, in a single
   * history entry. Locked tracks block the nudge. Linked `clip_audio` peers
   * follow the move when they're not in the input set. Delegates to
   * {@link moveClips} so the linked-audio and overlap-trim rules are shared.
   *
   * @param clipIds  - Clips to nudge
   * @param deltaMs  - Signed shift in ms
   */
  nudgeClips: (clipIds: string[], deltaMs: number) => void

  /**
   * Set whether a video clip's audio is linked to its clip_audio counterpart.
   *
   * When linked (default), moving/trimming/splitting the video clip also updates
   * the matching clip_audio. When unlinked, video and clip_audio can be edited
   * independently (e.g. trim or cut clip audio without affecting the video).
   *
   * @param videoClipId - The video clip ID (must be on a video track)
   * @param linked      - true to link, false to unlink
   */
  setClipAudioLinked: (videoClipId: string, linked: boolean) => void

  /**
   * Set the fade-in or fade-out duration on an audio clip.
   *
   * Applies to clips on `audio` and `clip_audio` tracks. A duration of 0
   * removes the fade. The store clamps the value to half of the clip's
   * timeline duration so a fade never exceeds the clip's available length.
   *
   * Crossfades are implicit: when two adjacent audio clips both have fades
   * on the facing edges, the Remotion composition shifts the right clip's
   * playback earlier to overlap with the left clip's tail. The store doesn't
   * need to know about the pair — it just stores per-clip fade durations.
   *
   * @param clipId       - Audio clip to modify
   * @param edge         - 'in' (left edge) or 'out' (right edge)
   * @param durationMs   - Fade duration in ms; 0 or negative clears the fade
   */
  setClipAudioFade: (
    clipId: string,
    edge: 'in' | 'out',
    durationMs: number,
  ) => void

  /**
   * Update a clip's transform properties (position, scale, rotation, crop, flip).
   *
   * Merges the provided partial transform with the clip's existing transform.
   *
   * @param clipId    - Clip to update
   * @param transform - Partial transform to merge
   */
  updateClipTransform: (clipId: string, transform: Partial<ClipTransform>) => void

  // ── Effect stack ──
  //
  // Premiere-style ordered effect instances on a clip. When the stack empties
  // the whole `effects` array is dropped so untouched clips stay byte-identical
  // to their pre-effects serialization.

  /** Append an effect instance to the end of a clip's stack. */
  addClipEffect: (clipId: string, effect: EffectInstance) => void

  /** Merge a params/enabled patch into one instance (identified by its id). */
  updateClipEffect: (
    clipId: string,
    effectId: string,
    patch: Partial<EffectInstance>,
  ) => void

  /** Remove one instance from a clip's stack. */
  removeClipEffect: (clipId: string, effectId: string) => void

  /** Reorder: move the instance at `fromIndex` to `toIndex` within the stack. */
  moveClipEffect: (clipId: string, fromIndex: number, toIndex: number) => void

  /**
   * Replace a clip's entire stack (paste-effects, clear-all). Instances are
   * stored as given — callers pasting from another clip must re-id them first.
   */
  setClipEffects: (clipId: string, effects: EffectInstance[]) => void

  // ── Keyframes ──

  /**
   * Enable keyframing on a clip property — creates a `KeyframeTrack` for the
   * property (if one doesn't already exist) and seeds it with one keyframe at
   * `seedTimeMs` valued at the property's current static value.
   *
   * No-op if a track already exists for the property.
   */
  enableKeyframing: (
    clipId: string,
    propertyId: AnimatablePropertyId,
    seedTimeMs: number,
  ) => void

  /**
   * Disable keyframing on a clip property — removes the entire `KeyframeTrack`.
   * The static baseline value on `clip.transform` is unchanged.
   *
   * Undoable in one step (the prior keyframes are restored on undo).
   */
  disableKeyframing: (clipId: string, propertyId: AnimatablePropertyId) => void

  /**
   * Write a value to a keyframable property at the current playhead. When the
   * property has a `KeyframeTrack`, this upserts a keyframe at `timeMs`.
   * Otherwise, falls back to writing the static baseline via the property
   * registry (matches current behavior when the stopwatch is off).
   */
  setPropertyAtPlayhead: (
    clipId: string,
    propertyId: AnimatablePropertyId,
    timeMs: number,
    value: number,
  ) => void

  /**
   * Move an existing keyframe to a new clip-local time, clamped to the clip's
   * duration. Replaces any peer keyframe already at the target time.
   */
  moveKeyframe: (
    clipId: string,
    propertyId: AnimatablePropertyId,
    keyframeId: string,
    newTimeMs: number,
  ) => void

  /** Remove one or more keyframes from a property track. */
  deleteKeyframes: (
    clipId: string,
    propertyId: AnimatablePropertyId,
    keyframeIds: ReadonlyArray<string>,
  ) => void

  /**
   * Set the incoming or outgoing easing for a keyframe. Triggered by the
   * right-click easing menu on a keyframe marker in the Inspector ribbon.
   */
  setKeyframeEasing: (
    clipId: string,
    propertyId: AnimatablePropertyId,
    keyframeId: string,
    side: 'in' | 'out',
    easing: EasingKind,
  ) => void

  /**
   * Update a clip's playback speed.
   *
   * Recalculates the clip's duration based on the new speed:
   *   newDuration = (outPoint - inPoint) / newSpeed
   *
   * @param clipId - Clip to update
   * @param speed  - New speed multiplier (0.25 to 4.0)
   */
  updateClipSpeed: (clipId: string, speed: number) => void

  /**
   * Set or clear the freeze frame for a clip (Phase 3.6).
   *
   * When set, the clip displays a single frozen frame for its entire timeline
   * duration. The `frameMs` value is the source-relative timestamp to freeze on
   * (i.e., it comes from `getClipSourceTime(clip, playheadPosition)`).
   *
   * When `frameMs` is `undefined`, the clip reverts to normal playback — the
   * freeze frame is cleared and the clip plays through its source asset range.
   *
   * @param clipId  - Clip to update
   * @param frameMs - Source timestamp to freeze at (ms), or undefined to clear
   *
   * @see composition-utils.ts `getClipSourceTime` — source time formula
   * @see InspectorPanel.tsx SpeedSection — UI toggle that calls this action
   */
  setClipFreezeFrame: (clipId: string, frameMs: number | undefined) => void

  /**
   * Update the caption text of a caption clip (Phase 3.8).
   *
   * Only applies to clips on caption tracks (`clip.captionText`). This action
   * allows the user to manually edit individual caption clip text in the
   * InspectorPanel's CaptionClipSection.
   *
   * @param clipId - Caption clip to update
   * @param text   - New caption text content
   *
   * @see InspectorPanel.tsx CaptionClipSection — UI that calls this action
   * @see useCaptionGeneration.ts — creates initial captionText from transcript
   */
  updateCaptionText: (clipId: string, text: string) => void

  /**
   * Merge a partial CaptionStyle override into a caption clip (Phase 3.8).
   *
   * Caption clips inherit the global `captionStyle` (from the Zustand store
   * root) by default. When a per-clip override is applied via this action,
   * the Remotion composition uses the clip's own style for that clip only.
   *
   * Partial updates are merged with the clip's existing captionStyle (or with
   * the global style as baseline if no per-clip override exists yet). This
   * allows single-property changes without specifying the full style.
   *
   * @param clipId      - Caption clip to style
   * @param styleUpdate - Partial CaptionStyle to merge into the clip's style
   *
   * @see InspectorPanel.tsx CaptionClipSection — per-clip style controls
   * @see CaptionStylePanel.tsx — global style controls (affects all clips)
   * @see types.ts CaptionStyle — full property list
   */
  updateClipCaptionStyle: (clipId: string, styleUpdate: Partial<CaptionStyle>) => void

  /** Clear a caption clip's per-clip style override so it inherits global style. */
  clearClipCaptionStyle: (clipId: string) => void

  // ── Transitions ──

  /**
   * Set or clear the in/out transition on a single clip.
   *
   * Passing `null` for `transition` removes the transition. Otherwise the
   * provided transition replaces any existing one on that edge.
   *
   * @param clipId     - Clip to modify
   * @param edge       - Which edge to attach the transition to
   * @param transition - New transition value or null to clear
   */
  setClipTransition: (
    clipId: string,
    edge: 'in' | 'out',
    transition: ClipTransition | null,
  ) => void

  /**
   * Apply a paired transition across the seam between two adjacent clips.
   *
   * Sets `transitionOut` on the left clip and `transitionIn` on the right
   * clip so both sides of the seam render the same transition during the
   * overlap window. Mirrors Premiere's "drop a transition on the seam"
   * behaviour.
   *
   * @param leftClipId  - Clip that ends at the seam
   * @param rightClipId - Clip that begins at the seam
   * @param transition  - Transition to apply to both edges
   */
  setSeamTransition: (
    leftClipId: string,
    rightClipId: string,
    transition: ClipTransition,
  ) => void

  /**
   * Resize an existing transition's duration without changing its type.
   *
   * If the transition is part of a seam (the neighbour clip on the same track
   * has a matching transition on its facing edge), both halves are updated in
   * lockstep — mirroring Premiere where a cross-dissolve has a single duration.
   * Otherwise only the named edge of the named clip is updated.
   *
   * Duration is clamped to a sensible minimum and to a maximum that fits inside
   * the affected clip(s) (and the neighbour for seam transitions).
   *
   * @param clipId         - Clip whose transition is being resized
   * @param edge           - Which edge of that clip the transition lives on
   * @param newDurationMs  - Requested new duration in milliseconds
   */
  resizeTransition: (
    clipId: string,
    edge: 'in' | 'out',
    newDurationMs: number,
  ) => void

  // ── Track Operations ──

  /**
   * Add a new track to the timeline.
   *
   * @param label - Track display label
   * @param type  - Track type ('video', 'audio', or 'caption')
   */
  addTrack: (label: string, type: TrackType) => void

  /**
   * Remove a track and all its clips from the timeline.
   *
   * @param trackId - Track to remove
   */
  removeTrack: (trackId: string) => void

  /**
   * Reorder tracks by providing a new ordered array of track IDs.
   *
   * @param orderedTrackIds - Track IDs in the desired display order
   */
  reorderTracks: (orderedTrackIds: string[]) => void

  /**
   * Rename a track's label.
   *
   * @param trackId - Track to rename
   * @param label   - New label
   */
  renameTrack: (trackId: string, label: string) => void

  /**
   * Toggle a track's muted state.
   *
   * @param trackId - Track to toggle
   */
  toggleTrackMute: (trackId: string) => void

  /**
   * Solo (or un-solo) an audio / clip_audio track.
   *
   * If `trackId` is the only un-muted audio-bearing track, calling this
   * un-mutes every audio-bearing track (un-solo). Otherwise it un-mutes
   * `trackId` and mutes every other audio / clip_audio track. Video and
   * caption tracks are untouched — solo is an audio mixer affordance.
   *
   * One history entry.
   */
  soloTrack: (trackId: string) => void

  /** Toggle visual output for video/caption tracks. */
  toggleTrackVisibility: (trackId: string) => void

  /**
   * Toggle a track's locked state.
   *
   * @param trackId - Track to toggle
   */
  toggleTrackLock: (trackId: string) => void

  /**
   * Toggle auto-ducking on an audio / clip_audio track.
   *
   * Enabling for the first time seeds {@link DEFAULT_AUDIO_DUCKING}; toggling
   * an already-configured track flips `enabled` while preserving the
   * `amountDb` / `attackMs` / `releaseMs` the user picked.
   *
   * No-op on 'video' and 'caption' tracks.
   *
   * @param trackId - Track to toggle
   */
  toggleTrackDucking: (trackId: string) => void

  // ── Caption Style ──

  /**
   * Update the global caption style.
   *
   * @param style - Partial caption style to merge with current
   */
  setCaptionStyle: (style: Partial<CaptionStyle>) => void

  /**
   * Start coalescing subsequent history-writing mutations into one undo entry.
   *
   * Used by high-frequency interactions (sliders, typing) so a drag or edit
   * gesture undoes as a single user action instead of one entry per input event.
   */
  beginHistoryTransaction: (label: string) => void

  /** Finish the active history transaction, if any. */
  commitHistoryTransaction: () => void

  /**
   * Set the global audio volume for all tracks (0–1).
   *
   * @param volume - Volume level from 0 (mute) to 1 (full)
   */
  setGlobalAudioVolume: (volume: number) => void

  /**
   * Resize the composition canvas to a new width × height (in pixels).
   *
   * Used by the Inspector's aspect preset picker (9:16 / 1:1 / 16:9 / …) to
   * switch between common DTC-ad output formats without leaving the editor.
   * Pushes an undo entry so an accidental aspect flip is one Cmd/Ctrl+Z away.
   *
   * Clips are not re-laid-out — their per-clip transforms persist. After a
   * large aspect change the user typically rebalances the canvas by hand,
   * matching every NLE we benchmark against.
   *
   * @param width  - New canvas width in pixels (positive integer)
   * @param height - New canvas height in pixels (positive integer)
   */
  setCompositionSize: (width: number, height: number) => void

  /**
   * Change the composition's frames-per-second.
   *
   * Clamped to [1, 120] and rounded to an integer — Remotion supports
   * fractional FPS but the inspector exposes preset whole-number values
   * (24 / 25 / 30 / 50 / 60), which matches every other NLE we benchmark.
   */
  setCompositionFps: (fps: number) => void

  // ── Undo / Redo ──

  /** Undo the last action, restoring the previous state snapshot. */
  undo: () => void

  /** Redo the last undone action. */
  redo: () => void

  /** Whether undo is available (undo stack is non-empty). */
  canUndo: () => boolean

  /** Whether redo is available (redo stack is non-empty). */
  canRedo: () => boolean

  // ── Persistence ──

  /**
   * Get the serializable subset of state for saving to Supabase.
   *
   * Excludes transient UI state (playhead, selections, zoom, isPlaying).
   */
  getSerializableState: () => SerializedEditorState

  /**
   * Load state from a previously saved snapshot.
   *
   * Used on editor mount to hydrate from `projects.editor_state`.
   *
   * @param state - Serialized state to load
   */
  loadState: (state: SerializedEditorState) => void

  /**
   * Reset the editor to a fresh default state.
   *
   * Creates new default tracks and clears all history.
   */
  resetState: () => void
}

// ─── Store Type ──────────────────────────────────────────────────────────────

export type EditorStore = EditorState & EditorActions

// ─── Internal State (not exposed via Zustand) ─────────────────────────────────

/**
 * Undo/redo stacks are stored outside the Zustand state to avoid triggering
 * re-renders when history changes. Components that need canUndo/canRedo
 * should call the methods, which read from these stacks.
 */
let undoStack: HistoryEntry[] = []
let redoStack: HistoryEntry[] = []
let activeHistoryTransaction: {
  label: string
  state: SerializedEditorState
  pushed: boolean
} | null = null

// ─── Helper: Push to History ─────────────────────────────────────────────────

function snapshotPersistentState(state: EditorState): SerializedEditorState {
  return {
    tracks: structuredClone(state.tracks),
    captionStyle: structuredClone(state.captionStyle),
    composition: structuredClone(state.composition),
    globalAudioVolume: state.globalAudioVolume,
  }
}

function normalizeTrack(track: Track): Track {
  const normalized: Track = {
    ...track,
    // Saved projects from before the effect stack hold a flat effects object;
    // convert it to an ordered EffectInstance[] so the rest of the app only
    // ever sees the stack shape.
    clips: track.clips.map((clip) => {
      const effects = migrateLegacyEffects(
        clip.effects as EffectInstance[] | LegacyClipEffects | undefined,
      )
      return effects === clip.effects ? clip : { ...clip, effects }
    }),
  }
  if ((track.type === 'video' || track.type === 'caption') && normalized.visible === undefined) {
    normalized.visible = true
  }
  return normalized
}

/**
 * Apply `fn` to the effect stack of one clip across all tracks. An empty
 * result drops the `effects` field entirely so untouched clips stay
 * byte-identical to their pre-effects serialization.
 */
function mapClipEffects(
  tracks: Track[],
  clipId: string,
  fn: (stack: EffectInstance[]) => EffectInstance[],
): Track[] {
  return tracks.map((track) => ({
    ...track,
    clips: track.clips.map((clip) => {
      if (clip.id !== clipId) return clip
      const next = fn(clip.effects ?? [])
      return { ...clip, effects: next.length > 0 ? next : undefined }
    }),
  }))
}

/**
 * Push the current persistent state onto the undo stack.
 * Clears the redo stack (new action invalidates redo history).
 */
function pushHistory(label: string, state: EditorState) {
  if (activeHistoryTransaction) {
    if (!activeHistoryTransaction.pushed) {
      undoStack.push({
        label: activeHistoryTransaction.label,
        state: activeHistoryTransaction.state,
      })
      if (undoStack.length > MAX_HISTORY_SIZE) {
        undoStack.shift()
      }
      redoStack = []
      activeHistoryTransaction.pushed = true
    }
    return
  }

  const snapshot = snapshotPersistentState(state)
  undoStack.push({ label, state: snapshot })
  if (undoStack.length > MAX_HISTORY_SIZE) {
    undoStack.shift()
  }
  redoStack = []
}

// ─── Helper: Trim clips overlapping a range ───────────────────────────────────

const MIN_CLIP_DURATION_MS = 1

/**
 * Two clips that touch within this tolerance are considered to share a seam.
 * Mirrors `SEAM_TOLERANCE_MS` in `TimelineClip.tsx` and absorbs floating-point
 * drift from prior moves/trims so a visually-touching seam still registers.
 */
const SEAM_TOLERANCE_MS = 50

/**
 * Remove paired seam transitions whose host clips no longer touch.
 *
 * Mirrors Premiere: when adjacent clips with a paired transitionOut/transitionIn
 * are dragged or trimmed apart, the seam transition is destroyed (not left
 * dangling as two half-fades). Isolated transitions on a clip whose neighbour
 * never had a matching half are preserved — those are intentional in/out fades.
 *
 * Operates per-track on the sorted clip order. For each adjacent pair (A, B):
 *   - If A.transitionOut AND B.transitionIn are both set AND the gap between
 *     A.end and B.start exceeds the seam tolerance → strip both halves.
 *   - All other configurations are left alone.
 */
function cleanupBrokenSeamsOnTrack(track: Track): Track {
  if (track.clips.length < 2) return track
  const sorted = [...track.clips].sort((a, b) => a.startTime - b.startTime)
  const removeOut = new Set<string>()
  const removeIn = new Set<string>()
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]!
    const b = sorted[i + 1]!
    if (!a.transitionOut || !b.transitionIn) continue
    const gap = b.startTime - (a.startTime + a.duration)
    if (Math.abs(gap) <= SEAM_TOLERANCE_MS) continue
    removeOut.add(a.id)
    removeIn.add(b.id)
  }
  if (removeOut.size === 0 && removeIn.size === 0) return track
  return {
    ...track,
    clips: track.clips.map((clip) => {
      let next: Clip = clip
      if (removeOut.has(clip.id)) {
        const { transitionOut: _o, ...rest } = next
        void _o
        next = rest as Clip
      }
      if (removeIn.has(clip.id)) {
        const { transitionIn: _i, ...rest } = next
        void _i
        next = rest as Clip
      }
      return next
    }),
  }
}

/**
 * Given a set of clips and a timeline range [rangeStartMs, rangeEndMs], returns
 * a new array of clips with any overlapping portion removed or split. Used so
 * that a "winning" clip (new or moved) can occupy the range with no overlaps.
 * Applies to all track types (video, caption, audio, clip_audio).
 */
function trimClipsOverlappingRange(
  clips: Clip[],
  rangeStartMs: number,
  rangeEndMs: number,
): Clip[] {
  const result: Clip[] = []
  for (const o of clips) {
    const oStart = o.startTime
    const oEnd = o.startTime + o.duration
    if (oEnd <= rangeStartMs || oStart >= rangeEndMs) {
      result.push(o)
      continue
    }
    // O fully inside range → remove O
    if (oStart >= rangeStartMs && oEnd <= rangeEndMs) continue
    // Range fully inside O → split O into [oStart, rangeStartMs] and [rangeEndMs, oEnd]
    if (oStart < rangeStartMs && oEnd > rangeEndMs) {
      const leftDuration = rangeStartMs - oStart
      const rightDuration = oEnd - rangeEndMs
      if (leftDuration >= MIN_CLIP_DURATION_MS) {
        result.push({
          ...o,
          startTime: oStart,
          duration: leftDuration,
          inPoint: o.inPoint,
          outPoint: o.inPoint + leftDuration * o.speed,
        })
      }
      if (rightDuration >= MIN_CLIP_DURATION_MS) {
        result.push({
          ...o,
          id: crypto.randomUUID(),
          startTime: rangeEndMs,
          duration: rightDuration,
          inPoint: o.inPoint + (rangeEndMs - oStart) * o.speed,
          outPoint: o.outPoint,
        })
      }
      continue
    }
    // Overlap at end of O (O extends left of range) → trim O's end to rangeStartMs
    if (oStart < rangeStartMs && oEnd <= rangeEndMs) {
      const newDuration = rangeStartMs - oStart
      if (newDuration >= MIN_CLIP_DURATION_MS) {
        result.push({
          ...o,
          duration: newDuration,
          outPoint: o.inPoint + newDuration * o.speed,
        })
      }
      continue
    }
    // Overlap at start of O (O extends right of range) → trim O's start to rangeEndMs
    if (oStart >= rangeStartMs && oEnd > rangeEndMs) {
      const newDuration = oEnd - rangeEndMs
      if (newDuration >= MIN_CLIP_DURATION_MS) {
        const delta = rangeEndMs - oStart
        result.push({
          ...o,
          startTime: rangeEndMs,
          inPoint: o.inPoint + delta * o.speed,
          duration: newDuration,
        })
      }
    }
  }
  return result
}

function insertClipIntoTrack(track: Track, clip: Clip): Track {
  const rangeStart = Math.max(0, clip.startTime)
  const rangeEnd = rangeStart + clip.duration
  const trimmedOthers = trimClipsOverlappingRange(track.clips, rangeStart, rangeEnd)
  return {
    ...track,
    clips: [...trimmedOthers, { ...clip, startTime: rangeStart }],
  }
}

function createClipFromAsset(params: AddAssetClipParams, overrides: Partial<Clip> = {}): Clip {
  const duration = Math.max(1, params.duration)
  return {
    id: crypto.randomUUID(),
    assetId: params.assetId,
    kind: params.assetType === 'image' ? 'image' : 'video',
    startTime: Math.max(0, params.startTime),
    duration,
    inPoint: 0,
    outPoint: duration,
    sourceDurationMs: params.sourceDurationMs ?? duration,
    speed: 1.0,
    transform: structuredClone(DEFAULT_CLIP_TRANSFORM),
    ...overrides,
  }
}

/**
 * Label applied to the auto-created image overlay track. Kept as a constant so
 * the routing logic in `addAssetClipToTrack` and any future re-discovery code
 * (e.g. "find the existing overlay track") agree on the name.
 */
const IMAGE_OVERLAY_TRACK_LABEL = 'Image Overlay'

/**
 * Resolve (or create) the video track that should host an image clip dropped at
 * `dropStartMs..dropEndMs`. Image drops must stay on a track distinct from the
 * underlying video so the underlying video isn't trimmed away — otherwise the
 * image just *replaces* the video instead of overlaying on top of it.
 *
 * Selection rule:
 *   1. Prefer the highest-order video track whose drop range is free AND that
 *      already contains image-only clips (the existing overlay track).
 *   2. Otherwise prefer the highest-order video track that is empty in the
 *      drop range AND is not the target track the user dropped on (so the
 *      user's primary video lane stays untouched).
 *   3. Otherwise create a new `IMAGE_OVERLAY_TRACK_LABEL` track ordered above
 *      every existing track so it renders on top of the underlying video.
 *
 * Returns either an existing track id or a fully-formed new track to insert.
 */
function resolveImageOverlayTrack(
  tracks: Track[],
  droppedOnTrackId: string,
  dropStartMs: number,
  dropEndMs: number,
): { existingId: string; newTrack?: undefined } | { existingId?: undefined; newTrack: Track } {
  const isRangeFree = (track: Track) =>
    track.clips.every((c) => {
      const cEnd = c.startTime + c.duration
      return cEnd <= dropStartMs || c.startTime >= dropEndMs
    })
  const isImageOnly = (track: Track) =>
    track.clips.length > 0 && track.clips.every((c) => c.kind === 'image')

  const videoTracks = tracks
    .filter((t) => t.type === 'video' && !t.locked)
    .sort((a, b) => b.order - a.order)

  const reusableOverlay = videoTracks.find((t) => isImageOnly(t) && isRangeFree(t))
  if (reusableOverlay) return { existingId: reusableOverlay.id }

  const emptyAlt = videoTracks.find(
    (t) => t.id !== droppedOnTrackId && isRangeFree(t),
  )
  if (emptyAlt) return { existingId: emptyAlt.id }

  const maxOrder = Math.max(...tracks.map((t) => t.order), -1)
  const newTrack: Track = {
    id: crypto.randomUUID(),
    label: IMAGE_OVERLAY_TRACK_LABEL,
    type: 'video',
    clips: [],
    muted: false,
    visible: true,
    locked: false,
    order: maxOrder + 1,
  }
  return { newTrack }
}

// ─── Store Creation ──────────────────────────────────────────────────────────

/**
 * Create the editor Zustand store.
 *
 * Exported as `useEditorStore` — a React hook that components use to
 * subscribe to editor state and dispatch actions.
 *
 * @example
 *   // Read state
 *   const tracks = useEditorStore((s) => s.tracks)
 *   const isPlaying = useEditorStore((s) => s.isPlaying)
 *
 *   // Dispatch actions
 *   const addClip = useEditorStore((s) => s.addClip)
 *   addClip(trackId, newClip)
 */
export const useEditorStore = create<EditorStore>((set, get) => ({
  // ── Initial State (persistent only) ──

  tracks: createDefaultTracks(),
  captionStyle: DEFAULT_CAPTION_STYLE,
  composition: DEFAULT_COMPOSITION_CONFIG,
  globalAudioVolume: 1,

  // ── Clip Operations ──

  addClip: (trackId: string, clip: Clip) => {
    const state = get()
    const targetTrack = state.tracks.find((t) => t.id === trackId)
    if (!targetTrack || targetTrack.locked) return

    pushHistory('Add clip', state)

    set({
      tracks: state.tracks.map((track) =>
        track.id === trackId
          ? insertClipIntoTrack(track, clip)
          : track,
      ),
    })
  },

  addAssetClipToTrack: (trackId: string, params: AddAssetClipParams) => {
    const state = get()
    const targetTrack = state.tracks.find((t) => t.id === trackId)
    if (!targetTrack || targetTrack.locked || targetTrack.type === 'clip_audio') return

    const isVideoAsset = params.assetType === 'video'
    const isImageAsset = params.assetType === 'image'
    const isAudioAsset = params.assetType === 'audio'
    const canAddToVideo = targetTrack.type === 'video' && (isVideoAsset || isImageAsset)
    const canAddToAudio = targetTrack.type === 'audio' && isAudioAsset
    if (!canAddToVideo && !canAddToAudio) return

    pushHistory('Add asset clip', state)

    const primaryClipId = crypto.randomUUID()
    const primaryClip = createClipFromAsset(params, {
      id: primaryClipId,
      audioLinked: canAddToVideo && isVideoAsset ? true : undefined,
    })

    // Image drops route to (or create) a dedicated overlay video track so the
    // underlying video keeps playing and the image renders on top. See
    // `resolveImageOverlayTrack` for the selection rules.
    const overlayResolution =
      canAddToVideo && isImageAsset
        ? resolveImageOverlayTrack(
            state.tracks,
            targetTrack.id,
            primaryClip.startTime,
            primaryClip.startTime + primaryClip.duration,
          )
        : null
    const tracksWithOverlay = overlayResolution?.newTrack
      ? [...state.tracks, overlayResolution.newTrack]
      : state.tracks
    const hostTrackId =
      overlayResolution?.existingId ??
      overlayResolution?.newTrack?.id ??
      targetTrack.id

    const clipAudioTrack = canAddToVideo && isVideoAsset
      ? state.tracks.find((t) => t.type === 'clip_audio')
      : undefined
    const linkedAudioClip =
      clipAudioTrack && !clipAudioTrack.locked
        ? createClipFromAsset(params, {
            sourceVideoClipId: primaryClipId,
          })
        : null

    set({
      tracks: tracksWithOverlay.map((track) => {
        if (track.id === hostTrackId) return insertClipIntoTrack(track, primaryClip)
        if (linkedAudioClip && clipAudioTrack && track.id === clipAudioTrack.id) {
          return insertClipIntoTrack(track, linkedAudioClip)
        }
        return track
      }),
    })
    // Auto-select the new primary clip so the user sees it highlighted in the
    // timeline. Lives in the selection store after the Phase 4 split.
    useSelectionStore.getState().selectClip(primaryClipId)
  },

  moveClip: (clipId: string, newTrackId: string, newStartTime: number) => {
    const state = get()
    const found = findClipById(state.tracks, clipId)
    if (!found) return

    const sourceTrack = found.track
    const targetTrack = state.tracks.find((t) => t.id === newTrackId)

    // Disallow moving clips between incompatible track types:
    // clips must stay on tracks of the same type
    if (!targetTrack || sourceTrack.type !== targetTrack.type) {
      return
    }

    pushHistory('Move clip', state)

    const clip = found.clip
    const movedStart = Math.max(0, newStartTime)
    const movedEnd = movedStart + clip.duration
    const othersOnTarget = targetTrack.clips.filter((c) => c.id !== clipId)
    const trimmedOthers = trimClipsOverlappingRange(
      othersOnTarget,
      movedStart,
      movedEnd,
    )
    const updatedClip: Clip = { ...clip, startTime: movedStart }
    const isVideoClip = found.track.type === 'video'

    const isAudioClipFromVideo =
      sourceTrack.type === 'clip_audio' && clip.sourceVideoClipId

    const videoClipAudioLinked =
      isVideoClip ? clip.audioLinked !== false : (() => {
        const videoFound = findClipById(state.tracks, clip.sourceVideoClipId!)
        return videoFound ? videoFound.clip.audioLinked !== false : false
      })()

    // When moving a video+clip_audio pair, trim overlapping clips on the linked
    // track too so both layers are cut at the drop position (not just the one being dragged).
    let linkedTrackId: string | null = null
    let trimmedLinked: Clip[] | null = null
    let updatedLinkedClip: Clip | null = null

    if (videoClipAudioLinked) {
      if (isVideoClip) {
        const linked = findClipBySourceVideoClipId(state.tracks, clipId)
        if (linked) {
          linkedTrackId = linked.track.id
          const othersOnLinked = linked.track.clips.filter((c) => c.sourceVideoClipId !== clipId)
          trimmedLinked = trimClipsOverlappingRange(othersOnLinked, movedStart, movedEnd)
          updatedLinkedClip = { ...linked.clip, startTime: movedStart }
        }
      } else if (isAudioClipFromVideo && clip.sourceVideoClipId) {
        const videoFound = findClipById(state.tracks, clip.sourceVideoClipId)
        if (videoFound) {
          linkedTrackId = videoFound.track.id
          const othersOnLinked = videoFound.track.clips.filter((c) => c.id !== clip.sourceVideoClipId)
          trimmedLinked = trimClipsOverlappingRange(othersOnLinked, movedStart, movedEnd)
          updatedLinkedClip = { ...videoFound.clip, startTime: movedStart }
        }
      }
    }

    set({
      tracks: state.tracks.map((track) => {
        let nextTrack: Track
        if (track.id === newTrackId) {
          nextTrack = { ...track, clips: [...trimmedOthers, updatedClip] }
        } else if (
          track.id === linkedTrackId &&
          trimmedLinked != null &&
          updatedLinkedClip != null
        ) {
          nextTrack = { ...track, clips: [...trimmedLinked, updatedLinkedClip] }
        } else {
          const filtered = track.clips.filter((c) => c.id !== clipId)
          if (isVideoClip && track.type === 'clip_audio' && videoClipAudioLinked) {
            nextTrack = {
              ...track,
              clips: filtered.map((c) =>
                c.sourceVideoClipId === clipId ? { ...c, startTime: movedStart } : c,
              ),
            }
          } else if (
            isAudioClipFromVideo &&
            videoClipAudioLinked &&
            track.clips.some((c) => c.id === clip.sourceVideoClipId)
          ) {
            nextTrack = {
              ...track,
              clips: track.clips.map((c) =>
                c.id === clip.sourceVideoClipId ? { ...c, startTime: movedStart } : c,
              ),
            }
          } else {
            nextTrack = { ...track, clips: filtered }
          }
        }
        return cleanupBrokenSeamsOnTrack(nextTrack)
      }),
    })
  },

  moveClips: (moves) => {
    if (moves.length === 0) return
    const state = get()

    // ── Resolve each move against the current model ─────────────────────────
    //
    // Build a working table keyed by clipId. For each move we capture the
    // source track, the target track, and the clamped new start time. Invalid
    // moves (missing clip, missing/incompatible target) are dropped.
    type ResolvedMove = {
      clipId: string
      clip: Clip
      sourceTrackId: string
      targetTrackId: string
      newStart: number
    }
    const resolved = new Map<string, ResolvedMove>()
    for (const m of moves) {
      const found = findClipById(state.tracks, m.clipId)
      if (!found) continue
      const target = state.tracks.find((t) => t.id === m.newTrackId)
      if (!target || target.type !== found.track.type) continue
      resolved.set(m.clipId, {
        clipId: m.clipId,
        clip: found.clip,
        sourceTrackId: found.track.id,
        targetTrackId: m.newTrackId,
        newStart: Math.max(0, m.newStartTime),
      })
    }
    if (resolved.size === 0) return

    // ── Expand linked-audio pairs ───────────────────────────────────────────
    //
    // If a video clip is moving and its audio is linked, drag the matching
    // clip_audio along by the same delta — and vice versa. We only inject the
    // pair when the user hasn't already included it explicitly; if they have,
    // their explicit move wins.
    for (const m of [...resolved.values()]) {
      const sourceTrack = state.tracks.find((t) => t.id === m.sourceTrackId)
      if (!sourceTrack) continue
      const delta = m.newStart - m.clip.startTime

      if (sourceTrack.type === 'video' && m.clip.audioLinked !== false) {
        const linked = findClipBySourceVideoClipId(state.tracks, m.clipId)
        if (linked && !resolved.has(linked.clip.id)) {
          resolved.set(linked.clip.id, {
            clipId: linked.clip.id,
            clip: linked.clip,
            sourceTrackId: linked.track.id,
            targetTrackId: linked.track.id,
            newStart: Math.max(0, linked.clip.startTime + delta),
          })
        }
      } else if (sourceTrack.type === 'clip_audio' && m.clip.sourceVideoClipId) {
        const videoFound = findClipById(state.tracks, m.clip.sourceVideoClipId)
        if (
          videoFound &&
          videoFound.clip.audioLinked !== false &&
          !resolved.has(videoFound.clip.id)
        ) {
          resolved.set(videoFound.clip.id, {
            clipId: videoFound.clip.id,
            clip: videoFound.clip,
            sourceTrackId: videoFound.track.id,
            targetTrackId: videoFound.track.id,
            newStart: Math.max(0, videoFound.clip.startTime + delta),
          })
        }
      }
    }

    // Bail when none of the moves actually changed anything (e.g. the user
    // clicked without dragging). Avoids a no-op history entry.
    let anyChanged = false
    for (const m of resolved.values()) {
      if (m.sourceTrackId !== m.targetTrackId || m.newStart !== m.clip.startTime) {
        anyChanged = true
        break
      }
    }
    if (!anyChanged) return

    pushHistory('Move clips', state)

    // ── Group incoming clips by target track ────────────────────────────────
    const arrivingByTrack = new Map<string, Clip[]>()
    const movingIds = new Set<string>()
    for (const m of resolved.values()) {
      movingIds.add(m.clipId)
      const list = arrivingByTrack.get(m.targetTrackId) ?? []
      list.push({ ...m.clip, startTime: m.newStart })
      arrivingByTrack.set(m.targetTrackId, list)
    }

    // ── Build the new tracks list ───────────────────────────────────────────
    //
    // For each track:
    //   - drop every clip that's moving (its source row is losing it),
    //   - if this track is receiving clips, trim non-moving residents
    //     against each incoming clip's range and append the new copies.
    //   - moved clips never trim each other — the selection is treated as a
    //     single object.
    const nextTracks = state.tracks.map((track) => {
      const stayingResidents = track.clips.filter((c) => !movingIds.has(c.id))
      const incoming = arrivingByTrack.get(track.id)

      if (!incoming || incoming.length === 0) {
        return cleanupBrokenSeamsOnTrack({ ...track, clips: stayingResidents })
      }

      // Trim every staying clip against the union of incoming ranges, one
      // incoming clip at a time. Repeatedly applying the single-range trim
      // is correct because each pass only operates on non-moving clips.
      let survivors = stayingResidents
      for (const incomingClip of incoming) {
        const start = incomingClip.startTime
        const end = start + incomingClip.duration
        survivors = trimClipsOverlappingRange(survivors, start, end)
      }

      return cleanupBrokenSeamsOnTrack({ ...track, clips: [...survivors, ...incoming] })
    })

    set({ tracks: nextTracks })
  },

  trimClip: (clipId: string, edge: TrimEdge, newTime: number) => {
    const state = get()
    const found = findClipById(state.tracks, clipId)
    if (!found) return

    pushHistory('Trim clip', state)

    // Captions have no source media, so both edges can be dragged out freely.
    // Media-backed clips stay bounded by inPoint/outPoint as before.
    const isCaption = found.track.type === 'caption'

    const adjustKeyframesForTrim = (
      clip: Clip,
      deltaMs: number,
      newDuration: number,
    ): Clip['keyframeTracks'] => {
      if (!clip.keyframeTracks || clip.keyframeTracks.length === 0) return clip.keyframeTracks
      return clip.keyframeTracks.map((t) => {
        const baseline = ANIMATABLE_PROPERTIES[t.propertyId].read(clip)
        return shiftAndClamp(t, deltaMs, newDuration, baseline)
      })
    }

    const applyTrim = (clip: Clip): Clip => {
      if (edge === 'start') {
        // Media clips can extend left up to the source available before the
        // current in-point (`inPoint / speed` ms on the timeline). Captions
        // have no source media, so they only floor at t=0.
        const minMediaStart = Math.max(0, clip.startTime - clip.inPoint / clip.speed)
        const newStartTime = isCaption
          ? Math.max(0, newTime)
          : Math.max(minMediaStart, newTime)
        const delta = newStartTime - clip.startTime
        const newInPoint = Math.max(0, clip.inPoint + delta * clip.speed)
        const newDuration = Math.max(1, clip.duration - delta)
        // Keyframes are clip-local. Moving the clip's left edge right by
        // `delta` ms means a keyframe at old local time T is now at T - delta
        // in the new timebase — anything that lands before 0 gets clamped
        // with a synthetic boundary keyframe preserving the cut value.
        return {
          ...clip,
          startTime: newStartTime,
          inPoint: newInPoint,
          duration: newDuration,
          keyframeTracks: adjustKeyframesForTrim(clip, -delta, newDuration),
        }
      }
      // End trim: for media clips, allow extending back up to source asset length
      // (sourceDurationMs), not beyond. For clips without sourceDurationMs
      // (legacy/loaded), when shortening we set it to current outPoint so the user
      // can extend back after trimming. Captions have no source bound.
      const currentOutPoint = clip.outPoint
      const maxOutPoint = clip.sourceDurationMs ?? currentOutPoint
      const maxDuration = isCaption
        ? Number.POSITIVE_INFINITY
        : (maxOutPoint - clip.inPoint) / clip.speed
      const requestedDuration = newTime - clip.startTime
      const newDuration = Math.max(1, Math.min(maxDuration, requestedDuration))
      const newOutPoint = clip.inPoint + newDuration * clip.speed
      const preserveSourceDuration = isCaption
        ? undefined
        : clip.sourceDurationMs ?? (newDuration < clip.duration ? currentOutPoint : undefined)
      return {
        ...clip,
        duration: newDuration,
        outPoint: newOutPoint,
        // End trim: keyframe times don't shift, only the upper clamp changes.
        keyframeTracks: adjustKeyframesForTrim(clip, 0, newDuration),
        ...(preserveSourceDuration != null && { sourceDurationMs: preserveSourceDuration }),
      }
    }

    const isVideoClip = found.track.type === 'video'
    const videoClip = found.clip
    const audioLinked = isVideoClip ? videoClip.audioLinked !== false : true

    set({
      tracks: state.tracks.map((track) =>
        cleanupBrokenSeamsOnTrack({
          ...track,
          clips: track.clips.map((clip) => {
            if (clip.id === clipId) return applyTrim(clip)
            if (
              isVideoClip &&
              audioLinked &&
              track.type === 'clip_audio' &&
              clip.sourceVideoClipId === clipId
            ) {
              return applyTrim(clip)
            }
            return clip
          }),
        }),
      ),
    })
  },

  rateStretchClip: (clipId: string, edge: TrimEdge, newTime: number) => {
    const state = get()
    const found = findClipById(state.tracks, clipId)
    if (!found) return

    // Rate-stretch only applies to clips that have a real source duration.
    // Captions are pure text overlays and image clips have arbitrary duration —
    // there's nothing to "stretch" speed-wise. The UI guards against issuing
    // these, but a safety check keeps the store consistent.
    const { track: hostTrack, clip: hostClip } = found
    if (hostTrack.type === 'caption') return
    if (hostTrack.type === 'video' && hostClip.kind === 'image') return

    pushHistory('Rate stretch', state)

    const sourceDuration = hostClip.outPoint - hostClip.inPoint
    if (sourceDuration <= 0) return

    // Speed range mirrors `updateClipSpeed`'s clamp so users can't escape
    // either entry point. Below 0.25× audio becomes unintelligibly slow; above
    // 4× it's beyond what time-stretchers reliably handle.
    const MIN_SPEED = 0.25
    const MAX_SPEED = 4
    const MIN_DURATION_FROM_SPEED = sourceDuration / MAX_SPEED
    const MAX_DURATION_FROM_SPEED = sourceDuration / MIN_SPEED

    const originalEnd = hostClip.startTime + hostClip.duration
    const minDurationMs = 1 // floor at 1ms so we never produce a zero-length clip

    const requestedDuration =
      edge === 'end'
        ? Math.max(minDurationMs, newTime - hostClip.startTime)
        : Math.max(minDurationMs, originalEnd - newTime)
    const newDuration = Math.max(
      MIN_DURATION_FROM_SPEED,
      Math.min(MAX_DURATION_FROM_SPEED, requestedDuration),
    )
    const newSpeed = Math.max(
      MIN_SPEED,
      Math.min(MAX_SPEED, sourceDuration / newDuration),
    )
    const newStartTime =
      edge === 'start' ? Math.max(0, originalEnd - newDuration) : hostClip.startTime
    const durationFactor = hostClip.duration > 0 ? newDuration / hostClip.duration : 1

    const applyStretch = (clip: Clip): Clip => {
      // Keyframes are clip-local, so scale them by the same duration factor
      // the stretch produced — a keyframe at 50% of the old clip stays at 50%
      // of the new one, matching `updateClipSpeed`'s behaviour.
      const nextKeyframeTracks = clip.keyframeTracks
        ? clip.keyframeTracks.map((t) => scaleTimes(t, durationFactor))
        : clip.keyframeTracks
      return {
        ...clip,
        startTime: newStartTime,
        duration: newDuration,
        speed: newSpeed,
        keyframeTracks: nextKeyframeTracks,
      }
    }

    const isVideoClip = hostTrack.type === 'video'
    const audioLinked = isVideoClip ? hostClip.audioLinked !== false : true

    set({
      tracks: state.tracks.map((track) =>
        cleanupBrokenSeamsOnTrack({
          ...track,
          clips: track.clips.map((clip) => {
            if (clip.id === clipId) return applyStretch(clip)
            if (
              isVideoClip &&
              audioLinked &&
              track.type === 'clip_audio' &&
              clip.sourceVideoClipId === clipId
            ) {
              return applyStretch(clip)
            }
            return clip
          }),
        }),
      ),
    })
  },

  slipClip: (clipId: string, sourceDeltaMs: number) => {
    const state = get()
    const found = findClipById(state.tracks, clipId)
    if (!found) return

    // Slip needs a real source window — captions are text with no media to
    // scrub, and image clips have arbitrary duration with no "later frames"
    // to slide to. The UI guards against issuing these, but a safety check
    // keeps the store consistent if a stale tool mode slips through.
    const { track: hostTrack, clip: hostClip } = found
    if (hostTrack.type === 'caption') return
    if (hostTrack.type === 'video' && hostClip.kind === 'image') return

    const sourceWindow = hostClip.outPoint - hostClip.inPoint
    if (sourceWindow <= 0) return

    // Without a known total source length we can't safely slide the window
    // *forward* — there might not be more source to the right of the current
    // outPoint. Use the existing outPoint as a defensive upper bound in that
    // case; the user can still slip backward toward inPoint = 0.
    const sourceEnd = hostClip.sourceDurationMs ?? hostClip.outPoint
    const maxInPoint = Math.max(0, sourceEnd - sourceWindow)
    const minInPoint = 0
    const newInPoint = Math.max(
      minInPoint,
      Math.min(maxInPoint, hostClip.inPoint + sourceDeltaMs),
    )
    const appliedDelta = newInPoint - hostClip.inPoint
    if (appliedDelta === 0) return

    pushHistory('Slip clip', state)

    const applySlip = (clip: Clip): Clip => ({
      ...clip,
      inPoint: clip.inPoint + appliedDelta,
      outPoint: clip.outPoint + appliedDelta,
      // Keyframes are clip-local (0..duration), not source-local, so a slip
      // doesn't move them — the clip's visible timebase is unchanged.
    })

    const isVideoClip = hostTrack.type === 'video'
    const audioLinked = isVideoClip ? hostClip.audioLinked !== false : true

    set({
      tracks: state.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => {
          if (clip.id === clipId) return applySlip(clip)
          if (
            isVideoClip &&
            audioLinked &&
            track.type === 'clip_audio' &&
            clip.sourceVideoClipId === clipId
          ) {
            return applySlip(clip)
          }
          return clip
        }),
      })),
    })
  },

  splitClip: (clipId: string, atTime: number) => {
    const state = get()
    const found = findClipById(state.tracks, clipId)
    if (!found) return

    const { clip } = found
    // Can only split within the clip's timeline span
    if (atTime <= clip.startTime || atTime >= clip.startTime + clip.duration) return

    pushHistory('Split clip', state)

    const splitOffset = atTime - clip.startTime
    const splitSourceTime = clip.inPoint + splitOffset * clip.speed

    // Split keyframe tracks at the cut so each half keeps its share and a
    // synthetic boundary keyframe holds the interpolated value at the cut —
    // no visible pop across the split.
    let leftKeyframeTracks: typeof clip.keyframeTracks
    let rightKeyframeTracks: typeof clip.keyframeTracks
    if (clip.keyframeTracks && clip.keyframeTracks.length > 0) {
      const lefts: KeyframeTrack[] = []
      const rights: KeyframeTrack[] = []
      for (const t of clip.keyframeTracks) {
        const baseline = ANIMATABLE_PROPERTIES[t.propertyId].read(clip)
        const { left, right } = splitKeyframesAt(t, splitOffset, baseline)
        lefts.push(left)
        rights.push(right)
      }
      leftKeyframeTracks = lefts
      rightKeyframeTracks = rights
    }

    // Left half: original clip shortened
    const leftClip: Clip = {
      ...clip,
      duration: splitOffset,
      outPoint: splitSourceTime,
      keyframeTracks: leftKeyframeTracks,
    }

    // Right half: new clip starting at split point
    const rightClipId = crypto.randomUUID()
    const rightClip: Clip = {
      ...clip,
      id: rightClipId,
      startTime: atTime,
      duration: clip.duration - splitOffset,
      inPoint: splitSourceTime,
      keyframeTracks: rightKeyframeTracks,
    }

    const isVideoClip = found.track.type === 'video'
    const linked = findClipBySourceVideoClipId(state.tracks, clipId)
    const audioLinked = isVideoClip && clip.audioLinked !== false

    set({
      tracks: state.tracks.map((track) => {
        if (track.type === 'clip_audio' && isVideoClip && linked && audioLinked) {
          const audioClip = linked.clip
          const audioLeft: Clip = {
            ...audioClip,
            duration: splitOffset,
            outPoint: splitSourceTime,
          }
          const audioRight: Clip = {
            ...audioClip,
            id: crypto.randomUUID(),
            startTime: atTime,
            duration: clip.duration - splitOffset,
            inPoint: splitSourceTime,
            sourceVideoClipId: rightClipId,
          }
          return {
            ...track,
            clips: track.clips.flatMap((c) =>
              c.sourceVideoClipId === clipId ? [audioLeft, audioRight] : [c],
            ),
          }
        }
        return {
          ...track,
          clips: track.clips.flatMap((c) =>
            c.id === clipId ? [leftClip, rightClip] : [c],
          ),
        }
      }),
    })
  },

  setClipAudioLinked: (videoClipId: string, linked: boolean) => {
    const state = get()
    const found = findClipById(state.tracks, videoClipId)
    if (!found || found.track.type !== 'video') return

    pushHistory(linked ? 'Link clip audio' : 'Unlink clip audio', state)

    set({
      tracks: state.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((c) =>
          c.id === videoClipId ? { ...c, audioLinked: linked } : c,
        ),
      })),
    })
  },

  setClipAudioFade: (
    clipId: string,
    edge: 'in' | 'out',
    durationMs: number,
  ) => {
    const state = get()
    const found = findClipById(state.tracks, clipId)
    if (!found) return
    if (found.track.type !== 'audio' && found.track.type !== 'clip_audio') return

    const { clip } = found
    // Cap at half the clip's duration so the two fades can't overlap inside
    // a single clip — that would mean the audio is never at full volume.
    const maxMs = Math.max(0, clip.duration / 2)
    const next = Math.max(0, Math.min(maxMs, Math.round(durationMs)))
    const key = edge === 'in' ? 'fadeInMs' : 'fadeOutMs'
    const current = (clip as Clip)[key] ?? 0
    if (next === current) return

    pushHistory(next > 0 ? `Set audio fade ${edge}` : `Clear audio fade ${edge}`, state)

    set({
      tracks: state.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((c) => {
          if (c.id !== clipId) return c
          if (next <= 0) {
            const { [key]: _removed, ...rest } = c
            void _removed
            return rest as Clip
          }
          return { ...c, [key]: next }
        }),
      })),
    })
  },

  deleteClips: (clipIds: string[]) => {
    const state = get()
    pushHistory('Delete clips', state)

    const clipIdSet = new Set(clipIds)
    const idsToRemove = new Set(clipIds)
    for (const track of state.tracks) {
      if (track.type === 'clip_audio') {
        for (const c of track.clips) {
          if (c.sourceVideoClipId && clipIdSet.has(c.sourceVideoClipId)) idsToRemove.add(c.id)
        }
      }
    }
    set({
      tracks: state.tracks.map((track) => ({
        ...track,
        clips: track.clips.filter(
          (c) => !idsToRemove.has(c.id) && !(c.sourceVideoClipId && clipIdSet.has(c.sourceVideoClipId)),
        ),
      })),
    })
    // Keep selection coherent with the model after deletion.
    useSelectionStore.getState().removeFromSelection(idsToRemove)
  },

  duplicateClips: (clipIds: string[]) => {
    if (clipIds.length === 0) return
    const state = get()

    // Resolve each id → (clip, host track). Drop clip_audio sources from the
    // user-facing set — their parent video clip's duplicate already recreates
    // them, so duplicating both would land two audio peers on top of each other.
    type Resolved = { clip: Clip; track: Track }
    const resolved: Resolved[] = []
    for (const id of clipIds) {
      const found = findClipById(state.tracks, id)
      if (!found) continue
      if (found.track.locked) continue
      if (found.track.type === 'clip_audio') continue
      resolved.push({ clip: found.clip, track: found.track })
    }
    if (resolved.length === 0) return

    pushHistory('Duplicate clips', state)

    // Map<trackId, Clip[]> of new clips to insert.
    const newPrimaries: Array<{ trackId: string; clip: Clip }> = []
    const newAudioPeers: Array<{ trackId: string; clip: Clip }> = []
    const newPrimaryIds: string[] = []
    const clipAudioTrack = state.tracks.find((t) => t.type === 'clip_audio')

    for (const { clip, track } of resolved) {
      const dupId = crypto.randomUUID()
      newPrimaryIds.push(dupId)
      // Strip transitions: the duplicate's neighbours differ from the source's,
      // so seam transitions wouldn't pair correctly anyway.
      const { transitionIn: _i, transitionOut: _o, ...rest } = clip
      void _i
      void _o
      const dup: Clip = {
        ...structuredClone(rest),
        id: dupId,
        startTime: clip.startTime + clip.duration,
      }
      newPrimaries.push({ trackId: track.id, clip: dup })

      if (
        track.type === 'video' &&
        clip.audioLinked !== false &&
        clipAudioTrack &&
        !clipAudioTrack.locked
      ) {
        const peer = findClipBySourceVideoClipId(state.tracks, clip.id)
        if (peer) {
          const peerDup: Clip = {
            ...structuredClone(peer.clip),
            id: crypto.randomUUID(),
            startTime: peer.clip.startTime + peer.clip.duration,
            sourceVideoClipId: dupId,
          }
          newAudioPeers.push({ trackId: peer.track.id, clip: peerDup })
        }
      }
    }

    const allNew = [...newPrimaries, ...newAudioPeers]
    const newByTrack = new Map<string, Clip[]>()
    for (const { trackId, clip } of allNew) {
      const list = newByTrack.get(trackId) ?? []
      list.push(clip)
      newByTrack.set(trackId, list)
    }

    set({
      tracks: state.tracks.map((track) => {
        const incoming = newByTrack.get(track.id)
        if (!incoming) return track
        // Insert each new clip via the shared helper so existing clips on the
        // track are trimmed to make room (matches addClip / moveClip).
        let next = track
        for (const clip of incoming) {
          next = insertClipIntoTrack(next, clip)
        }
        return next
      }),
    })

    // Surface the duplicates as the new selection so the user sees them.
    useSelectionStore.getState().setSelection(newPrimaryIds)
  },

  copyClips: (clipIds: string[]) => {
    if (clipIds.length === 0) {
      clipboardBuffer = null
      useUIStore.getState().setClipboardPreview(null)
      return
    }
    const state = get()
    const entries: ClipboardEntry[] = []
    let baseline = Number.POSITIVE_INFINITY
    for (const id of clipIds) {
      const found = findClipById(state.tracks, id)
      if (!found) continue
      // clip_audio peers are recreated from their parent video clip during
      // paste; copying them standalone would result in a peer that can't be
      // resolved on paste.
      if (found.track.type === 'clip_audio') continue
      entries.push({
        clip: structuredClone(found.clip),
        sourceTrackType: found.track.type,
        sourceAudioPeer: (() => {
          if (found.track.type !== 'video' || found.clip.audioLinked === false) return null
          const peer = findClipBySourceVideoClipId(state.tracks, found.clip.id)
          return peer ? structuredClone(peer.clip) : null
        })(),
      })
      if (found.clip.startTime < baseline) baseline = found.clip.startTime
    }
    if (entries.length === 0) {
      clipboardBuffer = null
      useUIStore.getState().setClipboardPreview(null)
      return
    }
    clipboardBuffer = { entries, baselineStartMs: baseline }
    // Mirror a render-friendly summary into the UI store so timeline lanes can
    // draw paste-preview ghosts without subscribing to the (intentionally
    // non-reactive) module-scope buffer above.
    useUIStore.getState().setClipboardPreview({
      baselineMs: baseline,
      entries: entries.map((e) => ({
        sourceTrackType: e.sourceTrackType,
        offsetMs: e.clip.startTime - baseline,
        durationMs: e.clip.duration,
      })),
    })
  },

  pasteClips: (playheadMs: number) => {
    if (!clipboardBuffer || clipboardBuffer.entries.length === 0) return
    const state = get()
    const baseline = clipboardBuffer.baselineStartMs
    const anchor = Math.max(0, playheadMs)

    // Resolve a target track for each clip type once, so multiple pasted clips
    // of the same type land together rather than spreading across tracks.
    const targetTrackFor = (type: TrackType): Track | undefined =>
      state.tracks.find((t) => t.type === type && !t.locked)
    const audioPeerTrack = state.tracks.find((t) => t.type === 'clip_audio' && !t.locked)

    const placements: Array<{ trackId: string; clip: Clip }> = []
    const newPrimaryIds: string[] = []

    for (const entry of clipboardBuffer.entries) {
      const target = targetTrackFor(entry.sourceTrackType)
      if (!target) continue
      const offset = entry.clip.startTime - baseline
      const newId = crypto.randomUUID()
      const { transitionIn: _i, transitionOut: _o, ...rest } = entry.clip
      void _i
      void _o
      const placed: Clip = {
        ...structuredClone(rest),
        id: newId,
        startTime: Math.max(0, anchor + offset),
      }
      placements.push({ trackId: target.id, clip: placed })
      newPrimaryIds.push(newId)

      if (
        entry.sourceTrackType === 'video' &&
        entry.sourceAudioPeer &&
        audioPeerTrack
      ) {
        const peerOffset = entry.sourceAudioPeer.startTime - baseline
        placements.push({
          trackId: audioPeerTrack.id,
          clip: {
            ...structuredClone(entry.sourceAudioPeer),
            id: crypto.randomUUID(),
            startTime: Math.max(0, anchor + peerOffset),
            sourceVideoClipId: newId,
          },
        })
      }
    }

    if (placements.length === 0) return

    pushHistory('Paste clips', state)

    const byTrack = new Map<string, Clip[]>()
    for (const { trackId, clip } of placements) {
      const list = byTrack.get(trackId) ?? []
      list.push(clip)
      byTrack.set(trackId, list)
    }

    set({
      tracks: state.tracks.map((track) => {
        const incoming = byTrack.get(track.id)
        if (!incoming) return track
        let next = track
        for (const clip of incoming) {
          next = insertClipIntoTrack(next, clip)
        }
        return next
      }),
    })

    useSelectionStore.getState().setSelection(newPrimaryIds)
  },

  nudgeClips: (clipIds: string[], deltaMs: number) => {
    if (clipIds.length === 0 || deltaMs === 0) return
    const state = get()
    const moves: Array<{ clipId: string; newTrackId: string; newStartTime: number }> = []
    for (const id of clipIds) {
      const found = findClipById(state.tracks, id)
      if (!found || found.track.locked) continue
      moves.push({
        clipId: id,
        newTrackId: found.track.id,
        newStartTime: Math.max(0, found.clip.startTime + deltaMs),
      })
    }
    if (moves.length === 0) return
    // Delegate to moveClips so linked-audio mirroring and overlap-trim rules
    // are shared. moveClips also handles its own history entry, so we don't
    // push one here.
    get().moveClips(moves)
  },

  updateClipTransform: (clipId: string, transform: Partial<ClipTransform>) => {
    const state = get()
    pushHistory('Update transform', state)

    set({
      tracks: state.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) =>
          clip.id === clipId
            ? {
                ...clip,
                transform: {
                  ...clip.transform,
                  ...transform,
                  crop: transform.crop
                    ? { ...clip.transform.crop, ...transform.crop }
                    : clip.transform.crop,
                },
              }
            : clip,
        ),
      })),
    })
  },

  addClipEffect: (clipId: string, effect: EffectInstance) => {
    const state = get()
    pushHistory('Add effect', state)
    set({ tracks: mapClipEffects(state.tracks, clipId, (stack) => [...stack, effect]) })
  },

  updateClipEffect: (clipId: string, effectId: string, patch: Partial<EffectInstance>) => {
    const state = get()
    pushHistory('Update effect', state)
    set({
      tracks: mapClipEffects(state.tracks, clipId, (stack) =>
        stack.map((fx) => (fx.id === effectId ? ({ ...fx, ...patch } as EffectInstance) : fx)),
      ),
    })
  },

  removeClipEffect: (clipId: string, effectId: string) => {
    const state = get()
    pushHistory('Remove effect', state)
    set({
      tracks: mapClipEffects(state.tracks, clipId, (stack) =>
        stack.filter((fx) => fx.id !== effectId),
      ),
    })
  },

  moveClipEffect: (clipId: string, fromIndex: number, toIndex: number) => {
    const state = get()
    pushHistory('Reorder effects', state)
    set({
      tracks: mapClipEffects(state.tracks, clipId, (stack) => {
        if (
          fromIndex === toIndex ||
          fromIndex < 0 ||
          toIndex < 0 ||
          fromIndex >= stack.length ||
          toIndex >= stack.length
        ) {
          return stack
        }
        const next = [...stack]
        const [moved] = next.splice(fromIndex, 1)
        next.splice(toIndex, 0, moved)
        return next
      }),
    })
  },

  setClipEffects: (clipId: string, effects: EffectInstance[]) => {
    const state = get()
    pushHistory('Set effects', state)
    set({ tracks: mapClipEffects(state.tracks, clipId, () => effects) })
  },

  enableKeyframing: (
    clipId: string,
    propertyId: AnimatablePropertyId,
    seedTimeMs: number,
  ) => {
    const state = get()
    pushHistory('Enable keyframing', state)

    set({
      tracks: state.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => {
          if (clip.id !== clipId) return clip
          const tracks = clip.keyframeTracks ?? []
          if (tracks.some((t) => t.propertyId === propertyId)) return clip
          const baseline = ANIMATABLE_PROPERTIES[propertyId].read(clip)
          const clampedTime = Math.max(0, Math.min(clip.duration, seedTimeMs))
          const newTrack: KeyframeTrack = {
            propertyId,
            keyframes: [createKeyframe(clampedTime, baseline)],
          }
          return { ...clip, keyframeTracks: [...tracks, newTrack] }
        }),
      })),
    })
  },

  disableKeyframing: (clipId: string, propertyId: AnimatablePropertyId) => {
    const state = get()
    pushHistory('Disable keyframing', state)

    set({
      tracks: state.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => {
          if (clip.id !== clipId) return clip
          const tracks = clip.keyframeTracks
          if (!tracks || tracks.length === 0) return clip
          const filtered = tracks.filter((t) => t.propertyId !== propertyId)
          if (filtered.length === tracks.length) return clip
          return { ...clip, keyframeTracks: filtered.length === 0 ? undefined : filtered }
        }),
      })),
    })

    // If any selected keyframes were on the disabled track, drop them.
    const sel = useSelectionStore.getState()
    if (sel.selectedKeyframes.some((k) => k.clipId === clipId && k.propertyId === propertyId)) {
      useSelectionStore.setState({
        selectedKeyframes: sel.selectedKeyframes.filter(
          (k) => !(k.clipId === clipId && k.propertyId === propertyId),
        ),
      })
    }
  },

  setPropertyAtPlayhead: (
    clipId: string,
    propertyId: AnimatablePropertyId,
    timeMs: number,
    value: number,
  ) => {
    const state = get()
    pushHistory('Set keyframe value', state)

    const prop = ANIMATABLE_PROPERTIES[propertyId]

    set({
      tracks: state.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => {
          if (clip.id !== clipId) return clip
          const tracks = clip.keyframeTracks
          const trackIdx = tracks ? tracks.findIndex((t) => t.propertyId === propertyId) : -1

          // No keyframing on this property — write to baseline (matches the
          // current static-edit behavior when the stopwatch is off).
          if (!tracks || trackIdx < 0) return prop.write(clip, value)

          const clampedTime = Math.max(0, Math.min(clip.duration, timeMs))
          const updated = upsertKeyframe(tracks[trackIdx], clampedTime, value)
          const nextTracks = [...tracks]
          nextTracks[trackIdx] = updated
          return { ...clip, keyframeTracks: nextTracks }
        }),
      })),
    })
  },

  moveKeyframe: (
    clipId: string,
    propertyId: AnimatablePropertyId,
    keyframeId: string,
    newTimeMs: number,
  ) => {
    const state = get()
    pushHistory('Move keyframe', state)

    set({
      tracks: state.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => {
          if (clip.id !== clipId) return clip
          const tracks = clip.keyframeTracks
          const trackIdx = tracks ? tracks.findIndex((t) => t.propertyId === propertyId) : -1
          if (!tracks || trackIdx < 0) return clip
          const updated = moveAndResort(tracks[trackIdx], keyframeId, newTimeMs, clip.duration)
          if (updated === tracks[trackIdx]) return clip
          const nextTracks = [...tracks]
          nextTracks[trackIdx] = updated
          return { ...clip, keyframeTracks: nextTracks }
        }),
      })),
    })
  },

  deleteKeyframes: (
    clipId: string,
    propertyId: AnimatablePropertyId,
    keyframeIds: ReadonlyArray<string>,
  ) => {
    if (keyframeIds.length === 0) return
    const state = get()
    pushHistory('Delete keyframes', state)

    const idSet = new Set(keyframeIds)

    set({
      tracks: state.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => {
          if (clip.id !== clipId) return clip
          const tracks = clip.keyframeTracks
          const trackIdx = tracks ? tracks.findIndex((t) => t.propertyId === propertyId) : -1
          if (!tracks || trackIdx < 0) return clip
          const updated = deleteKeyframesById(tracks[trackIdx], idSet)
          if (updated === tracks[trackIdx]) return clip
          const nextTracks = [...tracks]
          nextTracks[trackIdx] = updated
          return { ...clip, keyframeTracks: nextTracks }
        }),
      })),
    })

    // Drop any selected refs pointing at deleted keyframes.
    const sel = useSelectionStore.getState()
    if (sel.selectedKeyframes.some((k) => k.clipId === clipId && k.propertyId === propertyId && idSet.has(k.keyframeId))) {
      useSelectionStore.setState({
        selectedKeyframes: sel.selectedKeyframes.filter(
          (k) => !(k.clipId === clipId && k.propertyId === propertyId && idSet.has(k.keyframeId)),
        ),
      })
    }
  },

  setKeyframeEasing: (
    clipId: string,
    propertyId: AnimatablePropertyId,
    keyframeId: string,
    side: 'in' | 'out',
    easing: EasingKind,
  ) => {
    const state = get()
    pushHistory('Set keyframe easing', state)

    set({
      tracks: state.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => {
          if (clip.id !== clipId) return clip
          const tracks = clip.keyframeTracks
          const trackIdx = tracks ? tracks.findIndex((t) => t.propertyId === propertyId) : -1
          if (!tracks || trackIdx < 0) return clip
          const updated = setKeyframeEasingPure(tracks[trackIdx], keyframeId, side, easing)
          if (updated === tracks[trackIdx]) return clip
          const nextTracks = [...tracks]
          nextTracks[trackIdx] = updated
          return { ...clip, keyframeTracks: nextTracks }
        }),
      })),
    })
  },

  updateClipSpeed: (clipId: string, speed: number) => {
    const state = get()
    pushHistory('Update speed', state)

    const clampedSpeed = Math.max(0.25, Math.min(4, speed))

    set({
      tracks: state.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => {
          if (clip.id !== clipId) return clip
          const newDuration = (clip.outPoint - clip.inPoint) / clampedSpeed
          // Scale keyframe times by the duration ratio so each keyframe stays
          // at the same proportional moment of the clip — e.g. a keyframe at
          // 50% of the clip is still at 50% after 2× speed.
          const factor = clip.duration > 0 ? newDuration / clip.duration : 1
          const nextKeyframeTracks = clip.keyframeTracks
            ? clip.keyframeTracks.map((t) => scaleTimes(t, factor))
            : clip.keyframeTracks
          return {
            ...clip,
            speed: clampedSpeed,
            duration: newDuration,
            keyframeTracks: nextKeyframeTracks,
          }
        }),
      })),
    })
  },

  setClipFreezeFrame: (clipId: string, frameMs: number | undefined) => {
    const state = get()
    pushHistory(frameMs !== undefined ? 'Freeze frame' : 'Clear freeze frame', state)

    set({
      tracks: state.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => {
          if (clip.id !== clipId) return clip
          // Spread the updated freezeFrame. Setting to undefined removes the
          // property from the serialized output (JSON.stringify omits undefined).
          return { ...clip, freezeFrame: frameMs }
        }),
      })),
    })
  },

  updateCaptionText: (clipId: string, text: string) => {
    const state = get()
    pushHistory('Edit caption text', state)

    set({
      tracks: state.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) =>
          clip.id === clipId ? { ...clip, captionText: text } : clip,
        ),
      })),
    })
  },

  updateClipCaptionStyle: (clipId: string, styleUpdate: Partial<CaptionStyle>) => {
    const state = get()
    pushHistory('Caption style override', state)

    set({
      tracks: state.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => {
          if (clip.id !== clipId) return clip
          // Merge the style update with the existing per-clip captionStyle.
          // If no per-clip style exists yet, start from the global captionStyle
          // so the user sees a diff from a known baseline rather than empty fields.
          const baseCaptionStyle = clip.captionStyle ?? state.captionStyle
          return {
            ...clip,
            captionStyle: { ...baseCaptionStyle, ...styleUpdate },
          }
        }),
      })),
    })
  },

  clearClipCaptionStyle: (clipId: string) => {
    const state = get()
    pushHistory('Clear caption style override', state)

    set({
      tracks: state.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => {
          if (clip.id !== clipId) return clip
          const { captionStyle, ...rest } = clip
          void captionStyle
          return rest as Clip
        }),
      })),
    })
  },

  // ── Transitions ──

  setClipTransition: (
    clipId: string,
    edge: 'in' | 'out',
    transition: ClipTransition | null,
  ) => {
    const state = get()
    const found = findClipById(state.tracks, clipId)
    // Captions are text overlays; transitions don't apply to them.
    if (found?.track.type === 'caption') return
    pushHistory(transition ? `Set ${edge} transition` : `Clear ${edge} transition`, state)

    const key = edge === 'in' ? 'transitionIn' : 'transitionOut'

    set({
      tracks: state.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => {
          if (clip.id !== clipId) return clip
          if (transition === null || transition.type === 'none') {
            const { [key]: _removed, ...rest } = clip
            void _removed
            return rest as Clip
          }
          return { ...clip, [key]: transition }
        }),
      })),
    })
  },

  setSeamTransition: (
    leftClipId: string,
    rightClipId: string,
    transition: ClipTransition,
  ) => {
    const state = get()
    const left = findClipById(state.tracks, leftClipId)
    const right = findClipById(state.tracks, rightClipId)
    if (left?.track.type === 'caption' || right?.track.type === 'caption') return
    pushHistory('Set seam transition', state)

    set({
      tracks: state.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => {
          if (clip.id === leftClipId) {
            if (transition.type === 'none') {
              const { transitionOut: _o, ...rest } = clip
              void _o
              return rest as Clip
            }
            return { ...clip, transitionOut: transition }
          }
          if (clip.id === rightClipId) {
            if (transition.type === 'none') {
              const { transitionIn: _i, ...rest } = clip
              void _i
              return rest as Clip
            }
            return { ...clip, transitionIn: transition }
          }
          return clip
        }),
      })),
    })
  },

  resizeTransition: (
    clipId: string,
    edge: 'in' | 'out',
    newDurationMs: number,
  ) => {
    const state = get()
    const found = findClipById(state.tracks, clipId)
    if (!found) return
    const { clip, track } = found
    const existing = edge === 'in' ? clip.transitionIn : clip.transitionOut
    if (!existing || existing.type === 'none') return

    // Find a paired neighbour on the same track (touching at this clip's edge).
    const seamNeighbour = (() => {
      if (edge === 'in') {
        // Looking for a clip whose end touches this clip's start, with a
        // transitionOut set on it.
        const start = clip.startTime
        let best: Clip | null = null
        let bestGap = Infinity
        for (const other of track.clips) {
          if (other.id === clip.id) continue
          if (!other.transitionOut) continue
          const otherEnd = other.startTime + other.duration
          const gap = Math.abs(otherEnd - start)
          if (
            otherEnd <= start + SEAM_TOLERANCE_MS &&
            gap <= SEAM_TOLERANCE_MS &&
            gap < bestGap
          ) {
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
        if (!other.transitionIn) continue
        const gap = Math.abs(other.startTime - end)
        if (
          other.startTime >= end - SEAM_TOLERANCE_MS &&
          gap <= SEAM_TOLERANCE_MS &&
          gap < bestGap
        ) {
          best = other
          bestGap = gap
        }
      }
      return best
    })()

    // Clamp: at least one frame at 30fps (~33ms), no more than half of each
    // affected clip so the badge never overruns the clip body.
    const MIN_DURATION_MS = 33
    const halfClip = clip.duration / 2
    const halfNeighbour = seamNeighbour ? seamNeighbour.duration / 2 : Infinity
    const maxDuration = Math.max(MIN_DURATION_MS, Math.min(halfClip, halfNeighbour))
    const clamped = Math.max(MIN_DURATION_MS, Math.min(maxDuration, newDurationMs))
    if (clamped === existing.durationMs) return

    pushHistory('Resize transition', state)

    set({
      tracks: state.tracks.map((t) => {
        if (t.id !== track.id) return t
        return {
          ...t,
          clips: t.clips.map((c) => {
            if (c.id === clip.id) {
              return {
                ...c,
                [edge === 'in' ? 'transitionIn' : 'transitionOut']: {
                  ...existing,
                  durationMs: clamped,
                },
              }
            }
            if (seamNeighbour && c.id === seamNeighbour.id) {
              // For a seam, mirror the duration onto the neighbour's opposite edge.
              const neighbourEdge: 'transitionIn' | 'transitionOut' =
                edge === 'in' ? 'transitionOut' : 'transitionIn'
              const neighbourTransition = c[neighbourEdge]
              if (!neighbourTransition) return c
              return {
                ...c,
                [neighbourEdge]: {
                  ...neighbourTransition,
                  durationMs: clamped,
                },
              }
            }
            return c
          }),
        }
      }),
    })
  },

  // ── Track Operations ──

  addTrack: (label: string, type: TrackType) => {
    const state = get()
    pushHistory('Add track', state)

    const maxOrder = Math.max(...state.tracks.map((t) => t.order), -1)
    const newTrack: Track = {
      id: crypto.randomUUID(),
      label,
      type,
      clips: [],
      muted: false,
      ...(type === 'video' || type === 'caption' ? { visible: true } : {}),
      locked: false,
      order: maxOrder + 1,
    }

    set({ tracks: [...state.tracks, newTrack] })
  },

  removeTrack: (trackId: string) => {
    const state = get()
    const track = state.tracks.find((t) => t.id === trackId)
    if (track?.type === 'clip_audio') return
    pushHistory('Remove track', state)

    const removedClipIds = new Set(track?.clips.map((c) => c.id) ?? [])

    set({
      tracks: state.tracks.filter((t) => t.id !== trackId),
    })
    if (removedClipIds.size > 0) {
      useSelectionStore.getState().removeFromSelection(removedClipIds)
    }
  },

  reorderTracks: (orderedTrackIds: string[]) => {
    const state = get()
    pushHistory('Reorder tracks', state)

    set({
      tracks: state.tracks.map((track) => ({
        ...track,
        order: orderedTrackIds.indexOf(track.id),
      })),
    })
  },

  renameTrack: (trackId: string, label: string) => {
    const state = get()
    pushHistory('Rename track', state)

    set({
      tracks: state.tracks.map((track) =>
        track.id === trackId ? { ...track, label } : track,
      ),
    })
  },

  toggleTrackMute: (trackId: string) => {
    const state = get()
    pushHistory('Toggle track mute', state)
    set({
      tracks: state.tracks.map((track) =>
        track.id === trackId ? { ...track, muted: !track.muted } : track,
      ),
    })
  },

  soloTrack: (trackId: string) => {
    const state = get()
    const target = state.tracks.find((t) => t.id === trackId)
    if (!target) return
    // Solo is a mixer affordance — only meaningful for audio-bearing tracks.
    if (target.type !== 'audio' && target.type !== 'clip_audio') return

    const audioTracks = state.tracks.filter(
      (t) => t.type === 'audio' || t.type === 'clip_audio',
    )
    // If the target is already the sole audible audio track, treat the call
    // as un-solo: bring everything back to un-muted. Otherwise enter solo:
    // un-mute target, mute every other audio track.
    const targetIsLoneAudible =
      !target.muted && audioTracks.every((t) => t.id === trackId || t.muted)

    pushHistory(targetIsLoneAudible ? 'Un-solo track' : 'Solo track', state)

    set({
      tracks: state.tracks.map((track) => {
        if (track.type !== 'audio' && track.type !== 'clip_audio') return track
        if (targetIsLoneAudible) {
          return track.muted ? { ...track, muted: false } : track
        }
        const shouldMute = track.id !== trackId
        if (track.muted === shouldMute) return track
        return { ...track, muted: shouldMute }
      }),
    })
  },

  toggleTrackVisibility: (trackId: string) => {
    const state = get()
    const track = state.tracks.find((t) => t.id === trackId)
    if (!track || (track.type !== 'video' && track.type !== 'caption')) return
    pushHistory('Toggle track visibility', state)

    set({
      tracks: state.tracks.map((t) =>
        t.id === trackId ? { ...t, visible: !(t.visible ?? true) } : t,
      ),
    })
  },

  toggleTrackLock: (trackId: string) => {
    const state = get()
    pushHistory('Toggle track lock', state)
    set({
      tracks: state.tracks.map((track) =>
        track.id === trackId ? { ...track, locked: !track.locked } : track,
      ),
    })
  },

  toggleTrackDucking: (trackId: string) => {
    const state = get()
    const track = state.tracks.find((t) => t.id === trackId)
    if (!track || (track.type !== 'audio' && track.type !== 'clip_audio')) return
    pushHistory('Toggle track ducking', state)

    set({
      tracks: state.tracks.map((t) =>
        t.id === trackId
          ? {
              ...t,
              ducking: t.ducking
                ? { ...t.ducking, enabled: !t.ducking.enabled }
                : { ...DEFAULT_AUDIO_DUCKING },
            }
          : t,
      ),
    })
  },

  // ── Caption Style ──

  setCaptionStyle: (style: Partial<CaptionStyle>) => {
    const state = get()
    pushHistory('Update caption style', state)

    set({
      captionStyle: { ...state.captionStyle, ...style },
    })
  },

  beginHistoryTransaction: (label: string) => {
    if (activeHistoryTransaction) return
    activeHistoryTransaction = {
      label,
      state: snapshotPersistentState(get()),
      pushed: false,
    }
  },

  commitHistoryTransaction: () => {
    activeHistoryTransaction = null
  },

  // ── Undo / Redo ──

  undo: () => {
    activeHistoryTransaction = null
    const entry = undoStack.pop()
    if (!entry) return

    const state = get()
    // Push current state onto redo stack
    redoStack.push({
      label: entry.label,
      state: snapshotPersistentState(state),
    })

    // Restore the previous state
    set({
      tracks: entry.state.tracks,
      captionStyle: entry.state.captionStyle,
      composition: entry.state.composition,
      globalAudioVolume: entry.state.globalAudioVolume ?? 1,
    })
  },

  redo: () => {
    activeHistoryTransaction = null
    const entry = redoStack.pop()
    if (!entry) return

    const state = get()
    // Push current state onto undo stack
    undoStack.push({
      label: entry.label,
      state: snapshotPersistentState(state),
    })

    // Restore the redo state
    set({
      tracks: entry.state.tracks,
      captionStyle: entry.state.captionStyle,
      composition: entry.state.composition,
      globalAudioVolume: entry.state.globalAudioVolume ?? 1,
    })
  },

  canUndo: () => undoStack.length > 0,

  canRedo: () => redoStack.length > 0,

  // ── Persistence ──

  getSerializableState: () => {
    const state = get()
    return {
      tracks: state.tracks,
      captionStyle: state.captionStyle,
      composition: state.composition,
      globalAudioVolume: state.globalAudioVolume,
    }
  },

  loadState: (state: SerializedEditorState) => {
    // Clear history when loading a new state
    undoStack = []
    redoStack = []
    activeHistoryTransaction = null

    set({
      tracks: state.tracks.map(normalizeTrack),
      captionStyle: state.captionStyle ?? DEFAULT_CAPTION_STYLE,
      composition: state.composition ?? DEFAULT_COMPOSITION_CONFIG,
      globalAudioVolume: state.globalAudioVolume ?? 1,
    })
    // Transient UI state lives in dedicated stores; reset them to defaults so
    // the loaded project doesn't inherit selection/playhead/zoom from the
    // previous session.
    useSelectionStore.getState().reset()
    usePlaybackStore.getState().reset()
    useUIStore.getState().reset()
  },

  setGlobalAudioVolume: (volume: number) => {
    const clamped = Math.max(0, Math.min(1, volume))
    set({ globalAudioVolume: clamped })
  },

  setCompositionSize: (width: number, height: number) => {
    const w = Math.max(1, Math.round(width))
    const h = Math.max(1, Math.round(height))
    const state = get()
    if (state.composition.width === w && state.composition.height === h) return
    pushHistory('Change composition size', state)
    set({
      composition: { ...state.composition, width: w, height: h },
    })
  },

  setCompositionFps: (fps: number) => {
    const next = Math.max(1, Math.min(120, Math.round(fps)))
    const state = get()
    if (state.composition.fps === next) return
    pushHistory('Change composition FPS', state)
    set({
      composition: { ...state.composition, fps: next },
    })
  },

  resetState: () => {
    undoStack = []
    redoStack = []
    activeHistoryTransaction = null

    set({
      tracks: createDefaultTracks(),
      captionStyle: DEFAULT_CAPTION_STYLE,
      composition: DEFAULT_COMPOSITION_CONFIG,
      globalAudioVolume: 1,
    })
    useSelectionStore.getState().reset()
    usePlaybackStore.getState().reset()
    useUIStore.getState().reset()
  },
}))
