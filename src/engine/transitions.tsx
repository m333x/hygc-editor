/**
 * Transitions — registry + animation math for per-clip in/out transitions.
 *
 * Two responsibilities live here:
 *
 *   1. `TRANSITION_PRESETS` — the user-facing list shown in the AssetPanel's
 *      Transitions tab. Each preset is the name shown to the user, the
 *      `TransitionType` enum value, and a small SVG icon that hints at the
 *      motion (slide arrow, fade gradient, spin curve, etc.).
 *
 *   2. `computeTransitionEffect` — pure animation math used inside the
 *      Remotion composition. Given a current frame within a clip's sequence,
 *      the clip's in/out transition configs, and the available durations,
 *      returns the visual delta (opacity / scale / translate / blur / clip-path)
 *      to apply to the clip wrapper for that frame.
 *
 * The split keeps the editor's panel-side code free of Remotion imports
 * (`spring`, `interpolate`) and the composition-side code free of icon JSX.
 *
 * SOLID: SRP — registry vs runtime math, no UI state.
 *
 * @see types.ts `TransitionType` for the enum and `ClipTransition` shape
 * @see ShortComposition.tsx for how the math is applied to clip wrappers
 * @see TransitionsPanel.tsx for the consumer of TRANSITION_PRESETS
 */

import type { ReactNode } from 'react'
import { interpolate, spring } from 'remotion'
import { DEFAULT_MOTION_BLUR_STRENGTH } from '../types'
import type { ClipTransition, TransitionDirection, TransitionType } from '../types'

// ─── Directional transitions ───────────────────────────────────────────────

/**
 * Transition types whose visual reads differently depending on a direction
 * vector. The Inspector shows a 4-arrow picker only for these types.
 */
export const DIRECTIONAL_TRANSITION_TYPES: ReadonlySet<TransitionType> = new Set([
  'slide',
  'pan',
  'wipe',
])

export function isDirectionalTransition(type: TransitionType): boolean {
  return DIRECTIONAL_TRANSITION_TYPES.has(type)
}

/**
 * Default direction per type, used when a transition has no explicit
 * direction set. Picked so behaviour matches what these transitions did
 * before direction was a first-class field.
 *   - slide: rightward push (legacy "comes from left")
 *   - pan:   leftward push (legacy "comes from right")
 *   - wipe:  rightward reveal (legacy "reveal from left edge")
 */
const DEFAULT_DIRECTION_FOR_TYPE: Partial<Record<TransitionType, TransitionDirection>> = {
  slide: 'right',
  pan: 'left',
  wipe: 'right',
}

export function getDefaultDirection(type: TransitionType): TransitionDirection {
  return DEFAULT_DIRECTION_FOR_TYPE[type] ?? 'right'
}

function resolveDirection(transition: ClipTransition): TransitionDirection {
  return transition.direction ?? getDefaultDirection(transition.type)
}

// ─── MIME type for drag-and-drop ────────────────────────────────────────────

/**
 * MIME type used to encode transition payloads in HTML5 drag-and-drop transfers.
 *
 * Mirrors `ASSET_DRAG_MIME_TYPE` from AssetBrowser: a separate type prevents
 * the timeline from misinterpreting a transition drag as an asset drag.
 */
export const TRANSITION_DRAG_MIME_TYPE = 'application/hygc-transition'

/**
 * Payload shape transferred when a transition tile is dragged from the
 * Transitions panel onto the timeline.
 */
export interface DraggedTransitionPayload {
  type: TransitionType
  durationMs: number
}

// ─── Registry ───────────────────────────────────────────────────────────────

export interface TransitionPreset {
  /** Discriminator used everywhere else (store, render, drop payload). */
  type: TransitionType
  /** Display label shown under the tile. */
  label: string
  /** Default duration when this preset is dropped onto a clip. */
  defaultDurationMs: number
  /** SVG icon for the palette tile (rendered at ~44px square). */
  icon: ReactNode
}

/**
 * Inline SVG icons for each transition. Each one has a unique silhouette so
 * tiles are scannable at a glance — no shared frame-target glyph, no
 * variations of the same outline-square. Stroke-based, ~28px, balanced for
 * the 64px panel tile.
 */

const STROKE_W = 1.6

function SlideIcon() {
  return (
    <svg viewBox="0 0 32 32" width={28} height={28} fill="none" stroke="currentColor" strokeWidth={STROKE_W} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 11 L11 16 L5 21" />
      <path d="M13 11 L19 16 L13 21" />
      <path d="M25 8 L25 24" />
    </svg>
  )
}

function PanIcon() {
  return (
    <svg viewBox="0 0 32 32" width={28} height={28} fill="none" stroke="currentColor" strokeWidth={STROKE_W} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="10" y="11" width="12" height="10" rx="1.4" fill="currentColor" fillOpacity="0.15" />
      <path d="M7 16 L2 16 M5 13 L2 16 L5 19" />
      <path d="M25 16 L30 16 M27 13 L30 16 L27 19" />
    </svg>
  )
}

function FadeIcon() {
  return (
    <svg viewBox="0 0 32 32" width={28} height={28} fill="none" stroke="currentColor" strokeWidth={STROKE_W} aria-hidden>
      <circle cx="16" cy="16" r="10" />
      <path d="M16 6 A 10 10 0 0 1 16 26 Z" fill="currentColor" stroke="none" />
    </svg>
  )
}

function BlurIcon() {
  return (
    <svg viewBox="0 0 32 32" width={28} height={28} fill="none" stroke="currentColor" strokeLinecap="round" aria-hidden>
      <circle cx="16" cy="16" r="11" strokeWidth={1.3} strokeDasharray="2 2.5" opacity="0.45" />
      <circle cx="16" cy="16" r="7" strokeWidth={1.4} strokeDasharray="2 2" opacity="0.75" />
      <circle cx="16" cy="16" r="2.5" fill="currentColor" stroke="none" />
    </svg>
  )
}

function GrowIcon() {
  return (
    <svg viewBox="0 0 32 32" width={28} height={28} fill="none" stroke="currentColor" strokeWidth={STROKE_W} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="12" y="12" width="8" height="8" rx="1.2" fill="currentColor" fillOpacity="0.7" stroke="none" />
      <path d="M4 10 L4 4 L10 4" />
      <path d="M28 10 L28 4 L22 4" />
      <path d="M4 22 L4 28 L10 28" />
      <path d="M28 22 L28 28 L22 28" />
    </svg>
  )
}

function ZoomIcon() {
  return (
    <svg viewBox="0 0 32 32" width={28} height={28} fill="none" stroke="currentColor" strokeWidth={STROKE_W} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="13" cy="13" r="7.5" />
      <path d="M19 19 L26 26" />
      <path d="M9 13 L17 13 M13 9 L13 17" />
    </svg>
  )
}

function PopIcon() {
  return (
    <svg viewBox="0 0 32 32" width={28} height={28} fill="currentColor" aria-hidden>
      <path d="M16 3 L18.2 13.8 L29 16 L18.2 18.2 L16 29 L13.8 18.2 L3 16 L13.8 13.8 Z" />
    </svg>
  )
}

function WipeIcon() {
  return (
    <svg viewBox="0 0 32 32" width={28} height={28} fill="none" stroke="currentColor" strokeWidth={STROKE_W} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4" y="8" width="24" height="16" rx="1.8" />
      <path d="M4 8 L16 8 L16 24 L4 24 Z" fill="currentColor" stroke="none" />
      <path d="M20 16 L25 16 M22.5 13.5 L25 16 L22.5 18.5" />
    </svg>
  )
}

function BaselineIcon() {
  return (
    <svg viewBox="0 0 32 32" width={28} height={28} fill="none" stroke="currentColor" strokeWidth={STROKE_W} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 26 L29 26" />
      <path d="M16 22 L16 7" />
      <path d="M10 13 L16 7 L22 13" />
    </svg>
  )
}

function CropZoomIcon() {
  return (
    <svg viewBox="0 0 32 32" width={28} height={28} fill="none" stroke="currentColor" strokeWidth={STROKE_W} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 11 L5 5 L11 5" />
      <path d="M27 11 L27 5 L21 5" />
      <path d="M5 21 L5 27 L11 27" />
      <path d="M27 21 L27 27 L21 27" />
      <rect x="11" y="11" width="10" height="10" rx="1.2" fill="currentColor" fillOpacity="0.7" stroke="none" />
    </svg>
  )
}

function SpinIcon() {
  return (
    <svg viewBox="0 0 32 32" width={28} height={28} fill="none" stroke="currentColor" strokeWidth={STROKE_W} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M26 16 A 10 10 0 1 1 16 6" />
      <path d="M16 2 L20 6 L16 10" />
    </svg>
  )
}

/**
 * Ordered list of presets shown in the panel.
 *
 * The 'none' / clear-transition action is intentionally NOT in this list —
 * clearing a transition is a per-clip affordance (timeline badge), not a
 * picker tile. The `'none'` TransitionType still exists for drop-handler
 * semantics and for older saved projects.
 */
export const TRANSITION_PRESETS: TransitionPreset[] = [
  { type: 'fade', label: 'Fade', defaultDurationMs: 280, icon: <FadeIcon /> },
  { type: 'slide', label: 'Slide', defaultDurationMs: 300, icon: <SlideIcon /> },
  { type: 'zoom', label: 'Zoom', defaultDurationMs: 360, icon: <ZoomIcon /> },
  { type: 'pan', label: 'Pan', defaultDurationMs: 360, icon: <PanIcon /> },
  { type: 'wipe', label: 'Wipe', defaultDurationMs: 300, icon: <WipeIcon /> },
  { type: 'blur', label: 'Blur', defaultDurationMs: 280, icon: <BlurIcon /> },
  { type: 'pop', label: 'Pop', defaultDurationMs: 300, icon: <PopIcon /> },
  { type: 'grow', label: 'Grow', defaultDurationMs: 360, icon: <GrowIcon /> },
  { type: 'crop-zoom', label: 'Crop Zoom', defaultDurationMs: 380, icon: <CropZoomIcon /> },
  { type: 'spin', label: 'Spin', defaultDurationMs: 400, icon: <SpinIcon /> },
  { type: 'baseline', label: 'Baseline', defaultDurationMs: 300, icon: <BaselineIcon /> },
]

/** Lookup helper used in the InspectorPanel and the timeline badge labels. */
export function getTransitionPreset(type: TransitionType): TransitionPreset | undefined {
  return TRANSITION_PRESETS.find((p) => p.type === type)
}

// ─── Animation Math ─────────────────────────────────────────────────────────

/**
 * Visual delta produced by a transition at a given frame.
 *
 * Returned values are *combined* (additive for translate, multiplicative for
 * scale/opacity) by the composition wrapper before applying CSS.
 */
export interface TransitionEffect {
  opacity: number
  scale: number
  translateX: number
  translateY: number
  rotate: number
  /** Uniform gaussian blur — used by the 'blur' transition. */
  blurPx: number
  /**
   * Directional motion blur, horizontal component (px). Implemented in the
   * composition via an SVG `feGaussianBlur` with `stdDeviation="X Y"`, which
   * (unlike CSS `filter: blur()`) accepts asymmetric values — so X-only blur
   * smears horizontally without softening vertical edges.
   */
  motionBlurX: number
  /** Directional motion blur, vertical component (px). */
  motionBlurY: number
  /** Optional clip-path (e.g. wipe reveal). Undefined = no clip-path. */
  clipPath?: string
}

const IDENTITY_EFFECT: TransitionEffect = {
  opacity: 1,
  scale: 1,
  translateX: 0,
  translateY: 0,
  rotate: 0,
  blurPx: 0,
  motionBlurX: 0,
  motionBlurY: 0,
}

/**
 * Per-axis offset for a direction. Positive values translate right/down,
 * negative values translate left/up. Used by both the IN-side helper (where
 * we want the clip to start off-screen in the opposite direction of its
 * motion vector) and the OUT-side helper (where we want the clip to exit
 * in the direction of motion).
 */
function offsetForDirection(
  direction: TransitionDirection,
  distance: number,
): { x: number; y: number } {
  switch (direction) {
    case 'left':  return { x: distance, y: 0 }
    case 'right': return { x: -distance, y: 0 }
    case 'up':    return { x: 0, y: distance }
    case 'down':  return { x: 0, y: -distance }
  }
}

/**
 * `clip-path: inset(top right bottom left)` is the reveal of the underlying
 * content; setting one side to 100% hides everything on that side. For wipe
 * IN we want the inset to start at 100% on the side OPPOSITE the motion
 * vector and ramp to 0 (fully revealed), so the visible edge sweeps in the
 * direction of motion.
 *
 * For wipe OUT we mirror this on the OPPOSITE edge of the canvas. If a wipe
 * IN reveals leftward-to-rightward, the wipe OUT of the previous clip must
 * also vacate leftward-to-rightward — i.e. its visible region shrinks from
 * the left, retaining the right side longest — so the two clips share one
 * travelling boundary at the seam. (Hiding from the same edge as the IN
 * reveal would mean both clips eat into the same side, exposing the canvas
 * behind them through the other half.)
 */
function oppositeWipeDirection(direction: TransitionDirection): TransitionDirection {
  switch (direction) {
    case 'left':  return 'right'
    case 'right': return 'left'
    case 'up':    return 'down'
    case 'down':  return 'up'
  }
}

function wipeInsetForDirection(
  direction: TransitionDirection,
  p: number,
  inverted: boolean,
): string {
  // `extent` is the inset depth on the relevant side. For IN we go from 100%
  // (hidden) → 0% (revealed); for OUT we go the other way.
  const extent = Math.max(0, (inverted ? p : 1 - p) * 100)
  // OUT vacates from the edge OPPOSITE the motion vector so it meets the
  // incoming clip's reveal at a single moving boundary.
  const side = inverted ? oppositeWipeDirection(direction) : direction
  switch (side) {
    // Reveal/vacate from the right edge.
    case 'left':  return `inset(0 0 0 ${extent}%)`
    // Reveal/vacate from the left edge.
    case 'right': return `inset(0 ${extent}% 0 0)`
    // Reveal/vacate from the bottom edge.
    case 'up':    return `inset(${extent}% 0 0 0)`
    // Reveal/vacate from the top edge.
    case 'down':  return `inset(0 0 ${extent}% 0)`
  }
}

/**
 * Compute the IN-edge animation contribution at the given progress (0→1).
 *
 * `progress = 0` is the very first frame of the clip; `progress = 1` is the
 * frame at which the transition finishes. Outside [0, 1] the wrapper should
 * treat the clip as fully resolved (identity).
 */
function computeInEffect(
  type: TransitionType,
  p: number,
  direction: TransitionDirection,
): TransitionEffect {
  // Motion blur stays near peak while the clip is moving (constant-velocity
  // interp ⇒ should look constantly blurred), then ramps to 0 over the final
  // ~25% as the clip settles. Plateau-then-decay reads as motion blur; a soft
  // exponential decay reads as the clip being out of focus.
  const motionBlur = (peakPx: number) => Math.min(1, (1 - p) * 4) * peakPx
  const isHorizontal = direction === 'left' || direction === 'right'
  switch (type) {
    case 'slide': {
      // Slide in from off-screen along the motion axis: start fully off-screen
      // on the OPPOSITE side of the motion vector, glide to centre. No opacity
      // ramp — the clip is offscreen at p=0 so a fade would only be visible
      // mid-motion, making a seam look like "A → black → B" instead of a clean
      // push.
      const { x, y } = offsetForDirection(direction, 1080)
      return {
        ...IDENTITY_EFFECT,
        translateX: (1 - p) * x,
        translateY: (1 - p) * y,
        motionBlurX: isHorizontal ? motionBlur(18) : 0,
        motionBlurY: isHorizontal ? 0 : motionBlur(18),
      }
    }
    case 'pan': {
      // Same geometry as slide for now — kept distinct so we can tune them
      // independently later. Full-canvas translate so it pushes cleanly at
      // a seam.
      const { x, y } = offsetForDirection(direction, 1080)
      return {
        ...IDENTITY_EFFECT,
        translateX: (1 - p) * x,
        translateY: (1 - p) * y,
        motionBlurX: isHorizontal ? motionBlur(14) : 0,
        motionBlurY: isHorizontal ? 0 : motionBlur(14),
      }
    }
    case 'fade':
      return { ...IDENTITY_EFFECT, opacity: p }
    case 'blur':
      return { ...IDENTITY_EFFECT, blurPx: (1 - p) * 22, opacity: Math.min(1, p * 1.4) }
    case 'grow':
      return {
        ...IDENTITY_EFFECT,
        scale: 0.4 + p * 0.6,
        motionBlurX: motionBlur(12),
        motionBlurY: motionBlur(12),
      }
    case 'zoom':
      return {
        ...IDENTITY_EFFECT,
        scale: 0.7 + p * 0.3,
        motionBlurX: motionBlur(8),
        motionBlurY: motionBlur(8),
      }
    case 'pop':
      // Pop uses a separate spring path — fallback values here are only used
      // for the linear progress callers (the composition prefers `computeInEffectSpring`).
      return {
        ...IDENTITY_EFFECT,
        scale: 0.6 + p * 0.4,
        motionBlurX: motionBlur(8),
        motionBlurY: motionBlur(8),
      }
    case 'wipe':
      // Reveal expands from the edge opposite the motion vector.
      return {
        ...IDENTITY_EFFECT,
        clipPath: wipeInsetForDirection(direction, p, false),
      }
    case 'baseline':
      // Subtle rise from below + scale.
      return {
        ...IDENTITY_EFFECT,
        translateY: (1 - p) * 80,
        scale: 0.9 + p * 0.1,
        motionBlurY: motionBlur(8),
      }
    case 'crop-zoom':
      // Shrink-in: starts oversized + cropped, settles to natural frame.
      return {
        ...IDENTITY_EFFECT,
        scale: 1.25 - p * 0.25,
        clipPath: `inset(${(1 - p) * 18}% ${(1 - p) * 18}% ${(1 - p) * 18}% ${(1 - p) * 18}%)`,
        motionBlurX: motionBlur(8),
        motionBlurY: motionBlur(8),
      }
    case 'spin':
      return {
        ...IDENTITY_EFFECT,
        rotate: (1 - p) * 270,
        scale: 0.6 + p * 0.4,
        motionBlurX: motionBlur(14),
        motionBlurY: motionBlur(14),
      }
    case 'none':
    default:
      return IDENTITY_EFFECT
  }
}

/**
 * OUT-edge counterpart of {@link computeInEffect}.
 *
 * `progress = 0` is the frame at which the out animation begins;
 * `progress = 1` is the last frame of the clip.
 */
function computeOutEffect(
  type: TransitionType,
  p: number,
  direction: TransitionDirection,
): TransitionEffect {
  // Mirror of IN: short ramp-in over the first ~25%, then plateau at peak for
  // the rest of the exit. The clip stays sharp until it actually starts
  // moving, then is blurred for the full duration of the motion.
  const motionBlur = (peakPx: number) => Math.min(1, p * 4) * peakPx
  const isHorizontal = direction === 'left' || direction === 'right'
  switch (type) {
    case 'slide': {
      // Exit fully off-screen in the direction of motion. Negate the IN
      // offset so OUT moves the opposite way along the same axis.
      const { x, y } = offsetForDirection(direction, 1080)
      return {
        ...IDENTITY_EFFECT,
        translateX: -p * x,
        translateY: -p * y,
        motionBlurX: isHorizontal ? motionBlur(18) : 0,
        motionBlurY: isHorizontal ? 0 : motionBlur(18),
      }
    }
    case 'pan': {
      const { x, y } = offsetForDirection(direction, 1080)
      return {
        ...IDENTITY_EFFECT,
        translateX: -p * x,
        translateY: -p * y,
        motionBlurX: isHorizontal ? motionBlur(14) : 0,
        motionBlurY: isHorizontal ? 0 : motionBlur(14),
      }
    }
    case 'fade':
      return { ...IDENTITY_EFFECT, opacity: 1 - p }
    case 'blur':
      return { ...IDENTITY_EFFECT, blurPx: p * 22, opacity: Math.max(0, 1 - p * 1.4) }
    case 'grow':
      return {
        ...IDENTITY_EFFECT,
        scale: 1 - p * 0.4,
        motionBlurX: motionBlur(12),
        motionBlurY: motionBlur(12),
      }
    case 'zoom':
      return {
        ...IDENTITY_EFFECT,
        scale: 1 + p * 0.3,
        motionBlurX: motionBlur(8),
        motionBlurY: motionBlur(8),
      }
    case 'pop':
      return {
        ...IDENTITY_EFFECT,
        scale: 1 - p * 0.4,
        motionBlurX: motionBlur(8),
        motionBlurY: motionBlur(8),
      }
    case 'wipe':
      return {
        ...IDENTITY_EFFECT,
        clipPath: wipeInsetForDirection(direction, p, true),
      }
    case 'baseline':
      return {
        ...IDENTITY_EFFECT,
        translateY: p * -80,
        scale: 1 - p * 0.1,
        motionBlurY: motionBlur(8),
      }
    case 'crop-zoom':
      return {
        ...IDENTITY_EFFECT,
        scale: 1 + p * 0.25,
        clipPath: `inset(${p * 18}% ${p * 18}% ${p * 18}% ${p * 18}%)`,
        motionBlurX: motionBlur(8),
        motionBlurY: motionBlur(8),
      }
    case 'spin':
      return {
        ...IDENTITY_EFFECT,
        rotate: p * -270,
        scale: 1 - p * 0.4,
        motionBlurX: motionBlur(14),
        motionBlurY: motionBlur(14),
      }
    case 'none':
    default:
      return IDENTITY_EFFECT
  }
}

/**
 * Scale only the motion-blur components of an effect by a user-controlled
 * strength (0 = off, 1 = preset default, >1 = exaggerated). The uniform
 * `blurPx` of the 'blur' transition is intentionally NOT scaled — that's the
 * primary visual of that transition, not a "motion smear" layer.
 */
function scaleMotionBlur(effect: TransitionEffect, strength: number | undefined): TransitionEffect {
  const s = strength ?? DEFAULT_MOTION_BLUR_STRENGTH
  if (s === 1) return effect
  if (effect.motionBlurX === 0 && effect.motionBlurY === 0) return effect
  return {
    ...effect,
    motionBlurX: effect.motionBlurX * s,
    motionBlurY: effect.motionBlurY * s,
  }
}

function multiplyEffects(a: TransitionEffect, b: TransitionEffect): TransitionEffect {
  return {
    opacity: a.opacity * b.opacity,
    scale: a.scale * b.scale,
    translateX: a.translateX + b.translateX,
    translateY: a.translateY + b.translateY,
    rotate: a.rotate + b.rotate,
    blurPx: a.blurPx + b.blurPx,
    motionBlurX: a.motionBlurX + b.motionBlurX,
    motionBlurY: a.motionBlurY + b.motionBlurY,
    clipPath: b.clipPath ?? a.clipPath,
  }
}

interface ComputeArgs {
  /** Sequence-relative frame (0 at clip start). */
  frame: number
  /** Frames per second of the composition. */
  fps: number
  /** Total frames in the clip's sequence. */
  totalFrames: number
  transitionIn?: ClipTransition
  transitionOut?: ClipTransition
  /**
   * When true, the out animation's opacity and blur contributions are pinned
   * to identity (1.0 / 0px) so this clip stays fully visible while the next
   * clip's transitionIn fades in on top of it. Geometric components
   * (translate / scale / rotate / clipPath) still animate. Used for the LEFT
   * side of a paired seam transition so the cross-dissolve compositing is
   * `B*α + A*(1-α)` instead of both halves dipping to ~0.5 alpha and exposing
   * the black canvas behind them.
   */
  suppressOutAlpha?: boolean
}

/**
 * Compute the combined transition effect for a clip at the given frame.
 *
 * Combines the in and out animations so an extremely short clip whose
 * in-and-out transition durations overlap still renders without one branch
 * clobbering the other.
 *
 * Handles the spring-based 'pop' transition by short-circuiting to a Remotion
 * `spring()` curve when that type is the active in/out edge.
 */
export function computeTransitionEffect({
  frame,
  fps,
  totalFrames,
  transitionIn,
  transitionOut,
  suppressOutAlpha = false,
}: ComputeArgs): TransitionEffect {
  let result: TransitionEffect = IDENTITY_EFFECT

  // ── In edge ──
  if (transitionIn && transitionIn.type !== 'none' && transitionIn.durationMs > 0) {
    const inFrames = Math.max(1, Math.min(totalFrames, Math.round((transitionIn.durationMs / 1000) * fps)))
    if (frame < inFrames) {
      let progress: number
      if (transitionIn.type === 'pop') {
        progress = spring({ frame, fps, durationInFrames: inFrames, config: { damping: 12, stiffness: 180, mass: 0.6 } })
      } else {
        progress = interpolate(frame, [0, inFrames], [0, 1], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        })
      }
      const inEffectRaw = computeInEffect(transitionIn.type, progress, resolveDirection(transitionIn))
      const inEffect = scaleMotionBlur(inEffectRaw, transitionIn.motionBlurStrength)
      result = multiplyEffects(result, inEffect)
    }
  }

  // ── Out edge ──
  if (transitionOut && transitionOut.type !== 'none' && transitionOut.durationMs > 0) {
    const outFrames = Math.max(1, Math.min(totalFrames, Math.round((transitionOut.durationMs / 1000) * fps)))
    const outStart = Math.max(0, totalFrames - outFrames)
    if (frame >= outStart) {
      const localFrame = frame - outStart
      let progress: number
      if (transitionOut.type === 'pop') {
        // Reverse spring: 1 - spring across the window.
        const s = spring({ frame: localFrame, fps, durationInFrames: outFrames, config: { damping: 12, stiffness: 180, mass: 0.6 } })
        progress = s
      } else {
        progress = interpolate(localFrame, [0, outFrames], [0, 1], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        })
      }
      const outEffectRaw = computeOutEffect(transitionOut.type, progress, resolveDirection(transitionOut))
      const outEffect = scaleMotionBlur(outEffectRaw, transitionOut.motionBlurStrength)
      // Seam left-side: keep this clip fully visible during the cross-fade so
      // the next clip's transitionIn alone drives the dissolve. Geometric
      // motion stays so slide/zoom/wipe still show the leaving clip moving.
      // motionBlurX/Y is intentionally NOT suppressed — both clips should
      // share the directional blur during a motion seam so the push reads as
      // one continuous blurred swipe instead of one sharp clip sliding under
      // a blurry one.
      const effectiveOut: TransitionEffect = suppressOutAlpha
        ? { ...outEffect, opacity: 1, blurPx: 0 }
        : outEffect
      result = multiplyEffects(result, effectiveOut)
    }
  }

  return result
}

/**
 * Build a CSS transform string from a {@link TransitionEffect}.
 *
 * Composed in a fixed order so consecutive effects layer predictably:
 *   translate → rotate → scale
 */
export function buildTransitionTransform(effect: TransitionEffect): string {
  const parts: string[] = []
  if (effect.translateX !== 0 || effect.translateY !== 0) {
    parts.push(`translate(${effect.translateX}px, ${effect.translateY}px)`)
  }
  if (effect.rotate !== 0) {
    parts.push(`rotate(${effect.rotate}deg)`)
  }
  if (effect.scale !== 1) {
    parts.push(`scale(${effect.scale})`)
  }
  return parts.join(' ')
}
