/**
 * effects — pure per-frame resolvers for non-destructive clip effects.
 *
 * Effects live on a clip as an ordered stack of `EffectInstance`s
 * (Premiere-style): index 0 is applied to the source media first, later
 * instances process its output. The same type may appear more than once, and
 * a disabled instance contributes nothing while keeping its settings.
 *
 * Everything here is a deterministic function of (effect stack, clip-local
 * time), never wall-clock or Math.random, so the preview Player, the server
 * render, and the WebCodecs web export produce pixel-identical results.
 * Motion effects that need variation (shake) derive a phase seed from the
 * clip id + instance id, so duplicated clips never move in lockstep.
 *
 * Only CSS primitives verified on ALL three render paths are emitted:
 * filter functions (brightness/contrast/saturate/hue-rotate/grayscale/sepia/
 * blur) and transforms. Overlay textures (grain/vignette) render as <Img>
 * elements in EffectOverlays — no blend modes, no SVG filters, no canvas.
 */

import type {
  EffectInstance,
  EffectType,
  LegacyClipEffects,
  LookPreset,
} from '../types'

// ─── Registry ────────────────────────────────────────────────────────────────

/** Display names for the Effects panel cards and Inspector stack rows. */
export const EFFECT_LABELS: Record<EffectType, string> = {
  look: 'Color Look',
  shake: 'Shake',
  pulse: 'Pulse',
  slowZoom: 'Slow Zoom',
  grain: 'Grain',
  vignette: 'Vignette',
  letterbox: 'Letterbox',
  focusIn: 'Focus In',
}

/** HTML5 drag payload MIME for effect cards dragged from the Effects panel. */
export const EFFECT_DRAG_MIME_TYPE = 'application/hygc-effect'

/** JSON payload carried by an effect drag. */
export interface DraggedEffectPayload {
  effectType: EffectType
}

/** A new instance of `type` with sensible defaults, ready to append to a stack. */
export function createEffectInstance(type: EffectType): EffectInstance {
  const id = crypto.randomUUID()
  switch (type) {
    case 'look':
      return { id, type, preset: 'punch', intensity: 1 }
    case 'shake':
      return { id, type, amount: 0.5 }
    case 'pulse':
      return { id, type, intervalMs: 500, amount: 0.5 }
    case 'slowZoom':
      return { id, type, direction: 'in', amount: 0.5 }
    case 'grain':
      return { id, type, amount: 0.5 }
    case 'vignette':
      return { id, type, amount: 0.7 }
    case 'letterbox':
      return { id, type, amount: 0.1 }
    case 'focusIn':
      return { id, type, durationMs: 500 }
  }
}

/**
 * Convert a legacy flat effects object into an ordered stack. Ordering matches
 * the fixed order the old renderer applied (grade → motion → texture → focus)
 * so migrated projects render identically. Returns the input unchanged when
 * it's already a stack; undefined when there's nothing to migrate.
 */
export function migrateLegacyEffects(
  fx: LegacyClipEffects | EffectInstance[] | undefined,
): EffectInstance[] | undefined {
  if (!fx) return undefined
  if (Array.isArray(fx)) return fx
  const id = () => crypto.randomUUID()
  const stack: EffectInstance[] = []
  if (fx.look) stack.push({ id: id(), type: 'look', ...fx.look })
  if (fx.shake) stack.push({ id: id(), type: 'shake', amount: fx.shake })
  if (fx.pulse) stack.push({ id: id(), type: 'pulse', ...fx.pulse })
  if (fx.slowZoom) stack.push({ id: id(), type: 'slowZoom', ...fx.slowZoom })
  if (fx.grain) stack.push({ id: id(), type: 'grain', amount: fx.grain })
  if (fx.vignette) stack.push({ id: id(), type: 'vignette', amount: fx.vignette })
  if (fx.letterbox) stack.push({ id: id(), type: 'letterbox', amount: fx.letterbox })
  if (fx.focusIn) stack.push({ id: id(), type: 'focusIn', ...fx.focusIn })
  return stack.length > 0 ? stack : undefined
}

// ─── Looks ───────────────────────────────────────────────────────────────────

/**
 * A look's target values at intensity 1. Missing fields sit at identity.
 * Intensity lerps each field from identity toward the target, so one slider
 * scales the whole grade uniformly.
 */
interface LookParams {
  brightness?: number // identity 1
  contrast?: number // identity 1
  saturate?: number // identity 1
  sepia?: number // identity 0 — low doses read as warmth, not "old photo"
  hueRotate?: number // identity 0, degrees
  grayscale?: number // identity 0
}

export const LOOK_PRESETS: Record<LookPreset, LookParams> = {
  /** "Make it pop" — the default grade everyone applies first. */
  punch: { contrast: 1.15, saturate: 1.35 },
  /** Matte, faded film: lifted blacks, muted color, a touch of warmth. */
  film: { contrast: 0.92, saturate: 0.85, brightness: 1.05, sepia: 0.12 },
  /** Golden-hour warmth for talking heads. */
  warm: { sepia: 0.25, saturate: 1.3, brightness: 1.03 },
  /** Clean tech/product cool cast. */
  cool: { hueRotate: -8, saturate: 1.1, contrast: 1.05 },
  /** Bold black & white. */
  bw: { grayscale: 1, contrast: 1.25 },
  /** Moody dark monochrome. */
  noir: { grayscale: 1, contrast: 1.1, brightness: 0.9 },
}

/** Display metadata for the inspector's preset picker. */
export const LOOK_PRESET_LABELS: Record<LookPreset, string> = {
  punch: 'Punch',
  film: 'Film',
  warm: 'Warm',
  cool: 'Cool',
  bw: 'B&W',
  noir: 'Noir',
}

const lerp = (from: number, to: number, t: number) => from + (to - from) * t

/**
 * Build the CSS filter string for a look at the given intensity.
 * Returns '' at intensity 0 (or an unknown preset) — callers can skip it.
 * Only non-identity functions are emitted to keep the style minimal.
 */
export function buildLookFilter(look: { preset: LookPreset; intensity: number }): string {
  const params = LOOK_PRESETS[look.preset]
  if (!params) return ''
  const t = Math.max(0, Math.min(1, look.intensity))
  if (t === 0) return ''

  const parts: string[] = []
  const push = (fn: string, value: number, identity: number, unit = '') => {
    const v = lerp(identity, value, t)
    if (Math.abs(v - identity) > 0.001) parts.push(`${fn}(${round3(v)}${unit})`)
  }
  if (params.brightness !== undefined) push('brightness', params.brightness, 1)
  if (params.contrast !== undefined) push('contrast', params.contrast, 1)
  if (params.saturate !== undefined) push('saturate', params.saturate, 1)
  if (params.grayscale !== undefined) push('grayscale', params.grayscale, 0)
  if (params.sepia !== undefined) push('sepia', params.sepia, 0)
  if (params.hueRotate !== undefined) push('hue-rotate', params.hueRotate, 0, 'deg')
  return parts.join(' ')
}

const round3 = (v: number) => Math.round(v * 1000) / 1000

// ─── Focus-in ────────────────────────────────────────────────────────────────

/** Max blur at the very first frame of a focus-in. */
const FOCUS_IN_MAX_BLUR_PX = 16

/**
 * Blur radius for the focus-in effect at a clip-local time. Quadratic
 * ease-out: sharpens fast at the start, settles gently. 0 once the window
 * has elapsed.
 */
export function focusInBlurPx(
  focusIn: { durationMs: number },
  clipLocalMs: number,
): number {
  const duration = Math.max(1, focusIn.durationMs)
  const p = Math.max(0, Math.min(1, clipLocalMs / duration))
  const remaining = (1 - p) * (1 - p)
  return round3(remaining * FOCUS_IN_MAX_BLUR_PX)
}

// ─── Motion ──────────────────────────────────────────────────────────────────

/** Peak shake displacement (px in composition space) and rotation (deg) at amount 1. */
const SHAKE_MAX_PX = 14
const SHAKE_MAX_DEG = 0.5
/** Extra scale so shake displacement never exposes the canvas edge. */
const SHAKE_OVERSCAN = 0.03

/** Peak extra scale for a pulse kick at amount 1. */
const PULSE_MAX_SCALE = 0.12

/** Extra scale at the zoomed-in end of a slow zoom at amount 1. */
const SLOW_ZOOM_MAX_SCALE = 0.25

/**
 * Cheap deterministic hash of a seed string → phase in [0, 2π).
 * Seeded with clip id + instance id so two shaken clips (or two shake
 * instances on one clip) never move in lockstep.
 */
export function clipPhaseSeed(seedKey: string): number {
  let h = 0
  for (let i = 0; i < seedKey.length; i++) {
    h = (h * 31 + seedKey.charCodeAt(i)) | 0
  }
  return (Math.abs(h) % 6283) / 1000
}

/** An instance renders unless explicitly disabled. */
const isOn = (fx: EffectInstance) => fx.enabled !== false

/**
 * Combined motion transform (shake + pulse + slow zoom) at a clip-local time.
 * Returns '' when no motion effect is active. `clipDurationMs` drives the
 * slow-zoom progress ramp.
 *
 * Each instance contributes its own transform snippet. Stack index 0 must be
 * applied to the media first, and CSS transforms apply right-to-left, so the
 * per-instance parts are emitted in reverse stack order.
 *
 * Shake is a sum of two incommensurate sine pairs — reads as organic drift
 * plus jitter without any randomness, and is trivially frame-deterministic.
 */
export function buildMotionTransform(
  stack: EffectInstance[],
  clipId: string,
  clipLocalMs: number,
  clipDurationMs: number,
): string {
  const parts: string[] = []

  for (const fx of stack) {
    if (!isOn(fx)) continue

    if (fx.type === 'shake' && fx.amount > 0) {
      const s = clipPhaseSeed(clipId + fx.id)
      const t = clipLocalMs / 1000
      // slow drift (~1.3 Hz) + fine jitter (~4.4 Hz), different phases per axis
      const tx = fx.amount * SHAKE_MAX_PX * (Math.sin(t * 8.2 + s) + 0.5 * Math.sin(t * 27.7 + s * 2))
      const ty = fx.amount * SHAKE_MAX_PX * (Math.cos(t * 9.4 + s * 3) + 0.5 * Math.sin(t * 31.3 + s))
      const rot = fx.amount * SHAKE_MAX_DEG * Math.sin(t * 5.9 + s * 4)
      const segs: string[] = []
      if (tx !== 0 || ty !== 0) segs.push(`translate(${round3(tx)}px, ${round3(ty)}px)`)
      if (rot !== 0) segs.push(`rotate(${round3(rot)}deg)`)
      segs.push(`scale(${round3(1 + fx.amount * SHAKE_OVERSCAN)})`)
      parts.push(segs.join(' '))
    } else if (fx.type === 'pulse' && fx.amount > 0 && fx.intervalMs > 0) {
      // Exponential decay from each beat: full kick at the beat, ~gone by 40%
      // of the interval. Reads as a punch, not a wobble.
      const p = (clipLocalMs % fx.intervalMs) / fx.intervalMs
      const scale = 1 + fx.amount * PULSE_MAX_SCALE * Math.exp(-p * 8)
      if (scale !== 1) parts.push(`scale(${round3(scale)})`)
    } else if (fx.type === 'slowZoom' && fx.amount > 0 && clipDurationMs > 0) {
      const p = Math.max(0, Math.min(1, clipLocalMs / clipDurationMs))
      const z = fx.amount * SLOW_ZOOM_MAX_SCALE
      const scale = fx.direction === 'in' ? 1 + z * p : 1 + z * (1 - p)
      if (scale !== 1) parts.push(`scale(${round3(scale)})`)
    }
  }

  return parts.reverse().join(' ')
}

// ─── Composition helpers ─────────────────────────────────────────────────────

const MEDIA_EFFECT_TYPES: ReadonlySet<EffectType> = new Set([
  'look',
  'shake',
  'pulse',
  'slowZoom',
  'focusIn',
])

const OVERLAY_EFFECT_TYPES: ReadonlySet<EffectType> = new Set([
  'grain',
  'vignette',
  'letterbox',
])

/** True when any enabled effect that needs the inner media wrapper is in the stack. */
export function hasMediaEffects(
  stack: EffectInstance[] | undefined,
): stack is EffectInstance[] {
  return !!stack?.some((fx) => isOn(fx) && MEDIA_EFFECT_TYPES.has(fx.type))
}

/** True when any enabled overlay (grain/vignette/letterbox) is in the stack. */
export function hasOverlayEffects(
  stack: EffectInstance[] | undefined,
): stack is EffectInstance[] {
  return !!stack?.some((fx) => isOn(fx) && OVERLAY_EFFECT_TYPES.has(fx.type))
}

/**
 * Filter string for the media wrapper: look grades + focus-in blurs, in stack
 * order (CSS filter chains apply left-to-right, so stack order maps directly).
 * Returns undefined when nothing applies.
 */
export function buildMediaFilter(
  stack: EffectInstance[],
  clipLocalMs: number,
): string | undefined {
  const parts: string[] = []
  for (const fx of stack) {
    if (!isOn(fx)) continue
    if (fx.type === 'look') {
      const look = buildLookFilter(fx)
      if (look) parts.push(look)
    } else if (fx.type === 'focusIn') {
      const blur = focusInBlurPx(fx, clipLocalMs)
      if (blur > 0) parts.push(`blur(${blur}px)`)
    }
  }
  return parts.length > 0 ? parts.join(' ') : undefined
}

/**
 * Deterministic grain jitter offset for a frame, in px of the (2×-scaled)
 * tile space. New pseudo-random offset every frame = the classic grain "boil".
 */
export function grainJitter(frame: number): { dx: number; dy: number } {
  // integer hash → two values in [-32, 32). `>>> 0` keeps the intermediate
  // unsigned — a negative int32 modulo would jitter past the bleed margin.
  let h = ((frame + 1) * 2654435761) >>> 0
  h = (h ^ (h >>> 16)) >>> 0
  const dx = (h % 64) - 32
  h = ((h * 2246822519) >>> 0) ^ (h >>> 13)
  const dy = ((h >>> 0) % 64) - 32
  return { dx, dy }
}
