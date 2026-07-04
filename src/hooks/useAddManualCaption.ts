/**
 * useAddManualCaption — add a single caption clip at the current playhead.
 *
 * Finds or creates the Captions track (same pattern as useCaptionGeneration),
 * builds a new caption Clip at playheadPosition with a default duration,
 * dispatches addClip, then selects the new clip so the user can edit text
 * in the Inspector immediately.
 *
 * @see PLAN.md "Manual Add Captions"
 * @see useCaptionGeneration.ts for find-or-create Captions track pattern
 * @see editor-store.ts for addClip, addTrack, selectClip
 */

import { useCallback } from 'react'
import { useEditorStore } from '../store/editor-store'
import { useSelectionStore } from '../store/selection-store'
import { usePlaybackStore } from '../store/playback-store'
import { DEFAULT_CLIP_TRANSFORM, DEFAULT_CAPTION_STYLE } from '../types'
import type { Clip } from '../types'

const CAPTIONS_TRACK_LABEL = 'Captions'
const DEFAULT_MANUAL_CAPTION_DURATION_MS = 3000

export interface UseAddManualCaptionReturn {
  addManualCaption: () => void
}

/**
 * useAddManualCaption — hook to add one caption clip at the playhead.
 *
 * @returns addManualCaption — call to insert a caption and select it
 */
export function useAddManualCaption(): UseAddManualCaptionReturn {
  const tracks = useEditorStore((s) => s.tracks)
  const playheadPosition = usePlaybackStore((s) => s.playheadPosition)
  const captionStyle = useEditorStore((s) => s.captionStyle)
  const addTrack = useEditorStore((s) => s.addTrack)
  const addClip = useEditorStore((s) => s.addClip)
  const selectClip = useSelectionStore((s) => s.selectClip)

  const addManualCaption = useCallback(() => {
    let captionsTrack = [...tracks]
      .sort((a, b) => a.order - b.order)
      .find((t) => t.type === 'caption')

    if (!captionsTrack) {
      addTrack(CAPTIONS_TRACK_LABEL, 'caption')
      const freshTracks = useEditorStore.getState().tracks
      captionsTrack = [...freshTracks]
        .sort((a, b) => a.order - b.order)
        .find((t) => t.type === 'caption')
    }

    if (!captionsTrack) return

    const id = crypto.randomUUID()
    const duration = DEFAULT_MANUAL_CAPTION_DURATION_MS
    const clip: Clip = {
      id,
      assetId: `caption-manual-${id}`,
      startTime: playheadPosition,
      duration,
      inPoint: 0,
      outPoint: duration,
      speed: 1.0,
      transform: { ...DEFAULT_CLIP_TRANSFORM },
      captionText: '',
      captionStyle: { ...(captionStyle ?? DEFAULT_CAPTION_STYLE) },
    }

    addClip(captionsTrack.id, clip)
    selectClip(clip.id)
  }, [tracks, playheadPosition, captionStyle, addTrack, addClip, selectClip])

  return { addManualCaption }
}
