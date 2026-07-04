/**
 * Pure helpers for mutating `KeyframeTrack` objects.
 *
 * The store uses these to implement keyframe actions (add / move / delete /
 * split-on-slice / shift-on-trim). They are pure: they take a track, return a
 * new track, and never touch React, Remotion, or the store. That makes the
 * arithmetic — which is the part most likely to have edge-case bugs — fully
 * unit-testable in isolation.
 *
 * Invariants every returned track satisfies:
 *   - `keyframes` is sorted ascending by `timeMs`
 *   - no duplicate ids
 *   - no two keyframes at the exact same `timeMs`
 *
 * SOLID: SRP — pure data transformations. No I/O, no side effects.
 */

import { resolveKeyframedValue } from './keyframe-interpolator'
import type { EasingKind, Keyframe, KeyframeTrack } from '../types'

/**
 * Two keyframes are considered to share a time if they fall within the same
 * millisecond. The store debounces playhead snaps to integer ms, but float
 * imprecision can still creep in via slice math — keep a small epsilon.
 */
const TIME_EPSILON_MS = 0.5

function generateKeyframeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // Fallback for older environments (tests, SSR). Sufficient for uniqueness
  // within a session — keyframe ids never leave the editor.
  return `kf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

function sortKeyframes(keyframes: Keyframe[]): Keyframe[] {
  return [...keyframes].sort((a, b) => a.timeMs - b.timeMs)
}

/**
 * Create a fresh keyframe with the given properties. Easing defaults to
 * linear on both sides — Premiere's default behavior.
 */
export function createKeyframe(
  timeMs: number,
  value: number,
  easingIn: EasingKind = 'linear',
  easingOut: EasingKind = 'linear',
): Keyframe {
  return {
    id: generateKeyframeId(),
    timeMs,
    value,
    easingIn,
    easingOut,
  }
}

/**
 * Insert a new keyframe at `timeMs` with `value`, OR update the existing
 * keyframe at that time. This is the behavior the Inspector wants when the
 * user changes a slider value while the playhead is on (or near) an existing
 * keyframe: don't pile up duplicates, just update in place.
 *
 * Existing keyframe easings are preserved on update — only the value moves.
 */
export function upsertKeyframe(
  track: KeyframeTrack,
  timeMs: number,
  value: number,
): KeyframeTrack {
  const existingIdx = track.keyframes.findIndex(
    (k) => Math.abs(k.timeMs - timeMs) <= TIME_EPSILON_MS,
  )

  if (existingIdx >= 0) {
    const next = [...track.keyframes]
    next[existingIdx] = { ...next[existingIdx], value }
    return { ...track, keyframes: next }
  }

  const newKf = createKeyframe(timeMs, value)
  return { ...track, keyframes: sortKeyframes([...track.keyframes, newKf]) }
}

export function deleteKeyframesById(
  track: KeyframeTrack,
  idsToDelete: ReadonlySet<string>,
): KeyframeTrack {
  if (idsToDelete.size === 0) return track
  const next = track.keyframes.filter((k) => !idsToDelete.has(k.id))
  if (next.length === track.keyframes.length) return track
  return { ...track, keyframes: next }
}

/**
 * Move a keyframe to a new time, clamping to `[0, maxTimeMs]` and re-sorting.
 * If another keyframe already occupies the target time, the moved keyframe
 * displaces it (the older one is deleted). This matches Premiere — dragging
 * a keyframe onto a peer replaces the peer rather than creating a duplicate.
 */
export function moveAndResort(
  track: KeyframeTrack,
  keyframeId: string,
  newTimeMs: number,
  maxTimeMs: number,
): KeyframeTrack {
  const idx = track.keyframes.findIndex((k) => k.id === keyframeId)
  if (idx < 0) return track

  const clamped = Math.max(0, Math.min(maxTimeMs, newTimeMs))
  const moved: Keyframe = { ...track.keyframes[idx], timeMs: clamped }

  // Drop any peer at the new time (other than the moved one itself).
  const others = track.keyframes.filter(
    (k, i) => i !== idx && Math.abs(k.timeMs - clamped) > TIME_EPSILON_MS,
  )
  return { ...track, keyframes: sortKeyframes([...others, moved]) }
}

export function setKeyframeEasing(
  track: KeyframeTrack,
  keyframeId: string,
  side: 'in' | 'out',
  easing: EasingKind,
): KeyframeTrack {
  const idx = track.keyframes.findIndex((k) => k.id === keyframeId)
  if (idx < 0) return track
  const next = [...track.keyframes]
  next[idx] = {
    ...next[idx],
    easingIn: side === 'in' ? easing : next[idx].easingIn,
    easingOut: side === 'out' ? easing : next[idx].easingOut,
  }
  return { ...track, keyframes: next }
}

/**
 * Split a keyframe track at `splitMs` (clip-local time) for a slice operation.
 *
 * Returns a pair of tracks for the left and right halves of the parent clip.
 * Visual continuity across the cut is preserved by inserting a synthetic
 * keyframe at the boundary on both sides, valued at the interpolated value
 * at the split — so the user never sees a pop on either side of the cut.
 *
 * The left half's local time runs `[0, splitMs]`; the right half's local time
 * runs `[0, rightDuration]` — keyframes that were on the right of the split
 * are shifted left by `splitMs`.
 *
 * @param fallback - The static baseline value used if the track is empty.
 *                   Almost never used since `splitKeyframesAt` is normally
 *                   only invoked on tracks that have at least one keyframe.
 */
export function splitKeyframesAt(
  track: KeyframeTrack,
  splitMs: number,
  fallback: number,
): { left: KeyframeTrack; right: KeyframeTrack } {
  const valueAtSplit = resolveKeyframedValue(track, splitMs, fallback)

  const leftKfs: Keyframe[] = []
  const rightKfs: Keyframe[] = []

  for (const k of track.keyframes) {
    if (k.timeMs < splitMs - TIME_EPSILON_MS) {
      leftKfs.push(k)
    } else if (k.timeMs > splitMs + TIME_EPSILON_MS) {
      rightKfs.push({ ...k, timeMs: k.timeMs - splitMs })
    }
    // Keyframes coincident with the split are absorbed into the synthetic
    // boundary keyframes below — we don't want duplicates at time 0/splitMs.
  }

  // Synthetic boundary keyframes preserve visual continuity at the cut.
  leftKfs.push(createKeyframe(splitMs, valueAtSplit))
  rightKfs.unshift(createKeyframe(0, valueAtSplit))

  return {
    left: { ...track, keyframes: sortKeyframes(leftKfs) },
    right: { ...track, keyframes: sortKeyframes(rightKfs) },
  }
}

/**
 * Adjust a track when the clip's local timebase changes — left-edge trim,
 * right-edge trim, or speed change.
 *
 * `deltaMs`     — shift applied to every keyframe time (positive shifts right)
 * `newDuration` — clamp upper bound for the resulting track (clip duration
 *                 after the operation)
 *
 * Keyframes that fall outside `[0, newDuration]` after shifting are dropped.
 * To preserve the boundary value, a synthetic keyframe is inserted at the
 * appropriate edge with the value that would have been visible there before
 * the trim — same continuity guarantee as `splitKeyframesAt`.
 */
export function shiftAndClamp(
  track: KeyframeTrack,
  deltaMs: number,
  newDuration: number,
  fallback: number,
): KeyframeTrack {
  if (track.keyframes.length === 0) return track

  // Resolve boundary values BEFORE shifting so they reflect what was visible
  // at the new edges in the original timebase.
  const oldStartProbe = -deltaMs // pre-shift time that becomes 0 post-shift
  const oldEndProbe = newDuration - deltaMs // pre-shift time that becomes newDuration

  const valueAtNewStart = resolveKeyframedValue(track, oldStartProbe, fallback)
  const valueAtNewEnd = resolveKeyframedValue(track, oldEndProbe, fallback)

  const shifted: Keyframe[] = []
  let needsStartBoundary = true
  let needsEndBoundary = true

  for (const k of track.keyframes) {
    const newTime = k.timeMs + deltaMs
    if (newTime < -TIME_EPSILON_MS || newTime > newDuration + TIME_EPSILON_MS) continue
    const clamped = Math.max(0, Math.min(newDuration, newTime))
    shifted.push({ ...k, timeMs: clamped })
    if (clamped <= TIME_EPSILON_MS) needsStartBoundary = false
    if (clamped >= newDuration - TIME_EPSILON_MS) needsEndBoundary = false
  }

  // Insert synthetic boundary keyframes only if no surviving keyframe lands
  // there — avoid duplicates that would collapse via TIME_EPSILON_MS.
  if (needsStartBoundary && shifted.length > 0 && shifted[0].timeMs > TIME_EPSILON_MS) {
    shifted.unshift(createKeyframe(0, valueAtNewStart))
  }
  if (
    needsEndBoundary &&
    shifted.length > 0 &&
    shifted[shifted.length - 1].timeMs < newDuration - TIME_EPSILON_MS
  ) {
    shifted.push(createKeyframe(newDuration, valueAtNewEnd))
  }

  return { ...track, keyframes: sortKeyframes(shifted) }
}

/**
 * Scale every keyframe's time by `factor`. Used when a clip's speed changes:
 * if the clip duration shrinks by half, each keyframe should land at half its
 * old clip-local time so the animation stays at the same proportional moment
 * in the playback.
 */
export function scaleTimes(track: KeyframeTrack, factor: number): KeyframeTrack {
  if (factor === 1 || track.keyframes.length === 0) return track
  return {
    ...track,
    keyframes: track.keyframes.map((k) => ({ ...k, timeMs: k.timeMs * factor })),
  }
}

/**
 * Drop any keyframes that fall outside `[0, maxTimeMs]` after a load — used
 * defensively when hydrating from persistence in case stored data drifted out
 * of bounds (e.g. a duration changed but keyframes weren't re-clamped).
 */
export function sanitizeTrack(track: KeyframeTrack, maxTimeMs: number): KeyframeTrack {
  const filtered = track.keyframes.filter((k) => k.timeMs >= 0 && k.timeMs <= maxTimeMs)
  return { ...track, keyframes: sortKeyframes(filtered) }
}
