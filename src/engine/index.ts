/**
 * Editor Engine barrel export.
 *
 * Re-exports the Remotion composition and utility functions used by the
 * editor's preview canvas and future server-side export pipeline.
 *
 * @see PLAN.md Phase 3.1 for Remotion setup requirements
 */

export { ShortComposition } from './ShortComposition'
export type { ShortCompositionProps, AssetUrlMap, AssetTypeMap } from './ShortComposition'

export {
  frameToMs,
  msToFrame,
  msToDurationInFrames,
  isClipActiveAtTime,
  getActiveClips,
  getClipSourceTime,
  buildCssTransform,
  buildCropClipPath,
  computeCompositionDuration,
  findClipById,
  getSnapPoints,
} from './composition-utils'

export {
  TRANSITION_PRESETS,
  TRANSITION_DRAG_MIME_TYPE,
  getTransitionPreset,
  computeTransitionEffect,
  buildTransitionTransform,
} from './transitions'
export type {
  TransitionPreset,
  TransitionEffect,
  DraggedTransitionPayload,
} from './transitions'

export {
  ANIMATABLE_PROPERTIES,
  ANIMATABLE_PROPERTY_IDS,
  getAnimatableProperty,
} from './animatable-properties'
export type { AnimatableProperty } from './animatable-properties'

export {
  resolveKeyframedValue,
  resolveAnimatedTransform,
} from './keyframe-interpolator'
