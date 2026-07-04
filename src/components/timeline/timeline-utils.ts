/**
 * Timeline Utilities — pure helper functions for the interactive timeline UI.
 *
 * These utilities are used exclusively by the timeline components (Timeline,
 * TimelineRuler, TimelineClip) to handle time formatting, ruler tick computation,
 * and snap-to-edge logic. All functions are pure (no side effects, no state).
 *
 * Unlike the `engine/composition-utils.ts` functions (which serve Remotion rendering),
 * these are focused on the *display* and *interaction* layer of the timeline.
 *
 * Function categories:
 *   - Ruler intervals: compute adaptive tick spacing based on zoom level
 *   - Time formatting: human-readable time strings for ruler labels
 *   - Snap: apply snap-to-edge/snap-to-playhead when dragging clips
 *   - Clip display: format durations for clip labels
 *   - Content width: total timeline canvas width from tracks
 *
 * SOLID: SRP — pure utility functions with zero UI or state concerns.
 *
 * @see PLAN.md Phase 3.4 for timeline UI requirements
 * @see README.md Section 7.3 for snap behavior specification
 */

import type { Track } from '../../types'

// ─── Ruler Interval Computation ──────────────────────────────────────────────

/**
 * Result of computing ruler tick intervals for a given zoom level.
 *
 * `major` ticks receive a time label; `minor` ticks are unlabelled.
 * All values are in seconds.
 */
export interface RulerInterval {
  /** Seconds between labelled (major) ticks. */
  major: number
  /** Seconds between minor tick marks (always major / 5). */
  minor: number
}

/**
 * Nice (human-readable) interval values for ruler major ticks, in seconds.
 * Chosen to be easily readable on a video timeline.
 */
const NICE_INTERVALS_SEC = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]

/**
 * Target spacing in pixels between major tick labels.
 * At this density, labels are legible without overlapping.
 */
const TARGET_MAJOR_SPACING_PX = 80

/**
 * Compute the optimal major and minor tick intervals for the given zoom level.
 *
 * Algorithm:
 *   1. Compute ideal interval: `targetSpacingPx / zoomLevel` seconds
 *   2. Round up to the nearest "nice" interval value
 *   3. Minor interval = major / 5 (quintary subdivisions)
 *
 * @param zoomLevel - Timeline zoom in pixels per second (e.g. 100 = 100px per second)
 * @returns RulerInterval with major and minor tick spacings in seconds
 *
 * @example
 *   computeRulerInterval(100)  // → { major: 1, minor: 0.2 }
 *   computeRulerInterval(20)   // → { major: 5, minor: 1 }
 *   computeRulerInterval(400)  // → { major: 0.25, minor: 0.05 }
 */
export function computeRulerInterval(zoomLevel: number): RulerInterval {
  const idealSec = TARGET_MAJOR_SPACING_PX / Math.max(1, zoomLevel)

  let major = NICE_INTERVALS_SEC[NICE_INTERVALS_SEC.length - 1]
  for (const v of NICE_INTERVALS_SEC) {
    if (v >= idealSec) {
      major = v
      break
    }
  }

  return { major, minor: major / 5 }
}

// ─── Time Formatting ─────────────────────────────────────────────────────────

/**
 * Format a time value (in seconds) as a ruler tick label.
 *
 * Display rules:
 *   - Sub-second: shows as "0.1s", "0.5s", etc.
 *   - Seconds (< 60): shows as "5s", "30s", etc.
 *   - Minutes (≥ 60): shows as "1:00", "1:30", etc.
 *
 * @param seconds - Time value in seconds (can be fractional)
 * @returns Human-readable label string
 *
 * @example
 *   formatRulerTime(0.5)  // → "0.5s"
 *   formatRulerTime(5)    // → "5s"
 *   formatRulerTime(65)   // → "1:05"
 */
export function formatRulerTime(seconds: number): string {
  if (seconds < 1) {
    // Show up to 2 significant decimal places, trim trailing zeros
    return `${parseFloat(seconds.toFixed(2))}s`
  }
  if (seconds < 60) {
    return `${Math.round(seconds)}s`
  }
  const min = Math.floor(seconds / 60)
  const sec = Math.round(seconds % 60)
  return `${min}:${sec.toString().padStart(2, '0')}`
}

/**
 * Format a clip duration (in milliseconds) as a compact label for clip blocks.
 *
 * Used inside the clip body label. Shorter than the full timecode format.
 *
 * @param ms - Duration in milliseconds
 * @returns Compact duration string
 *
 * @example
 *   formatClipDuration(500)    // → "0.5s"
 *   formatClipDuration(5000)   // → "5.0s"
 *   formatClipDuration(65000)  // → "1:05"
 */
export function formatClipDuration(ms: number): string {
  const s = ms / 1000
  if (s < 1) return `${Math.round(ms)}ms`
  if (s < 60) return `${s.toFixed(1)}s`
  const min = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${min}:${sec.toString().padStart(2, '0')}`
}

// ─── Snap Logic ──────────────────────────────────────────────────────────────

/**
 * Pixel threshold within which a clip snaps to a snap point.
 * Set to 8px so snapping feels magnetic but not intrusive.
 */
const SNAP_THRESHOLD_PX = 8

/**
 * Apply snap-to-edge behavior to a time value.
 *
 * Snaps `timeMs` to the nearest snap point (clip edge, playhead, or 0) if the
 * distance is within `SNAP_THRESHOLD_PX`. Snap points include:
 *   - Timeline origin (0ms)
 *   - All other clip start/end times
 *   - The current playhead position
 *
 * @param timeMs       - Time value to potentially snap (in milliseconds)
 * @param snapPoints   - Array of candidate snap positions (in ms)
 * @param playheadMs   - Current playhead position (in ms) — added as snap point
 * @param pxPerMs      - Current pixels-per-millisecond ratio (used to convert threshold)
 * @returns Snapped time value, or the original `timeMs` if no snap applies
 *
 * @example
 *   applySnap(498, [0, 500, 1000], 250, 0.1)
 *   // → 500 (within threshold of the snap point at 500ms)
 */
export function applySnap(
  timeMs: number,
  snapPoints: number[],
  playheadMs: number,
  pxPerMs: number,
): number {
  // Convert pixel threshold to ms threshold at the current zoom level
  const thresholdMs = SNAP_THRESHOLD_PX / pxPerMs

  // Candidate snap targets: all clip edges, playhead, and timeline start
  const candidates = [...snapPoints, playheadMs, 0]

  let nearest = timeMs
  let nearestDist = Infinity

  for (const point of candidates) {
    const dist = Math.abs(timeMs - point)
    if (dist < nearestDist) {
      nearestDist = dist
      nearest = point
    }
  }

  return nearestDist <= thresholdMs ? nearest : timeMs
}

/**
 * Apply snap to the end edge of a clip (outgoing edge).
 *
 * During trim-end or drag operations, we sometimes want to snap the clip's
 * END time (startTime + duration) rather than its start time. This helper
 * computes the snapped end time and returns the corresponding start time.
 *
 * @param clipEndMs  - Proposed clip end time (startTime + duration) in ms
 * @param snapPoints - Candidate snap positions in ms
 * @param playheadMs - Playhead position in ms
 * @param pxPerMs    - Pixels per millisecond
 * @returns Snapped clip end time in ms
 */
export function applySnapToEnd(
  clipEndMs: number,
  snapPoints: number[],
  playheadMs: number,
  pxPerMs: number,
): number {
  return applySnap(clipEndMs, snapPoints, playheadMs, pxPerMs)
}

/**
 * Apply snap during a clip *move* (both edges remain rigid).
 *
 * Unlike `applySnap`, which only tests a single point, this considers BOTH
 * the clip's leading (start) and trailing (end) edges as snap candidates and
 * picks whichever edge is closer to a snap point. The returned start time
 * already includes the offset, so the caller can use it directly.
 *
 * Why this exists: dragging forward, the leading edge should lock onto the
 * next clip's start (or playhead) just like dragging backward locks the
 * trailing edge onto the previous clip's end. Snapping only the start gives
 * one-sided behaviour that feels broken when butting clips up against each
 * other from the right.
 *
 * @param startMs    - Proposed new start time in ms
 * @param durationMs - Clip duration in ms (unchanged during a move)
 * @param snapPoints - Candidate snap positions in ms
 * @param playheadMs - Playhead position in ms
 * @param pxPerMs    - Pixels per millisecond
 * @returns Snapped start time in ms (or `startMs` unchanged if no edge is within threshold)
 */
export function applySnapMove(
  startMs: number,
  durationMs: number,
  snapPoints: number[],
  playheadMs: number,
  pxPerMs: number,
): number {
  const snappedStart = applySnap(startMs, snapPoints, playheadMs, pxPerMs)
  const startDelta = snappedStart - startMs

  const endMs = startMs + durationMs
  const snappedEnd = applySnap(endMs, snapPoints, playheadMs, pxPerMs)
  const endDelta = snappedEnd - endMs

  // Neither edge snapped — pass through unchanged.
  if (startDelta === 0 && endDelta === 0) return startMs
  // Only one edge snapped — apply that one.
  if (startDelta === 0) return startMs + endDelta
  if (endDelta === 0) return snappedStart
  // Both edges found a snap — pick whichever moved less (the closer match).
  return Math.abs(startDelta) <= Math.abs(endDelta)
    ? snappedStart
    : startMs + endDelta
}

// ─── Track Select Tools ──────────────────────────────────────────────────────

/**
 * Direction for the Premiere-style Track Select Forward/Backward tools.
 *   - 'forward':  collect clips at or to the right of the cursor time
 *   - 'backward': collect clips at or to the left of the cursor time
 */
export type TrackSelectDirection = 'forward' | 'backward'

/**
 * Collect every clip across every track that falls on one side of a cursor
 * time, used by the Track Select Forward / Backward tools.
 *
 * Inclusive on the cursor side so clicking *on* a clip selects that clip too —
 * matches Premiere's behaviour where the clicked clip is always included.
 * Clips on locked tracks are skipped so the tool doesn't dump a selection the
 * user can't act on.
 *
 *   - 'forward':  `clip.startTime + duration > timeMs` (clip extends past cursor)
 *   - 'backward': `clip.startTime < timeMs`            (clip starts before cursor)
 */
export function collectClipIdsByDirection(
  tracks: Track[],
  timeMs: number,
  direction: TrackSelectDirection,
): string[] {
  const ids: string[] = []
  for (const track of tracks) {
    if (track.locked) continue
    for (const clip of track.clips) {
      if (direction === 'forward') {
        if (clip.startTime + clip.duration > timeMs) ids.push(clip.id)
      } else {
        if (clip.startTime < timeMs) ids.push(clip.id)
      }
    }
  }
  return ids
}

// ─── Content Width ────────────────────────────────────────────────────────────

/**
 * Minimum visible padding added after the last clip or composition end.
 * Gives users space to add new clips after the current content.
 */
const CONTENT_PADDING_MS = 5_000 // 5 seconds of padding

/**
 * Maximum timeline length in milliseconds (10 minutes).
 * The timeline content area always extends to this length so the ruler and
 * playhead can reach the full range. Exported for playhead/seek clamping.
 */
export const MAX_TIMELINE_DURATION_MS = 10 * 60 * 1000

// ─── Layout Constants ────────────────────────────────────────────────────────
//
// Shared across Timeline, TimelineTrackList, TimelinePlayhead, etc. Kept here
// so all timeline sub-components agree on the same dimensions without one of
// them having to import from another (which would create cycles).

/** Width of the fixed track header column (px). */
export const TRACK_HEADER_WIDTH = 200

/** Height of a single track row (px). */
export const TRACK_ROW_HEIGHT = 48

/** Height of the ruler row above all tracks (px). */
export const RULER_HEIGHT = 24

/**
 * Compute the total pixel width of the timeline content area.
 *
 * The timeline is always at least MAX_TIMELINE_DURATION_MS long so that:
 *   - The ruler shows tick marks for the full 0–10 min range
 *   - The playhead can be sought to any time up to 10 minutes
 *
 * Content (composition duration + clips + padding) still determines width when
 * it exceeds 10 minutes, but is capped at MAX_TIMELINE_DURATION_MS.
 *
 * @param tracks          - All timeline tracks
 * @param durationMs      - Composition duration in ms (from CompositionConfig)
 * @param zoomLevel       - Timeline zoom in pixels per second
 * @returns Total content width in pixels
 */
export function computeTimelineContentWidth(
  tracks: Track[],
  durationMs: number,
  zoomLevel: number,
): number {
  const pxPerMs = zoomLevel / 1000

  // Find the latest clip end time
  let maxEndMs = durationMs
  for (const track of tracks) {
    for (const clip of track.clips) {
      const endMs = clip.startTime + clip.duration
      if (endMs > maxEndMs) maxEndMs = endMs
    }
  }

  // At least 10 min of timeline so ruler and playhead cover full range; cap at 10 min
  const extentMs = Math.min(
    Math.max(maxEndMs + CONTENT_PADDING_MS, MAX_TIMELINE_DURATION_MS),
    MAX_TIMELINE_DURATION_MS,
  )
  return extentMs * pxPerMs
}

/**
 * Right-side breathing room reserved past the last clip when fitting to view,
 * so the trailing edge isn't flush against the scrollbar/track edge.
 */
const FIT_VIEW_TRAILING_MARGIN_PX = 24

/** Fallback zoom when fit is requested with no measurable content or viewport. */
const FIT_VIEW_FALLBACK_ZOOM = 100

/**
 * Compute the zoom level (px/s) that fits the actual project content into the
 * given timeline viewport. Unlike `computeTimelineContentWidth`, this measures
 * the *real* content extent (no 10-minute floor) — fit-to-window means fit the
 * material the user has placed, not the entire ruler range.
 *
 * Returns a value clamped to the zoom slider's [10, 500] range. Falls back to
 * the default 100 px/s if the viewport hasn't been measured yet, or the
 * project is empty.
 *
 * @param tracks         - Every timeline track
 * @param durationMs     - Composition duration in ms (acts as a minimum extent)
 * @param viewportWidth  - Width of the timeline's scroll container in px
 *                         (includes the sticky track-header column)
 */
export function computeFitZoomLevel(
  tracks: Track[],
  durationMs: number,
  viewportWidth: number,
): number {
  const available = viewportWidth - TRACK_HEADER_WIDTH - FIT_VIEW_TRAILING_MARGIN_PX
  if (available <= 0) return FIT_VIEW_FALLBACK_ZOOM

  let maxEndMs = durationMs
  for (const track of tracks) {
    for (const clip of track.clips) {
      const endMs = clip.startTime + clip.duration
      if (endMs > maxEndMs) maxEndMs = endMs
    }
  }
  if (maxEndMs <= 0) return FIT_VIEW_FALLBACK_ZOOM

  const zoom = (available * 1000) / maxEndMs
  return Math.max(10, Math.min(500, zoom))
}

// ─── Track Type Configuration ─────────────────────────────────────────────────

/**
 * Visual style configuration for each track type.
 *
 * Driven by OKLCH design tokens in `src/styles/globals.css` (see the
 * `--clip-*` block). Hues are ≥40° apart so audio vs clip-audio vs caption
 * vs video are recognizable at clip-thumbnail size. Cyan (H 215) is reserved
 * exclusively for the selection ring (`--ring`) so the playhead, focus rings,
 * and selected clips share one focus language.
 *
 * Light mode pulls hues from the canonical conic-gradient palette
 * (`src/shared/config/gradients.ts`) at saturated mid-lightness so clips
 * pop on the near-white editor rail; dark mode overrides in `globals.css`
 * sink lightness so colored tape reads as ribbon on a dark rail.
 */
export const TRACK_TYPE_CONFIG = {
  video: {
    /** Color for the type indicator dot on the track header. */
    dotClass: 'bg-clip-video-bg',
    /** Background + border classes for clip blocks (default state). */
    clipClass:
      'bg-clip-video-bg border-clip-video-bg-selected/50 text-clip-video-fg',
    /** Highlight class for selected clips — slightly lifted surface. */
    clipSelectedClass: 'bg-clip-video-bg-selected border-clip-video-bg-selected',
    /**
     * Tailwind ring colour used to outline this clip type when selected.
     * Uses the base (un-lifted) tape colour so the ring reads as a darker
     * accent against the lifted selected body — same hue, lower L.
     */
    clipRingClass: 'ring-clip-video-ring',
    /** Label shown when adding this track type. */
    label: 'Video',
  },
  audio: {
    dotClass: 'bg-clip-audio-bg',
    clipClass:
      'bg-clip-audio-bg border-clip-audio-bg-selected/50 text-clip-audio-fg',
    clipSelectedClass: 'bg-clip-audio-bg-selected border-clip-audio-bg-selected',
    clipRingClass: 'ring-clip-audio-ring',
    label: 'Audio',
  },
  caption: {
    dotClass: 'bg-clip-caption-bg',
    clipClass:
      'bg-clip-caption-bg border-clip-caption-bg-selected/50 text-clip-caption-fg',
    clipSelectedClass:
      'bg-clip-caption-bg-selected border-clip-caption-bg-selected',
    clipRingClass: 'ring-clip-caption-ring',
    label: 'Caption',
  },
  clip_audio: {
    dotClass: 'bg-clip-clipaudio-bg',
    clipClass:
      'bg-clip-clipaudio-bg border-clip-clipaudio-bg-selected/50 text-clip-clipaudio-fg',
    clipSelectedClass:
      'bg-clip-clipaudio-bg-selected border-clip-clipaudio-bg-selected',
    clipRingClass: 'ring-clip-clipaudio-ring',
    label: 'Clip Audio',
  },
} as const satisfies Record<string, {
  dotClass: string
  clipClass: string
  clipSelectedClass: string
  clipRingClass: string
  label: string
}>

/**
 * Visual style override applied to image clips on a video track. Lets users
 * distinguish a still image overlay from a moving video at a glance — the two
 * sit on the same track type today but render very differently in preview.
 *
 * Picks up the magenta-pink `--clip-image-*` tokens defined in `globals.css`,
 * which sit ≥60° away from every other clip hue (video indigo, caption orange,
 * audio green) so colored tape remains scannable.
 */
export const IMAGE_CLIP_STYLE = {
  clipClass:
    'bg-clip-image-bg border-clip-image-bg-selected/50 text-clip-image-fg',
  clipSelectedClass:
    'bg-clip-image-bg-selected border-clip-image-bg-selected',
  clipRingClass: 'ring-clip-image-ring',
} as const
