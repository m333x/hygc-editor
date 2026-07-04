import { describe, expect, it } from 'vitest'

import {
  resolveAnimatedTransform,
  resolveKeyframedValue,
} from '../../engine/keyframe-interpolator'
import { DEFAULT_CLIP_TRANSFORM } from '../../types'
import type { Clip, EasingKind, KeyframeTrack } from '../../types'

function kf(timeMs: number, value: number, easing: EasingKind = 'linear') {
  return { id: `k-${timeMs}-${value}`, timeMs, value, easingIn: easing, easingOut: easing }
}

function track(propertyId: KeyframeTrack['propertyId'], keyframes: KeyframeTrack['keyframes']) {
  return { propertyId, keyframes }
}

function makeClip(partial: Partial<Clip> = {}): Clip {
  return {
    id: 'clip-1',
    assetId: 'asset-1',
    startTime: 0,
    duration: 1000,
    inPoint: 0,
    outPoint: 1000,
    speed: 1,
    transform: { ...DEFAULT_CLIP_TRANSFORM },
    ...partial,
  }
}

describe('resolveKeyframedValue', () => {
  it('returns the fallback when the track is empty', () => {
    const t = track('transform.x', [])
    expect(resolveKeyframedValue(t, 500, 42)).toBe(42)
  })

  it('returns the single keyframe value when only one exists', () => {
    const t = track('transform.x', [kf(200, 100)])
    expect(resolveKeyframedValue(t, 0, 0)).toBe(100)
    expect(resolveKeyframedValue(t, 200, 0)).toBe(100)
    expect(resolveKeyframedValue(t, 5000, 0)).toBe(100)
  })

  it('returns the first value before the first keyframe (pre-roll)', () => {
    const t = track('transform.x', [kf(500, 50), kf(1000, 100)])
    expect(resolveKeyframedValue(t, 0, 999)).toBe(50)
    expect(resolveKeyframedValue(t, 250, 999)).toBe(50)
  })

  it('returns the last value after the last keyframe (post-roll)', () => {
    const t = track('transform.x', [kf(0, 0), kf(500, 100)])
    expect(resolveKeyframedValue(t, 999, 0)).toBe(100)
    expect(resolveKeyframedValue(t, 10_000, 0)).toBe(100)
  })

  it('linearly interpolates between two keyframes', () => {
    const t = track('transform.x', [kf(0, 0, 'linear'), kf(1000, 100, 'linear')])
    expect(resolveKeyframedValue(t, 0, 0)).toBe(0)
    expect(resolveKeyframedValue(t, 500, 0)).toBe(50)
    expect(resolveKeyframedValue(t, 1000, 0)).toBe(100)
  })

  it('holds the left value until the next keyframe when easingOut is hold', () => {
    const t = track('transform.x', [kf(0, 10, 'hold'), kf(1000, 90, 'hold')])
    expect(resolveKeyframedValue(t, 0, 0)).toBe(10)
    expect(resolveKeyframedValue(t, 500, 0)).toBe(10)
    expect(resolveKeyframedValue(t, 999, 0)).toBe(10)
    // At or beyond the next keyframe time, the interpolator falls through to it.
    expect(resolveKeyframedValue(t, 1000, 0)).toBe(90)
  })

  it('produces a non-linear curve when easing is easeIn', () => {
    const t = track('transform.x', [kf(0, 0, 'easeIn'), kf(1000, 100, 'easeIn')])
    // Linear midpoint would be 50; easeIn at t=0.5 is t^3 = 0.125 → 12.5
    expect(resolveKeyframedValue(t, 500, 0)).toBeCloseTo(12.5, 5)
  })

  it('produces a non-linear curve when easing is easeOut', () => {
    const t = track('transform.x', [kf(0, 0, 'easeOut'), kf(1000, 100, 'easeOut')])
    // easeOut(0.5) = 1 - (1-0.5)^3 = 1 - 0.125 = 0.875 → 87.5
    expect(resolveKeyframedValue(t, 500, 0)).toBeCloseTo(87.5, 5)
  })

  it('clamps t to [0,1] when called between keyframes', () => {
    const t = track('transform.x', [kf(0, 0, 'linear'), kf(1000, 100, 'linear')])
    // Negative ms is treated as before the first keyframe → returns first value
    expect(resolveKeyframedValue(t, -100, 0)).toBe(0)
  })

  it('handles coincident keyframes by preferring the right one', () => {
    const t = track('transform.x', [kf(500, 10), kf(500, 90)])
    // Both at 500 — span 0, should not divide by zero.
    expect(resolveKeyframedValue(t, 500, 0)).toBe(90)
  })
})

describe('resolveAnimatedTransform', () => {
  it('returns the static transform when the clip has no keyframe tracks', () => {
    const clip = makeClip({ transform: { ...DEFAULT_CLIP_TRANSFORM, x: 42 } })
    const result = resolveAnimatedTransform(clip, 500)
    expect(result).toBe(clip.transform) // identity — no allocation when nothing to do
    expect(result.x).toBe(42)
  })

  it('overrides the baseline with the keyframed value', () => {
    const clip = makeClip({
      transform: { ...DEFAULT_CLIP_TRANSFORM, x: 0 },
      keyframeTracks: [track('transform.x', [kf(0, 0), kf(1000, 200)])],
    })
    expect(resolveAnimatedTransform(clip, 500).x).toBe(100)
  })

  it('only writes keyframed properties; others come through unchanged', () => {
    const clip = makeClip({
      transform: { ...DEFAULT_CLIP_TRANSFORM, x: 10, y: 99, scale: 1.5 },
      keyframeTracks: [track('transform.x', [kf(0, 0), kf(1000, 100)])],
    })
    const result = resolveAnimatedTransform(clip, 500)
    expect(result.x).toBe(50)
    expect(result.y).toBe(99) // untouched
    expect(result.scale).toBe(1.5) // untouched
  })

  it('clamps opacity writes through the property registry', () => {
    const clip = makeClip({
      transform: { ...DEFAULT_CLIP_TRANSFORM, opacity: 1 },
      keyframeTracks: [
        track('transform.opacity', [kf(0, 0), kf(1000, 5)]),
      ],
    })
    // mid-point 2.5 → write clamps to 1; outside [0,1] is invalid for opacity.
    expect(resolveAnimatedTransform(clip, 500).opacity).toBeLessThanOrEqual(1)
  })

  it('handles multiple keyframe tracks simultaneously', () => {
    const clip = makeClip({
      transform: { ...DEFAULT_CLIP_TRANSFORM, x: 0, y: 0 },
      keyframeTracks: [
        track('transform.x', [kf(0, 0), kf(1000, 100)]),
        track('transform.y', [kf(0, 0), kf(1000, 200)]),
      ],
    })
    const result = resolveAnimatedTransform(clip, 500)
    expect(result.x).toBe(50)
    expect(result.y).toBe(100)
  })
})
