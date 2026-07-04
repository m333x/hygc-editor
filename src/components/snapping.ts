/**
 * Snapping helpers for canvas drag/resize interactions.
 *
 * Pure module — no React, no store. Both VideoClipDragOverlay and
 * CaptionDragOverlay feed candidate positions through `snapMove` and apply the
 * snapped result back to their respective stores. The returned `SnapLine[]`
 * drives <SnapGuidesOverlay /> mounted by PreviewCanvas.
 *
 * Coordinate convention:
 *   All inputs and outputs are in composition pixels (1080 × 1920). Callers
 *   should pass a `threshold` derived from screen-pixel grace divided by the
 *   current CSS scale, so the snap zone reads as a consistent ~N screen px
 *   regardless of how the preview is zoomed.
 */

export interface SnapLine {
  /** 'v' = vertical line at x = position; 'h' = horizontal line at y = position. */
  axis: 'v' | 'h'
  /** Composition pixel along the perpendicular axis. */
  position: number
}

interface SnapAxisCandidate {
  /** Where the box-center must land to satisfy this snap. */
  centerValue: number
  /** Where the guideline draws along the canvas. */
  linePosition: number
}

function pickClosest(
  candidate: number,
  options: readonly SnapAxisCandidate[],
  threshold: number,
): SnapAxisCandidate | null {
  let best: (SnapAxisCandidate & { distance: number }) | null = null
  for (const opt of options) {
    const distance = Math.abs(candidate - opt.centerValue)
    if (distance > threshold) continue
    if (!best || distance < best.distance) {
      best = { ...opt, distance }
    }
  }
  return best ? { centerValue: best.centerValue, linePosition: best.linePosition } : null
}

export interface SnapMoveInput {
  centerX: number
  centerY: number
  /** Box width in composition px. Used so edges can snap, not just the center. */
  width: number
  /** Box height in composition px. */
  height: number
  compositionWidth: number
  compositionHeight: number
  /** Snap zone half-width in composition px (typically `8 / cssScale`). */
  threshold: number
}

export interface SnapMoveOutput {
  centerX: number
  centerY: number
  lines: SnapLine[]
}

/**
 * Snap a moving box's center against canvas anchors. Each axis is snapped
 * independently; the returned `lines` contains at most one entry per axis.
 *
 * Snap targets per axis:
 *   - Box center ↔ canvas center
 *   - Near edge ↔ canvas near edge   (left/top)
 *   - Far edge ↔ canvas far edge     (right/bottom)
 *
 * Edge snaps work whether the box is smaller or larger than the canvas — the
 * math is symmetric. Boxes scaled > 1× still get useful "align edge inside
 * canvas" snaps for partial-reveal compositions.
 */
export function snapMove(input: SnapMoveInput): SnapMoveOutput {
  const {
    centerX,
    centerY,
    width,
    height,
    compositionWidth: cw,
    compositionHeight: ch,
    threshold,
  } = input

  const xOptions: SnapAxisCandidate[] = [
    { centerValue: cw / 2, linePosition: cw / 2 },
    { centerValue: width / 2, linePosition: 0 },
    { centerValue: cw - width / 2, linePosition: cw },
  ]
  const yOptions: SnapAxisCandidate[] = [
    { centerValue: ch / 2, linePosition: ch / 2 },
    { centerValue: height / 2, linePosition: 0 },
    { centerValue: ch - height / 2, linePosition: ch },
  ]

  const x = pickClosest(centerX, xOptions, threshold)
  const y = pickClosest(centerY, yOptions, threshold)

  const lines: SnapLine[] = []
  if (x) lines.push({ axis: 'v', position: x.linePosition })
  if (y) lines.push({ axis: 'h', position: y.linePosition })

  return {
    centerX: x ? x.centerValue : centerX,
    centerY: y ? y.centerValue : centerY,
    lines,
  }
}

const SCALE_SNAP_TARGETS = [0.25, 0.5, 0.75, 1.0, 1.5, 2.0] as const

/**
 * Snap a candidate scale to a common round value when within `threshold`
 * (absolute scale units — 0.04 means 0.96 snaps to 1.0). Returns the input
 * unchanged if no target is in range.
 */
export function snapScale(candidate: number, threshold = 0.04): number {
  let best: { value: number; distance: number } | null = null
  for (const target of SCALE_SNAP_TARGETS) {
    const distance = Math.abs(candidate - target)
    if (distance > threshold) continue
    if (!best || distance < best.distance) {
      best = { value: target, distance }
    }
  }
  return best ? best.value : candidate
}
