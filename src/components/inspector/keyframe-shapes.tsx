/**
 * KeyframeShape — a split-easing marker, rendered as a single SVG.
 *
 * Each half of the marker encodes one side of the keyframe's easing:
 *   left half  = `easingIn`  (curve arriving at the keyframe)
 *   right half = `easingOut` (curve departing toward the next one)
 *
 * Three visual classes — the After Effects / DaVinci / Cavalry vocabulary
 * motion designers have read for decades:
 *
 *   triangle   → sharp / linear interpolation
 *   semicircle → curved (easeIn, easeOut, easeInOut)
 *   square     → held (step / clamp)
 *
 * Same-on-both-sides combos produce a familiar silhouette:
 *   linear ↔ linear → diamond (matches the legacy marker)
 *   ease   ↔ ease   → circle
 *   hold   ↔ hold   → square
 *
 * Mixed combos are immediately distinguishable at 11px without any legend —
 * the corner profile reveals what's about to happen on each side of the
 * playhead. A thin center seam is drawn only when the two halves differ.
 */

import type { EasingKind } from '../../types'

type EasingClass = 'linear' | 'curve' | 'hold'

function classify(easing: EasingKind): EasingClass {
  if (easing === 'linear') return 'linear'
  if (easing === 'hold') return 'hold'
  return 'curve'
}

/**
 * Half-marker outline paths, viewBox 12×12, center seam at x=6. Each path
 * starts at (6, 0) and closes back through (6, 12) so the two halves meet
 * cleanly along the seam regardless of which classes are combined.
 */
const HALF_PATHS: Record<'left' | 'right', Record<EasingClass, string>> = {
  left: {
    linear: 'M 6 0 L 0 6 L 6 12 Z',
    curve: 'M 6 0 A 6 6 0 0 0 6 12 Z',
    hold: 'M 6 0 L 0 0 L 0 12 L 6 12 Z',
  },
  right: {
    linear: 'M 6 0 L 12 6 L 6 12 Z',
    curve: 'M 6 0 A 6 6 0 0 1 6 12 Z',
    hold: 'M 6 0 L 12 0 L 12 12 L 6 12 Z',
  },
}

export type KeyframeShapeVariant = 'inspector' | 'graph' | 'menu'

export interface KeyframeShapeProps {
  easingIn: EasingKind
  easingOut: EasingKind
  selected?: boolean
  hovered?: boolean
  /** Pixel size of the rendered marker. */
  size?: number
  /**
   * Color-token set. `inspector` uses default app tokens; `graph` uses the
   * editor-chrome tokens so the marker reads on the dark timeline surface;
   * `menu` is a neutral preview used inside the easing picker.
   */
  variant?: KeyframeShapeVariant
  /**
   * Render only one half of the marker. Used by the easing picker to show
   * exactly the side the user is about to change.
   */
  onlySide?: 'left' | 'right'
  className?: string
}

interface Palette {
  fill: string
  stroke: string
  seam: string
}

function paletteFor(variant: KeyframeShapeVariant, selected: boolean, hovered: boolean): Palette {
  if (selected) {
    return {
      fill: 'var(--primary)',
      stroke: 'var(--primary-foreground)',
      seam: 'color-mix(in oklch, var(--primary-foreground) 80%, transparent)',
    }
  }
  if (variant === 'graph') {
    return {
      fill: hovered ? 'var(--editor-on-chrome)' : 'color-mix(in oklch, var(--editor-on-chrome) 88%, transparent)',
      stroke: 'color-mix(in oklch, var(--editor-on-chrome-muted) 55%, transparent)',
      seam: 'color-mix(in oklch, var(--editor-chrome-strong) 70%, transparent)',
    }
  }
  if (variant === 'menu') {
    return {
      fill: 'color-mix(in oklch, var(--foreground) 75%, transparent)',
      stroke: 'transparent',
      seam: 'color-mix(in oklch, var(--background) 80%, transparent)',
    }
  }
  return {
    fill: hovered ? 'var(--foreground)' : 'var(--muted-foreground)',
    stroke: 'transparent',
    seam: 'color-mix(in oklch, var(--background) 85%, transparent)',
  }
}

export function KeyframeShape({
  easingIn,
  easingOut,
  selected = false,
  hovered = false,
  size = 12,
  variant = 'inspector',
  onlySide,
  className,
}: KeyframeShapeProps) {
  const leftClass = classify(easingIn)
  const rightClass = classify(easingOut)
  const palette = paletteFor(variant, selected, hovered)
  const showSeam = !onlySide && leftClass !== rightClass

  const showLeft = onlySide !== 'right'
  const showRight = onlySide !== 'left'

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      className={className}
      aria-hidden
      // shape-rendering keeps the half-paths from sub-pixel-bleeding into
      // each other at the seam — important at 11px.
      shapeRendering="geometricPrecision"
    >
      {showLeft && (
        <path
          d={HALF_PATHS.left[leftClass]}
          fill={palette.fill}
          stroke={palette.stroke}
          strokeWidth={0.6}
          strokeLinejoin="miter"
        />
      )}
      {showRight && (
        <path
          d={HALF_PATHS.right[rightClass]}
          fill={palette.fill}
          stroke={palette.stroke}
          strokeWidth={0.6}
          strokeLinejoin="miter"
        />
      )}
      {showSeam && (
        <line
          x1={6}
          y1={1.5}
          x2={6}
          y2={10.5}
          stroke={palette.seam}
          strokeWidth={0.7}
          strokeLinecap="round"
        />
      )}
    </svg>
  )
}
