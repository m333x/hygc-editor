/**
 * Editor Types — type definitions for the HyGC non-linear editor (NLE).
 *
 * Defines the core data structures that drive the timeline, preview canvas,
 * and inspector panel. These types are serialized to JSON and stored in the
 * `projects.editor_state` column in Supabase, making them the source of truth
 * for project persistence and server-side rendering.
 *
 * Type hierarchy:
 *   EditorState          — top-level state shape for the Zustand store
 *   ├── Track[]          — ordered list of timeline tracks
 *   │   └── Clip[]       — clips placed on each track
 *   │       └── ClipTransform — per-clip transform (position, scale, rotation, crop)
 *   ├── CaptionStyle     — shared styling for caption clips
 *   └── CompositionConfig — output dimensions, FPS, and format
 *
 * Serialization:
 *   The entire EditorState (minus transient UI state like selections and playback)
 *   is JSON-serializable. The Zustand store provides `serialize()` and `deserialize()`
 *   methods for saving to and loading from Supabase.
 *
 * SOLID: SRP — this module only defines data shapes. No behavior, no rendering,
 *   no state management logic.
 * SOLID: OCP — new clip types or track types can be added by extending the
 *   union types without modifying existing type definitions.
 *
 * @see README.md Section 7.3 for timeline state specification
 * @see PLAN.md Phase 3.1 for Remotion setup requirements
 * @see PLAN.md Phase 3.3 for Zustand store requirements
 */

// ─── Composition Configuration ───────────────────────────────────────────────

/**
 * Output composition configuration.
 *
 * Defines the dimensions, frame rate, and format for the Remotion composition.
 * For YouTube Shorts, the default is 1080x1920 at 30 FPS — these values are
 * fixed for the Shorts workflow but kept configurable for future expansion
 * (e.g., 16:9 horizontal video support).
 *
 * @see README.md Section 7.2 "Canvas & Layout" for default composition specs
 */
export interface CompositionConfig {
  /** Canvas width in pixels. Default: 1080 (9:16 portrait). */
  width: number

  /** Canvas height in pixels. Default: 1920 (9:16 portrait). */
  height: number

  /** Frames per second. Default: 30. */
  fps: number

  /** Total composition duration in milliseconds. Derived from track content. */
  durationMs: number
}

/**
 * Default composition configuration for YouTube Shorts.
 * 1080x1920 resolution, 30 FPS, no fixed duration — the project's runtime
 * length is derived from the latest clip end (see `computeCompositionDuration`),
 * matching Premiere Pro's behavior where an empty project has zero duration.
 */
export const DEFAULT_COMPOSITION_CONFIG: CompositionConfig = {
  width: 1080,
  height: 1920,
  fps: 30,
  durationMs: 0,
}

// ─── Clip Transform ──────────────────────────────────────────────────────────

/**
 * Crop values for a clip, expressed as percentages (0–50) of the source
 * dimensions. Applied before scale/position transforms.
 *
 * @see README.md Section 7.4 "Crop Section" for inspector UI spec
 */
export interface CropRect {
  /** Percentage cropped from the top edge (0–50). */
  top: number
  /** Percentage cropped from the right edge (0–50). */
  right: number
  /** Percentage cropped from the bottom edge (0–50). */
  bottom: number
  /** Percentage cropped from the left edge (0–50). */
  left: number
}

/**
 * Per-clip transform properties.
 *
 * Applied in the Remotion composition to position, scale, rotate, flip, and
 * crop each clip on the canvas. The transform is relative to the composition
 * center (0, 0 = centered). The inspector panel provides UI controls for
 * each of these properties.
 *
 * Application order in the renderer:
 *   1. Crop (reduces visible area)
 *   2. Scale
 *   3. Flip (horizontal/vertical)
 *   4. Rotate
 *   5. Translate (position)
 *
 * @see README.md Section 7.4 "Clip Tweaking (Inspector Panel)"
 */
export interface ClipTransform {
  /** Horizontal offset from center in pixels. Positive = right. */
  x: number

  /** Vertical offset from center in pixels. Positive = down. */
  y: number

  /**
   * Scale factor. 1.0 = 100% (original size).
   * Range: 0.1 (10%) to 4.0 (400%).
   */
  scale: number

  /** Rotation in degrees. Range: -360 to 360. */
  rotation: number

  /** Whether to flip the clip horizontally. */
  flipH: boolean

  /** Whether to flip the clip vertically. */
  flipV: boolean

  /** Crop rectangle (percentage-based). */
  crop: CropRect

  /**
   * Layer opacity (0–1). Applied in the composition renderer.
   * Default 1 when omitted (older projects).
   */
  opacity?: number
}

/**
 * Default transform — centered, no scale/rotation/crop/flip.
 */
export const DEFAULT_CLIP_TRANSFORM: ClipTransform = {
  x: 0,
  y: 0,
  scale: 1,
  rotation: 0,
  flipH: false,
  flipV: false,
  crop: { top: 0, right: 0, bottom: 0, left: 0 },
  opacity: 1,
}

// ─── Keyframes ───────────────────────────────────────────────────────────────

/**
 * Temporal interpolation for one side of a keyframe.
 *
 *   - 'linear'     — straight line between values
 *   - 'easeIn'     — cubic ease in (slow start)
 *   - 'easeOut'    — cubic ease out (slow end)
 *   - 'easeInOut'  — cubic ease in then out
 *   - 'hold'       — step: keep the source value until the next keyframe
 *
 * Each keyframe stores `easingIn` (how it ARRIVES from the previous keyframe)
 * and `easingOut` (how it DEPARTS toward the next one), matching Premiere's
 * temporal interpolation model.
 */
export type EasingKind = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'hold'

/**
 * A single keyframe on one property of one clip.
 *
 * `timeMs` is CLIP-LOCAL: 0 at the clip's left edge, ranging up to
 * `clip.duration` at the right edge. Clip-local time means keyframes move
 * with the clip when you drag it on the timeline, and survive right-edge
 * trims without needing to recompute timestamps.
 *
 * v1 only handles scalar number properties (x, y, scale, rotation, opacity).
 */
export interface Keyframe {
  /** Unique keyframe identifier (UUID). */
  id: string

  /** Time within the clip in milliseconds (0..clip.duration). */
  timeMs: number

  /** Property value at this keyframe. */
  value: number

  /** Interpolation curve for the segment ARRIVING at this keyframe. */
  easingIn: EasingKind

  /** Interpolation curve for the segment DEPARTING this keyframe. */
  easingOut: EasingKind
}

/**
 * IDs of properties that can be keyframed in v1.
 *
 * `transform.*` entries animate `clip.transform` and apply to video clips.
 * `caption.*` entries animate fields on `clip.captionStyle` (per-clip override
 * over the global caption style) — caption clips don't have transform-driven
 * rendering in the composition, so their size/position need their own
 * property family. The engine resolves whichever family is keyframed; clips
 * may have both families simultaneously (rare but allowed).
 *
 * Add new entries here (and to `ANIMATABLE_PROPERTIES` in
 * `engine/animatable-properties.ts`) to make additional properties keyframable.
 * The render path reads from the registry — no switch statements to update.
 */
export type AnimatablePropertyId =
  | 'transform.x'
  | 'transform.y'
  | 'transform.scale'
  | 'transform.rotation'
  | 'transform.opacity'
  | 'caption.fontSizePx'
  | 'caption.xOffset'
  | 'caption.yOffset'

/**
 * Keyframes for one property on one clip.
 *
 * Invariants:
 *   - `keyframes` is sorted by `timeMs` ascending
 *   - all `keyframes[i].id` values are unique within the track
 *   - all `keyframes[i].timeMs` values are unique within the track
 *
 * Empty tracks are valid (e.g. when keyframing is enabled with no values yet)
 * but should generally be cleaned up to keep the data compact.
 */
export interface KeyframeTrack {
  propertyId: AnimatablePropertyId
  keyframes: Keyframe[]
}

// ─── Clip Types ──────────────────────────────────────────────────────────────

/**
 * Track types determine rendering behavior in the Remotion composition.
 *
 *   - 'video': renders video frames with transforms
 *   - 'audio': renders audio waveform in timeline, audio output only
 *   - 'caption': renders styled text overlays
 *   - 'clip_audio': non-deletable track showing audio from B-roll/video clips above
 *
 * @see README.md Section 7.3 "Default Tracks" for track type descriptions
 */
export type TrackType = 'video' | 'audio' | 'caption' | 'clip_audio'

/**
 * A clip placed on a timeline track.
 *
 * Represents a segment of a source asset placed at a specific position on
 * the timeline. Clips can be trimmed (inPoint/outPoint), repositioned
 * (startTime), and transformed (scale, position, rotation, crop).
 *
 * The Remotion composition reads clip data to determine which clips are
 * active at each frame, then renders them with their transforms applied.
 *
 * Key timing relationships:
 *   - startTime: where the clip begins on the timeline (ms)
 *   - duration: how long the clip appears on the timeline (ms)
 *   - inPoint: where to start reading from the source asset (ms)
 *   - outPoint: where to stop reading from the source asset (ms)
 *   - source duration = outPoint - inPoint
 *   - timeline duration = (outPoint - inPoint) / speed
 *
 * @see README.md Section 7.3 "Clip" interface for the spec
 */
export interface Clip {
  /** Unique clip identifier (UUID). */
  id: string

  /** Reference to the source asset in the assets table. */
  assetId: string

  /**
   * Concrete media kind backing this clip. Distinguishes a still image from a
   * moving video on the same `video` track so the timeline can render an
   * image-specific style and the composition can pick the right Remotion
   * component without re-querying the asset table.
   *
   * Optional and additive: clips created before this field landed (or audio /
   * caption clips, where the field is meaningless) are treated as plain video.
   */
  kind?: 'video' | 'image'

  /**
   * Position on the timeline where the clip starts, in milliseconds.
   * This is the "left edge" of the clip block in the timeline UI.
   */
  startTime: number

  /**
   * Visible duration on the timeline in milliseconds.
   * Computed as (outPoint - inPoint) / speed, but stored explicitly
   * to avoid rounding issues during timeline operations.
   */
  duration: number

  /**
   * Trim start within the source asset, in milliseconds.
   * 0 = start from the beginning of the source.
   */
  inPoint: number

  /**
   * Trim end within the source asset, in milliseconds.
   * Defaults to the source asset's total duration.
   */
  outPoint: number

  /**
   * Source asset's total duration in milliseconds.
   * Set when the clip is created so we can allow extending the trim back up
   * to the full source length after the user has shortened the clip.
   */
  sourceDurationMs?: number

  /**
   * Playback speed multiplier.
   * 1.0 = normal speed. Range: 0.25x to 4.0x.
   */
  speed: number

  /**
   * Optional freeze frame timestamp within the source asset (ms).
   * When set, the clip displays this single frame for its entire duration.
   */
  freezeFrame?: number

  /** Visual transform (position, scale, rotation, crop, flip). */
  transform: ClipTransform

  /**
   * Caption-specific text content. Only used on 'caption' track clips.
   * For video/audio clips this is undefined.
   */
  captionText?: string

  /**
   * Caption-specific styling override. Only used on 'caption' track clips.
   * If undefined, the global CaptionStyle from EditorState is used.
   */
  captionStyle?: CaptionStyle

  /**
   * For clips on a 'clip_audio' track: the id of the video clip this audio
   * is derived from. Used to keep clip audio in sync when the video clip
   * is moved, trimmed, split, or deleted.
   */
  sourceVideoClipId?: string

  /**
   * For video clips that have a matching clip_audio: when true (default),
   * moving/trimming/splitting the video clip also updates the linked clip_audio.
   * When false, video and clip_audio can be edited independently.
  */
  audioLinked?: boolean

  /**
   * Transition applied at the start (left edge) of the clip.
   *
   * When the clip is adjacent to another clip on the same track and both share
   * a transition pair (e.g. crossfade), the previous clip's `transitionOut`
   * and this clip's `transitionIn` overlap during the transition window.
   *
   * For isolated clips (no left neighbor or a gap), this becomes a pure
   * "in" animation: the clip animates into the composition at its start.
   *
   * Only applies to 'video' tracks. Caption tracks are text overlays and do
   * not accept transitions; audio clips use the separate `fadeInMs` /
   * `fadeOutMs` fields below — audio doesn't have multiple transition shapes,
   * just a fade envelope, so we keep its data model independent of visual
   * transitions.
   */
  transitionIn?: ClipTransition

  /**
   * Transition applied at the end (right edge) of the clip.
   *
   * For isolated clips this becomes a pure "out" animation. See
   * `transitionIn` above for the paired-transition behavior.
   */
  transitionOut?: ClipTransition

  /**
   * Fade-in duration in milliseconds for audio clips.
   *
   * Applies to clips on `audio` and `clip_audio` tracks. The Remotion
   * composition ramps the clip volume from 0 to its base volume over this
   * window starting at the clip's left edge. Omitted/0 means no fade.
   *
   * When the previous adjacent audio clip has `fadeOutMs` set and the two
   * clips touch on the timeline, the renderer shifts this clip's playback
   * earlier by the smaller of the two fades — producing a crossfade where
   * one clip fades out while the other fades in over the shared window.
   * See `computeAudioSeamOverrides` in ShortComposition.tsx.
   */
  fadeInMs?: number

  /**
   * Fade-out duration in milliseconds for audio clips.
   *
   * Symmetrical counterpart of `fadeInMs` — ramps the clip volume from its
   * base volume down to 0 over this window ending at the clip's right edge.
   * Paired with the next adjacent clip's `fadeInMs` to produce a crossfade.
   */
  fadeOutMs?: number

  /**
   * Per-property keyframe tracks for time-varying animation.
   *
   * Premiere-style: each property has its own track, toggleable independently
   * via the Inspector "stopwatch." When a property has a track, the renderer
   * resolves the animated value at the current frame (see
   * `resolveAnimatedTransform` in `engine/keyframe-interpolator.ts`) and
   * overrides the static baseline from `transform`.
   *
   * Optional and additive: clips without keyframes render exactly as before.
   */
  keyframeTracks?: KeyframeTrack[]

  /**
   * Non-destructive visual effect stack (Premiere-style). An ordered list of
   * effect instances — index 0 is applied to the source media first, later
   * instances process its output. The same effect type may appear more than
   * once. Pure clip data: the composition derives pixels from these per frame;
   * the source media is never modified. Only meaningful on video-track clips.
   *
   * All effects are deterministic per frame (no wall-clock, no Math.random)
   * so preview, server render, and WebCodecs export produce identical output.
   *
   * Legacy projects stored a flat one-slot-per-effect object here; it is
   * migrated to a stack on load (see `migrateLegacyEffects`).
   */
  effects?: EffectInstance[]
}

// ─── Effects ─────────────────────────────────────────────────────────────────

/**
 * Named color-grade presets. Each maps to a CSS filter chain in
 * `engine/effects.ts`; `intensity` interpolates every parameter toward
 * identity so one slider tames the whole look.
 */
export type LookPreset = 'punch' | 'film' | 'warm' | 'cool' | 'bw' | 'noir'

/**
 * Type-specific parameters for one effect instance. Discriminated on `type`.
 *
 *   - look      — color grade preset with 0–1 intensity (1 = full recipe)
 *   - shake     — handheld camera shake strength, 0–1
 *   - pulse     — rhythmic zoom kick every `intervalMs`, `amount` 0–1
 *   - slowZoom  — continuous Ken Burns zoom over the clip, `amount` 0–1
 *   - grain     — film grain overlay opacity, 0–1
 *   - vignette  — vignette overlay opacity, 0–1
 *   - letterbox — cinematic bars: fraction of frame height per bar, 0–0.15
 *   - focusIn   — clip opens blurred and pulls sharp over `durationMs`
 */
export type EffectParams =
  | { type: 'look'; preset: LookPreset; intensity: number }
  | { type: 'shake'; amount: number }
  | { type: 'pulse'; intervalMs: number; amount: number }
  | { type: 'slowZoom'; direction: 'in' | 'out'; amount: number }
  | { type: 'grain'; amount: number }
  | { type: 'vignette'; amount: number }
  | { type: 'letterbox'; amount: number }
  | { type: 'focusIn'; durationMs: number }

export type EffectType = EffectParams['type']

/**
 * One applied effect in a clip's effect stack.
 *
 * `id` is a UUID unique per instance — it keys the Inspector's sortable list
 * and (combined with the clip id) seeds deterministic per-instance variation
 * such as shake phase. `enabled` defaults to true when omitted; a disabled
 * instance stays in the stack with its settings but contributes nothing to
 * the render (Premiere's per-effect "fx" toggle).
 */
export type EffectInstance = { id: string; enabled?: boolean } & EffectParams

/**
 * Pre-stack flat effects object (one optional slot per effect type). Only
 * referenced by the load-time migration that converts it to `EffectInstance[]`.
 */
export interface LegacyClipEffects {
  look?: { preset: LookPreset; intensity: number }
  shake?: number
  pulse?: { intervalMs: number; amount: number }
  slowZoom?: { direction: 'in' | 'out'; amount: number }
  grain?: number
  vignette?: number
  letterbox?: number
  focusIn?: { durationMs: number }
}

// ─── Transitions ─────────────────────────────────────────────────────────────

/**
 * Available transition types.
 *
 * Each type maps to a distinct visual animation applied at the clip's in/out
 * edge. The 'none' type is a sentinel for "no transition" and is treated the
 * same as `undefined` — kept here so the UI can render an explicit None tile
 * for clearing existing transitions.
 *
 * @see editor/engine/transitions.ts for the animation implementations
 * @see TransitionsPanel.tsx for the user-facing palette
 */
export type TransitionType =
  | 'none'
  | 'slide'
  | 'pan'
  | 'fade'
  | 'blur'
  | 'grow'
  | 'zoom'
  | 'pop'
  | 'wipe'
  | 'baseline'
  | 'crop-zoom'
  | 'spin'

/**
 * Direction of motion for directional transitions (slide, pan, wipe).
 *
 * The value describes the visual motion vector — i.e. which way the content
 * is moving on screen. `'left'` means the new clip enters from the right and
 * the leaving clip exits to the left (everything moves leftward). When both
 * sides of a seam share the same direction, the result reads as one
 * continuous push rather than two clips moving in opposite directions.
 *
 * Non-directional transitions (fade, blur, zoom, grow, pop, baseline,
 * crop-zoom, spin) ignore this field.
 */
export type TransitionDirection = 'left' | 'right' | 'up' | 'down'

/**
 * A transition applied to one edge of a clip.
 *
 * `durationMs` is the animation length in milliseconds. The composition
 * clamps the value to the clip's available length at render time so very
 * short clips don't render half-finished transitions.
 *
 * `direction` is only meaningful for directional types (slide, pan, wipe).
 * When omitted, each preset falls back to its registered default.
 *
 * `motionBlurStrength` is a 0–2 multiplier applied to the per-type motion
 * blur peak (1 = the preset default, 0 = no motion blur, 2 = doubled). Only
 * meaningful for types that produce motion blur in the first place — types
 * like `fade` and `wipe` ignore it.
 */
export interface ClipTransition {
  type: TransitionType
  durationMs: number
  direction?: TransitionDirection
  motionBlurStrength?: number
}

/** Default motion-blur strength when a transition has no explicit value. */
export const DEFAULT_MOTION_BLUR_STRENGTH = 1
/** Slider bounds for the Inspector motion-blur strength control. */
export const MIN_MOTION_BLUR_STRENGTH = 0
export const MAX_MOTION_BLUR_STRENGTH = 5

/** Default transition duration in milliseconds. Tuned snappier than typical NLE defaults — closer to CapCut than Premiere. */
export const DEFAULT_TRANSITION_DURATION_MS = 300

/**
 * Default fade duration for audio clips (ms).
 *
 * Matches the visual transition default so an audio crossfade and a video
 * crossfade between paired clips share the same overlap window when the user
 * hasn't customised either.
 */
export const DEFAULT_AUDIO_FADE_MS = 500

/**
 * Upper bound on a per-clip audio fade in milliseconds. Used as a slider cap
 * in the inspector. Long fades over this are uncommon in short-form video and
 * cluttering the slider with a 10s range hurts precision near typical values.
 */
export const MAX_AUDIO_FADE_MS = 5000

// ─── Audio Ducking ───────────────────────────────────────────────────────────

/**
 * Per-track auto-ducking configuration.
 *
 * When `enabled`, the track's effective volume drops by `amountDb` whenever any
 * audio clip on a *different* non-muted audio or clip_audio track is playing.
 * The drop ramps in over `attackMs` before each trigger window and ramps back
 * out over `releaseMs` after it. Typical use: enable on the Music track so it
 * automatically quiets under voiceover.
 *
 * Trigger model is implicit (any other audio activity) — there's no concept of
 * a "voice source" track in v1. Two tracks with ducking enabled will each duck
 * against the other; that's intentional and avoids a separate role enum.
 *
 * The values are dB-based so 0 = no change, −6 ≈ half loudness, −12 ≈ quarter,
 * −24 ≈ near-silent. The renderer converts to a linear gain via 10^(dB/20).
 */
export interface AudioDuckingConfig {
  enabled: boolean
  /** dB reduction applied while a trigger clip is active. 0 to −24. */
  amountDb: number
  /** Ramp-down time before each trigger window starts (ms). */
  attackMs: number
  /** Ramp-up time after each trigger window ends (ms). */
  releaseMs: number
}

/** Defaults applied the first time ducking is enabled on a track. */
export const DEFAULT_AUDIO_DUCKING: AudioDuckingConfig = {
  enabled: true,
  amountDb: -12,
  attackMs: 150,
  releaseMs: 300,
}

// ─── Track ───────────────────────────────────────────────────────────────────

/**
 * A timeline track containing an ordered list of clips.
 *
 * Tracks are rendered as horizontal rows in the timeline UI. Each track
 * has a type that determines how its clips are rendered in the Remotion
 * composition (video frames, audio output, or text overlays).
 *
 * Default tracks for a new project (ordered top to bottom):
 *   1. Captions (type: 'caption')   — auto-generated or manual text overlays
 *   2. B-Roll   (type: 'video')     — AI-generated or uploaded video clips
 *   3. Clip Audio (type: 'clip_audio') — audio from B-roll (non-deletable)
 *   4. Voiceover (type: 'audio')    — voiceover audio clips
 *   5. Music    (type: 'audio')    — background music
 *
 * Users can add, rename, reorder, and delete tracks via the timeline UI.
 *
 * @see README.md Section 7.3 "Default Tracks" and "Dynamic Track System"
 */
export interface Track {
  /** Unique track identifier (UUID). */
  id: string

  /**
   * User-visible track label. Editable in the timeline header.
   * Default labels: 'Captions', 'B-Roll', 'Voiceover', 'Music'.
   */
  label: string

  /**
   * Track type determines rendering behavior.
   *   - 'video': clips render as video layers in the composition
   *   - 'audio': clips produce audio output (rendered as waveforms in timeline)
   *   - 'caption': clips render as styled text overlays
   *   - 'clip_audio': clips produce audio from the B-roll video above (non-deletable track)
   */
  type: TrackType

  /** Ordered array of clips on this track. */
  clips: Clip[]

  /** Whether this track's audio output is muted. */
  muted: boolean

  /**
   * Whether this visual track renders in preview/export.
   * Applies to 'video' and 'caption' tracks. Undefined means true for older projects.
   */
  visible?: boolean

  /** Whether this track is locked (prevents edits to its clips). */
  locked: boolean

  /**
   * Display order in the timeline (0 = topmost track).
   * Used for drag-to-reorder via DnD Kit.
   */
  order: number

  /**
   * Auto-ducking configuration. Only meaningful on 'audio' / 'clip_audio'
   * tracks; ignored on 'video' and 'caption'. Undefined means ducking is off.
   * See {@link AudioDuckingConfig} for trigger semantics.
   */
  ducking?: AudioDuckingConfig
}

// ─── Caption Styling ─────────────────────────────────────────────────────────

/**
 * Caption animation type for in/out transitions.
 *
 * @see README.md Section 7.6 "Styling Options" for animation descriptions
 */
export type CaptionAnimation =
  | 'none'
  | 'pop-in'
  | 'fade-in'
  | 'slide-up'
  | 'slide-down'
  | 'slide-left'
  | 'slide-right'

/**
 * Vertical position anchor for captions.
 */
export type CaptionPosition = 'top' | 'center' | 'bottom'

/**
 * Font size preset for captions.
 */
export type CaptionFontSize = 'S' | 'M' | 'L' | 'XL'

/**
 * Global caption style configuration.
 *
 * Applied to all caption clips unless a clip has its own `captionStyle`
 * override. Users configure these settings in the caption styling panel
 * (Phase 3.8 / Phase 4.5).
 *
 * The Remotion composition reads this config to render caption text with
 * the correct font, size, color, position, animation, and effects.
 *
 * @see README.md Section 7.6 "Caption System" for full styling spec
 */
export interface CaptionStyle {
  /** Font family name (e.g. 'Impact', 'Montserrat Bold', 'Roboto'). */
  fontFamily: string

  /** Font size preset. Maps to pixel sizes in the composition renderer. */
  fontSize: CaptionFontSize

  /**
   * Optional custom font size in pixels. When set, overrides the `fontSize`
   * preset at render time. Lets users dial in a size between or beyond the
   * S/M/L/XL steps without expanding the preset union.
   */
  fontSizePx?: number

  /** Primary text color (hex string, e.g. '#FFFFFF'). */
  color: string

  /** Outline/stroke color (hex string). */
  outlineColor: string

  /** Outline width in pixels. 0 = no outline. */
  outlineWidth: number

  /** Vertical position anchor on the canvas. */
  position: CaptionPosition

  /** Fine-tune Y offset from the position anchor, in pixels. */
  yOffset: number

  /**
   * Fine-tune X offset from horizontal center, in pixels.
   * Together with yOffset this enables free drag placement on the canvas
   * while still keeping `position` as the snap-to anchor.
   */
  xOffset?: number

  /** Entry animation for caption appearance. */
  animationIn: CaptionAnimation

  /** Exit animation for caption disappearance. */
  animationOut: CaptionAnimation

  /** Whether to highlight the currently-spoken word (karaoke style). */
  wordHighlight: boolean

  /** Color for the highlighted active word (hex string). */
  wordHighlightColor: string

  /** Drop shadow CSS value (e.g. '2px 2px 4px rgba(0,0,0,0.8)'). Empty = none. */
  dropShadow: string

  /** Background box color (hex + alpha, e.g. 'rgba(0,0,0,0.5)'). Empty = none. */
  backgroundColor: string

  /**
   * Numeric font weight (100–900). When omitted the renderer falls back to a
   * sensible default (400 for display families, 700 for body families) so old
   * projects keep their look. Synthetic weights from the browser are accepted
   * even if the font file doesn't ship them — most short-form caption fonts
   * only carry a single weight, and synthetic bolding is what users expect.
   */
  fontWeight?: number

  /** Italic vs upright. Defaults to 'normal'. */
  fontStyle?: 'normal' | 'italic'

  /**
   * Case transform applied to the rendered text. Lets users force ALL CAPS or
   * Title Case without rewriting the caption text — important for AI-generated
   * captions where re-running the transcription rewrites the words.
   */
  textTransform?: 'none' | 'uppercase' | 'lowercase' | 'capitalize'

  /**
   * Line-height multiplier for wrapped captions. Defaults to ~1.3 — tuned for
   * Inter/Roboto-style sans-serif. Display fonts (Bangers, Luckiest Guy) often
   * read better at 1.1.
   */
  lineHeight?: number

  /**
   * Letter spacing (tracking) in pixels. Negative values tighten the glyphs;
   * positive values open them up. Note: traditional "kerning" is per-pair,
   * but in CSS this is the global letter-spacing knob users actually want.
   */
  letterSpacing?: number
}

/**
 * Default caption style — white Impact text, centered, with black outline.
 * Matches the "Bold Impact" preset commonly seen in YouTube Shorts.
 */
export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  fontFamily: 'Impact',
  fontSize: 'L',
  color: '#FFFFFF',
  outlineColor: '#000000',
  outlineWidth: 3,
  position: 'bottom',
  yOffset: 0,
  xOffset: 0,
  animationIn: 'pop-in',
  animationOut: 'none',
  wordHighlight: true,
  wordHighlightColor: '#FFD700',
  dropShadow: '2px 2px 4px rgba(0,0,0,0.8)',
  backgroundColor: '',
  fontWeight: 700,
  fontStyle: 'normal',
  textTransform: 'none',
  lineHeight: 1.3,
  letterSpacing: 0,
}

// ─── Editor State ────────────────────────────────────────────────────────────

/**
 * Complete editor state shape for the Zustand store.
 *
 * Divided into two categories:
 *   1. Persistent state — serialized to Supabase `projects.editor_state`
 *      (tracks, captionStyle, composition)
 *   2. Transient UI state — only lives in the Zustand store during a session
 *      (playheadPosition, isPlaying, zoomLevel, selectedClipIds, snapEnabled)
 *
 * The store provides `getSerializableState()` to extract only the persistent
 * portion for auto-save, and `loadState()` to hydrate from a saved snapshot.
 *
 * @see PLAN.md Phase 3.3 for Zustand store requirements
 * @see README.md Section 7.3 for timeline state interface spec
 */
export interface EditorState {
  // ── Persistent State (saved to Supabase) ──
  //
  // Transient UI state — selection, playback, tool mode, zoom, drag flags —
  // lives in its own focused stores so per-frame UI updates don't trigger
  // re-renders on consumers that only care about the persisted model:
  //   - selection state → store/selection-store.ts (useSelectionStore)
  //   - playback state  → store/playback-store.ts (usePlaybackStore)
  //   - tool/UI state   → store/ui-store.ts (useUIStore)

  /** Ordered list of timeline tracks (top to bottom). */
  tracks: Track[]

  /** Global caption style applied to all caption clips by default. */
  captionStyle: CaptionStyle

  /** Composition output configuration (dimensions, FPS). */
  composition: CompositionConfig

  /**
   * Global audio volume for all audio tracks (0–1).
   * Applied as a multiplier to every audio clip in the composition.
   */
  globalAudioVolume: number
}

/**
 * IDs of the tabs in the left asset rail.
 *   - my-assets : Browse project assets
 *   - ai-generate : AI generation tools
 *   - upload : Upload media files
 *   - voiceover : Record your own voiceover with the microphone
 *   - captions : Caption generation + global style
 *   - effects : Drag effects onto clips
 *   - transitions : Drag transitions onto clip edges or seams
 *
 * Defined here (and not in AssetPanel.tsx) so it can be stored in the editor
 * store and referenced from anywhere that wants to switch tabs programmatically.
 */
export type AssetTab =
  | 'my-assets'
  | 'upload'
  | 'voiceover'
  | 'captions'
  | 'effects'
  | 'transitions'
  // Host-registered extra tabs (EditorHost.assetPanelExtraTabs) use their own ids.
  | (string & {})

// ─── Serialization Types ─────────────────────────────────────────────────────

/**
 * The subset of EditorState that is persisted to Supabase.
 *
 * Excludes transient UI state (playhead, selections, zoom) that is only
 * relevant during an active editing session.
 */
export interface SerializedEditorState {
  tracks: Track[]
  captionStyle: CaptionStyle
  composition: CompositionConfig
  /** Global audio volume (0–1). Default 1. */
  globalAudioVolume?: number
}

// ─── Default Track Factory ───────────────────────────────────────────────────

/**
 * Create the default set of tracks for a new project.
 *
 * Returns 5 tracks matching the spec default:
 *   1. Captions (caption track, topmost)
 *   2. B-Roll (video track)
 *   3. Clip Audio (clip_audio track, non-deletable)
 *   4. Voiceover (audio track)
 *   5. Music (audio track, bottommost)
 *
 * Each track gets a unique ID generated from crypto.randomUUID().
 *
 * @returns Array of 4 default Track objects
 * @see README.md Section 7.3 "Default Tracks"
 */
export function createDefaultTracks(): Track[] {
  return [
    {
      id: crypto.randomUUID(),
      label: 'Captions',
      type: 'caption',
      clips: [],
      muted: false,
      visible: true,
      locked: false,
      order: 0,
    },
    {
      id: crypto.randomUUID(),
      label: 'B-Roll',
      type: 'video',
      clips: [],
      muted: false,
      visible: true,
      locked: false,
      order: 1,
    },
    {
      id: crypto.randomUUID(),
      label: 'Clip Audio',
      type: 'clip_audio',
      clips: [],
      muted: false,
      locked: false,
      order: 2,
    },
    {
      id: crypto.randomUUID(),
      label: 'Voiceover',
      type: 'audio',
      clips: [],
      muted: false,
      locked: false,
      order: 3,
    },
    {
      id: crypto.randomUUID(),
      label: 'Music',
      type: 'audio',
      clips: [],
      muted: false,
      locked: false,
      order: 4,
    },
  ]
}

// ─── Tool Modes ──────────────────────────────────────────────────────────────

/**
 * Active editing tool mode for the timeline and canvas.
 *
 * The selected tool determines how user interactions are interpreted:
 *   - 'select': Click/drag to select and move clips (default).
 *   - 'slice':  Click on a clip to split it at the click position.
 *     The cursor changes to a blade/razor icon in slice mode.
 *   - 'track-select-forward':  Click anywhere on the timeline to select every
 *     clip on every track that lies at or to the right of the click position
 *     (Premiere's Track Select Forward — shortcut A).
 *   - 'track-select-backward': Same idea but selects everything to the left of
 *     the click position (Premiere's Track Select Backward — shortcut Shift+A).
 *
 * Tool mode is transient UI state — it is not persisted to Supabase.
 * Pressing Escape returns to 'select' mode. Track-select tools stay active
 * across clicks so the user can re-sweep the selection from a different
 * cursor position; switch back via the toolbar, V, or Escape.
 *
 * @see README.md Section 7.3 "Core Behaviors" for clip operations
 * @see PLAN.md Phase 3.2 "Toolbar: Select tool, Slice tool"
 */
export type ToolMode =
  | 'select'
  | 'slice'
  | 'track-select-forward'
  | 'track-select-backward'
  | 'rate-stretch'
  | 'slip'

/**
 * Identifies a transition selected in the timeline for editing in the inspector.
 *
 * Transitions live on clip edges (transitionIn = left, transitionOut = right),
 * so the selection is naturally identified by `(clipId, edge)`. Seam pairing
 * is resolved at edit time — when the user changes a seam transition's type
 * or duration, the store mirrors the change to the paired half automatically.
 */
export interface SelectedTransition {
  clipId: string
  edge: 'in' | 'out'
}

/**
 * Transient state broadcast while the user drags a transition's resize handle.
 *
 * Both halves of a seam transition need to reflect the in-progress duration so
 * the neighbour clip's badge grows/shrinks in lockstep during the drag — not
 * just when the pointer is released. The actively-resizing clip writes this
 * each pointermove; the matched neighbour reads it to render its preview width.
 *
 * `neighbourClipId` is set when the transition sits on a touching seam; it is
 * null for isolated in/out animations (no paired half to update). Not persisted.
 */
export interface LiveTransitionResize {
  clipId: string
  edge: 'in' | 'out'
  neighbourClipId: string | null
  neighbourEdge: 'in' | 'out' | null
  durationMs: number
}

/**
 * Live state broadcast while a clip is being dragged across tracks.
 *
 * The clip's drag is owned by `TimelineClip` (pointer events on the clip
 * itself), which updates its own preview position locally for instant visual
 * feedback. That works fine for horizontal motion inside the source lane, but
 * the clip's DOM stays parented to its source `TrackContent` (which clips with
 * `overflow-hidden`), so a vertical drag into a different track lane has no
 * visual cue. The target lane reads this field and paints a translucent
 * "ghost" of the clip at the live position so the user can see where the
 * pointer release will commit.
 *
 * Only set while the pointer is moving *between* lanes (sourceTrackId !=
 * targetTrackId). Cleared on pointer release/cancel. Not persisted.
 */
export interface LiveClipDrag {
  clipId: string
  sourceTrackId: string
  targetTrackId: string
  /** Left position in pixels relative to the target track content area. */
  leftPx: number
  /** Width of the clip at the current zoom, in pixels. */
  widthPx: number
  /**
   * Resolved Tailwind class string from the source clip (already factors in
   * the image-style override for image clips). The target lane uses this so
   * the ghost matches the dragged clip's color, not the lane's default tape.
   */
  clipClass: string
  /**
   * Resolved Tailwind selected-state class from the source clip. Used as the
   * ghost's accent outline so the colour matches the dragged tape instead of
   * the generic teal `--ring` token.
   */
  clipSelectedClass: string
}

/**
 * Live state broadcast while the Slip tool is dragging a clip's source window.
 *
 * The clip's timeline span never changes during a slip — only `inPoint` /
 * `outPoint` move — so the badge alone wouldn't tell the editor *which frame*
 * they're landing on. `EditorPage` reads this field, applies the delta to the
 * dragged clip (and any linked `clip_audio`) in a derived `displayTracks`, and
 * feeds the result to the Remotion Player so the preview canvas scrubs to the
 * new source frame in real time. Cleared on pointer release/cancel. Not
 * persisted.
 *
 * The delta is already clamped to `[-inPoint, sourceEnd - outPoint]` by the
 * producer — consumers can apply it without re-clamping.
 */
export interface LiveSlip {
  clipId: string
  /**
   * Source-time shift in ms. Positive means later source (inPoint moves
   * forward); negative means earlier source.
   */
  sourceDeltaMs: number
}

/**
 * Lightweight, render-friendly mirror of the in-memory copy buffer. Lives on
 * the UI store so timeline lanes can draw a "this is where Ctrl+V will land"
 * ghost at the playhead without having to subscribe to the (intentionally
 * non-reactive) clipboard buffer in the editor store.
 *
 * One entry per primary clip in the buffer (clip_audio peers are not preview-
 * ghosted — they shadow their video parent). `offsetMs` is relative to
 * `baselineMs` so the consumer can compute each ghost's left as
 * `(playhead + offsetMs) * pxPerMs`.
 */
export interface ClipboardPreview {
  /** Earliest startTime among the copied primary clips at the time of copy. */
  baselineMs: number
  entries: ReadonlyArray<{
    /** Original track type — determines which lanes will paint the ghost. */
    sourceTrackType: TrackType
    /** `clip.startTime - baselineMs` from the source clip. */
    offsetMs: number
    /** `clip.duration` — the ghost's width on the timeline. */
    durationMs: number
  }>
}

// ─── Utility Types ───────────────────────────────────────────────────────────

/**
 * Trim edge identifier for clip trimming operations.
 * 'start' = left edge (adjusts inPoint), 'end' = right edge (adjusts outPoint).
 */
export type TrimEdge = 'start' | 'end'

/**
 * Undo/redo action entry stored in the history stack.
 *
 * Each action captures a snapshot of the persistent state before the action
 * was applied. The undo stack grows on every mutating action, and the redo
 * stack is populated when undo is invoked.
 *
 * @see PLAN.md Phase 3.3 "undo, redo (maintain action history stack)"
 */
export interface HistoryEntry {
  /** Human-readable description of the action (for debugging). */
  label: string

  /** Snapshot of the persistent state before the action. */
  state: SerializedEditorState
}
