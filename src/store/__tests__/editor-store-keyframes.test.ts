import { beforeEach, describe, expect, it } from 'vitest'

import { useEditorStore } from '../editor-store'
import { useSelectionStore } from '../selection-store'
import { usePlaybackStore } from '../playback-store'
import { resolveKeyframedValue } from '../../engine/keyframe-interpolator'
import type { Clip, Track } from '../../types'

const state = () => useEditorStore.getState()
const selection = () => useSelectionStore.getState()
const playback = () => usePlaybackStore.getState()

function videoTrack(): Track {
  const t = state().tracks.find((tr) => tr.type === 'video')
  if (!t) throw new Error('no default video track')
  return t
}

function addVideoAsset(startTime = 0, duration = 4000) {
  state().addAssetClipToTrack(videoTrack().id, {
    assetId: 'asset-v1',
    assetType: 'video',
    startTime,
    duration,
    sourceDurationMs: duration,
  })
  return videoTrack().clips[0]!
}

function findClip(id: string): Clip {
  for (const t of state().tracks) {
    const c = t.clips.find((x) => x.id === id)
    if (c) return c
  }
  throw new Error(`clip ${id} not found`)
}

beforeEach(() => {
  state().resetState()
  selection().reset()
  playback().reset()
})

describe('enableKeyframing', () => {
  it('seeds a keyframe at the playhead with the property baseline', () => {
    const clip = addVideoAsset(0, 4000)
    state().updateClipTransform(clip.id, { x: 200 })

    state().enableKeyframing(clip.id, 'transform.x', 1500)

    const after = findClip(clip.id)
    expect(after.keyframeTracks).toHaveLength(1)
    const track = after.keyframeTracks![0]
    expect(track.propertyId).toBe('transform.x')
    expect(track.keyframes).toHaveLength(1)
    expect(track.keyframes[0].timeMs).toBe(1500)
    expect(track.keyframes[0].value).toBe(200) // captured the static baseline
  })

  it('is a no-op when a track already exists for the property', () => {
    const clip = addVideoAsset(0, 4000)
    state().enableKeyframing(clip.id, 'transform.x', 0)
    const firstId = findClip(clip.id).keyframeTracks![0].keyframes[0].id

    state().enableKeyframing(clip.id, 'transform.x', 2000)
    const second = findClip(clip.id).keyframeTracks!
    expect(second).toHaveLength(1)
    expect(second[0].keyframes).toHaveLength(1)
    expect(second[0].keyframes[0].id).toBe(firstId) // unchanged
  })
})

describe('disableKeyframing', () => {
  it('removes the entire track and any selection pointing at it', () => {
    const clip = addVideoAsset(0, 4000)
    state().enableKeyframing(clip.id, 'transform.x', 0)
    const kfId = findClip(clip.id).keyframeTracks![0].keyframes[0].id
    selection().selectKeyframe({
      clipId: clip.id,
      propertyId: 'transform.x',
      keyframeId: kfId,
    })

    state().disableKeyframing(clip.id, 'transform.x')

    expect(findClip(clip.id).keyframeTracks).toBeUndefined()
    expect(selection().selectedKeyframes).toEqual([])
  })
})

describe('setPropertyAtPlayhead', () => {
  it('writes to the static baseline when no keyframe track exists', () => {
    const clip = addVideoAsset(0, 4000)
    state().setPropertyAtPlayhead(clip.id, 'transform.x', 500, 123)

    const after = findClip(clip.id)
    expect(after.transform.x).toBe(123)
    expect(after.keyframeTracks).toBeUndefined()
  })

  it('creates a new keyframe at the playhead when the track exists', () => {
    const clip = addVideoAsset(0, 4000)
    state().enableKeyframing(clip.id, 'transform.x', 0)
    state().setPropertyAtPlayhead(clip.id, 'transform.x', 1000, 50)
    state().setPropertyAtPlayhead(clip.id, 'transform.x', 2000, 100)

    const track = findClip(clip.id).keyframeTracks![0]
    expect(track.keyframes.map((k) => [k.timeMs, k.value])).toEqual([
      [0, 0],
      [1000, 50],
      [2000, 100],
    ])
  })

  it('updates the existing keyframe when called at its time', () => {
    const clip = addVideoAsset(0, 4000)
    state().enableKeyframing(clip.id, 'transform.x', 1000)
    state().setPropertyAtPlayhead(clip.id, 'transform.x', 1000, 999)

    const track = findClip(clip.id).keyframeTracks![0]
    expect(track.keyframes).toHaveLength(1)
    expect(track.keyframes[0].value).toBe(999)
  })
})

describe('moveKeyframe', () => {
  it('moves and re-sorts; subsequent resolves see the new time', () => {
    const clip = addVideoAsset(0, 4000)
    state().enableKeyframing(clip.id, 'transform.x', 0)
    state().setPropertyAtPlayhead(clip.id, 'transform.x', 1000, 100)
    const middleId = findClip(clip.id).keyframeTracks![0].keyframes[1].id

    state().moveKeyframe(clip.id, 'transform.x', middleId, 3000)

    const track = findClip(clip.id).keyframeTracks![0]
    expect(track.keyframes.map((k) => k.timeMs)).toEqual([0, 3000])
    // Sample at 1500 — linearly between (0, 0) and (3000, 100) → 50.
    expect(resolveKeyframedValue(track, 1500, 0)).toBeCloseTo(50, 5)
  })
})

describe('history transactions', () => {
  it('coalesces a drag of multiple moveKeyframe calls into one undo step', () => {
    const clip = addVideoAsset(0, 4000)
    state().enableKeyframing(clip.id, 'transform.x', 0)
    state().setPropertyAtPlayhead(clip.id, 'transform.x', 1000, 100)
    const id = findClip(clip.id).keyframeTracks![0].keyframes[1].id

    const undosBefore = state().canUndo()

    state().beginHistoryTransaction('Move keyframe')
    state().moveKeyframe(clip.id, 'transform.x', id, 1200)
    state().moveKeyframe(clip.id, 'transform.x', id, 1500)
    state().moveKeyframe(clip.id, 'transform.x', id, 1800)
    state().commitHistoryTransaction()

    expect(undosBefore).toBe(true)
    state().undo() // should restore the state from before the drag
    const restored = findClip(clip.id).keyframeTracks![0].keyframes[1]
    expect(restored.timeMs).toBe(1000)
  })
})

describe('splitClip with keyframes', () => {
  it('partitions keyframes across the cut and preserves continuity', () => {
    const clip = addVideoAsset(0, 4000)
    state().enableKeyframing(clip.id, 'transform.x', 0)
    state().setPropertyAtPlayhead(clip.id, 'transform.x', 4000, 100)
    // Track: kf(0,0), kf(4000,100). Linear ramp → at 2000ms, value = 50.

    state().splitClip(clip.id, 2000)

    const videoClips = videoTrack().clips
    expect(videoClips).toHaveLength(2)
    const [left, right] = videoClips
    expect(left.duration).toBe(2000)
    expect(right.duration).toBe(2000)

    // Left half should end with a synthetic keyframe at 2000 with value 50.
    const lt = left.keyframeTracks![0]
    expect(lt.keyframes[lt.keyframes.length - 1].timeMs).toBe(2000)
    expect(lt.keyframes[lt.keyframes.length - 1].value).toBeCloseTo(50, 5)
    // Right half should start at 0 with the same value, end at 2000 with 100.
    const rt = right.keyframeTracks![0]
    expect(rt.keyframes[0].timeMs).toBe(0)
    expect(rt.keyframes[0].value).toBeCloseTo(50, 5)
    expect(rt.keyframes[rt.keyframes.length - 1].timeMs).toBe(2000)
    expect(rt.keyframes[rt.keyframes.length - 1].value).toBe(100)
  })
})

describe('updateClipSpeed with keyframes', () => {
  it('scales keyframe times so they stay at the same proportional positions', () => {
    const clip = addVideoAsset(0, 4000)
    state().enableKeyframing(clip.id, 'transform.x', 0)
    state().setPropertyAtPlayhead(clip.id, 'transform.x', 2000, 50)
    state().setPropertyAtPlayhead(clip.id, 'transform.x', 4000, 100)

    state().updateClipSpeed(clip.id, 2)

    const after = findClip(clip.id)
    expect(after.duration).toBe(2000) // halved
    const times = after.keyframeTracks![0].keyframes.map((k) => k.timeMs)
    expect(times).toEqual([0, 1000, 2000]) // each halved
  })
})

describe('trimClip with keyframes', () => {
  it('drops out-of-range keyframes on right-edge trim and inserts a boundary', () => {
    const clip = addVideoAsset(0, 4000)
    state().enableKeyframing(clip.id, 'transform.x', 0)
    state().setPropertyAtPlayhead(clip.id, 'transform.x', 2000, 50)
    state().setPropertyAtPlayhead(clip.id, 'transform.x', 4000, 100)

    // Trim right edge to 3000 (relative to startTime=0 → newTime = 3000).
    state().trimClip(clip.id, 'end', 3000)

    const after = findClip(clip.id)
    expect(after.duration).toBe(3000)
    const times = after.keyframeTracks![0].keyframes.map((k) => k.timeMs)
    // Original 4000ms keyframe is dropped; synthetic boundary at 3000 added.
    expect(times).not.toContain(4000)
    expect(times.some((t) => Math.abs(t - 3000) <= 1)).toBe(true)
    expect(times).toContain(0)
    expect(times).toContain(2000)
  })
})
