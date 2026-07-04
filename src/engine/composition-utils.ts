/**
 * Composition Utilities — pure helper functions for Remotion composition rendering.
 *
 * These utilities are used by the ShortComposition component to determine which
 * clips are active at any given frame, convert between time units, and compute
 * visual transforms. All functions are pure (no side effects, no state) so they
 * can be easily tested and reused in both the preview player and server-side
 * rendering pipeline.
 *
 * Function categories:
 *   - Time conversion: frame ↔ millisecond conversions
 *   - Clip queries: determine active clips at a given frame
 *   - Transform: compute CSS transform strings from ClipTransform
 *   - Duration: compute total composition duration from track content
 *
 * SOLID: SRP — pure utility functions with no UI or state management concerns.
 *
 * @see README.md Section 7.3 for timeline state and clip timing
 * @see PLAN.md Phase 3.1 for composition rendering requirements
 */

import type { Track, Clip, ClipTransform, CompositionConfig } from '../types'

// ─── Time Conversion ─────────────────────────────────────────────────────────

/**
 * Convert a frame number to milliseconds at the given FPS.
 *
 * @param frame - Frame number (0-based)
 * @param fps   - Frames per second
 * @returns Time in milliseconds
 */
export function frameToMs(frame: number, fps: number): number {
  return (frame / fps) * 1000
}

/**
 * Convert milliseconds to the nearest frame number at the given FPS.
 *
 * @param ms  - Time in milliseconds
 * @param fps - Frames per second
 * @returns Frame number (0-based, rounded down)
 */
export function msToFrame(ms: number, fps: number): number {
  return Math.floor((ms / 1000) * fps)
}

/**
 * Convert milliseconds to the total frame count (for composition duration).
 *
 * Uses Math.ceil to ensure the composition is long enough to show all content.
 *
 * @param ms  - Duration in milliseconds
 * @param fps - Frames per second
 * @returns Total frame count
 */
export function msToDurationInFrames(ms: number, fps: number): number {
  return Math.max(1, Math.ceil((ms / 1000) * fps))
}

// ─── Clip Queries ────────────────────────────────────────────────────────────

/**
 * Determine whether a clip is active (visible/audible) at a given time.
 *
 * A clip is active when the current time falls within its timeline span:
 *   startTime <= currentTimeMs < startTime + duration
 *
 * @param clip          - The clip to check
 * @param currentTimeMs - Current playhead position in milliseconds
 * @returns True if the clip is active at the given time
 */
export function isClipActiveAtTime(clip: Clip, currentTimeMs: number): boolean {
  return currentTimeMs >= clip.startTime && currentTimeMs < clip.startTime + clip.duration
}

/**
 * Get all active clips from a track at a given time.
 *
 * Returns clips sorted by their startTime (earliest first). Multiple clips
 * can be active simultaneously on the same track if they overlap — the
 * composition renders them in order (later clips on top).
 *
 * @param track         - The track to query
 * @param currentTimeMs - Current playhead position in milliseconds
 * @returns Array of active clips, sorted by startTime ascending
 */
export function getActiveClips(track: Track, currentTimeMs: number): Clip[] {
  return track.clips
    .filter((clip) => isClipActiveAtTime(clip, currentTimeMs))
    .sort((a, b) => a.startTime - b.startTime)
}

/**
 * Get the source-relative time for a clip at the given timeline time.
 *
 * Accounts for the clip's inPoint (trim start) and speed multiplier.
 * This is the timestamp to seek to in the source video/audio file.
 *
 * Formula: sourceTime = inPoint + (timelineTime - startTime) * speed
 *
 * @param clip          - The clip to compute source time for
 * @param currentTimeMs - Current playhead position in milliseconds
 * @returns Source-relative time in milliseconds
 */
export function getClipSourceTime(clip: Clip, currentTimeMs: number): number {
  if (clip.freezeFrame !== undefined) {
    return clip.freezeFrame
  }
  const timeIntoClip = currentTimeMs - clip.startTime
  return clip.inPoint + timeIntoClip * clip.speed
}

// ─── Transform ───────────────────────────────────────────────────────────────

/**
 * Compute a CSS transform string from a ClipTransform object.
 *
 * Applied to clip elements in the Remotion composition. The transform chain
 * matches the application order defined in the ClipTransform docs:
 *   translate → rotate → scale → flip
 *
 * @param transform - The clip's transform properties
 * @returns CSS transform string for use in inline styles
 */
export function buildCssTransform(transform: ClipTransform): string {
  const parts: string[] = []

  if (transform.x !== 0 || transform.y !== 0) {
    parts.push(`translate(${transform.x}px, ${transform.y}px)`)
  }

  if (transform.rotation !== 0) {
    parts.push(`rotate(${transform.rotation}deg)`)
  }

  if (transform.scale !== 1) {
    parts.push(`scale(${transform.scale})`)
  }

  const flipX = transform.flipH ? -1 : 1
  const flipY = transform.flipV ? -1 : 1
  if (flipX !== 1 || flipY !== 1) {
    parts.push(`scale(${flipX}, ${flipY})`)
  }

  return parts.join(' ')
}

/**
 * Compute CSS clip-path for crop values.
 *
 * Uses CSS `inset()` to crop the clip. Crop values are percentages (0–50)
 * of the source dimensions.
 *
 * @param crop - Crop rectangle with top/right/bottom/left percentages
 * @returns CSS clip-path string, or empty string if no crop is applied
 */
export function buildCropClipPath(crop: ClipTransform['crop']): string {
  if (crop.top === 0 && crop.right === 0 && crop.bottom === 0 && crop.left === 0) {
    return ''
  }
  return `inset(${crop.top}% ${crop.right}% ${crop.bottom}% ${crop.left}%)`
}

// ─── Duration ────────────────────────────────────────────────────────────────

/**
 * Compute the total duration of the composition based on track content.
 *
 * The composition duration is the maximum endTime across all clips in all
 * tracks — Premiere-style. The project has no fixed length; it grows when
 * clips are added or extended, and shrinks when they're removed or trimmed.
 * `config` is accepted for legacy callers but its `durationMs` is ignored.
 *
 * @param tracks - All timeline tracks
 * @param _config - Composition configuration (unused; retained for callers)
 * @returns Duration in milliseconds
 */
export function computeCompositionDuration(
  tracks: Track[],
  _config: CompositionConfig,
): number {
  let maxEndTime = 0

  for (const track of tracks) {
    for (const clip of track.clips) {
      const endTime = clip.startTime + clip.duration
      if (endTime > maxEndTime) {
        maxEndTime = endTime
      }
    }
  }

  return maxEndTime
}

/**
 * Find a clip by ID across all tracks.
 *
 * Searches through every track's clips array and returns the clip along
 * with its parent track. Returns null if the clip is not found.
 *
 * @param tracks - All timeline tracks to search
 * @param clipId - The clip UUID to find
 * @returns Object with the clip and its parent track, or null
 */
export function findClipById(
  tracks: Track[],
  clipId: string,
): { clip: Clip; track: Track } | null {
  for (const track of tracks) {
    const clip = track.clips.find((c) => c.id === clipId)
    if (clip) {
      return { clip, track }
    }
  }
  return null
}

/**
 * Return the single clip_audio track, if present.
 */
export function getClipAudioTrack(tracks: Track[]): Track | undefined {
  return tracks.find((t) => t.type === 'clip_audio')
}

/**
 * Find the clip on the clip_audio track that is linked to the given video clip id.
 */
export function findClipBySourceVideoClipId(
  tracks: Track[],
  sourceVideoClipId: string,
): { clip: Clip; track: Track } | null {
  const clipAudioTrack = getClipAudioTrack(tracks)
  if (!clipAudioTrack) return null
  const clip = clipAudioTrack.clips.find((c) => c.sourceVideoClipId === sourceVideoClipId)
  if (!clip) return null
  return { clip, track: clipAudioTrack }
}

/**
 * Compute snap points from all clips in all tracks.
 *
 * Returns an array of timeline positions (in ms) where clips start or end.
 * Used by the snap system to align clips to other clip edges during drag
 * operations.
 *
 * @param tracks      - All timeline tracks
 * @param excludeIds  - Clip IDs to exclude (e.g. the clip being dragged)
 * @returns Sorted array of snap positions in milliseconds
 */
export function getSnapPoints(
  tracks: Track[],
  excludeIds: string[] = [],
): number[] {
  const points = new Set<number>()

  for (const track of tracks) {
    for (const clip of track.clips) {
      if (excludeIds.includes(clip.id)) continue
      points.add(clip.startTime)
      points.add(clip.startTime + clip.duration)
    }
  }

  return Array.from(points).sort((a, b) => a - b)
}

/**
 * Collect unique media asset ids from video and audio clips. Excludes caption
 * virtual ids (`caption-*`), which have no backing asset.
 */
export function getMediaAssetIds(tracks: Track[]): string[] {
  const ids = new Set<string>()
  for (const track of tracks) {
    if (track.type !== 'video' && track.type !== 'audio' && track.type !== 'clip_audio') continue
    for (const clip of track.clips) {
      if (clip.assetId.startsWith('caption-')) continue
      ids.add(clip.assetId)
    }
  }
  return Array.from(ids)
}
