/**
 * SnapGuidesOverlay — draws active snap guidelines over the composition.
 *
 * Mounts as a sibling of the drag overlays inside PreviewCanvas's scaled
 * composition wrapper, so positions are in native composition pixels and the
 * outer CSS scale takes care of viewport sizing.
 *
 * Rendering is purely passive: lines come in as props from PreviewCanvas state.
 * The drag overlays own the snap math and push lines into that state during
 * pointer-move; this component just paints them.
 *
 * Returns null (no DOM, no listeners) when there are no active lines.
 */

import type { SnapLine } from './snapping'

export interface SnapGuidesOverlayProps {
  compositionWidth: number
  compositionHeight: number
  /** Current CSS scale factor — used to keep guide stroke ~constant on screen. */
  scale: number
  lines: SnapLine[]
}

export function SnapGuidesOverlay({
  compositionWidth,
  compositionHeight,
  scale,
  lines,
}: SnapGuidesOverlayProps) {
  if (lines.length === 0) return null

  const strokeWidth = Math.max(2, Math.round(1.5 / Math.max(scale, 0.01)))
  const color = '#f43f5e'

  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 7,
      }}
    >
      {lines.map((line, i) =>
        line.axis === 'v' ? (
          <div
            key={`v-${i}-${line.position}`}
            style={{
              position: 'absolute',
              left: line.position - strokeWidth / 2,
              top: 0,
              width: strokeWidth,
              height: compositionHeight,
              background: color,
            }}
          />
        ) : (
          <div
            key={`h-${i}-${line.position}`}
            style={{
              position: 'absolute',
              left: 0,
              top: line.position - strokeWidth / 2,
              width: compositionWidth,
              height: strokeWidth,
              background: color,
            }}
          />
        ),
      )}
    </div>
  )
}
