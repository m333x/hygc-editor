/**
 * Seed timeline for the demo project — what `EditorHost.projects.seed`
 * returns when the editor opens an empty project. A 22-second landscape cut:
 * three stock clips with transitions, a keyframed slow zoom, a photo outro,
 * captions, and a music bed with fades.
 */

import {
  createDefaultTracks,
  DEFAULT_CAPTION_STYLE,
  DEFAULT_CLIP_TRANSFORM,
  DEFAULT_COMPOSITION_CONFIG,
  DEFAULT_TRANSITION_DURATION_MS,
} from '@hygc/editor'
import type { Clip, ClipTransition, SerializedEditorState } from '@hygc/editor'

const uuid = () => crypto.randomUUID()

const fade = (): ClipTransition => ({ type: 'fade', durationMs: DEFAULT_TRANSITION_DURATION_MS })

function mediaClip(opts: {
  assetId: string
  kind: 'video' | 'image'
  startTime: number
  duration: number
  inPoint?: number
  sourceDurationMs?: number
}): Clip {
  const inPoint = opts.inPoint ?? 0
  return {
    id: uuid(),
    assetId: opts.assetId,
    kind: opts.kind,
    startTime: opts.startTime,
    duration: opts.duration,
    inPoint,
    outPoint: inPoint + opts.duration,
    sourceDurationMs: opts.sourceDurationMs,
    speed: 1,
    transform: { ...DEFAULT_CLIP_TRANSFORM },
  }
}

function captionClip(text: string, startTime: number, duration: number): Clip {
  return {
    id: uuid(),
    assetId: `caption-manual-${uuid()}`,
    startTime,
    duration,
    inPoint: 0,
    outPoint: duration,
    speed: 1,
    transform: { ...DEFAULT_CLIP_TRANSFORM },
    captionText: text,
  }
}

export function buildSeedState(): { state: SerializedEditorState; title: string } {
  const tracks = createDefaultTracks()
  const videoTrack = tracks.find((t) => t.type === 'video')
  const captionTrack = tracks.find((t) => t.type === 'caption')
  const musicTrack = tracks.filter((t) => t.type === 'audio').at(-1)
  if (!videoTrack || !captionTrack || !musicTrack) {
    throw new Error('createDefaultTracks() no longer returns the expected track set')
  }

  const bunny = mediaClip({
    assetId: 'stock-big-buck-bunny',
    kind: 'video',
    startTime: 0,
    duration: 6000,
    sourceDurationMs: 10000,
  })
  // Slow push-in on the opening shot so the Inspector has keyframes to show.
  bunny.keyframeTracks = [
    {
      propertyId: 'transform.scale',
      keyframes: [
        { id: uuid(), timeMs: 0, value: 1, easingIn: 'linear', easingOut: 'easeInOut' },
        { id: uuid(), timeMs: 6000, value: 1.12, easingIn: 'easeInOut', easingOut: 'linear' },
      ],
    },
  ]

  const sintel = mediaClip({
    assetId: 'stock-sintel',
    kind: 'video',
    startTime: 6000,
    duration: 6000,
    inPoint: 2000,
    sourceDurationMs: 10000,
  })
  const jellyfish = mediaClip({
    assetId: 'stock-jellyfish',
    kind: 'video',
    startTime: 12000,
    duration: 6000,
    sourceDurationMs: 10000,
  })
  const outro = mediaClip({
    assetId: 'stock-fjord-lookout',
    kind: 'image',
    startTime: 18000,
    duration: 4000,
  })

  // Paired crossfades: prior clip fades out while the next fades in.
  bunny.transitionOut = fade()
  sintel.transitionIn = fade()
  sintel.transitionOut = fade()
  jellyfish.transitionIn = fade()
  jellyfish.transitionOut = fade()
  outro.transitionIn = fade()

  videoTrack.clips = [bunny, sintel, jellyfish, outro]

  captionTrack.clips = [
    captionClip('Cut, trim & stack — right in your browser', 500, 4000),
    captionClip('Keyframes, transitions & effects', 6500, 4000),
    captionClip('Captions with word-level highlight', 12500, 4000),
    captionClip('Exports locally with WebCodecs', 18200, 3400),
  ]

  const music: Clip = {
    id: uuid(),
    assetId: 'stock-monkeys-spinning-monkeys',
    startTime: 0,
    duration: 22000,
    inPoint: 0,
    outPoint: 22000,
    sourceDurationMs: 125074,
    speed: 1,
    transform: { ...DEFAULT_CLIP_TRANSFORM },
    fadeInMs: 800,
    fadeOutMs: 1500,
  }
  musicTrack.clips = [music]

  return {
    title: 'Stock footage showcase',
    state: {
      tracks,
      captionStyle: { ...DEFAULT_CAPTION_STYLE },
      composition: {
        ...DEFAULT_COMPOSITION_CONFIG,
        width: 1920,
        height: 1080,
        durationMs: 22000,
      },
      globalAudioVolume: 1,
    },
  }
}
