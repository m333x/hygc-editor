/**
 * Keyframe graph sizing constants and helpers — kept in their own module so
 * the `ClipKeyframeGraph` component file can export only components (fast
 * refresh requirement) while still letting the timeline-row layout code read
 * graph dimensions without pulling in any React deps.
 */

import type { Clip } from '../../types'

/** Header strip height inside the graph (title + add / close). */
export const KEYFRAME_GRAPH_HEADER_HEIGHT = 22

/** Each property sub-row height in pixels. */
export const KEYFRAME_GRAPH_ROW_HEIGHT = 56

/**
 * Compute the graph's total pixel height for a given clip. Used by the
 * timeline so the parent track row can grow to make room. The minimum is a
 * single empty row so the "Add property" affordance is always visible.
 */
export function computeGraphHeightForClip(clip: Clip): number {
  const count = clip.keyframeTracks?.length ?? 0
  const rows = Math.max(1, count)
  return KEYFRAME_GRAPH_HEADER_HEIGHT + rows * KEYFRAME_GRAPH_ROW_HEIGHT
}
