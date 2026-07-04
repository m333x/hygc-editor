/**
 * Animatable property registry — the Open/Closed seam for keyframable values.
 *
 * Each entry describes one property that the user can keyframe: how to read
 * its static baseline from a clip, how to write a resolved value back into a
 * clip, and what range it lives in. The interpolator and Inspector read from
 * this registry by id — adding a new property (e.g. crop sides, audio gain,
 * caption color) means adding an entry here plus an Inspector control, with
 * zero changes to the render path.
 *
 * v1 covers the five `transform.*` scalar properties that account for the
 * vast majority of NLE animation needs (position, scale, rotation, opacity).
 *
 * SOLID: OCP — engine and UI close over the abstract `AnimatableProperty`
 *   shape; concrete entries plug in here without changing those consumers.
 */

import type { AnimatablePropertyId, CaptionStyle, Clip, ClipTransform } from '../types'
import { DEFAULT_CAPTION_STYLE } from '../types'

export interface AnimatableProperty {
  /** Stable id used in `KeyframeTrack.propertyId` and store action arguments. */
  id: AnimatablePropertyId

  /** Human-readable label for the Inspector ("Position X", "Scale", ...). */
  label: string

  /** Reads the static baseline value from a clip. */
  read: (clip: Clip) => number

  /**
   * Returns a new clip with the value written back into the appropriate field.
   * Used when keyframing is OFF (writes to baseline) and when capturing the
   * current value as the first keyframe on stopwatch enable.
   */
  write: (clip: Clip, value: number) => Clip

  /** The value used when the property is reset to default. */
  defaultValue: number

  /** Inclusive lower bound (omit for unbounded). */
  min?: number

  /** Inclusive upper bound (omit for unbounded). */
  max?: number
}

function withTransform(clip: Clip, patch: Partial<ClipTransform>): Clip {
  return { ...clip, transform: { ...clip.transform, ...patch } }
}

/**
 * Merge a patch into a clip's `captionStyle`, creating a per-clip override if
 * one didn't already exist. The override is seeded from the existing override
 * (if any) or from `DEFAULT_CAPTION_STYLE` so we never write a half-formed
 * style object — the renderer always sees every field populated.
 */
function withCaptionStyle(clip: Clip, patch: Partial<CaptionStyle>): Clip {
  const base = clip.captionStyle ?? DEFAULT_CAPTION_STYLE
  return { ...clip, captionStyle: { ...base, ...patch } }
}

/**
 * Initial caption font size used when seeding a `caption.fontSizePx` keyframe
 * on a clip that's still using the preset font-size token. Matches the
 * "Medium" preset in `FONT_SIZE_MAP` (ShortComposition).
 */
const CAPTION_DEFAULT_FONT_SIZE_PX = 48

export const ANIMATABLE_PROPERTIES: Record<AnimatablePropertyId, AnimatableProperty> = {
  'transform.x': {
    id: 'transform.x',
    label: 'Position X',
    read: (clip) => clip.transform.x,
    write: (clip, value) => withTransform(clip, { x: value }),
    defaultValue: 0,
    min: -2000,
    max: 2000,
  },
  'transform.y': {
    id: 'transform.y',
    label: 'Position Y',
    read: (clip) => clip.transform.y,
    write: (clip, value) => withTransform(clip, { y: value }),
    defaultValue: 0,
    min: -2000,
    max: 2000,
  },
  'transform.scale': {
    id: 'transform.scale',
    label: 'Scale',
    read: (clip) => clip.transform.scale,
    write: (clip, value) => withTransform(clip, { scale: value }),
    defaultValue: 1,
    min: 0.1,
    max: 4,
  },
  'transform.rotation': {
    id: 'transform.rotation',
    label: 'Rotation',
    read: (clip) => clip.transform.rotation,
    write: (clip, value) => withTransform(clip, { rotation: value }),
    defaultValue: 0,
    min: -360,
    max: 360,
  },
  'transform.opacity': {
    id: 'transform.opacity',
    label: 'Opacity',
    read: (clip) => clip.transform.opacity ?? 1,
    write: (clip, value) => withTransform(clip, { opacity: Math.max(0, Math.min(1, value)) }),
    defaultValue: 1,
    min: 0,
    max: 1,
  },
  'caption.fontSizePx': {
    id: 'caption.fontSizePx',
    label: 'Font size',
    read: (clip) =>
      clip.captionStyle?.fontSizePx ??
      DEFAULT_CAPTION_STYLE.fontSizePx ??
      CAPTION_DEFAULT_FONT_SIZE_PX,
    write: (clip, value) => withCaptionStyle(clip, { fontSizePx: Math.max(12, Math.round(value)) }),
    defaultValue: CAPTION_DEFAULT_FONT_SIZE_PX,
    min: 12,
    max: 280,
  },
  'caption.xOffset': {
    id: 'caption.xOffset',
    label: 'Caption X',
    read: (clip) => clip.captionStyle?.xOffset ?? DEFAULT_CAPTION_STYLE.xOffset ?? 0,
    write: (clip, value) => withCaptionStyle(clip, { xOffset: Math.round(value) }),
    defaultValue: 0,
    min: -540,
    max: 540,
  },
  'caption.yOffset': {
    id: 'caption.yOffset',
    label: 'Caption Y',
    read: (clip) => clip.captionStyle?.yOffset ?? DEFAULT_CAPTION_STYLE.yOffset ?? 0,
    write: (clip, value) => withCaptionStyle(clip, { yOffset: Math.round(value) }),
    defaultValue: 0,
    min: -960,
    max: 960,
  },
}

/** Ordered list of property ids, matching Inspector display order. */
export const ANIMATABLE_PROPERTY_IDS: readonly AnimatablePropertyId[] = [
  'transform.scale',
  'transform.x',
  'transform.y',
  'transform.rotation',
  'transform.opacity',
  'caption.fontSizePx',
  'caption.xOffset',
  'caption.yOffset',
]

/**
 * Property IDs available for keyframing a clip of a given track type. Caption
 * clips don't render via the transform pipeline, so the transform.* family is
 * a no-op there; conversely, video/image clips don't use captionStyle.
 *
 * Returned in display order — first entry is the "most useful" default.
 */
export function getAnimatablePropertiesForTrackType(
  trackType: 'video' | 'caption' | 'audio' | 'clip_audio',
): ReadonlyArray<AnimatablePropertyId> {
  if (trackType === 'caption') {
    return ['caption.fontSizePx', 'caption.xOffset', 'caption.yOffset']
  }
  if (trackType === 'video') {
    return [
      'transform.scale',
      'transform.x',
      'transform.y',
      'transform.rotation',
      'transform.opacity',
    ]
  }
  // Audio tracks don't have visual properties.
  return []
}

export function getAnimatableProperty(id: AnimatablePropertyId): AnimatableProperty {
  return ANIMATABLE_PROPERTIES[id]
}
