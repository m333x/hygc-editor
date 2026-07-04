import { describe, expect, it } from 'vitest'

import {
  createKeyframe,
  deleteKeyframesById,
  moveAndResort,
  scaleTimes,
  sanitizeTrack,
  setKeyframeEasing,
  shiftAndClamp,
  splitKeyframesAt,
  upsertKeyframe,
} from '../../engine/keyframe-mutations'
import type { Keyframe, KeyframeTrack } from '../../types'

function track(keyframes: Keyframe[] = []): KeyframeTrack {
  return { propertyId: 'transform.x', keyframes }
}

describe('upsertKeyframe', () => {
  it('appends a new keyframe and keeps the track sorted', () => {
    const t = track([createKeyframe(0, 0), createKeyframe(1000, 100)])
    const next = upsertKeyframe(t, 500, 50)
    expect(next.keyframes.map((k) => k.timeMs)).toEqual([0, 500, 1000])
    expect(next.keyframes.map((k) => k.value)).toEqual([0, 50, 100])
  })

  it('updates an existing keyframe in place at the same time', () => {
    const t = track([createKeyframe(0, 0), createKeyframe(500, 50)])
    const next = upsertKeyframe(t, 500, 999)
    expect(next.keyframes).toHaveLength(2)
    expect(next.keyframes[1].value).toBe(999)
    expect(next.keyframes[1].id).toBe(t.keyframes[1].id) // id preserved
  })

  it('treats near-coincident times as equivalent (epsilon)', () => {
    const t = track([createKeyframe(500, 50)])
    const next = upsertKeyframe(t, 500.4, 99)
    expect(next.keyframes).toHaveLength(1)
    expect(next.keyframes[0].value).toBe(99)
  })
})

describe('deleteKeyframesById', () => {
  it('drops only the requested ids', () => {
    const a = createKeyframe(0, 0)
    const b = createKeyframe(500, 50)
    const c = createKeyframe(1000, 100)
    const t = track([a, b, c])
    const next = deleteKeyframesById(t, new Set([b.id]))
    expect(next.keyframes).toEqual([a, c])
  })

  it('returns the same reference when no ids match', () => {
    const t = track([createKeyframe(0, 0)])
    const next = deleteKeyframesById(t, new Set(['nonexistent']))
    expect(next).toBe(t)
  })
})

describe('moveAndResort', () => {
  it('moves a keyframe and re-sorts', () => {
    const t = track([createKeyframe(0, 0), createKeyframe(500, 50), createKeyframe(1000, 100)])
    const middleId = t.keyframes[1].id
    const next = moveAndResort(t, middleId, 1500, 2000)
    expect(next.keyframes.map((k) => k.timeMs)).toEqual([0, 1000, 1500])
  })

  it('clamps to [0, maxTimeMs]', () => {
    const t = track([createKeyframe(500, 50)])
    const id = t.keyframes[0].id
    expect(moveAndResort(t, id, -200, 1000).keyframes[0].timeMs).toBe(0)
    expect(moveAndResort(t, id, 5000, 1000).keyframes[0].timeMs).toBe(1000)
  })

  it('displaces a peer keyframe at the target time', () => {
    const t = track([createKeyframe(0, 0), createKeyframe(500, 50), createKeyframe(1000, 100)])
    const middleId = t.keyframes[1].id
    const next = moveAndResort(t, middleId, 1000, 2000)
    // The keyframe at 1000 was displaced; only the moved one survives there.
    expect(next.keyframes.map((k) => k.timeMs)).toEqual([0, 1000])
    expect(next.keyframes[1].id).toBe(middleId)
    expect(next.keyframes[1].value).toBe(50)
  })
})

describe('setKeyframeEasing', () => {
  it('updates only the requested side', () => {
    const t = track([createKeyframe(0, 0, 'linear', 'linear')])
    const id = t.keyframes[0].id
    const next = setKeyframeEasing(t, id, 'out', 'easeIn')
    expect(next.keyframes[0].easingOut).toBe('easeIn')
    expect(next.keyframes[0].easingIn).toBe('linear')
  })

  it('returns the same track for an unknown id', () => {
    const t = track([createKeyframe(0, 0)])
    expect(setKeyframeEasing(t, 'missing', 'in', 'easeOut')).toBe(t)
  })
})

describe('splitKeyframesAt', () => {
  it('partitions keyframes around the split and inserts boundary keyframes for continuity', () => {
    const t = track([
      createKeyframe(0, 0, 'linear', 'linear'),
      createKeyframe(1000, 100, 'linear', 'linear'),
    ])
    // value at the midpoint should be 50 (linear interpolation)
    const { left, right } = splitKeyframesAt(t, 500, 0)
    // Left half ends with a synthetic keyframe at the cut.
    expect(left.keyframes[0].timeMs).toBe(0)
    expect(left.keyframes[0].value).toBe(0)
    expect(left.keyframes[left.keyframes.length - 1].timeMs).toBe(500)
    expect(left.keyframes[left.keyframes.length - 1].value).toBe(50)
    // Right half starts with a synthetic keyframe at 0 with the same value.
    expect(right.keyframes[0].timeMs).toBe(0)
    expect(right.keyframes[0].value).toBe(50)
    // Right half's later keyframe shifted by -splitMs.
    expect(right.keyframes[right.keyframes.length - 1].timeMs).toBe(500)
    expect(right.keyframes[right.keyframes.length - 1].value).toBe(100)
  })

  it('absorbs keyframes coincident with the split into the synthetic boundary', () => {
    const t = track([
      createKeyframe(0, 0),
      createKeyframe(500, 77),
      createKeyframe(1000, 100),
    ])
    const { left, right } = splitKeyframesAt(t, 500, 0)
    // The 500-ms keyframe is absorbed; both halves get exactly one boundary kf there.
    expect(left.keyframes.filter((k) => k.timeMs === 500)).toHaveLength(1)
    expect(right.keyframes.filter((k) => k.timeMs === 0)).toHaveLength(1)
  })
})

describe('shiftAndClamp', () => {
  it('drops keyframes that fall outside the new range', () => {
    const t = track([createKeyframe(0, 0), createKeyframe(500, 50), createKeyframe(1000, 100)])
    // newDuration = 600 — the 1000-ms keyframe falls off.
    const next = shiftAndClamp(t, 0, 600, 0)
    const times = next.keyframes.map((k) => k.timeMs)
    expect(times).toContain(0)
    expect(times).toContain(500)
    // Synthetic boundary keyframe added at 600 since nothing landed there.
    expect(times.some((t) => Math.abs(t - 600) <= 1)).toBe(true)
    expect(times).not.toContain(1000)
  })

  it('shifts keyframes by deltaMs for a left-edge trim and inserts a start boundary', () => {
    const t = track([createKeyframe(0, 0), createKeyframe(500, 50), createKeyframe(1000, 100)])
    // Trim 200ms off the left → delta = -200, newDuration = 800
    const next = shiftAndClamp(t, -200, 800, 0)
    // The keyframe at original 0 is now at -200, dropped. A new boundary at 0
    // is inserted with the interpolated value (which is 20 for a linear ramp 0→100 at t=0.2).
    expect(next.keyframes[0].timeMs).toBe(0)
    expect(next.keyframes[0].value).toBeCloseTo(20, 1)
    // The 500ms keyframe is now at 300.
    expect(next.keyframes.some((k) => k.timeMs === 300 && k.value === 50)).toBe(true)
    // The 1000ms keyframe is now at 800 (within range).
    expect(next.keyframes.some((k) => k.timeMs === 800 && k.value === 100)).toBe(true)
  })

  it('returns the track unchanged when it has no keyframes', () => {
    const t = track([])
    expect(shiftAndClamp(t, 100, 1000, 0)).toBe(t)
  })
})

describe('scaleTimes', () => {
  it('multiplies each keyframe time by the factor', () => {
    const t = track([createKeyframe(0, 0), createKeyframe(500, 50), createKeyframe(1000, 100)])
    const next = scaleTimes(t, 0.5)
    expect(next.keyframes.map((k) => k.timeMs)).toEqual([0, 250, 500])
  })

  it('returns the same reference when factor is 1', () => {
    const t = track([createKeyframe(0, 0)])
    expect(scaleTimes(t, 1)).toBe(t)
  })
})

describe('sanitizeTrack', () => {
  it('drops keyframes outside [0, maxTimeMs] and re-sorts the rest', () => {
    const t = track([
      createKeyframe(500, 50),
      createKeyframe(0, 0),
      createKeyframe(2000, 200), // outside
    ])
    const clean = sanitizeTrack(t, 1000)
    expect(clean.keyframes.map((k) => k.timeMs)).toEqual([0, 500])
  })
})
