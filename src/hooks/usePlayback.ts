/**
 * usePlayback — hook for playback control and playhead position.
 *
 * Provides playback-related state and actions from the editor Zustand store.
 * Separating playback from timeline operations (useTimeline) follows the
 * Interface Segregation Principle — components like the playback controls bar
 * only need play/pause/seek, not clip/track mutation APIs.
 *
 * Returns:
 *   - playheadPosition: current position in milliseconds
 *   - isPlaying: whether the composition is playing
 *   - compositionDuration: total duration in milliseconds
 *   - fps: frames per second
 *   - setPlayhead, togglePlayback, setPlaying: control actions
 *   - playheadFrame: playhead position converted to frame number
 *   - formattedTime: playhead position as MM:SS.mmm string
 *
 * SOLID: SRP — only exposes playback-related state.
 * SOLID: ISP — playback consumers don't receive clip/track mutation APIs.
 *
 * @example
 *   const { isPlaying, togglePlayback, formattedTime } = usePlayback()
 *
 * @see PLAN.md Phase 3.5 for playback system requirements
 * @see README.md Section 7.5 "Playback System"
 */

import { useMemo } from 'react'
import { useEditorStore } from '../store/editor-store'
import { usePlaybackStore } from '../store/playback-store'
import { msToFrame, computeCompositionDuration } from '../engine/composition-utils'
import { MAX_TIMELINE_DURATION_MS } from '../components/timeline/timeline-utils'

// ─── Return Type ─────────────────────────────────────────────────────────────

export interface UsePlaybackReturn {
  /** Current playhead position in milliseconds. */
  playheadPosition: number

  /** Whether the composition is currently playing. */
  isPlaying: boolean

  /** Total composition duration in milliseconds. */
  compositionDuration: number

  /** Composition frames per second. */
  fps: number

  /** Playhead position as a frame number (0-based). */
  playheadFrame: number

  /** Playhead position formatted as MM:SS.mmm (e.g., "00:15.250"). */
  formattedTime: string

  /** Total duration formatted as MM:SS.mmm (e.g., "01:00.000"). */
  formattedDuration: string

  /** Set the playhead to a specific time in milliseconds. */
  setPlayhead: (timeMs: number) => void

  /** Toggle between playing and paused states. */
  togglePlayback: () => void

  /** Explicitly set the playing state. */
  setPlaying: (playing: boolean) => void

  /**
   * Step the playhead forward or backward by one frame.
   * Useful for frame-by-frame navigation (arrow key shortcuts).
   *
   * @param direction - 1 for forward, -1 for backward
   */
  stepFrame: (direction: 1 | -1) => void
}

// ─── Formatting & Parsing Helpers ─────────────────────────────────────────────

/**
 * Format a time in milliseconds as MM:SS.mmm (accurate to the millisecond).
 *
 * @param ms - Time in milliseconds
 * @returns Formatted time string (e.g., "01:30.250")
 */
function formatTime(ms: number): string {
  const totalSeconds = ms / 1000
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  const secFloor = Math.floor(seconds)
  const msRemainder = Math.round((seconds - secFloor) * 1000)
  const msPart = String(msRemainder).padStart(3, '0')
  return `${String(minutes).padStart(2, '0')}:${String(secFloor).padStart(2, '0')}.${msPart}`
}

/**
 * Parse a time string into milliseconds.
 * Accepts: "90", "90.5", "1:30", "1:30.250", "00:01:30", "00:01:30.250".
 *
 * @param str - User input (seconds, M:SS, MM:SS.mmm, or H:MM:SS.mmm)
 * @returns Time in milliseconds, or null if invalid
 */
export function parseTimeToMs(str: string): number | null {
  const trimmed = str.trim()
  if (trimmed === '') return null
  const parts = trimmed.split(':')
  let secondsDecimal: number
  if (parts.length === 1) {
    const parsed = parseFloat(parts[0])
    if (Number.isNaN(parsed) || parsed < 0) return null
    secondsDecimal = parsed
  } else if (parts.length === 2) {
    const m = parseInt(parts[0], 10)
    const s = parseFloat(parts[1])
    if (Number.isNaN(m) || m < 0 || Number.isNaN(s) || s < 0 || s >= 60) return null
    secondsDecimal = m * 60 + s
  } else if (parts.length === 3) {
    const h = parseInt(parts[0], 10)
    const m = parseInt(parts[1], 10)
    const s = parseFloat(parts[2])
    if (
      Number.isNaN(h) || h < 0 ||
      Number.isNaN(m) || m < 0 || m >= 60 ||
      Number.isNaN(s) || s < 0 || s >= 60
    ) return null
    secondsDecimal = h * 3600 + m * 60 + s
  } else {
    return null
  }
  const ms = Math.round(secondsDecimal * 1000)
  return ms < 0 ? null : ms
}

// ─── Hook Implementation ─────────────────────────────────────────────────────

export function usePlayback(): UsePlaybackReturn {
  const playheadPosition = usePlaybackStore((s) => s.playheadPosition)
  const isPlaying = usePlaybackStore((s) => s.isPlaying)
  const tracks = useEditorStore((s) => s.tracks)
  const composition = useEditorStore((s) => s.composition)
  const setPlayhead = usePlaybackStore((s) => s.setPlayhead)
  const togglePlayback = usePlaybackStore((s) => s.togglePlayback)
  const setPlaying = usePlaybackStore((s) => s.setPlaying)

  const fps = composition.fps

  const compositionDuration = useMemo(
    () => computeCompositionDuration(tracks, composition),
    [tracks, composition],
  )

  const playheadFrame = useMemo(
    () => msToFrame(playheadPosition, fps),
    [playheadPosition, fps],
  )

  const formattedTime = useMemo(
    () => formatTime(playheadPosition),
    [playheadPosition],
  )

  const formattedDuration = useMemo(
    () => formatTime(compositionDuration),
    [compositionDuration],
  )

  const stepFrame = useMemo(
    () => (direction: 1 | -1) => {
      const frameDurationMs = 1000 / fps
      const newPosition = Math.max(0, playheadPosition + direction * frameDurationMs)
      setPlayhead(Math.min(newPosition, MAX_TIMELINE_DURATION_MS))
    },
    [fps, playheadPosition, setPlayhead],
  )

  return {
    playheadPosition,
    isPlaying,
    compositionDuration,
    fps,
    playheadFrame,
    formattedTime,
    formattedDuration,
    setPlayhead,
    togglePlayback,
    setPlaying,
    stepFrame,
  }
}
