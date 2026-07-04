/**
 * usePlaybackEngine — bridges the Zustand editor store to the Remotion Player.
 *
 * This hook is the core of Phase 3.5's playback system. It owns the two-way
 * synchronisation contract between the Zustand store (source of truth for
 * intent) and the Remotion Player (source of truth for actual timing):
 *
 *   Store → Player  (intent → execution)
 *   ──────────────────────────────────────────────────────────────────────
 *   isPlaying: true   →  player.play()
 *   isPlaying: false  →  player.pause()
 *   playheadPosition  →  player.seekTo(frame)   ← only when NOT playing
 *                                                 (the player drives its own
 *                                                  frame counter during playback)
 *
 *   Player → Store  (execution → reflection)
 *   ──────────────────────────────────────────────────────────────────────
 *   frameupdate event  →  store.setPlayhead(frameToMs(frame, fps))
 *   pause / ended      →  store.setPlaying(false)
 *
 * Why the Player handles timing during playback:
 *   Remotion's internal `requestAnimationFrame` loop is calibrated to the
 *   composition FPS. Driving it via an external RAF loop would introduce drift.
 *   We call `player.play()` once and let Remotion do the work, mirroring each
 *   frame event back into the store so the timeline ruler stays in sync.
 *
 * Seek loop prevention:
 *   During playback the player emits frameupdate → store.setPlayhead() → which
 *   would retrigger a seekTo() call. We prevent this by guarding the seek
 *   effect with `if (isPlaying) return` — when the player is running, the
 *   store's playheadPosition is a *read* from the player, not a *write* to it.
 *
 *   When paused, playheadPosition changes come from user intent (ruler click,
 *   J/K/L keys, arrow keys) and SHOULD seek the player.
 *
 * End-of-composition behaviour:
 *   The Remotion Player fires 'ended' when it reaches the last frame, then
 *   stops. PreviewCanvas relays this via onPlaybackChange(false), which sets
 *   store.isPlaying = false. The playhead stays at the last frame so the user
 *   can see the final state before seeking back.
 *
 * SOLID: SRP — only manages playback synchronisation.
 *   The keyboard shortcuts that trigger play/pause/seek are in useEditorKeyboard.
 *   The timeline ruler that triggers seek is in TimelineRuler.
 *   The Remotion composition rendering is in ShortComposition.
 * SOLID: DIP — depends on the PreviewCanvasHandle abstraction, not the
 *   Remotion PlayerRef directly.
 *
 * @see PLAN.md Phase 3.5 for playback system requirements
 * @see README.md Section 7.5 "Playback System" for keyboard and seek specs
 * @see PreviewCanvas.tsx for the PreviewCanvasHandle interface
 * @see useEditorKeyboard.ts for keyboard shortcut bindings
 */

import { useEffect, useRef } from 'react'
import { useEditorStore } from '../store/editor-store'
import { usePlaybackStore } from '../store/playback-store'
import { msToFrame } from '../engine/composition-utils'
import type { PreviewCanvasHandle } from '../components/PreviewCanvas'

// ─── Hook ────────────────────────────────────────────────────────────────────

/**
 * Synchronise the Zustand editor store's playback state with the Remotion Player.
 *
 * Mount this hook once in EditorPage alongside `useEditorKeyboard` and
 * `useEditorPersistence`. It requires a ref to the PreviewCanvas's imperative
 * handle so it can call play/pause/seekTo on the Remotion Player.
 *
 * The hook has no return value — its entire surface is side effects.
 *
 * @param canvasRef - Ref to the PreviewCanvas imperative handle.
 *   Created with `useRef<PreviewCanvasHandle>(null)` in EditorPage and
 *   passed to `<PreviewCanvas ref={canvasRef} .../>`.
 *
 * @example
 *   const canvasRef = useRef<PreviewCanvasHandle>(null)
 *   usePlaybackEngine(canvasRef)
 *   // Then pass canvasRef to <PreviewCanvas ref={canvasRef} ... />
 */
export function usePlaybackEngine(
  canvasRef: React.RefObject<PreviewCanvasHandle | null>,
): void {
  // ── Store subscriptions ──
  const isPlaying = usePlaybackStore((s) => s.isPlaying)
  const fps = useEditorStore((s) => s.composition.fps)

  /**
   * Guard ref: whether the Remotion Player is currently the source of
   * playheadPosition updates.
   *
   * Set to `true` immediately before we call `canvas.play()` and reverted
   * to `false` when we call `canvas.pause()`. The seek effect reads this
   * ref to decide whether a playheadPosition change should be forwarded
   * back to the player (user-driven) or ignored (player-driven).
   *
   * Using a ref (not state) because toggling it must not cause a render cycle.
   */
  const playerIsRunningRef = useRef(false)

  // ── Effect 1: Play / Pause ─────────────────────────────────────────────────
  //
  // Fires whenever the `isPlaying` flag in the store changes.
  // Translates the declarative intent (isPlaying) into an imperative
  // call on the Remotion Player.

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    if (isPlaying) {
      // Signal that position updates will now come FROM the player
      playerIsRunningRef.current = true
      canvas.play()
    } else {
      canvas.pause()
      // Signal that position updates now come FROM user intent
      playerIsRunningRef.current = false
    }
  }, [isPlaying, canvasRef])

  // ── Effect 2: Seek ─────────────────────────────────────────────────────────
  //
  // WHAT WENT WRONG (timecode / scrubbing not seeking):
  // We originally did: useEditorStore.subscribe((state, prevState) => { ... }).
  // We assumed Zustand always calls the listener with (newState, prevState).
  // Depending on version or usage, the listener can be invoked with no arguments
  // (just "something changed"). Then state and prevState were undefined, so
  // "state.playheadPosition === prevState.playheadPosition" was undefined === undefined
  // → true → we returned early and NEVER called canvas.seekTo(). So changing the
  // timecode or scrubbing the timeline updated the store but the player never sought.
  //
  // HOW WE FIXED IT:
  // Don't rely on callback arguments. Inside the listener we always read the
  // current store via getState() and we track the previous playhead in a ref.
  // We only seek when playheadPosition actually changed. This works regardless
  // of how (or whether) Zustand passes state/prevState to the listener.

  const prevPlayheadRef = useRef(usePlaybackStore.getState().playheadPosition)

  useEffect(() => {
    prevPlayheadRef.current = usePlaybackStore.getState().playheadPosition

    const unsub = usePlaybackStore.subscribe(() => {
      const state = usePlaybackStore.getState()
      const nextPos = state.playheadPosition
      if (prevPlayheadRef.current === nextPos) return
      prevPlayheadRef.current = nextPos

      if (playerIsRunningRef.current) return

      const canvas = canvasRef.current
      if (!canvas) return

      const frame = msToFrame(nextPos, fps)
      canvas.seekTo(frame)
    })

    return unsub
  }, [fps, canvasRef])
}
