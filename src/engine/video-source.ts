/**
 * video-source — client-side video *reading* via Mediabunny.
 *
 * Mediabunny is already in the tree as a dependency of @remotion/web-renderer
 * (which powers web-export.ts), so this adds no install. It decodes frames out
 * of an uploaded or remote clip entirely in the browser — no server round-trip.
 *
 * This is the read counterpart to web-export.ts (which only writes): Remotion's
 * renderer can't decode arbitrary files. Powers timeline filmstrips, frame-
 * accurate scrubbing, and import-time probing (duration / dimensions).
 *
 * @see web-export.ts — the client-side render/encode path (write side)
 */

import { Input, ALL_FORMATS, BlobSource, UrlSource, CanvasSink } from 'mediabunny'

/** A local file/blob, or a remote URL. */
export type VideoInput = Blob | string

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas

function toInput(src: VideoInput): Input {
  const source = typeof src === 'string' ? new UrlSource(src) : new BlobSource(src)
  return new Input({ formats: ALL_FORMATS, source })
}

export interface VideoProbe {
  durationSec: number
  /** Display dimensions (rotation already applied). */
  width: number
  height: number
  rotation: number
  /** False if the browser can't decode this codec — fall back to server render. */
  decodable: boolean
}

/** Read duration + dimensions of a clip without decoding pixels. Null if no video track. */
export async function probeVideo(src: VideoInput): Promise<VideoProbe | null> {
  const track = await toInput(src).getPrimaryVideoTrack()
  if (!track) return null
  return {
    durationSec: await track.computeDuration(),
    width: track.displayWidth,
    height: track.displayHeight,
    rotation: track.rotation,
    decodable: await track.canDecode(),
  }
}

export interface FilmstripOptions {
  /** How many thumbnails to produce. Default 8. */
  count?: number
  /** Decode width per thumbnail in px; height follows aspect ratio. Default 160. */
  thumbWidth?: number
  /** Window start in seconds (e.g. a clip's trimmed in-point). Default 0. */
  startSec?: number
  /** Window end in seconds (e.g. a clip's trimmed out-point). Default = full duration. */
  endSec?: number
}

/**
 * Decode `count` evenly-spaced frames as canvases for a timeline filmstrip.
 * Empty if the clip can't be decoded in this browser.
 *
 * Frames are sampled at each segment's midpoint ((i + 0.5) / count) so the
 * first/last thumbnails aren't the usual black lead-in / fade-out frames.
 * Pass startSec/endSec to sample only a clip's trimmed window so the strip
 * shows the frames the clip actually contains, not the whole source.
 */
export async function generateFilmstrip(
  src: VideoInput,
  { count = 8, thumbWidth = 160, startSec, endSec }: FilmstripOptions = {},
): Promise<AnyCanvas[]> {
  const input = toInput(src)
  const track = await input.getPrimaryVideoTrack()
  if (!track || !(await track.canDecode())) return []

  const from = startSec ?? 0
  const to = endSec ?? (await track.computeDuration())
  const span = Math.max(0, to - from)
  const timestamps = Array.from({ length: count }, (_, i) => from + ((i + 0.5) / count) * span)

  const sink = new CanvasSink(track, { width: thumbWidth })
  const frames: AnyCanvas[] = []
  for await (const wrapped of sink.canvasesAtTimestamps(timestamps)) {
    if (wrapped) frames.push(wrapped.canvas)
  }
  return frames
}

export interface VideoScrubber {
  durationSec: number
  width: number
  height: number
  /** Decode the frame at `timeSec` (returns the last frame at or before it). */
  getFrame(timeSec: number): Promise<AnyCanvas | null>
}

/**
 * Open a persistent decoder for live scrubbing. The first call parses + seeks;
 * subsequent getFrame() calls reuse one warm CanvasSink, so dragging the
 * playhead doesn't re-open the file each tick. Use this over a one-shot for
 * anything interactive; for a single poster frame, call getFrame once.
 *
 * ponytail: no explicit teardown — CanvasSink owns its decoder and is GC'd with
 * the scrubber. Add a close()/dispose path if profiling shows decoders piling up.
 */
export async function openVideoScrubber(
  src: VideoInput,
  thumbWidth?: number,
): Promise<VideoScrubber | null> {
  const input = toInput(src)
  const track = await input.getPrimaryVideoTrack()
  if (!track || !(await track.canDecode())) return null

  const sink = new CanvasSink(track, thumbWidth ? { width: thumbWidth } : undefined)
  return {
    durationSec: await track.computeDuration(),
    width: track.displayWidth,
    height: track.displayHeight,
    async getFrame(timeSec) {
      const wrapped = await sink.getCanvas(timeSec)
      return wrapped?.canvas ?? null
    },
  }
}
