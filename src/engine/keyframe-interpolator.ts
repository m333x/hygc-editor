/**
 * Keyframe interpolator — pure, frame-independent value resolution.
 *
 * Given a `KeyframeTrack` and a clip-local time in milliseconds, returns the
 * interpolated value for that property at that moment. Easings are applied
 * per-segment: the `easingOut` of the keyframe before the time, and the
 * `easingIn` of the one after, jointly define the curve. A `'hold'` easing
 * on the left keyframe makes the segment a step function (value snaps at the
 * next keyframe).
 *
 * The renderer composes this for every keyframable property on a clip via
 * `resolveAnimatedTransform`, which returns a fresh `ClipTransform` with
 * keyframed values overlaid on the static baseline. Properties without a
 * track fall through to the baseline — no behavior change for static clips.
 *
 * SOLID: SRP — pure math, no React/Remotion/store deps.
 * SOLID: OCP — new easings extend `EASING_FUNCTIONS` without touching callers.
 */

import { ANIMATABLE_PROPERTIES } from './animatable-properties'
import type {
  AnimatablePropertyId,
  CaptionStyle,
  Clip,
  ClipTransform,
  EasingKind,
  Keyframe,
  KeyframeTrack,
} from '../types'

type EasingFn = (t: number) => number

const EASING_FUNCTIONS: Record<EasingKind, EasingFn> = {
  linear: (t) => t,
  // Cubic ease in: slow start, accelerates.
  easeIn: (t) => t * t * t,
  // Cubic ease out: fast start, decelerates.
  easeOut: (t) => 1 - Math.pow(1 - t, 3),
  // Cubic ease in-out: slow start and end, fast middle.
  easeInOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  // Step: handled separately in resolveKeyframedValue (returns left value).
  hold: (t) => (t >= 1 ? 1 : 0),
}

/**
 * Combine the left keyframe's outgoing easing with the right keyframe's
 * incoming easing. When both are 'linear', the result is linear. When one
 * side has a curve, that curve dominates; when both have curves we blend by
 * averaging — a pragmatic v1 compromise that avoids users having to think
 * about per-side curves until they actively want to.
 */
function blendEasings(out: EasingKind, incoming: EasingKind, t: number): number {
  if (out === incoming) {
    return EASING_FUNCTIONS[out](t)
  }
  if (out === 'linear') return EASING_FUNCTIONS[incoming](t)
  if (incoming === 'linear') return EASING_FUNCTIONS[out](t)
  // Both non-linear and different — average.
  return (EASING_FUNCTIONS[out](t) + EASING_FUNCTIONS[incoming](t)) / 2
}

function findSurroundingKeyframes(
  keyframes: Keyframe[],
  timeMs: number,
): { left: Keyframe | null; right: Keyframe | null } {
  if (keyframes.length === 0) return { left: null, right: null }

  // Binary search for the rightmost keyframe with timeMs <= input time.
  let lo = 0
  let hi = keyframes.length - 1
  let leftIdx = -1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    if (keyframes[mid].timeMs <= timeMs) {
      leftIdx = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }

  const left = leftIdx >= 0 ? keyframes[leftIdx] : null
  const right = leftIdx + 1 < keyframes.length ? keyframes[leftIdx + 1] : null
  return { left, right }
}

/**
 * Resolve the value of a keyframe track at a given clip-local time.
 *
 * Boundary behavior:
 *   - empty track     → returns `fallback` (baseline static value)
 *   - before first kf → returns first.value (constant pre-roll)
 *   - after last kf   → returns last.value (constant post-roll)
 *   - between kfs     → interpolates with the appropriate easing
 */
export function resolveKeyframedValue(
  track: KeyframeTrack,
  clipLocalMs: number,
  fallback: number,
): number {
  const kfs = track.keyframes
  if (kfs.length === 0) return fallback

  const { left, right } = findSurroundingKeyframes(kfs, clipLocalMs)

  if (!left) return right!.value // before first
  if (!right) return left.value // after last
  if (left.easingOut === 'hold') return left.value

  const span = right.timeMs - left.timeMs
  if (span <= 0) return right.value // coincident keyframes — prefer right
  const rawT = (clipLocalMs - left.timeMs) / span
  const t = Math.max(0, Math.min(1, rawT))
  const easedT = blendEasings(left.easingOut, right.easingIn, t)
  return left.value + (right.value - left.value) * easedT
}

/**
 * Iterate every keyframed property on a clip and overlay its resolved value
 * onto the clip via the registry's `write`. Returns a fresh clip object only
 * if at least one property differs from the baseline; otherwise returns the
 * original clip by reference so callers can cheaply identity-compare.
 *
 * Filtering by `propertyPrefix` lets caller subsets (e.g. transform-only or
 * caption-only render paths) avoid building intermediate clip objects for
 * properties they don't consume — useful when the resolver runs every frame.
 */
function resolveAnimatedClipFields(
  clip: Clip,
  clipLocalMs: number,
  propertyPrefix?: 'transform.' | 'caption.',
): Clip {
  const tracks = clip.keyframeTracks
  if (!tracks || tracks.length === 0) return clip

  let result: Clip = clip
  for (const track of tracks) {
    if (propertyPrefix && !track.propertyId.startsWith(propertyPrefix)) continue
    const prop = ANIMATABLE_PROPERTIES[track.propertyId as AnimatablePropertyId]
    if (!prop) continue // unknown id (forward-compat: old client meets newer data)
    const baseline = prop.read(clip)
    const value = resolveKeyframedValue(track, clipLocalMs, baseline)
    if (value !== baseline) {
      result = prop.write(result, value)
    }
  }
  return result
}

/**
 * Resolve every keyframed property on a clip at a given clip-local time and
 * return a fresh `ClipTransform` ready to feed into `buildCssTransform`.
 *
 * Properties with a keyframe track are overlaid via the registry's `write`.
 * Properties without a track pass through `clip.transform` unchanged.
 */
export function resolveAnimatedTransform(clip: Clip, clipLocalMs: number): ClipTransform {
  return resolveAnimatedClipFields(clip, clipLocalMs, 'transform.').transform
}

/**
 * Resolve every keyframed caption-style property on a clip at a given
 * clip-local time and return a `CaptionStyle` with animated fields overlaid on
 * top of `baseStyle`. Use this from the caption renderer: pass in the
 * effective static caption style (per-clip override or global default), get
 * back the per-frame animated version.
 *
 * Properties with a keyframe track are overlaid via the registry's `write`.
 * Properties without a track pass through `baseStyle` unchanged.
 */
export function resolveAnimatedCaptionStyle(
  clip: Clip,
  baseStyle: CaptionStyle,
  clipLocalMs: number,
): CaptionStyle {
  const tracks = clip.keyframeTracks
  if (!tracks || tracks.length === 0) return baseStyle
  // Has at least one caption.* track? Avoid building a temp clip otherwise.
  if (!tracks.some((t) => t.propertyId.startsWith('caption.'))) return baseStyle

  // Seed a temporary clip carrying baseStyle so `prop.read`/`prop.write` see
  // the right baseline (the renderer's effective style, not whatever the clip
  // had persisted as an override).
  const seeded: Clip = { ...clip, captionStyle: baseStyle }
  const resolved = resolveAnimatedClipFields(seeded, clipLocalMs, 'caption.')
  return resolved.captionStyle ?? baseStyle
}
