/**
 * useEditorKeyboard — keyboard shortcut handler for the NLE.
 *
 * Registers global keyboard listeners for editor shortcuts as specified
 * in the README Section 7.5 "Playback System". All shortcuts are only
 * active when the editor page is mounted and the user is not focused on
 * a text input field.
 *
 * Supported shortcuts:
 *   Space        — play/pause toggle
 *   J            — step backward (1 second)
 *   K            — pause
 *   L            — step forward (1 second)
 *   Left Arrow   — step back one frame
 *   Right Arrow  — step forward one frame
 *   Shift+←/→    — nudge selected clips by 1 frame
 *   Alt+←/→      — nudge selected clips by 10 frames
 *   Home         — jump playhead to start
 *   End          — jump playhead to composition end
 *   Delete/Backspace — delete selected clips
 *   Ctrl+Z       — undo
 *   Ctrl+Shift+Z — redo
 *   Ctrl+Y       — redo (alternative)
 *   Ctrl+A       — select every clip on every track
 *   Ctrl+D       — duplicate selected clips
 *   Ctrl+C       — copy selected clips to scratch buffer
 *   Ctrl+V       — paste scratch buffer at playhead
 *   V            — switch to Select tool
 *   C            — switch to Slice tool (razor cut)
 *   A            — switch to Track Select Forward tool
 *   Shift+A      — switch to Track Select Backward tool
 *   R            — switch to Rate Stretch tool
 *   Y            — switch to Slip tool
 *   S            — split selected clip(s) at playhead
 *   Shift+S      — toggle snap-to-edges
 *   G            — toggle keyframe graph for the selected clip
 *   \            — fit timeline to window (reset zoom)
 *   + / =        — zoom in
 *   −            — zoom out
 *   ?            — open / close the shortcut cheatsheet
 *   Escape       — deselect all + return to Select tool
 *
 * Input guard:
 *   Shortcuts are suppressed when the active element is an <input>,
 *   <textarea>, or [contenteditable] to avoid conflicts with text editing.
 *
 * SOLID: SRP — only handles keyboard event binding. The actual actions
 *   are delegated to the Zustand store via useTimeline and usePlayback hooks.
 *
 * @see README.md Section 7.5 "Keyboard shortcuts (desktop)"
 * @see PLAN.md Phase 3.2 for Select/Slice tool requirements
 * @see PLAN.md Phase 3.5 for shortcut requirements
 */

import { useEffect } from 'react'
import { useEditorStore } from '../store/editor-store'
import { useSelectionStore } from '../store/selection-store'
import { usePlaybackStore } from '../store/playback-store'
import { useUIStore } from '../store/ui-store'

// ─── Hook Implementation ─────────────────────────────────────────────────────

/**
 * Register keyboard shortcuts for the editor.
 *
 * Call this hook once in the EditorPage component. It sets up event
 * listeners on mount and cleans them up on unmount.
 */
export function useEditorKeyboard(): void {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      // Ignore shortcuts when focused on text inputs
      const target = event.target as HTMLElement
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      ) {
        return
      }

      const store = useEditorStore.getState()
      const selection = useSelectionStore.getState()
      const playback = usePlaybackStore.getState()
      const ui = useUIStore.getState()
      const isCtrl = event.ctrlKey || event.metaKey

      switch (event.key) {
        case ' ':
          event.preventDefault()
          playback.togglePlayback()
          break

        case 'j':
        case 'J':
          event.preventDefault()
          // Step backward 1 second
          playback.setPlayhead(Math.max(0, playback.playheadPosition - 1000))
          break

        case 'k':
        case 'K':
          event.preventDefault()
          playback.setPlaying(false)
          break

        case 'l':
        case 'L':
          event.preventDefault()
          // Step forward 1 second
          playback.setPlayhead(playback.playheadPosition + 1000)
          break

        case 'ArrowLeft':
        case 'ArrowRight': {
          // Three behaviours stacked on the arrows:
          //   Shift+Arrow → nudge the selected clip(s) by one frame
          //   Alt+Arrow   → nudge the selected clip(s) by ten frames
          //   bare Arrow  → step the playhead one frame (existing behaviour)
          //
          // The nudge variants only fire when there's an actual clip selection
          // so a stray modifier with nothing selected falls through to the
          // playhead step rather than no-oping silently.
          event.preventDefault()
          const frameMs = 1000 / store.composition.fps
          const direction = event.key === 'ArrowLeft' ? -1 : 1
          const hasClipSelection = selection.selectedClipIds.length > 0
          if (hasClipSelection && (event.shiftKey || event.altKey)) {
            const frames = event.altKey ? 10 : 1
            store.nudgeClips(selection.selectedClipIds, direction * frames * frameMs)
          } else if (direction === -1) {
            playback.setPlayhead(Math.max(0, playback.playheadPosition - frameMs))
          } else {
            playback.setPlayhead(playback.playheadPosition + frameMs)
          }
          break
        }

        case 'Home':
          event.preventDefault()
          playback.setPlayhead(0)
          break

        case 'End': {
          event.preventDefault()
          // Composition.durationMs is derived per-render from track content,
          // so compute the actual end at the moment of the keypress rather
          // than trusting a possibly-stale field.
          let endMs = 0
          for (const track of store.tracks) {
            for (const clip of track.clips) {
              const clipEnd = clip.startTime + clip.duration
              if (clipEnd > endMs) endMs = clipEnd
            }
          }
          if (endMs > 0) playback.setPlayhead(endMs)
          break
        }

        case 'Delete':
        case 'Backspace':
          if (selection.selectedKeyframes.length > 0) {
            event.preventDefault()
            // Group selected keyframes by (clipId, propertyId) so each track
            // gets one store action — keeps the history label clean and
            // avoids a flurry of pushes.
            const grouped = new Map<string, string[]>()
            for (const ref of selection.selectedKeyframes) {
              const key = `${ref.clipId}::${ref.propertyId}`
              const list = grouped.get(key) ?? []
              list.push(ref.keyframeId)
              grouped.set(key, list)
            }
            store.beginHistoryTransaction('Delete keyframes')
            for (const [key, ids] of grouped) {
              const [clipId, propertyId] = key.split('::') as [string, string]
              store.deleteKeyframes(clipId, propertyId as typeof selection.selectedKeyframes[number]['propertyId'], ids)
            }
            store.commitHistoryTransaction()
            selection.clearKeyframeSelection()
          } else if (selection.selectedTransition) {
            event.preventDefault()
            const sel = selection.selectedTransition
            // For seam transitions clear both halves so we don't leave an
            // orphan in/out animation on the neighbour clip.
            const SEAM_TOL = 50
            const hostTrack = store.tracks.find((t) =>
              t.clips.some((c) => c.id === sel.clipId),
            )
            const hostClip = hostTrack?.clips.find((c) => c.id === sel.clipId)
            if (hostTrack && hostClip) {
              const neighbour = (() => {
                if (sel.edge === 'in') {
                  const start = hostClip.startTime
                  return (
                    hostTrack.clips.find(
                      (other) =>
                        other.id !== hostClip.id &&
                        other.transitionOut &&
                        Math.abs(other.startTime + other.duration - start) <= SEAM_TOL,
                    ) ?? null
                  )
                }
                const end = hostClip.startTime + hostClip.duration
                return (
                  hostTrack.clips.find(
                    (other) =>
                      other.id !== hostClip.id &&
                      other.transitionIn &&
                      Math.abs(other.startTime - end) <= SEAM_TOL,
                  ) ?? null
                )
              })()
              store.setClipTransition(sel.clipId, sel.edge, null)
              if (neighbour) {
                store.setClipTransition(
                  neighbour.id,
                  sel.edge === 'in' ? 'out' : 'in',
                  null,
                )
              }
            } else {
              store.setClipTransition(sel.clipId, sel.edge, null)
            }
            selection.selectTransition(null)
          } else if (selection.selectedClipIds.length > 0) {
            event.preventDefault()
            store.deleteClips(selection.selectedClipIds)
          }
          break

        case 'z':
        case 'Z':
          if (isCtrl && event.shiftKey) {
            event.preventDefault()
            store.redo()
          } else if (isCtrl) {
            event.preventDefault()
            store.undo()
          }
          break

        case 'y':
        case 'Y':
          // Ctrl/Cmd+Y → redo. Bare Y → Slip tool (Premiere parity). The two
          // gestures live on the same key so they have to be merged into one
          // case — duplicate labels would silently shadow each other.
          if (isCtrl) {
            event.preventDefault()
            store.redo()
          } else {
            event.preventDefault()
            ui.setToolMode('slip')
          }
          break

        case 'Escape':
          // Deselect all clips and return to the default Select tool
          selection.deselectAll()
          ui.setToolMode('select')
          break

        case 'v':
        case 'V':
          // Cmd/Ctrl+V → paste at playhead. Bare V → Select tool.
          if (isCtrl) {
            event.preventDefault()
            store.pasteClips(playback.playheadPosition)
          } else {
            event.preventDefault()
            ui.setToolMode('select')
          }
          break

        case 'c':
        case 'C':
          // Cmd/Ctrl+C → copy clips to scratch buffer. Bare C → Slice tool.
          if (isCtrl) {
            event.preventDefault()
            if (selection.selectedClipIds.length > 0) {
              store.copyClips(selection.selectedClipIds)
            }
          } else {
            event.preventDefault()
            ui.setToolMode('slice')
          }
          break

        case 'a':
        case 'A':
          // Cmd/Ctrl+A → select every clip across every track.
          // Bare A / Shift+A → Track Select Forward / Backward.
          if (isCtrl) {
            event.preventDefault()
            const ids: string[] = []
            for (const track of store.tracks) {
              for (const clip of track.clips) ids.push(clip.id)
            }
            selection.selectAll(ids)
          } else {
            event.preventDefault()
            ui.setToolMode(
              event.shiftKey ? 'track-select-backward' : 'track-select-forward',
            )
          }
          break

        case 'r':
        case 'R':
          // R = Rate Stretch tool (Premiere parity).
          // Skip Ctrl+R — that's the browser's hard-reload, and stealing it
          // mid-edit would make development needlessly painful.
          if (!isCtrl) {
            event.preventDefault()
            ui.setToolMode('rate-stretch')
          }
          break

        case 'g':
        case 'G':
          // G = toggle the advanced keyframe graph for the active clip.
          // Only meaningful when exactly one clip is selected (the graph is
          // anchored to a specific clip's time range). If nothing or a
          // multi-selection is active, swallow the key and do nothing.
          if (!isCtrl && selection.selectedClipIds.length === 1) {
            event.preventDefault()
            const clipId = selection.selectedClipIds[0]
            // Skip the toggle for clips whose track type can't be keyframed
            // (audio / clip_audio) — the affordance isn't shown there either.
            const hostTrack = store.tracks.find((t) =>
              t.clips.some((c) => c.id === clipId),
            )
            if (hostTrack && (hostTrack.type === 'video' || hostTrack.type === 'caption')) {
              ui.toggleKeyframeGraph(clipId)
            }
          }
          break

        case 's':
        case 'S':
          // Shift+S → snap toggle. Bare S → split selected clip(s) at the
          // playhead. The two gestures share the key because the snap toggle
          // is rare and we want the bare key for the high-frequency split.
          if (isCtrl) break
          if (event.shiftKey) {
            event.preventDefault()
            ui.toggleSnap()
            break
          }
          event.preventDefault()
          if (selection.selectedClipIds.length === 0) break
          {
            // Split every selected clip whose timespan straddles the playhead.
            // Group into one history entry so the operation reads as a single
            // user action.
            const hits: string[] = []
            const playheadMs = playback.playheadPosition
            for (const id of selection.selectedClipIds) {
              for (const track of store.tracks) {
                const clip = track.clips.find((c) => c.id === id)
                if (!clip) continue
                if (
                  playheadMs > clip.startTime &&
                  playheadMs < clip.startTime + clip.duration
                ) {
                  hits.push(id)
                }
                break
              }
            }
            if (hits.length === 0) break
            store.beginHistoryTransaction('Split clips at playhead')
            for (const id of hits) store.splitClip(id, playheadMs)
            store.commitHistoryTransaction()
          }
          break

        case 'd':
        case 'D':
          // Cmd/Ctrl+D → duplicate. Bare D has no meaning today, so we only
          // intercept the modified variant.
          if (isCtrl) {
            event.preventDefault()
            if (selection.selectedClipIds.length > 0) {
              store.duplicateClips(selection.selectedClipIds)
            }
          }
          break

        case 'x':
        case 'X':
          // Cmd/Ctrl+X → cut. Equivalent to copy + delete in one user action.
          if (isCtrl && selection.selectedClipIds.length > 0) {
            event.preventDefault()
            const ids = selection.selectedClipIds
            store.copyClips(ids)
            store.deleteClips(ids)
          }
          break

        case '\\':
          // Fit timeline to window — mirrors Premiere's `\`. The actual fit
          // (zoom calc against viewport width + scroll reset) lives in the
          // Timeline component; this just asks for it.
          event.preventDefault()
          ui.fitTimelineToWindow()
          break

        case '+':
        case '=':
          // `+` and `=` share a key on US keyboards; bind both so the user
          // doesn't have to hold Shift to zoom in. Matches the PlaybackBar's
          // ±20px/s zoom step and clamp.
          event.preventDefault()
          ui.setZoomLevel(Math.min(500, ui.zoomLevel + 20))
          break

        case '-':
        case '_':
          // Bind both `-` and `_` (Shift+-) so either modifier state works.
          event.preventDefault()
          ui.setZoomLevel(Math.max(10, ui.zoomLevel - 20))
          break

        case '?':
          // Toggle the cheatsheet. On US keyboards `?` requires Shift+`/`,
          // but the resulting `event.key` is just `?`, so we don't have to
          // check the shift modifier explicitly.
          event.preventDefault()
          ui.setCheatsheetOpen(!ui.cheatsheetOpen)
          break

      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])
}
