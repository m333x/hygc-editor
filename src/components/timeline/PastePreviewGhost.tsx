/**
 * PastePreviewGhost — translucent silhouettes of clipboard contents at the
 * current playhead, scoped to a single track lane.
 *
 * Acts as a "this is where Ctrl+V will land" affordance. The clipboard buffer
 * is otherwise invisible — without this ghost, users have to mentally simulate
 * the paste before committing to it. Mirrors CapCut's paste-cursor and
 * Premiere's source-monitor overlay in spirit, scaled down to a low-contrast
 * dashed outline so it never competes with real clips for visual priority.
 *
 * Why this is a separate component (instead of inlining in `TrackContent`):
 *   - Subscribes to `playheadPosition`, which updates ~30×/sec during
 *     playback. Co-located inside `TrackContent` would force the entire lane
 *     (every clip, every keyframe graph) to re-render on each tick. Isolating
 *     the subscription here keeps the lane calm.
 *   - Renders zero DOM when the clipboard is empty or when the lane's track
 *     type isn't in the buffer — the common case during normal editing.
 */

import { memo } from 'react'

import { usePlaybackStore } from '../../store/playback-store'
import { useUIStore } from '../../store/ui-store'
import type { TrackType } from '../../types'
import { TRACK_ROW_HEIGHT, TRACK_TYPE_CONFIG } from './timeline-utils'

export interface PastePreviewGhostProps {
  trackType: TrackType
  pxPerMs: number
}

export const PastePreviewGhost = memo(function PastePreviewGhost({
  trackType,
  pxPerMs,
}: PastePreviewGhostProps) {
  const preview = useUIStore((s) => s.clipboardPreview)
  const playhead = usePlaybackStore((s) => s.playheadPosition)

  if (!preview || preview.entries.length === 0) return null

  // Filter entries by lane type up-front — a video-typed clipboard never paints
  // a ghost on an audio or caption lane, matching `pasteClips`'s routing.
  const entries = preview.entries.filter((e) => e.sourceTrackType === trackType)
  if (entries.length === 0) return null

  const tape = TRACK_TYPE_CONFIG[trackType]

  return (
    <>
      {entries.map((entry, i) => {
        // pasteClips clamps the landing position to 0; mirror that here so the
        // ghost never pokes into negative space at the timeline origin.
        const startMs = Math.max(0, playhead + entry.offsetMs)
        const left = startMs * pxPerMs
        // Keep a minimum visual width at far-out zoom — same floor used for
        // expanded keyframe graphs — otherwise sub-millisecond entries vanish.
        const width = Math.max(8, entry.durationMs * pxPerMs)
        return (
          <div
            key={i}
            data-paste-preview-ghost
            className={`
              absolute pointer-events-none rounded border-2 border-dashed
              ${tape.clipClass}
              opacity-40
            `}
            style={{
              left,
              width,
              top: 6,
              height: TRACK_ROW_HEIGHT - 12,
              zIndex: 4,
            }}
            aria-hidden
          />
        )
      })}
    </>
  )
})
