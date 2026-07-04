/**
 * Timeline components barrel export.
 *
 * The Timeline module provides the full interactive NLE timeline for the
 * HyGC editor. Implemented in Phase 3.4.
 *
 * Public API:
 *   - `Timeline`          — main orchestrating component (mount in EditorPage)
 *   - `TimelineRuler`     — time ruler with adaptive ticks (used internally,
 *                           exported for testing / Storybook)
 *   - `TrackHeader`       — left-side track header (sortable, label edit)
 *   - `TimelineClip`      — individual clip block with drag/trim/slice
 *   - `TrackContent`      — track lane containing clips
 *   - `AddTrackDropdown`  — "Add Track" button + type picker
 *   - `AddElementButton`  — per-track "Add clip" stub (Phase 3.7 integration)
 *
 * Utility exports:
 *   - Type-safe constants and helpers from `timeline-utils` are intentionally
 *     NOT re-exported here to keep the public surface minimal. Import from
 *     `./timeline-utils` directly if needed in other modules.
 *
 * @see PLAN.md Phase 3.4 for full feature requirements
 */

export { Timeline } from './Timeline'
export { TimelineRuler } from './TimelineRuler'
export type { TimelineRulerProps } from './TimelineRuler'
export { TrackHeader } from './TrackHeader'
export type { TrackHeaderProps } from './TrackHeader'
export { TimelineClip } from './TimelineClip'
export type { TimelineClipProps } from './TimelineClip'
export { TrackContent } from './TrackContent'
export type { TrackContentProps } from './TrackContent'
export { AddTrackDropdown, AddElementButton } from './AddTrackDropdown'
export type { AddTrackDropdownProps } from './AddTrackDropdown'
