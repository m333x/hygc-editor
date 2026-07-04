/**
 * Shared, non-component utilities for the Inspector panel.
 *
 * Lives in its own file because `primitives.tsx` exports components only —
 * mixing component and value exports in one module breaks React Fast Refresh.
 */

/** Default snap thresholds for inspector sliders. */
export const SNAP_THRESHOLDS = {
  scale: 0.02,
  position: 2,
  rotation: 2,
  crop: 1,
  speed: 0.05,
} as const

/** If `value` is within `threshold` of `defaultVal`, snap to the default. */
export function snapToDefault(value: number, defaultVal: number, threshold: number): number {
  return Math.abs(value - defaultVal) <= threshold ? defaultVal : value
}
