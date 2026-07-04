import { beforeEach, describe, expect, it } from 'vitest'

import { useEditorStore } from '../editor-store'
import { useSelectionStore } from '../selection-store'
import { usePlaybackStore } from '../playback-store'
import type { Track } from '../../types'

const state = () => useEditorStore.getState()
const selection = () => useSelectionStore.getState()
const playback = () => usePlaybackStore.getState()

function trackOfType(type: Track['type']): Track {
  const t = state().tracks.find((tr) => tr.type === type)
  if (!t) throw new Error(`no default ${type} track`)
  return t
}

function addVideoAsset(startTime = 0, duration = 5000) {
  const videoTrack = trackOfType('video')
  state().addAssetClipToTrack(videoTrack.id, {
    assetId: 'asset-v1',
    assetType: 'video',
    startTime,
    duration,
    sourceDurationMs: duration,
  })
  return videoTrack.id
}

function addAudioAsset(startTime = 0, duration = 5000) {
  const audioTrack = state().tracks.find((t) => t.type === 'audio' && t.label === 'Voiceover')!
  state().addAssetClipToTrack(audioTrack.id, {
    assetId: 'asset-a1',
    assetType: 'audio',
    startTime,
    duration,
    sourceDurationMs: duration,
  })
  return audioTrack.id
}

beforeEach(() => {
  state().resetState()
})

describe('addAssetClipToTrack', () => {
  it('adding a video asset creates a linked clip_audio clip and selects the video clip', () => {
    addVideoAsset(0, 4000)

    const video = trackOfType('video')
    const clipAudio = trackOfType('clip_audio')

    expect(video.clips).toHaveLength(1)
    expect(clipAudio.clips).toHaveLength(1)

    const videoClip = video.clips[0]!
    const audioClip = clipAudio.clips[0]!

    expect(videoClip.audioLinked).toBe(true)
    expect(audioClip.sourceVideoClipId).toBe(videoClip.id)
    expect(audioClip.startTime).toBe(videoClip.startTime)
    expect(audioClip.duration).toBe(videoClip.duration)

    expect(selection().selectedClipIds).toEqual([videoClip.id])
    expect(state().canUndo()).toBe(true)
  })

  it('adding an audio-only asset to an audio track does NOT create a linked clip_audio clip', () => {
    addAudioAsset(0, 3000)

    const clipAudio = trackOfType('clip_audio')
    expect(clipAudio.clips).toHaveLength(0)

    const audio = state().tracks.find((t) => t.type === 'audio' && t.label === 'Voiceover')!
    expect(audio.clips).toHaveLength(1)
  })

  it('refuses to add an audio asset onto a video track (no-op)', () => {
    const videoTrack = trackOfType('video')
    state().addAssetClipToTrack(videoTrack.id, {
      assetId: 'asset-a-bad',
      assetType: 'audio',
      startTime: 0,
      duration: 1000,
    })
    expect(trackOfType('video').clips).toHaveLength(0)
    expect(state().canUndo()).toBe(false)
  })
})

describe('moveClip', () => {
  it('moves the video clip and its linked clip_audio in lockstep', () => {
    addVideoAsset(0, 4000)
    const videoClip = trackOfType('video').clips[0]!

    state().moveClip(videoClip.id, trackOfType('video').id, 2000)

    const movedVideo = trackOfType('video').clips.find((c) => c.id === videoClip.id)!
    const movedAudio = trackOfType('clip_audio').clips.find(
      (c) => c.sourceVideoClipId === videoClip.id,
    )!
    expect(movedVideo.startTime).toBe(2000)
    expect(movedAudio.startTime).toBe(2000)
  })

  it('refuses to move a video clip onto an audio track (no-op)', () => {
    addVideoAsset(0, 4000)
    const videoClip = trackOfType('video').clips[0]!
    const audioTrack = state().tracks.find((t) => t.type === 'audio')!

    state().moveClip(videoClip.id, audioTrack.id, 1000)

    // Clip stays on the video track at startTime=0
    expect(trackOfType('video').clips.find((c) => c.id === videoClip.id)!.startTime).toBe(0)
    expect(audioTrack.clips).toHaveLength(0)
  })

  it('cleans up dangling seam transitions when adjacent clips are dragged apart', () => {
    // Set up two video clips touching at t=4000, with a seam transition between them.
    addVideoAsset(0, 4000)
    const videoTrack = trackOfType('video')
    state().addAssetClipToTrack(videoTrack.id, {
      assetId: 'asset-v2',
      assetType: 'video',
      startTime: 4000,
      duration: 3000,
      sourceDurationMs: 3000,
    })
    const [a, b] = trackOfType('video').clips
      .slice()
      .sort((x, y) => x.startTime - y.startTime)
    state().setSeamTransition(a!.id, b!.id, {
      type: 'fade',
      durationMs: 400,
    })

    // Drag B far to the right — the seam should be destroyed on both halves.
    state().moveClip(b!.id, trackOfType('video').id, 8000)

    const finalA = trackOfType('video').clips.find((c) => c.id === a!.id)!
    const finalB = trackOfType('video').clips.find((c) => c.id === b!.id)!
    expect(finalA.transitionOut).toBeUndefined()
    expect(finalB.transitionIn).toBeUndefined()
  })
})

describe('splitClip', () => {
  it('splits the video clip AND its linked clip_audio at the same time', () => {
    addVideoAsset(0, 5000)
    const videoClip = trackOfType('video').clips[0]!

    state().splitClip(videoClip.id, 2000)

    const videoClips = trackOfType('video').clips.slice().sort((a, b) => a.startTime - b.startTime)
    const audioClips = trackOfType('clip_audio')
      .clips.slice()
      .sort((a, b) => a.startTime - b.startTime)

    expect(videoClips).toHaveLength(2)
    expect(audioClips).toHaveLength(2)
    expect(videoClips[0]!.duration).toBe(2000)
    expect(videoClips[1]!.startTime).toBe(2000)
    expect(videoClips[1]!.duration).toBe(3000)
    expect(audioClips[0]!.duration).toBe(2000)
    expect(audioClips[1]!.startTime).toBe(2000)
    expect(audioClips[1]!.duration).toBe(3000)

    // Right-half audio re-binds to the right-half video, not the original.
    expect(audioClips[1]!.sourceVideoClipId).toBe(videoClips[1]!.id)
  })

  it('is a no-op when split time is outside the clip span', () => {
    addVideoAsset(0, 5000)
    const videoClip = trackOfType('video').clips[0]!

    state().splitClip(videoClip.id, 10000)

    expect(trackOfType('video').clips).toHaveLength(1)
  })
})

describe('deleteClips', () => {
  it('removes the video clip and cascades to its linked clip_audio clip', () => {
    addVideoAsset(0, 4000)
    const videoClip = trackOfType('video').clips[0]!

    state().deleteClips([videoClip.id])

    expect(trackOfType('video').clips).toHaveLength(0)
    expect(trackOfType('clip_audio').clips).toHaveLength(0)
  })

  it('clears deleted clip IDs from selection', () => {
    addVideoAsset(0, 4000)
    const videoClip = trackOfType('video').clips[0]!
    selection().selectClip(videoClip.id)
    expect(selection().selectedClipIds).toEqual([videoClip.id])

    state().deleteClips([videoClip.id])

    expect(selection().selectedClipIds).toEqual([])
  })
})

describe('toggleTrackDucking', () => {
  it('seeds defaults the first time ducking is enabled and toggles thereafter', () => {
    const music = state().tracks.find((t) => t.type === 'audio' && t.label === 'Music')!
    expect(music.ducking).toBeUndefined()

    state().toggleTrackDucking(music.id)
    const afterEnable = state().tracks.find((t) => t.id === music.id)!
    expect(afterEnable.ducking?.enabled).toBe(true)
    expect(afterEnable.ducking?.amountDb).toBeLessThan(0)
    expect(afterEnable.ducking?.attackMs).toBeGreaterThan(0)
    expect(afterEnable.ducking?.releaseMs).toBeGreaterThan(0)

    state().toggleTrackDucking(music.id)
    const afterDisable = state().tracks.find((t) => t.id === music.id)!
    expect(afterDisable.ducking?.enabled).toBe(false)
    // User-tuned values survive a toggle-off so re-enabling restores them.
    expect(afterDisable.ducking?.amountDb).toBe(afterEnable.ducking?.amountDb)
  })

  it('is a no-op on non-audio tracks', () => {
    const video = trackOfType('video')
    state().toggleTrackDucking(video.id)
    expect(state().tracks.find((t) => t.id === video.id)?.ducking).toBeUndefined()
  })

  it('pushes an undo entry that can revert the toggle', () => {
    const music = state().tracks.find((t) => t.type === 'audio' && t.label === 'Music')!
    state().toggleTrackDucking(music.id)
    expect(state().canUndo()).toBe(true)
    state().undo()
    expect(state().tracks.find((t) => t.id === music.id)?.ducking).toBeUndefined()
  })
})

describe('removeTrack', () => {
  it('removes the track and clears selection for any clips it owned', () => {
    addAudioAsset(0, 3000)
    const audioTrack = state().tracks.find((t) => t.type === 'audio' && t.label === 'Voiceover')!
    const audioClipId = audioTrack.clips[0]!.id
    selection().selectClip(audioClipId)

    state().removeTrack(audioTrack.id)

    expect(state().tracks.find((t) => t.id === audioTrack.id)).toBeUndefined()
    expect(selection().selectedClipIds).toEqual([])
  })

  it('refuses to remove a clip_audio track', () => {
    const clipAudioId = trackOfType('clip_audio').id
    state().removeTrack(clipAudioId)
    expect(state().tracks.find((t) => t.id === clipAudioId)).toBeDefined()
  })
})

describe('history transactions', () => {
  it('coalesces multiple mutations within begin/commit into a single undo entry', () => {
    addVideoAsset(0, 4000)
    const videoClip = trackOfType('video').clips[0]!
    const tracksBeforeDrag = state().tracks

    state().beginHistoryTransaction('Drag transform')
    state().updateClipTransform(videoClip.id, { x: 10 })
    state().updateClipTransform(videoClip.id, { x: 20 })
    state().updateClipTransform(videoClip.id, { x: 30 })
    state().commitHistoryTransaction()

    const after = state().tracks.find((t) => t.type === 'video')!.clips[0]!
    expect(after.transform.x).toBe(30)

    // One undo should rewind all three updates at once.
    state().undo()
    const restored = state().tracks.find((t) => t.type === 'video')!.clips[0]!
    expect(restored.transform.x).toBe(tracksBeforeDrag.find((t) => t.type === 'video')!.clips[0]!.transform.x)
  })

  it('a mutation after commitHistoryTransaction starts a fresh entry', () => {
    addVideoAsset(0, 4000)
    const videoClip = trackOfType('video').clips[0]!

    state().beginHistoryTransaction('Drag')
    state().updateClipTransform(videoClip.id, { x: 5 })
    state().commitHistoryTransaction()

    state().updateClipTransform(videoClip.id, { x: 99 })

    // Two distinct undos: first rewinds the standalone update, second rewinds the drag.
    state().undo()
    expect(state().tracks.find((t) => t.type === 'video')!.clips[0]!.transform.x).toBe(5)
    state().undo()
    expect(state().tracks.find((t) => t.type === 'video')!.clips[0]!.transform.x).toBe(0)
  })
})

describe('undo / redo', () => {
  it('undo restores the previous persistent snapshot; redo reapplies', () => {
    addVideoAsset(0, 4000)
    expect(trackOfType('video').clips).toHaveLength(1)

    state().undo()
    expect(trackOfType('video').clips).toHaveLength(0)
    expect(state().canRedo()).toBe(true)

    state().redo()
    expect(trackOfType('video').clips).toHaveLength(1)
  })

  it('undo does NOT restore transient state like playhead or selection', () => {
    addVideoAsset(0, 4000)
    const videoClipId = trackOfType('video').clips[0]!.id
    selection().selectClip(videoClipId)
    playback().setPlayhead(1234)

    state().undo()

    // Undo wiped the persistent clip, but transient slices are untouched.
    expect(trackOfType('video').clips).toHaveLength(0)
    expect(playback().playheadPosition).toBe(1234)
    expect(selection().selectedClipIds).toEqual([videoClipId])
  })
})

describe('persistence round-trip', () => {
  it('getSerializableState → loadState restores tracks/captionStyle/composition/globalAudioVolume', () => {
    addVideoAsset(0, 4000)
    state().setCompositionSize(720, 1280)
    state().setGlobalAudioVolume(0.5)
    state().setCaptionStyle({ fontSizePx: 96 })

    const snapshot = state().getSerializableState()

    state().resetState()
    expect(trackOfType('video').clips).toHaveLength(0)
    expect(state().composition.width).toBe(1080)

    state().loadState(snapshot)

    expect(trackOfType('video').clips).toHaveLength(1)
    expect(state().composition.width).toBe(720)
    expect(state().composition.height).toBe(1280)
    expect(state().globalAudioVolume).toBe(0.5)
    expect(state().captionStyle.fontSizePx).toBe(96)
  })

  it('loadState clears undo/redo history', () => {
    addVideoAsset(0, 4000)
    expect(state().canUndo()).toBe(true)

    const snapshot = state().getSerializableState()
    state().loadState(snapshot)

    expect(state().canUndo()).toBe(false)
    expect(state().canRedo()).toBe(false)
  })

  it('serializable snapshot is JSON-safe (no circular refs, no functions)', () => {
    addVideoAsset(0, 4000)
    const snapshot = state().getSerializableState()
    const roundTripped = JSON.parse(JSON.stringify(snapshot))
    expect(roundTripped.tracks).toHaveLength(snapshot.tracks.length)
    expect(roundTripped.composition).toEqual(snapshot.composition)
  })
})
