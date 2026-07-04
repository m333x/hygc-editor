/**
 * Playback Store — transient state for the timeline playhead and play/pause.
 *
 * Owns:
 *   - `playheadPosition` — current time on the timeline (ms)
 *   - `isPlaying`        — whether the composition is currently playing
 *
 * Why a separate store: playback ticks at frame rate during play. Components
 * that only care about the playhead (the ruler, timecode readout) shouldn't
 * subscribe to a store that also re-renders on every clip mutation.
 */

import { create } from 'zustand'

export interface PlaybackState {
  /** Current playhead position on the timeline, in milliseconds. */
  playheadPosition: number
  /** Whether the composition is currently playing. */
  isPlaying: boolean
}

export interface PlaybackActions {
  /** Set the playhead position (clamped to ≥ 0). */
  setPlayhead(timeMs: number): void
  /** Toggle between playing and paused. */
  togglePlayback(): void
  /** Explicitly set the playing state. */
  setPlaying(playing: boolean): void
  /** Reset transient playback state (called on project load/reset). */
  reset(): void
}

export type PlaybackStore = PlaybackState & PlaybackActions

const INITIAL_STATE: PlaybackState = {
  playheadPosition: 0,
  isPlaying: false,
}

export const usePlaybackStore = create<PlaybackStore>((set, get) => ({
  ...INITIAL_STATE,

  setPlayhead: (timeMs) => {
    set({ playheadPosition: Math.max(0, timeMs) })
  },

  togglePlayback: () => {
    set({ isPlaying: !get().isPlaying })
  },

  setPlaying: (playing) => {
    set({ isPlaying: playing })
  },

  reset: () => {
    set({ ...INITIAL_STATE })
  },
}))
