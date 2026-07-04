/**
 * ShortComposition — base Remotion composition for YouTube Shorts.
 *
 * This is the root component that Remotion renders, both in the preview player
 * and during server-side export. It receives the serialized timeline state as
 * input props and renders the layered composition for each frame:
 *
 *   Render order (bottom to top):
 *     1. Background — solid black fill behind all content
 *     2. Music tracks — audio-only (no visual, rendered as <Audio> elements)
 *     3. Voiceover tracks — audio-only
 *     4. Video tracks — video clips with transforms
 *     5. Caption tracks — styled text overlays (topmost)
 *
 * We render ALL clips for each track (track.clips.map). Remotion's <Sequence>
 * controls visibility and premounting via from/durationInFrames/premountFor.
 * We do NOT filter by "active at current time" — see below.
 *
 * Configuration:
 *   - 1080×1920 pixels (9:16 portrait, YouTube Shorts standard)
 *   - 30 FPS (configurable via CompositionConfig)
 *   - Duration derived from track content (minimum 60 seconds)
 *
 * --- WHAT WENT WRONG (black frame + music skip at video cuts) ---
 * We used to call getActiveClips(track, currentTimeMs) and only render clips
 * that were "active" at the current frame. That meant the next video's
 * <Sequence> was NOT in the React tree until the exact frame it started.
 * Remotion's premountFor only works when the <Sequence> is already mounted:
 * it pre-renders it with opacity 0 so the browser can decode the first frame.
 * By mounting the next video's <Sequence> only on the cut frame, we got:
 *   (1) One black frame — the new <Html5Video> mounted on the cut and hadn't
 *       decoded the first frame yet.
 *   (2) Music skip — the new video triggered pauseWhenBuffering, so Remotion
 *       paused the entire Player until the video was ready, which paused
 *       the background music too.
 *
 * --- HOW WE FIXED IT ---
 * Render every clip as a <Sequence> (track.clips.map). No getActiveClips, no
 * currentTimeMs passed into the composition. Remotion's internal frame drives
 * which Sequence is visible; premountFor then works: the next video's Sequence
 * is in the tree 4s before the cut (premountFor={4*fps}), so the browser
 * decodes its first frame in the background. On the cut we just flip opacity;
 * no black frame, no buffer pause, no music skip.
 *
 * SOLID: SRP — this component only handles visual composition rendering.
 * @see README.md Section 7.1 for technology approach
 * @see README.md Section 7.2 for canvas layout specification
 * @see PLAN.md Phase 3.1 for Remotion setup requirements
 */

import { createContext, useContext, type CSSProperties } from 'react'
import {
  useVideoConfig,
  AbsoluteFill,
  Sequence,
  OffthreadVideo,
  Html5Video,
  Img,
  Audio,
  useRemotionEnvironment,
  useCurrentFrame,
  interpolate,
  spring,
} from 'remotion'
// The WebCodecs web-renderer only accepts the new @remotion/media components;
// core Remotion's <Video>/<Audio> resolve to Html5Video/Html5Audio, which it
// rejects. Used only on the webExport path.
import { Video as MediaVideo, Audio as MediaAudio } from '@remotion/media'

/**
 * True while rendering client-side via `@remotion/web-renderer` (WebCodecs).
 * That renderer emulates layout to a canvas and does NOT support
 * `<OffthreadVideo>` / `<Html5Video>` — only the universal `<Video>`. We can't
 * tell web-render from server-render via `useRemotionEnvironment()` (both have
 * `isRendering: true`), so the web-export path sets `webExport` in inputProps
 * and we read it here.
 */
const WebExportContext = createContext(false)
import {
  buildCssTransform,
  buildCropClipPath,
  frameToMs,
  msToFrame,
} from './composition-utils'
import {
  computeTransitionEffect,
  buildTransitionTransform,
  type TransitionEffect,
} from './transitions'
import { resolveAnimatedTransform, resolveAnimatedCaptionStyle } from './keyframe-interpolator'
import {
  hasMediaEffects,
  hasOverlayEffects,
  buildMediaFilter,
  buildMotionTransform,
} from './effects'
import { EffectOverlays } from './EffectOverlays'
import type {
  Track,
  TrackType,
  Clip,
  CaptionStyle,
  ClipTransition,
  AudioDuckingConfig,
} from '../types'
import { DEFAULT_CAPTION_STYLE } from '../types'

// ─── Error Handling ──────────────────────────────────────────────────────────

/**
 * Soft-handle Remotion media errors instead of letting them propagate to the
 * React error boundary. The common case is a Chrome `PIPELINE_ERROR_READ`
 * ("demuxer seek failed") on a blob URL — usually because the underlying MP4
 * doesn't have its `moov` atom at the start, so seeking back fails inside
 * FFmpeg. We can't fix the source on the fly, but throwing would crash the
 * canvas; logging keeps playback alive (subsequent frames recover).
 *
 * Without this prop, Remotion's <Html5Video> / <OffthreadVideo> / <Audio>
 * re-throw the error, which the browser surfaces as
 * "Uncaught Error: The browser threw an error while playing the video".
 *
 * @see https://remotion.dev/docs/media-playback-error
 */
function logMediaError(error: Error): void {
  if (typeof console !== 'undefined') {
    console.warn('[editor] media playback error:', error.message)
  }
}

// ─── Input Props ─────────────────────────────────────────────────────────────

/**
 * Optional map from asset ID to fetchable URL. When provided, video and audio
 * clips render real media instead of placeholders. Used for both preview
 * (client-resolved) and server-side export (Edge Function-resolved).
 */
export type AssetUrlMap = Record<string, string>

/**
 * Map from asset ID to asset type. Used to render image clips with Remotion Img
 * instead of video components.
 */
export type AssetTypeMap = Record<string, 'video' | 'audio' | 'image'>

/**
 * Props passed to the ShortComposition from the Remotion Player or renderer.
 *
 * These map directly to the serialized editor state stored in
 * `projects.editor_state`. The Remotion Player receives these via its
 * `inputProps` prop, and the server-side renderer passes them to
 * `renderMedia()`.
 */
export interface ShortCompositionProps {
  /** Timeline tracks with their clips. */
  tracks: Track[]

  /** Global caption styling configuration. */
  captionStyle?: CaptionStyle

  /** Map of assetId -> URL for video/audio clips. When set, real media is rendered. */
  assetUrlMap?: AssetUrlMap

  /** Map of assetId -> type. When 'image', clip is rendered with Remotion Img. */
  assetTypeMap?: AssetTypeMap

  /** Global audio volume (0–1). Applied to all audio clips. Default 1. */
  globalAudioVolume?: number

  /**
   * Set by the client-side web export (renderMediaOnWeb) so video clips render
   * with the WebCodecs-compatible `<Video>` instead of OffthreadVideo/Html5Video.
   * Undefined/false in the preview Player and server-side export.
   */
  webExport?: boolean
}

// ─── Main Composition ────────────────────────────────────────────────────────

/**
 * Root Remotion composition for YouTube Shorts.
 *
 * Renders all tracks layered on top of each other in the correct order.
 * The composition uses AbsoluteFill for full-canvas coverage and layers
 * tracks using z-index ordering.
 */
export function ShortComposition({
  tracks,
  captionStyle,
  assetUrlMap,
  assetTypeMap,
  globalAudioVolume = 1,
  webExport = false,
}: ShortCompositionProps) {
  const { fps } = useVideoConfig()
  const resolvedCaptionStyle = captionStyle ?? DEFAULT_CAPTION_STYLE

  // Sort so caption tracks always render on top (after video/audio).
  // Within each group, sort by order (lower = behind).
  const sortedTracks = [...tracks].sort((a, b) => {
    const aCaption = a.type === 'caption' ? 1 : 0
    const bCaption = b.type === 'caption' ? 1 : 0
    if (aCaption !== bCaption) return aCaption - bCaption
    return a.order - b.order
  })

  // Cross-track ducking: each ducked audio track learns about clips on every
  // other audible audio track up-front, before any per-track render begins.
  const duckingTriggers = computeDuckingTriggers(tracks)

  return (
    <WebExportContext.Provider value={webExport}>
      <AbsoluteFill style={{ backgroundColor: '#000000' }}>
        {sortedTracks.map((track) => (
          <TrackLayer
            key={track.id}
            track={track}
            fps={fps}
            captionStyle={resolvedCaptionStyle}
            assetUrlMap={assetUrlMap}
            assetTypeMap={assetTypeMap}
            globalAudioVolume={globalAudioVolume}
            duckingWindows={duckingTriggers.get(track.id)}
          />
        ))}
      </AbsoluteFill>
    </WebExportContext.Provider>
  )
}

// ─── Track Layer ─────────────────────────────────────────────────────────────

interface TrackLayerProps {
  track: Track
  fps: number
  captionStyle: CaptionStyle
  assetUrlMap?: AssetUrlMap
  assetTypeMap?: AssetTypeMap
  globalAudioVolume?: number
  /**
   * Pre-computed trigger windows for auto-ducking. Set when this track has
   * `ducking.enabled` and at least one trigger clip on another track. Forwarded
   * to {@link AudioClipLayer} so the volume callback can apply the ramp.
   */
  duckingWindows?: readonly DuckingWindow[]
}

/**
 * Two clips that touch within this tolerance are considered to share a seam
 * during render. Mirrors `SEAM_TOLERANCE_MS` in the editor store / timeline so
 * the renderer and the editor agree on which adjacent pairs cross-fade.
 */
const SEAM_TOLERANCE_MS = 50

/** Per-clip seam-pair overrides computed once per track render. */
interface SeamOverride {
  /** When this clip is the RIGHT side of a paired seam, shift its Sequence
   *  this many milliseconds earlier so it overlaps the previous clip's tail. */
  seamInOverlapMs?: number
  /** Clamped transitionIn used at render time (matches the overlap window). */
  transitionIn?: ClipTransition
  /** Clamped transitionOut used at render time (matches the overlap window). */
  transitionOut?: ClipTransition
  /**
   * Whether this clip is the LEFT side of a paired seam. Used to suppress the
   * opacity / blur components of the out animation so that the right clip's
   * fade-in alone drives the cross-dissolve. Without this, both clips fade to
   * partial alpha in the middle of the transition and the canvas background
   * (black) bleeds through, producing the "A → black → B" flicker.
   */
  isSeamLeft?: boolean
  /**
   * Whether this clip is the RIGHT side of a paired seam. Mostly informational
   * — the cross-dissolve is achieved by combining the left clip's `isSeamLeft`
   * suppression with this clip's normal transitionIn animation.
   */
  isSeamRight?: boolean
}

/**
 * Detect seam-paired transitions on a video track and produce per-clip
 * overrides so adjacent clips actually cross-fade instead of playing their
 * in/out animations back-to-back.
 *
 * A seam is a pair (A, B) of adjacent clips where:
 *   - A.transitionOut and B.transitionIn are both set (same type)
 *   - The gap between A.end and B.start is within SEAM_TOLERANCE_MS
 *
 * For each seam, we compute an overlap window equal to the shorter of the two
 * configured durations. The right clip's Sequence shifts that much earlier and
 * `trimBefore` is pulled back proportionally so the media stays in sync where
 * head handles exist; when the clip has `inPoint = 0` we still shift the
 * Sequence (so the cross-fade always works) and accept that the first frames
 * play slightly earlier than the data suggests — the alternative is no fade
 * at all, which is what the user was seeing.
 *
 * Suppression of the left clip's opacity/blur (via `isSeamLeft`) is what
 * turns the dual-animation into a real cross-dissolve. With both halves
 * fading to ~0.5, CSS compositing layers `B*0.5 + A*0.25 + Black*0.25`,
 * which reads as a darker middle frame; pinning A to full opacity removes
 * the black-bleed entirely and lets B's fade-in drive the blend.
 *
 * Isolated transitions (no neighbour, or types don't match, or gap too large)
 * are left untouched and animate as a pure in/out at the clip's own edge.
 */
function computeSeamOverrides(track: Track): Map<string, SeamOverride> {
  const overrides = new Map<string, SeamOverride>()
  if (track.type !== 'video') return overrides
  if (track.clips.length < 2) return overrides

  const sorted = [...track.clips].sort((a, b) => a.startTime - b.startTime)
  for (let i = 1; i < sorted.length; i++) {
    const left = sorted[i - 1]!
    const right = sorted[i]!
    const lOut = left.transitionOut
    const rIn = right.transitionIn
    if (!lOut || lOut.type === 'none') continue
    if (!rIn || rIn.type === 'none') continue
    if (lOut.type !== rIn.type) continue
    const gap = right.startTime - (left.startTime + left.duration)
    if (Math.abs(gap) > SEAM_TOLERANCE_MS) continue

    const overlapMs = Math.max(0, Math.min(lOut.durationMs, rIn.durationMs))
    if (overlapMs <= 0) continue

    const clampedIn: ClipTransition = { ...rIn, durationMs: overlapMs }
    const clampedOut: ClipTransition = { ...lOut, durationMs: overlapMs }

    overrides.set(right.id, {
      ...(overrides.get(right.id) ?? {}),
      seamInOverlapMs: overlapMs,
      transitionIn: clampedIn,
      isSeamRight: true,
    })
    overrides.set(left.id, {
      ...(overrides.get(left.id) ?? {}),
      transitionOut: clampedOut,
      isSeamLeft: true,
    })
  }

  return overrides
}

/**
 * Per-audio-clip overrides used by {@link AudioClipLayer} to implement fade
 * and crossfade rendering.
 *
 * Mirrors {@link SeamOverride} but lives in the audio layer because audio
 * fades are a separate data path (no `ClipTransition`, just per-clip
 * `fadeInMs` / `fadeOutMs`). When two adjacent audio clips have facing fades
 * set and touch within {@link SEAM_TOLERANCE_MS}, the right clip's playback
 * is shifted earlier by the overlap window so the two play simultaneously —
 * a real crossfade rather than a tail-fade-then-head-fade sequence.
 */
interface AudioSeamOverride {
  /** Shift the right clip's Sequence this many ms earlier. */
  seamInOverlapMs?: number
  /** Effective fade-in length at render time (matches the overlap when paired). */
  fadeInMs?: number
  /** Effective fade-out length at render time (matches the overlap when paired). */
  fadeOutMs?: number
}

/**
 * Detect audio crossfade seams on an `audio` or `clip_audio` track.
 *
 * A pair (A, B) of adjacent audio clips crossfades when:
 *   - A.fadeOutMs > 0 AND B.fadeInMs > 0
 *   - The gap between A.end and B.start is within SEAM_TOLERANCE_MS
 *
 * The overlap window is the smaller of the two fades, additionally capped by
 * B's available head media (`inPoint / speed`) so we never invent audio that
 * doesn't exist on the source. Within the window the right clip ramps in
 * from 0 while the left clip ramps out — the volumes sum to (approximately)
 * constant perceived loudness with a linear curve, matching Premiere's
 * default constant-gain crossfade.
 *
 * Isolated fades (no neighbour, or facing edge has no fade, or gap too big)
 * are left untouched and render as a standalone fade-in or fade-out at the
 * clip's own edge.
 */
function computeAudioSeamOverrides(track: Track): Map<string, AudioSeamOverride> {
  const overrides = new Map<string, AudioSeamOverride>()
  if (track.type !== 'audio' && track.type !== 'clip_audio') return overrides
  if (track.clips.length < 2) return overrides

  const sorted = [...track.clips].sort((a, b) => a.startTime - b.startTime)
  for (let i = 1; i < sorted.length; i++) {
    const left = sorted[i - 1]!
    const right = sorted[i]!
    const lFadeOut = left.fadeOutMs ?? 0
    const rFadeIn = right.fadeInMs ?? 0
    if (lFadeOut <= 0 || rFadeIn <= 0) continue
    const gap = right.startTime - (left.startTime + left.duration)
    if (Math.abs(gap) > SEAM_TOLERANCE_MS) continue

    const requested = Math.min(lFadeOut, rFadeIn)
    const speed = Math.max(0.0001, right.speed || 1)
    // Cap by how much of B's source we can pull in before its current inPoint.
    const headHeadroomMs = right.inPoint / speed
    const overlapMs = Math.max(0, Math.min(requested, headHeadroomMs))
    if (overlapMs <= 0) continue

    overrides.set(right.id, {
      ...(overrides.get(right.id) ?? {}),
      seamInOverlapMs: overlapMs,
      fadeInMs: overlapMs,
    })
    overrides.set(left.id, {
      ...(overrides.get(left.id) ?? {}),
      fadeOutMs: overlapMs,
    })
  }

  return overrides
}

/**
 * Trigger window for a ducked track: a half-open [startMs, endMs] interval
 * during which the track's volume is reduced. Computed as the union of audio
 * clip ranges on all *other* non-muted audio / clip_audio tracks.
 */
type DuckingWindow = readonly [number, number]

/**
 * For each ducked audio track, compute the merged list of trigger windows.
 *
 * Trigger rule: a clip on any other non-muted audio or clip_audio track counts
 * as a trigger. Same-track clips don't trigger ducking on themselves. Muted
 * tracks produce no audible output, so they shouldn't pull other tracks down.
 *
 * Windows are sorted by start and merged so the per-frame lookup in
 * {@link AudioClipLayer} can scan a small list without worrying about
 * overlaps. Touching windows merge too (gap of 0 ms reads as one duck).
 *
 * Returned map is keyed by track id and only contains entries for tracks with
 * `ducking.enabled` and at least one trigger window — saves the volume-curve
 * code an unnecessary lookup for the common case.
 */
function computeDuckingTriggers(tracks: Track[]): Map<string, DuckingWindow[]> {
  const result = new Map<string, DuckingWindow[]>()

  // All audible audio clip ranges, tagged with their source track id.
  const allRanges: { trackId: string; start: number; end: number }[] = []
  for (const track of tracks) {
    if (track.type !== 'audio' && track.type !== 'clip_audio') continue
    if (track.muted) continue
    for (const clip of track.clips) {
      const end = clip.startTime + clip.duration
      if (end <= clip.startTime) continue
      allRanges.push({ trackId: track.id, start: clip.startTime, end })
    }
  }

  for (const track of tracks) {
    if (track.type !== 'audio' && track.type !== 'clip_audio') continue
    if (!track.ducking?.enabled) continue

    // Other-track ranges only — a track never ducks against its own clips.
    const others = allRanges.filter((r) => r.trackId !== track.id)
    if (others.length === 0) continue

    others.sort((a, b) => a.start - b.start)
    const merged: [number, number][] = []
    for (const range of others) {
      const last = merged[merged.length - 1]
      if (last && range.start <= last[1]) {
        if (range.end > last[1]) last[1] = range.end
      } else {
        merged.push([range.start, range.end])
      }
    }
    if (merged.length > 0) result.set(track.id, merged)
  }

  return result
}

/**
 * Compute the per-frame ducking gain (linear, 0..1) for a given timeline
 * position. Returns 1 when no trigger window is active (or close enough to
 * matter via attack/release ramps).
 *
 * When multiple windows' attack/release zones overlap the same timeline ms,
 * the most-ducked value wins (minimum gain). This handles back-to-back voice
 * clips whose release tail bleeds into the next clip's attack head without
 * creating a brief volume bump in between.
 */
function duckingGainAt(
  timelineMs: number,
  windows: readonly DuckingWindow[],
  config: AudioDuckingConfig,
): number {
  if (windows.length === 0) return 1
  const duckedGain = Math.pow(10, config.amountDb / 20)
  const attackMs = Math.max(0, config.attackMs)
  const releaseMs = Math.max(0, config.releaseMs)
  let minGain = 1

  for (const [start, end] of windows) {
    const attackStart = start - attackMs
    const releaseEnd = end + releaseMs
    if (timelineMs < attackStart || timelineMs > releaseEnd) continue

    let g: number
    if (timelineMs < start) {
      const t = attackMs > 0 ? (timelineMs - attackStart) / attackMs : 1
      g = 1 + (duckedGain - 1) * t
    } else if (timelineMs <= end) {
      g = duckedGain
    } else {
      const t = releaseMs > 0 ? (timelineMs - end) / releaseMs : 1
      g = duckedGain + (1 - duckedGain) * t
    }
    if (g < minGain) minGain = g
  }

  return minGain
}

/**
 * Per-clip renderer arguments passed to entries in {@link CLIP_LAYER_RENDERERS}.
 * Every renderer receives the same shape so a new track type can register a
 * renderer without changing the dispatcher in `TrackLayer`.
 */
interface ClipLayerRendererArgs {
  clip: Clip
  track: Track
  fps: number
  captionStyle: CaptionStyle
  assetUrlMap: AssetUrlMap | undefined
  assetTypeMap: AssetTypeMap | undefined
  globalAudioVolume: number
  seamOverrides: Map<string, SeamOverride>
  audioSeamOverrides: Map<string, AudioSeamOverride>
  duckingWindows: readonly DuckingWindow[] | undefined
}

type ClipLayerRenderer = (args: ClipLayerRendererArgs) => React.ReactNode

/** Shared by `audio` and `clip_audio` — both render via AudioClipLayer. */
const renderAudioClip: ClipLayerRenderer = ({
  clip,
  track,
  fps,
  assetUrlMap,
  globalAudioVolume,
  audioSeamOverrides,
  duckingWindows,
}) => {
  const audioOverride = audioSeamOverrides.get(clip.id)
  const duckingConfig = track.ducking?.enabled ? track.ducking : undefined
  return (
    <AudioClipLayer
      key={clip.id}
      clip={clip}
      track={track}
      fps={fps}
      assetUrlMap={assetUrlMap}
      globalAudioVolume={globalAudioVolume}
      seamInOverlapMs={audioOverride?.seamInOverlapMs ?? 0}
      fadeInMs={audioOverride?.fadeInMs ?? clip.fadeInMs ?? 0}
      fadeOutMs={audioOverride?.fadeOutMs ?? clip.fadeOutMs ?? 0}
      duckingConfig={duckingConfig}
      duckingWindows={duckingWindows}
    />
  )
}

/**
 * Registry mapping `TrackType` → per-clip renderer. Adding a new track type
 * requires only registering an entry here (and adding the type to `TrackType`);
 * the `TrackLayer` dispatcher stays untouched.
 *
 * SOLID: OCP — open for extension (new entries), closed for modification.
 */
const CLIP_LAYER_RENDERERS: Record<TrackType, ClipLayerRenderer> = {
  video: ({ clip, fps, assetUrlMap, assetTypeMap, seamOverrides }) => {
    const override = seamOverrides.get(clip.id)
    return (
      <VideoClipLayer
        key={clip.id}
        clip={clip}
        fps={fps}
        assetUrlMap={assetUrlMap}
        assetTypeMap={assetTypeMap}
        seamInOverlapMs={override?.seamInOverlapMs ?? 0}
        transitionIn={override?.transitionIn ?? clip.transitionIn}
        transitionOut={override?.transitionOut ?? clip.transitionOut}
        suppressOutOpacity={override?.isSeamLeft ?? false}
      />
    )
  },
  audio: renderAudioClip,
  clip_audio: renderAudioClip,
  caption: ({ clip, fps, captionStyle }) => (
    <CaptionClipLayer
      key={clip.id}
      clip={clip}
      fps={fps}
      captionStyle={clip.captionStyle ?? captionStyle}
    />
  ),
}

/**
 * Renders all clips for a single track (no filtering by current time).
 * Remotion's <Sequence> handles visibility and premounting; we must render
 * every clip so premountFor can mount the next video before the cut.
 */
function TrackLayer({
  track,
  fps,
  captionStyle,
  assetUrlMap,
  assetTypeMap,
  globalAudioVolume = 1,
  duckingWindows,
}: TrackLayerProps) {
  if ((track.type === 'video' || track.type === 'caption') && track.visible === false) {
    return null
  }

  if (track.muted && (track.type === 'audio' || track.type === 'clip_audio')) {
    // Audio-only tracks that are muted produce no output
    return null
  }

  const seamOverrides = computeSeamOverrides(track)
  const audioSeamOverrides = computeAudioSeamOverrides(track)
  // Render video clips in chronological order so that the RIGHT side of a seam
  // (the entering clip) stacks on top of the LEFT side (the leaving clip).
  // Stack order matters: with B above A, the cross-dissolve becomes
  // `B * opacity_B + A * (1 - opacity_B)` once A is forced to full opacity,
  // which is the only ordering that reads as a real cross-fade instead of a
  // double fade with the canvas background showing through.
  const renderedClips =
    track.type === 'video'
      ? [...track.clips].sort((a, b) => a.startTime - b.startTime)
      : track.clips

  const render = CLIP_LAYER_RENDERERS[track.type]
  if (!render) return null

  return (
    <AbsoluteFill>
      {renderedClips.map((clip) =>
        render({
          clip,
          track,
          fps,
          captionStyle,
          assetUrlMap,
          assetTypeMap,
          globalAudioVolume,
          seamOverrides,
          audioSeamOverrides,
          duckingWindows,
        }),
      )}
    </AbsoluteFill>
  )
}

// ─── Video Clip Renderer ─────────────────────────────────────────────────────

interface VideoClipLayerProps {
  clip: Clip
  fps: number
  assetUrlMap?: AssetUrlMap
  assetTypeMap?: AssetTypeMap
  /**
   * If this clip is the RIGHT side of a paired seam transition, shift its
   * Sequence this many ms earlier so it overlaps the previous clip's tail and
   * the two clips actually cross-fade. Computed by `computeSeamOverrides` in
   * TrackLayer; defaults to 0 (no shift) for isolated clips.
   */
  seamInOverlapMs?: number
  /**
   * Effective in/out transitions for this clip in the renderer. Normally the
   * same as `clip.transitionIn` / `clip.transitionOut`, but a seam pair
   * clamps both halves to the actual overlap window so the fade is contained
   * to the shared time slice.
   */
  transitionIn?: ClipTransition
  transitionOut?: ClipTransition
  /**
   * When true, the transitionOut animation's opacity/blur components are
   * pinned to identity (1.0 / 0px) so the clip stays fully visible during a
   * seam cross-fade. Geometric components (translate/scale/rotate/clipPath)
   * still animate so slide/zoom/wipe transitions still show the leaving clip
   * moving. The right side of the seam still fades its opacity in normally,
   * and the resulting compositing is a clean cross-dissolve instead of both
   * clips dipping to ~0.5 alpha at the midpoint (which exposes the black
   * canvas behind them — the "A → black → B" flicker).
   */
  suppressOutOpacity?: boolean
}

/**
 * Renders a single video clip with its transforms and crop applied.
 *
 * When assetUrlMap contains the clip's assetId, renders real video via
 * OffthreadVideo inside a Sequence. Otherwise shows a placeholder.
 * Caption clips (assetId starting with 'caption-') never use media.
 *
 * --- Seam cross-fade ---
 * When this clip is the right side of a paired seam transition (see
 * `computeSeamOverrides`), we shift the Sequence to start `seamInOverlapMs`
 * earlier and extend `durationInFrames` to compensate, so the Sequence still
 * ends at the same point on the timeline. We also pull `trimBefore` back by
 * the same amount in media-frames (speed-adjusted) so the video keeps playing
 * the right content at the right time. The previous clip's transitionOut and
 * this clip's transitionIn then run during the same shared window, producing
 * a real cross-fade instead of a sequential out-then-in.
 *
 * @see README.md Section 7.4 for transform specification
 */
function VideoClipLayer({
  clip,
  fps,
  assetUrlMap,
  assetTypeMap,
  seamInOverlapMs = 0,
  transitionIn,
  transitionOut,
  suppressOutOpacity = false,
}: VideoClipLayerProps) {
  const assetUrl =
    assetUrlMap &&
    !clip.assetId.startsWith('caption-') &&
    assetUrlMap[clip.assetId]
  const isImage = assetUrl && assetTypeMap?.[clip.assetId] === 'image'
  const env = useRemotionEnvironment()
  const webExport = useContext(WebExportContext)

  // Seam shift converts the requested overlap (in timeline ms) to a frame
  // offset on the Sequence start and a matching extension to its duration.
  // The trimBefore shift is speed-adjusted because the media advances at
  // `playbackRate` ms-of-media per ms-of-timeline.
  const overlapFrames = Math.max(0, Math.round((seamInOverlapMs / 1000) * fps))
  const speed = Math.max(0.0001, clip.speed || 1)
  const overlapMediaFrames = Math.max(
    0,
    Math.round((seamInOverlapMs * speed) / 1000 * fps),
  )

  const fromFrame = msToFrame(clip.startTime, fps) - overlapFrames
  const durationInFrames = msToFrame(clip.duration, fps) + overlapFrames

  if (assetUrl) {
    const freezeFrame = clip.freezeFrame !== undefined
      ? msToFrame(clip.freezeFrame, fps)
      : null
    // For freeze frames the trimBefore must stay pinned to the frozen frame —
    // the seam shift just gives more time on that same frame.
    const trimBefore =
      freezeFrame ??
      Math.max(0, msToFrame(clip.inPoint, fps) - overlapMediaFrames)
    const playbackRate = freezeFrame !== null ? 0.000001 : clip.speed
    // Premount 4s so the next clip is in the DOM before the cut; with prefetched
    // blob URLs the browser has time to decode the first frame and avoid a black frame.
    const premountFrames = 4 * fps

    if (isImage) {
      return (
        <Sequence from={fromFrame} durationInFrames={durationInFrames} premountFor={premountFrames}>
          <VideoClipBody
            clip={clip}
            durationInFrames={durationInFrames}
            transitionIn={transitionIn}
            transitionOut={transitionOut}
            suppressOutOpacity={suppressOutOpacity}
          >
            {/*
             * Images preserve their natural aspect ratio (objectFit:'contain')
             * because they almost always come from a different aspect than the
             * 9:16 canvas — a Shopify product photo at 4:5 squeezed to cover
             * would lose the product's edges. Width/height auto + max constraints
             * lets the browser size the element to the intrinsic ratio so the
             * canvas backdrop (or video below) shows through the letterbox.
             */}
            <Img
              src={assetUrl}
              style={{
                maxWidth: '100%',
                maxHeight: '100%',
                width: 'auto',
                height: 'auto',
                objectFit: 'contain',
              }}
            />
          </VideoClipBody>
        </Sequence>
      )
    }

    // Client-side web export (renderMediaOnWeb / WebCodecs): OffthreadVideo and
    // Html5Video are unsupported there — only the universal <Video> works. No
    // FFmpeg in the browser, so frame extraction goes through WebCodecs instead.
    if (webExport) {
      return (
        <Sequence from={fromFrame} durationInFrames={durationInFrames} premountFor={premountFrames}>
          <VideoClipBody
            clip={clip}
            durationInFrames={durationInFrames}
            transitionIn={transitionIn}
            transitionOut={transitionOut}
            suppressOutOpacity={suppressOutOpacity}
          >
            <MediaVideo
              src={assetUrl}
              trimBefore={trimBefore}
              playbackRate={playbackRate}
              muted
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          </VideoClipBody>
        </Sequence>
      )
    }

    // Preview: Html5Video with trimBefore (no per-frame startFrom) — lets video play
    // instead of seeking every frame, which causes alternating black frames.
    // We set a very high acceptableTimeShiftInSeconds so Remotion DOES NOT force
    // seeks (which causes 134+ Range requests) when the video slightly desyncs.
    // Render: OffthreadVideo for frame-perfect FFmpeg extraction.
    if (!env.isRendering) {
      return (
        <Sequence from={fromFrame} durationInFrames={durationInFrames} premountFor={premountFrames}>
          <VideoClipBody
            clip={clip}
            durationInFrames={durationInFrames}
            transitionIn={transitionIn}
            transitionOut={transitionOut}
            suppressOutOpacity={suppressOutOpacity}
          >
            <Html5Video
              src={assetUrl}
              trimBefore={trimBefore}
              playbackRate={playbackRate}
              muted
              pauseWhenBuffering
              acceptableTimeShiftInSeconds={10.0}
              onError={logMediaError}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          </VideoClipBody>
        </Sequence>
      )
    }

    return (
      <Sequence from={fromFrame} durationInFrames={durationInFrames} premountFor={premountFrames}>
        <VideoClipBody
          clip={clip}
          durationInFrames={durationInFrames}
          transitionIn={transitionIn}
          transitionOut={transitionOut}
          suppressOutOpacity={suppressOutOpacity}
        >
          <OffthreadVideo
            src={assetUrl}
            trimBefore={trimBefore}
            playbackRate={playbackRate}
            muted
            pauseWhenBuffering
            onError={logMediaError}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        </VideoClipBody>
      </Sequence>
    )
  }

  // Placeholder
  return (
    <Sequence from={fromFrame} durationInFrames={durationInFrames}>
      <VideoClipBody
        clip={clip}
        durationInFrames={durationInFrames}
        transitionIn={transitionIn}
        transitionOut={transitionOut}
        suppressOutOpacity={suppressOutOpacity}
      >
        <div
          style={{
            width: '100%',
            height: '100%',
            background:
              'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#e2e8f0',
            fontFamily: 'system-ui, sans-serif',
          }}
        >
          <div style={{ fontSize: 24, opacity: 0.7, marginBottom: 8 }}>
            Video Clip
          </div>
          <div style={{ fontSize: 14, opacity: 0.4 }}>
            {clip.assetId.substring(0, 8)}...
          </div>
        </div>
      </VideoClipBody>
    </Sequence>
  )
}

// ─── Video Clip Body (transition-aware wrapper) ──────────────────────────────

interface VideoClipBodyProps {
  clip: Clip
  durationInFrames: number
  transitionIn?: ClipTransition
  transitionOut?: ClipTransition
  /** Forwarded to `computeTransitionEffect` — see prop docs on VideoClipLayer. */
  suppressOutOpacity?: boolean
  children: React.ReactNode
}

/**
 * Inner wrapper for a video clip's Sequence content.
 *
 * Lives inside the `<Sequence>` so `useCurrentFrame()` returns a
 * sequence-relative frame (0 at clip start). Combines the clip's static
 * transform (position/scale/rotation/crop) with the per-frame transition
 * effect to produce the final CSS for the wrapper.
 */
function VideoClipBody({
  clip,
  durationInFrames,
  transitionIn,
  transitionOut,
  suppressOutOpacity = false,
  children,
}: VideoClipBodyProps) {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()

  const effect: TransitionEffect = computeTransitionEffect({
    frame,
    fps,
    totalFrames: durationInFrames,
    transitionIn,
    transitionOut,
    suppressOutAlpha: suppressOutOpacity,
  })

  // Resolve keyframed properties at the current clip-local time. For clips
  // with no `keyframeTracks`, this returns `clip.transform` unchanged — no
  // behavior change for static clips, no extra allocations.
  const animatedTransform = resolveAnimatedTransform(clip, frameToMs(frame, fps))

  const staticTransform = buildCssTransform(animatedTransform)
  const transitionTransform = buildTransitionTransform(effect)
  const combinedTransform = [staticTransform, transitionTransform].filter(Boolean).join(' ')

  const staticClipPath = buildCropClipPath(animatedTransform.crop)
  // Transition clip-path (wipe / crop-zoom) takes precedence over the static
  // crop because it animates to/from the static crop's identity anyway.
  const finalClipPath = effect.clipPath ?? (staticClipPath || undefined)

  // CSS `filter: blur()` is gaussian-symmetric, but SVG `feGaussianBlur`
  // accepts a `stdDeviation` of "X Y" — so we can apply blur only along the
  // axis of motion. Chained with the uniform blur from the 'blur' transition
  // when both are active.
  const hasMotionBlur = effect.motionBlurX > 0.05 || effect.motionBlurY > 0.05
  const motionBlurFilterId = hasMotionBlur ? `motion-blur-${clip.id}` : null
  const filterParts: string[] = []
  if (effect.blurPx > 0) filterParts.push(`blur(${effect.blurPx}px)`)
  if (motionBlurFilterId) filterParts.push(`url(#${motionBlurFilterId})`)

  const wrapperStyle: CSSProperties = {
    transform: combinedTransform || undefined,
    clipPath: finalClipPath,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    opacity: (animatedTransform.opacity ?? 1) * effect.opacity,
    filter: filterParts.length > 0 ? filterParts.join(' ') : undefined,
  }

  // Non-destructive clip effects. Media-level effects (look grade, focus-in
  // blur, shake/pulse/zoom motion) wrap the media in an inner layer so the
  // grain/vignette/letterbox overlays — rendered as siblings — stay stable on
  // the "print" while the footage moves and grades underneath. Clips without
  // effects skip both wrappers and render byte-identical to before.
  const fx = clip.effects
  const clipLocalMs = frameToMs(frame, fps)
  const mediaFilter = hasMediaEffects(fx) ? buildMediaFilter(fx, clipLocalMs) : undefined
  const motionTransform = hasMediaEffects(fx)
    ? buildMotionTransform(fx, clip.id, clipLocalMs, frameToMs(durationInFrames, fps))
    : ''

  const content =
    mediaFilter || motionTransform ? (
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transform: motionTransform || undefined,
          filter: mediaFilter,
          // Motion changes the transform every frame — keep it compositor-only
          // instead of repainting the video subtree. Not set for a static look
          // filter alone (willChange costs a layer's worth of memory).
          willChange: motionTransform ? 'transform' : undefined,
        }}
      >
        {children}
      </div>
    ) : (
      children
    )

  return (
    <AbsoluteFill style={wrapperStyle}>
      {motionBlurFilterId && (
        <svg
          width={0}
          height={0}
          style={{ position: 'absolute', pointerEvents: 'none' }}
          aria-hidden
        >
          <defs>
            <filter
              id={motionBlurFilterId}
              x="-20%"
              y="-20%"
              width="140%"
              height="140%"
              colorInterpolationFilters="sRGB"
            >
              <feGaussianBlur
                stdDeviation={`${effect.motionBlurX} ${effect.motionBlurY}`}
                edgeMode="duplicate"
              />
            </filter>
          </defs>
        </svg>
      )}
      {content}
      {hasOverlayEffects(fx) && <EffectOverlays effects={fx} />}
    </AbsoluteFill>
  )
}

// ─── Audio Clip Renderer ─────────────────────────────────────────────────────

interface AudioClipLayerProps {
  clip: Clip
  track: Track
  fps: number
  assetUrlMap?: AssetUrlMap
  globalAudioVolume?: number
  /**
   * If this clip is the RIGHT side of a paired audio crossfade, shift its
   * Sequence this many ms earlier so it overlaps the previous clip's tail
   * and the two clips actually crossfade. Computed by
   * `computeAudioSeamOverrides` in TrackLayer; defaults to 0 for isolated
   * clips. Mirrors {@link VideoClipLayerProps.seamInOverlapMs}.
   */
  seamInOverlapMs?: number
  /**
   * Effective fade-in length used at render time. Normally `clip.fadeInMs`,
   * but a crossfade pair clamps both halves to the actual overlap window so
   * the volume curve matches the shared time slice.
   */
  fadeInMs?: number
  /** Effective fade-out length used at render time. */
  fadeOutMs?: number
  /**
   * Active auto-ducking config for this clip's track. When set together with
   * `duckingWindows`, the volume callback multiplies the base × fade gain by a
   * ducking gain that drops to {@link AudioDuckingConfig.amountDb} during each
   * trigger window (with attack / release ramps).
   */
  duckingConfig?: AudioDuckingConfig
  /**
   * Pre-merged trigger windows for ducking, sorted by start time. Set together
   * with `duckingConfig`. Undefined or empty means no ducking is applied even
   * if the track config is enabled (no triggering clips exist).
   */
  duckingWindows?: readonly DuckingWindow[]
}

/**
 * Renders a single audio clip with optional fade-in / fade-out and crossfade
 * overlap with adjacent clips.
 *
 * Fade math:
 *   The Remotion `<Audio>` `volume` prop accepts a `(frame) => number`
 *   callback. We use that to ramp from 0 → base at the start (fade-in window)
 *   and from base → 0 at the end (fade-out window). Linear curve — matches
 *   Premiere's constant-gain crossfade default and is simpler / cheaper than
 *   an equal-power curve. Most users won't perceive the difference for short
 *   fades typical in social-format video.
 *
 * Crossfade:
 *   When this clip is the right side of a paired audio crossfade (see
 *   `computeAudioSeamOverrides`), we shift the Sequence to start
 *   `seamInOverlapMs` earlier and extend `durationInFrames` to compensate,
 *   matching the video seam pattern. `trimBefore` pulls back by the same
 *   amount in media-frames (speed-adjusted) so the source audio plays the
 *   correct content within the new window — i.e. the right clip's head plays
 *   while the left clip's tail is still going, both with appropriate volume
 *   curves, producing the crossfade.
 *
 * Muted tracks short-circuit to 0 without computing the curve. Otherwise no
 * placeholder is rendered — audio-only tracks have no visual.
 *
 * @see PLAN.md Phase 3.5 for playback system and Web Audio API integration
 */
function AudioClipLayer({
  clip,
  track,
  fps,
  assetUrlMap,
  globalAudioVolume = 1,
  seamInOverlapMs = 0,
  fadeInMs = 0,
  fadeOutMs = 0,
  duckingConfig,
  duckingWindows,
}: AudioClipLayerProps) {
  // Read before the early return — hooks must run unconditionally.
  const webExport = useContext(WebExportContext)

  const assetUrl =
    assetUrlMap &&
    !clip.assetId.startsWith('caption-') &&
    assetUrlMap[clip.assetId]

  if (!assetUrl) {
    return null
  }

  // Seam overlap shifts the Sequence start earlier and extends its duration
  // to compensate; `trimBefore` pulls back by the same window in media-frames
  // (speed-adjusted) so the audio stays in sync. Mirrors the video path.
  const overlapFrames = Math.max(0, Math.round((seamInOverlapMs / 1000) * fps))
  const speed = Math.max(0.0001, clip.speed || 1)
  const overlapMediaFrames = Math.max(
    0,
    Math.round((seamInOverlapMs * speed) / 1000 * fps),
  )

  const fromFrame = msToFrame(clip.startTime, fps) - overlapFrames
  const durationInFrames = msToFrame(clip.duration, fps) + overlapFrames
  const startFromFrame = Math.max(0, msToFrame(clip.inPoint, fps) - overlapMediaFrames)

  const baseVolume = (track.muted ? 0 : 1) * globalAudioVolume
  const fadeInFrames = Math.max(0, Math.round((fadeInMs / 1000) * fps))
  const fadeOutFrames = Math.max(0, Math.round((fadeOutMs / 1000) * fps))
  const fadeOutStart = Math.max(0, durationInFrames - fadeOutFrames)
  const premountFrames = Math.min(fps, 30)

  // Ducking is active when the track has an enabled config AND there's at
  // least one trigger window — both gates avoid an unnecessary per-frame
  // callback when nothing on another track is playing.
  const duckingActive =
    !!duckingConfig &&
    duckingConfig.enabled &&
    !!duckingWindows &&
    duckingWindows.length > 0

  // When neither edge has a fade and ducking is off we pass the constant —
  // Remotion is happier with a number than a function that always returns the
  // same thing, and it skips per-frame callback overhead.
  const hasFade = fadeInFrames > 0 || fadeOutFrames > 0
  const needsCallback = hasFade || duckingActive
  const volume: number | ((f: number) => number) = needsCallback && baseVolume > 0
    ? (f: number) => {
        let gain = 1
        if (fadeInFrames > 0 && f < fadeInFrames) {
          gain = Math.min(gain, f / fadeInFrames)
        }
        if (fadeOutFrames > 0 && f >= fadeOutStart) {
          // remaining = how many frames left until the end of the clip
          const remaining = durationInFrames - f
          gain = Math.min(gain, Math.max(0, remaining / fadeOutFrames))
        }
        if (duckingActive) {
          // `f` is Sequence-relative; convert to timeline ms to look up the
          // trigger window. `fromFrame` already accounts for any seam shift.
          const timelineMs = ((fromFrame + f) * 1000) / fps
          gain *= duckingGainAt(timelineMs, duckingWindows!, duckingConfig!)
        }
        return Math.max(0, gain * baseVolume)
      }
    : baseVolume

  return (
    <Sequence from={fromFrame} durationInFrames={durationInFrames} premountFor={premountFrames}>
      {webExport ? (
        // WebCodecs render: @remotion/media Audio (core <Audio> is rejected).
        <MediaAudio
          src={assetUrl}
          trimBefore={startFromFrame}
          playbackRate={clip.speed}
          volume={volume}
        />
      ) : (
        <Audio
          src={assetUrl}
          trimBefore={startFromFrame}
          playbackRate={clip.speed}
          volume={volume}
          pauseWhenBuffering
          onError={logMediaError}
        />
      )}
    </Sequence>
  )
}

// ─── Caption Clip Renderer ───────────────────────────────────────────────────

interface CaptionClipLayerProps {
  clip: Clip
  fps: number
  captionStyle: CaptionStyle
}

/**
 * Font size map from CaptionFontSize presets to pixel values.
 * Tuned for 1080px-wide composition at 9:16 aspect ratio.
 */
const FONT_SIZE_MAP: Record<string, number> = {
  S: 36,
  M: 48,
  L: 64,
  XL: 80,
}

/**
 * Vertical anchor map from CaptionPosition to flex justify-content.
 *
 * AbsoluteFill defaults to `flexDirection: 'column'`, so the MAIN axis is
 * vertical and `justifyContent` is what controls top/center/bottom anchoring.
 * (`alignItems` on a column flex controls horizontal alignment, which we
 * always centre.) This guarantees that top, center, and bottom all render
 * visibly within the 1080×1920 frame — the old `top: '75%'` strategy
 * combined with `height: 100%` from AbsoluteFill pushed bottom captions
 * hundreds of pixels below the frame.
 */
const POSITION_JUSTIFY_MAP: Record<string, 'flex-start' | 'center' | 'flex-end'> = {
  top: 'flex-start',
  center: 'center',
  bottom: 'flex-end',
}

/** Safe-area padding (px in 1080×1920 space) so anchored captions don't kiss the edge. */
const CAPTION_SAFE_AREA_PX = 160

/**
 * Font families that ship a single, naturally-heavy weight. For these we
 * default to `font-weight: 400` so we don't trigger a synthetic-bold stamp
 * on glyphs that are already display-weight. The caption panel's preset
 * thumbnails apply the same rule for the same reason.
 */
const CAPTION_DISPLAY_FAMILIES = new Set([
  'Bangers',
  'Luckiest Guy',
  'Anton',
  'Bebas Neue',
  'Impact',
])

/**
 * Renders a single caption clip with the resolved caption style.
 *
 * Caption clips display their `captionText` field with the styling
 * defined in the CaptionStyle (font, color, position, outline, shadow,
 * animation). Individual clips can override the global style.
 *
 * Layout strategy:
 *   - Full-frame flex container with vertical anchor (top/center/bottom)
 *     so all three anchors render visibly inside the 1920px height.
 *   - xOffset / yOffset translate the text block in pixels for free
 *     placement (drag handle in the editor).
 *
 * In the live preview, empty captions render a faded placeholder so newly
 * placed clips don't appear invisible. During final rendering
 * (useRemotionEnvironment().isRendering) the placeholder is suppressed.
 *
 * @see README.md Section 7.6 for caption styling specification
 * @see PLAN.md Phase 3.8 for caption generation requirements
 */
function CaptionClipLayer({ clip, fps, captionStyle }: CaptionClipLayerProps) {
  const env = useRemotionEnvironment()
  const hasText = !!clip.captionText && clip.captionText.trim().length > 0

  // In the final render we suppress empty captions entirely. In the preview
  // we show a faded placeholder so the clip is visually present.
  if (!hasText && env.isRendering) {
    return null
  }

  // AbsoluteFill is flex-direction: column, so justifyContent = vertical anchor.
  // The position anchor is not keyframable (it's a discrete enum), so this is
  // resolved once at the layer level and stays put for the clip's lifetime.
  const justify = POSITION_JUSTIFY_MAP[captionStyle.position] ?? 'flex-end'
  const fromFrame = msToFrame(clip.startTime, fps)
  const durationInFrames = msToFrame(clip.duration, fps)
  return (
    <Sequence from={fromFrame} durationInFrames={durationInFrames}>
      <CaptionClipBody
        clip={clip}
        baseStyle={captionStyle}
        justify={justify}
        durationInFrames={durationInFrames}
        text={hasText ? (clip.captionText ?? '') : 'Caption text…'}
        hasText={hasText}
      />
    </Sequence>
  )
}

/**
 * Inner body for a caption — split into its own component so it can call
 * `useCurrentFrame` (the parent CaptionClipLayer renders a `<Sequence>` that
 * resets the frame clock; hooks must live inside the Sequence).
 *
 * Receives the clip-level `baseStyle` (per-clip override or global default)
 * and overlays any animated caption properties on top of it, per frame.
 * Non-animated fields pass through `baseStyle` unchanged.
 */
interface CaptionClipBodyProps {
  clip: Clip
  baseStyle: CaptionStyle
  justify: 'flex-start' | 'center' | 'flex-end'
  durationInFrames: number
  text: string
  hasText: boolean
}

function CaptionClipBody({
  clip,
  baseStyle,
  justify,
  durationInFrames,
  text,
  hasText,
}: CaptionClipBodyProps) {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()

  // Resolve any animated caption properties (font size, X/Y offset) at this
  // frame's clip-local time, falling through to the static baseStyle for
  // anything not keyframed. The resolver is a no-op when the clip has no
  // caption.* tracks, so the static path stays cheap.
  const clipLocalMs = frameToMs(frame, fps)
  const captionStyle = resolveAnimatedCaptionStyle(clip, baseStyle, clipLocalMs)
  const fontSize = captionStyle.fontSizePx ?? FONT_SIZE_MAP[captionStyle.fontSize] ?? 64

  const textShadow = [
    captionStyle.dropShadow || undefined,
    captionStyle.outlineWidth > 0
      ? buildTextStroke(captionStyle.outlineColor, captionStyle.outlineWidth)
      : undefined,
  ]
    .filter(Boolean)
    .join(', ')

  const xOffset = captionStyle.xOffset ?? 0
  const yOffset = captionStyle.yOffset ?? 0

  // ── Animations ──────────────────────────────────────────────────────────────
  // useCurrentFrame() here is sequence-relative (0..durationInFrames-1) because
  // we sit inside the parent CaptionClipLayer's <Sequence>. The "in" animation
  // plays at the start, the "out" animation plays in the final frames.
  const inDurationFrames = 8
  const outDurationFrames = 8
  // outStartFrame is when the exit animation begins; clamp so very-short caption
  // clips still get a visible exit if at all possible.
  const outStartFrame = Math.max(0, durationInFrames - outDurationFrames)

  const anim = computeCaptionAnimation({
    frame,
    fps,
    inAnimation: captionStyle.animationIn,
    outAnimation: captionStyle.animationOut,
    inDurationFrames,
    outDurationFrames,
    outStartFrame,
  })

  // Combine the static positional offset with the animation's transform delta.
  const transform = [
    `translate(${xOffset + anim.translateX}px, ${yOffset + anim.translateY}px)`,
    `scale(${anim.scale})`,
  ].join(' ')

  return (
    <AbsoluteFill
      style={{
        // AbsoluteFill is column flex; main axis (vertical) gets justifyContent,
        // cross axis (horizontal) stays centred.
        justifyContent: justify,
        alignItems: 'center',
        padding: `${CAPTION_SAFE_AREA_PX}px 48px`,
        // Transparent — the caption layer must never blot out the video below.
        backgroundColor: 'transparent',
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          fontFamily: captionStyle.fontFamily,
          fontSize,
          // Display families (Bangers, Luckiest Guy, Impact, …) only ship one
          // weight; forcing 700 on top of those triggers a synthetic-bold
          // double-stamp in some browsers. Body families default to 700 so
          // captions read as bold by default, matching every TikTok preset.
          fontWeight:
            captionStyle.fontWeight ??
            (CAPTION_DISPLAY_FAMILIES.has(captionStyle.fontFamily) ? 400 : 700),
          fontStyle: captionStyle.fontStyle ?? 'normal',
          textTransform: captionStyle.textTransform ?? 'none',
          letterSpacing: `${captionStyle.letterSpacing ?? 0}px`,
          // Real captions render in their own colour at full opacity. Empty
          // clips use a muted grey for the "Caption text…" placeholder so
          // it reads as an instruction, not as styled text — the opacity
          // stays at 1 so nothing about a real caption ever looks dimmed.
          color: hasText ? captionStyle.color : 'rgba(255,255,255,0.55)',
          textAlign: 'center',
          lineHeight: captionStyle.lineHeight ?? 1.3,
          padding: '8px 24px',
          maxWidth: '90%',
          textShadow: hasText ? (textShadow || undefined) : undefined,
          backgroundColor: hasText ? (captionStyle.backgroundColor || undefined) : undefined,
          borderRadius: hasText && captionStyle.backgroundColor ? 8 : undefined,
          wordBreak: 'break-word',
          transform,
          opacity: anim.opacity,
          // Placeholder marker: dashed outline only on empty clips.
          outline: hasText ? undefined : `4px dashed rgba(255,255,255,0.35)`,
          outlineOffset: hasText ? undefined : 8,
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  )
}

// ─── Caption Animation ───────────────────────────────────────────────────────

interface CaptionAnimationOutput {
  opacity: number
  scale: number
  translateX: number
  translateY: number
}

interface ComputeCaptionAnimationArgs {
  frame: number
  fps: number
  inAnimation: CaptionStyle['animationIn']
  outAnimation: CaptionStyle['animationOut']
  inDurationFrames: number
  outDurationFrames: number
  outStartFrame: number
}

/**
 * Resolve the visual state (opacity / scale / translate) of a caption for a
 * given frame, based on the configured in/out animations.
 *
 * The function is split into "in" and "out" phases so they can apply
 * simultaneously without one clobbering the other (in stops near frame 0; out
 * begins near the end). Each animation picks a single visual axis to drive
 * (e.g. fade-in → opacity; pop-in → scale; slide-up → translateY) and leaves
 * the others at their identity values.
 *
 * Tuned for ~250ms enter/exit at 30fps so it feels snappy without being
 * disorienting. spring() gives pop-in its characteristic overshoot; everything
 * else uses a linear/eased interpolate.
 */
function computeCaptionAnimation({
  frame,
  fps,
  inAnimation,
  outAnimation,
  inDurationFrames,
  outDurationFrames,
  outStartFrame,
}: ComputeCaptionAnimationArgs): CaptionAnimationOutput {
  let opacity = 1
  let scale = 1
  let translateX = 0
  let translateY = 0

  // ── In ──
  // Progress is 0 at clip start, 1 once the entry animation has finished.
  const inProgress = interpolate(frame, [0, inDurationFrames], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  })

  switch (inAnimation) {
    case 'pop-in': {
      // Spring gives a satisfying overshoot — this is the signature TikTok caption motion.
      const s = spring({ frame, fps, config: { damping: 12, stiffness: 180, mass: 0.6 } })
      // Map spring's 0..1 to a 0.6..1 scale + a quick opacity fade-in.
      scale = 0.6 + s * 0.4
      opacity = Math.min(1, frame / 4)
      break
    }
    case 'fade-in':
      opacity = inProgress
      break
    case 'slide-up':
      // Start 40px below final, slide up to 0.
      translateY = (1 - inProgress) * 40
      opacity = inProgress
      break
    case 'slide-down':
      translateY = (1 - inProgress) * -40
      opacity = inProgress
      break
    case 'slide-left':
      // Enter from the right, slide left into place.
      translateX = (1 - inProgress) * 60
      opacity = inProgress
      break
    case 'slide-right':
      translateX = (1 - inProgress) * -60
      opacity = inProgress
      break
    case 'none':
      // No-op.
      break
  }

  // ── Out ──
  // Only compute if we're inside the exit window — otherwise the out branch
  // would multiplicatively reduce opacity throughout the entire clip.
  if (frame >= outStartFrame && outAnimation !== 'none') {
    const outProgress = interpolate(
      frame,
      [outStartFrame, outStartFrame + outDurationFrames],
      [0, 1],
      { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
    )
    switch (outAnimation) {
      case 'pop-in':
        // Reverse pop: shrink + fade out.
        scale *= 1 - outProgress * 0.4
        opacity *= 1 - outProgress
        break
      case 'fade-in':
        opacity *= 1 - outProgress
        break
      case 'slide-up':
        translateY += outProgress * -40
        opacity *= 1 - outProgress
        break
      case 'slide-down':
        translateY += outProgress * 40
        opacity *= 1 - outProgress
        break
      case 'slide-left':
        translateX += outProgress * -60
        opacity *= 1 - outProgress
        break
      case 'slide-right':
        translateX += outProgress * 60
        opacity *= 1 - outProgress
        break
    }
  }

  return { opacity, scale, translateX, translateY }
}

// ─── Text Stroke Helper ──────────────────────────────────────────────────────

/**
 * Generate a CSS text-shadow that simulates a text stroke/outline.
 *
 * Creates multiple shadow layers at cardinal and diagonal offsets to
 * produce a consistent outline effect around text. This is more widely
 * supported than -webkit-text-stroke and works well in Remotion.
 *
 * @param color - Outline color (hex or rgba)
 * @param width - Outline width in pixels
 * @returns CSS text-shadow string
 */
function buildTextStroke(color: string, width: number): string {
  const offsets = [
    [width, 0],
    [-width, 0],
    [0, width],
    [0, -width],
    [width, width],
    [-width, -width],
    [width, -width],
    [-width, width],
  ]
  return offsets.map(([x, y]) => `${x}px ${y}px 0 ${color}`).join(', ')
}
