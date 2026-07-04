import { useMemo } from 'react'
import { useEditorStore } from '../../store/editor-store'
import { useSelectionStore } from '../../store/selection-store'
import { findClipById } from '../../engine/composition-utils'
import type { Clip } from '../../types'

/** Tolerance for considering two clip edges to share a seam. Mirrors the
 *  constant in editor-store.ts and absorbs floating-point drift. */
const SEAM_TOLERANCE_MS = 50

export interface TransitionSelection {
  host: Clip
  edge: 'in' | 'out'
  neighbour: Clip | null
  isSeam: boolean
}

export interface InspectorSelection {
  selectionCount: number
  selectedClip: Clip | null
  selectedTrackType: string
  transitionSelection: TransitionSelection | null
}

/**
 * Memoised selector for the Inspector panel. Resolves the single selected clip,
 * its track type, and any active transition selection (with its seam neighbour).
 * Returns null fields when the corresponding selection is empty or stale.
 */
export function useInspectorSelection(): InspectorSelection {
  const tracks = useEditorStore((s) => s.tracks)
  const selectedClipIds = useSelectionStore((s) => s.selectedClipIds)
  const selectedTransition = useSelectionStore((s) => s.selectedTransition)

  const selectionCount = selectedClipIds.length

  const selectedResult =
    selectionCount === 1 ? findClipById(tracks, selectedClipIds[0]) : null

  const selectedClip: Clip | null = selectedResult?.clip ?? null
  const selectedTrackType: string = selectedResult?.track.type ?? ''

  const transitionSelection = useMemo<TransitionSelection | null>(() => {
    if (!selectedTransition) return null
    const host = findClipById(tracks, selectedTransition.clipId)
    if (!host) return null
    const transition =
      selectedTransition.edge === 'in' ? host.clip.transitionIn : host.clip.transitionOut
    if (!transition || transition.type === 'none') return null

    let neighbour: Clip | null = null
    if (selectedTransition.edge === 'in') {
      const start = host.clip.startTime
      for (const other of host.track.clips) {
        if (other.id === host.clip.id) continue
        if (!other.transitionOut) continue
        const otherEnd = other.startTime + other.duration
        if (Math.abs(otherEnd - start) <= SEAM_TOLERANCE_MS) {
          neighbour = other
          break
        }
      }
    } else {
      const end = host.clip.startTime + host.clip.duration
      for (const other of host.track.clips) {
        if (other.id === host.clip.id) continue
        if (!other.transitionIn) continue
        if (Math.abs(other.startTime - end) <= SEAM_TOLERANCE_MS) {
          neighbour = other
          break
        }
      }
    }
    return {
      host: host.clip,
      edge: selectedTransition.edge,
      neighbour,
      isSeam: neighbour !== null,
    }
  }, [selectedTransition, tracks])

  return { selectionCount, selectedClip, selectedTrackType, transitionSelection }
}
