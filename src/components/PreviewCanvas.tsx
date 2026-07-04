/**
 * PreviewCanvas — Remotion Player wrapper with responsive CSS scaling.
 *
 * Wraps the Remotion Player component to display the ShortComposition at the
 * correct aspect ratio (9:16) while fitting within the available viewport space.
 * The composition is rendered at full 1080×1920 resolution internally, then
 * CSS-scaled down to fit the container.
 *
 * Scaling strategy:
 *   The composition is always rendered at native 1080×1920. A CSS `transform: scale()`
 *   is applied to shrink it into the available container. The scale factor is
 *   computed as: min(containerWidth / 1080, containerHeight / 1920).
 *
 *   For example, in a 225×400 container: scale = min(225/1080, 400/1920) = 0.208
 *   This matches the approach used by Viewmax (see Appendix A of README.md).
 *
 * Imperative handle (Phase 3.5):
 *   PreviewCanvas is a forwardRef component that exposes a `PreviewCanvasHandle`
 *   to parent components. The handle wraps the Remotion `PlayerRef` API surface
 *   required by `usePlaybackEngine` to drive play/pause/seek operations.
 *
 *   The parent (EditorPage) creates the ref, passes it here, and also mounts
 *   `usePlaybackEngine(canvasRef)` to keep the Zustand store in sync with the
 *   player. This avoids prop-drilling playback callbacks through the component
 *   tree while keeping EditorPage as the single wiring point.
 *
 * Player event flow (Phase 3.5):
 *   Player fires `frameupdate` → `onFrameChange(frame)` → EditorPage calls
 *   `store.setPlayhead(ms)` → timeline ruler updates.
 *
 *   Player fires `play`/`pause`/`ended` → `onPlaybackChange(bool)` → EditorPage
 *   calls `store.setPlaying(bool)`.
 *
 * The Player component provides:
 *   - Real-time preview of the composition
 *   - Frame-accurate scrubbing via the `inputProps` updates
 *   - Pause/play/seek control (exposed via imperative ref)
 *
 * Integration with Zustand store:
 *   The PreviewCanvas reads track data and caption style from the editor Zustand
 *   store and passes them as `inputProps` to the Player. When the store updates
 *   (e.g., clip moved, track added), the Player re-renders automatically.
 *
 * SOLID: SRP — only handles preview rendering, scaling, and the imperative
 *   player control surface. Playback state management is in the Zustand store.
 *   Playback sync logic is in usePlaybackEngine.
 *
 * @see README.md Section 7.1 "Preview Canvas: Remotion Player"
 * @see README.md Section 7.2 for canvas layout and scaling
 * @see README.md Appendix A for Viewmax's scaling approach (transform: scale(0.208333))
 * @see PLAN.md Phase 3.1 "Set up Remotion Player wrapper component with CSS scaling"
 * @see PLAN.md Phase 3.5 "Remotion Player synced to playhead position"
 * @see usePlaybackEngine.ts for the hook that drives this component's imperative API
 */

import {
  useMemo,
  useRef,
  useState,
  useEffect,
  useCallback,
  forwardRef,
  useImperativeHandle,
  type ComponentType,
} from 'react'
import { Player, type PlayerRef } from '@remotion/player'
import { ShortComposition } from '../engine/ShortComposition'
import type { ShortCompositionProps } from '../engine/ShortComposition'
import { CaptionDragOverlay } from './CaptionDragOverlay'
import { VideoClipDragOverlay } from './VideoClipDragOverlay'
import { SnapGuidesOverlay } from './SnapGuidesOverlay'
import { SlipPreviewOverlay } from './SlipPreviewOverlay'
import type { SnapLine } from './snapping'

/**
 * Cast ShortComposition to a type-compatible component for the Remotion Player.
 * The Player's `component` prop expects `Record<string, unknown>` props, but
 * our ShortComposition has typed props. This cast is safe because inputProps
 * is type-checked separately.
 */
const CompositionComponent = ShortComposition as unknown as ComponentType<Record<string, unknown>>
import type { Track, CaptionStyle, CompositionConfig } from '../types'
import { DEFAULT_COMPOSITION_CONFIG, DEFAULT_CAPTION_STYLE } from '../types'
import { frameToMs, msToDurationInFrames, computeCompositionDuration } from '../engine/composition-utils'
import { useAssetUrlMap } from '../hooks/useAssetUrlMap'
import { usePrefetchedAssetUrls } from '../hooks/usePrefetchedAssetUrls'

/** Throttle playhead sync to this interval (ms). Avoids 30 store updates/sec and cascading re-renders. */
const PLAYHEAD_SYNC_INTERVAL_MS = 100
const PREFETCH_CENTER_SYNC_INTERVAL_MS = 1000
const PREFETCH_LOOKBEHIND_MS = 10_000
const PREFETCH_LOOKAHEAD_MS = 20_000

// ─── Props ───────────────────────────────────────────────────────────────────

export interface PreviewCanvasProps {
  /** Timeline tracks to render in the composition. */
  tracks: Track[]

  /** Global caption style configuration. */
  captionStyle?: CaptionStyle

  /** Composition output configuration (dimensions, FPS). */
  composition?: CompositionConfig

  /** Global audio volume (0–1). Passed to ShortComposition. */
  globalAudioVolume?: number

  /**
   * Callback fired when the player's current frame changes during playback.
   * Used by EditorPage to sync the playhead position in the Zustand store.
   *
   * @param frameNumber - Current frame (0-based)
   */
  onFrameChange?: (frameNumber: number) => void

  /**
   * Callback fired when playback state changes (play/pause/ended).
   * Used by EditorPage to mirror the player's running state in the store.
   *
   * @param isPlaying - Whether the player is currently playing
   */
  onPlaybackChange?: (isPlaying: boolean) => void

  /**
   * When true, we push frameupdate → store (playhead stays in sync during playback).
   * When false (paused), we ignore frameupdate so the store is the single source of truth.
   *
   * WHY: If we always pushed frameupdate, then when the user scrubbed or typed a timecode,
   * we'd set the store, but the player could emit a stale frameupdate (old frame) right
   * after. That would overwrite the store and the timecode would jump back. So when
   * paused we only let user actions (scrub, timecode, keyboard) drive the store.
   */
  isPlaying?: boolean

  /** Optional CSS class name for the outer container. */
  className?: string
}

// ─── Imperative Handle ───────────────────────────────────────────────────────

/**
 * Ref handle exposed by PreviewCanvas for external playback control.
 *
 * EditorPage obtains this handle via `useRef<PreviewCanvasHandle>(null)` and
 * `forwardRef`. It passes the ref to `usePlaybackEngine`, which calls these
 * methods in response to Zustand store changes (isPlaying, playheadPosition).
 *
 * All methods are no-ops when the player hasn't mounted yet (playerRef.current
 * is null), so callers don't need to guard against early invocations.
 *
 * @see usePlaybackEngine.ts — the only consumer of this handle
 * @see PLAN.md Phase 3.5 "Remotion Player synced to playhead position"
 */
export interface PreviewCanvasHandle {
  /** Start playback from the current frame. */
  play: () => void

  /** Pause playback at the current frame. */
  pause: () => void

  /** Toggle between playing and paused. */
  toggle: () => void

  /**
   * Seek to a specific frame number (0-based).
   * Updates the preview to show the composition at that frame.
   *
   * @param frame - Frame number to seek to
   */
  seekTo: (frame: number) => void

  /** Returns whether the player is currently playing. */
  isPlaying: () => boolean
}

// ─── Component ───────────────────────────────────────────────────────────────

/**
 * Remotion Player wrapper with responsive CSS scaling and imperative control.
 *
 * Renders the ShortComposition inside a container that maintains the 9:16
 * aspect ratio. Uses ResizeObserver to detect container size changes and
 * recompute the CSS scale factor.
 *
 * Pass a `ref` (created via `useRef<PreviewCanvasHandle>(null)`) to gain
 * imperative access to play/pause/seekTo. Used exclusively by `usePlaybackEngine`.
 *
 * @example
 *   const canvasRef = useRef<PreviewCanvasHandle>(null)
 *   <PreviewCanvas
 *     ref={canvasRef}
 *     tracks={editorState.tracks}
 *     captionStyle={editorState.captionStyle}
 *     onFrameChange={(frame) => store.setPlayhead(frameToMs(frame, 30))}
 *     onPlaybackChange={(playing) => store.setPlaying(playing)}
 *   />
 */
export const PreviewCanvas = forwardRef<PreviewCanvasHandle, PreviewCanvasProps>(
  function PreviewCanvas(
    {
      tracks,
      captionStyle,
      composition,
      globalAudioVolume = 1,
      onFrameChange,
      onPlaybackChange,
      isPlaying = false,
      className = '',
    }: PreviewCanvasProps,
    ref,
  ) {
    const config = composition ?? DEFAULT_COMPOSITION_CONFIG
    const resolvedCaptionStyle = captionStyle ?? DEFAULT_CAPTION_STYLE

    /** Direct access to the Remotion Player's imperative API. */
    const playerRef = useRef<PlayerRef>(null)
    const containerRef = useRef<HTMLDivElement>(null)
    const [containerSize, setContainerSize] = useState({ width: 0, height: 0 })
    const [prefetchCenterMs, setPrefetchCenterMs] = useState(0)
    // Ephemeral overlay state: snap guidelines currently active during a drag
    // or resize. Pushed by the child overlays via the callback below; rendered
    // by <SnapGuidesOverlay /> as a sibling inside the scaled composition
    // wrapper. Cleared on pointer-up.
    const [snapLines, setSnapLines] = useState<SnapLine[]>([])

    // ── Sync global audio volume to Remotion Player ────────────────────────────
    // The Player has its own volume (0–1) applied to the composition output. Syncing
    // here makes the slider take effect immediately; composition inputProps alone
    // may not re-render the composition while paused.
    useEffect(() => {
      const player = playerRef.current
      if (player && 'setVolume' in player && typeof player.setVolume === 'function') {
        player.setVolume(globalAudioVolume)
      }
    }, [globalAudioVolume])

    // ── Expose Imperative Handle ──────────────────────────────────────────────
    //
    // Wire the PreviewCanvasHandle interface (used by usePlaybackEngine) through
    // to the underlying Remotion PlayerRef. This indirection keeps the parent
    // decoupled from Remotion's API surface — if we ever swap out Remotion, only
    // this file needs updating.

    useImperativeHandle(
      ref,
      () => ({
        play: () => {
          playerRef.current?.play()
        },

        pause: () => {
          playerRef.current?.pause()
        },

        toggle: () => {
          if (playerRef.current?.isPlaying()) {
            playerRef.current.pause()
          } else {
            playerRef.current?.play()
          }
        },

        seekTo: (frame: number) => {
          playerRef.current?.seekTo(frame)
        },

        isPlaying: () => {
          return playerRef.current?.isPlaying() ?? false
        },
      }),
      // No deps — the ref object is stable; playerRef.current is read at call time.
      [],
    )

    // ── Container Size Tracking ───────────────────────────────────────────────

    useEffect(() => {
      const container = containerRef.current
      if (!container) return

      const observer = new ResizeObserver((entries) => {
        const entry = entries[0]
        if (entry) {
          setContainerSize({
            width: entry.contentRect.width,
            height: entry.contentRect.height,
          })
        }
      })

      observer.observe(container)
      return () => observer.disconnect()
    }, [])

    // ── Scale Computation ─────────────────────────────────────────────────────

/**
     * Compute the CSS scale factor to fit the composition within the container.
     */
    const scale = useMemo(() => {
      if (containerSize.width === 0 || containerSize.height === 0) return 0

      const scaleX = containerSize.width / config.width
      const scaleY = containerSize.height / config.height
      return Math.min(scaleX, scaleY)
    }, [containerSize, config.width, config.height])

    // ── Composition Duration ──────────────────────────────────────────────────

    const durationMs = useMemo(
      () => computeCompositionDuration(tracks, config),
      [tracks, config],
    )

    const durationInFrames = useMemo(
      () => msToDurationInFrames(durationMs, config.fps),
      [durationMs, config.fps],
    )

    // ── Asset URL resolution for real video/audio preview ────────────────────
    // Prefetch to blob URLs so playback reads from memory (avoids 100+ requests
    // to the same Supabase URL when Remotion syncs the video).
    const mediaClipCount = useMemo(
      () =>
        tracks.reduce(
          (n, t) =>
            n +
            (t.type === 'video' || t.type === 'audio'
              ? t.clips.filter((c) => !c.assetId.startsWith('caption-')).length
              : 0),
          0,
        ),
      [tracks],
    )
    const { assetUrlMap: resolvedUrls, assetTypeMap } = useAssetUrlMap(tracks)
    const priorityAssetIds = useMemo(() => {
      const seen = new Set<string>()
      const candidates: { assetId: string; distance: number }[] = []
      const windowStart = Math.max(0, prefetchCenterMs - PREFETCH_LOOKBEHIND_MS)
      const windowEnd = prefetchCenterMs + PREFETCH_LOOKAHEAD_MS

      for (const track of tracks) {
        if (track.type !== 'video' && track.type !== 'audio' && track.type !== 'clip_audio') {
          continue
        }
        if (track.type === 'video' && track.visible === false) {
          continue
        }
        for (const clip of track.clips) {
          if (clip.assetId.startsWith('caption-') || seen.has(clip.assetId)) continue
          const clipEnd = clip.startTime + clip.duration
          if (clipEnd < windowStart || clip.startTime > windowEnd) continue
          const distance = Math.max(0, clip.startTime - prefetchCenterMs, prefetchCenterMs - clipEnd)
          seen.add(clip.assetId)
          candidates.push({ assetId: clip.assetId, distance })
        }
      }

      return candidates
        .sort((a, b) => a.distance - b.distance)
        .map((candidate) => candidate.assetId)
    }, [tracks, prefetchCenterMs])
    const { assetUrlMap, progress: prefetchProgress } = usePrefetchedAssetUrls(
      resolvedUrls,
      priorityAssetIds,
    )
    const resolvedCount = Object.keys(resolvedUrls).filter((k) => resolvedUrls[k]).length

    // ── Input Props ───────────────────────────────────────────────────────────

    const inputProps: ShortCompositionProps = useMemo(
      () => ({
        tracks,
        captionStyle: resolvedCaptionStyle,
        assetUrlMap,
        assetTypeMap,
        globalAudioVolume,
      }),
      [tracks, resolvedCaptionStyle, assetUrlMap, assetTypeMap, globalAudioVolume],
    )

    const lastPlayheadSyncRef = useRef(0)
    const lastPrefetchCenterSyncRef = useRef(0)

    const syncPrefetchCenter = useCallback(
      (frame: number, force = false) => {
        const now = Date.now()
        if (!force && now - lastPrefetchCenterSyncRef.current < PREFETCH_CENTER_SYNC_INTERVAL_MS) {
          return
        }
        lastPrefetchCenterSyncRef.current = now
        setPrefetchCenterMs(frameToMs(frame, config.fps))
      },
      [config.fps],
    )

    /**
     * Fired by the Remotion Player on every rendered frame.
     * We only call onFrameChange when isPlaying. When paused we ignore frameupdate
     * so the store is not overwritten by (possibly stale) player events — that
     * keeps scrubbing and timecode input stable. Throttled during playback.
     */
    const handleFrameUpdate = useCallback(
      (event: { detail: { frame: number } }) => {
        syncPrefetchCenter(event.detail.frame)
        if (!isPlaying) return
        const now = Date.now()
        if (now - lastPlayheadSyncRef.current >= PLAYHEAD_SYNC_INTERVAL_MS) {
          lastPlayheadSyncRef.current = now
          onFrameChange?.(event.detail.frame)
        }
      },
      [isPlaying, onFrameChange, syncPrefetchCenter],
    )

    /**
     * Fired when the player transitions to the playing state.
     * Propagated to EditorPage → store.setPlaying(true).
     */
    const handlePlay = useCallback(() => {
      onPlaybackChange?.(true)
    }, [onPlaybackChange])

    /**
     * Fired when the player transitions to the paused state (including at
     * end-of-composition). We flush the current frame to the store so the
     * playhead is exact, then propagate pause.
     */
    const handlePause = useCallback(() => {
      const frame = playerRef.current?.getCurrentFrame()
      if (typeof frame === 'number') {
        syncPrefetchCenter(frame, true)
        onFrameChange?.(frame)
      }
      onPlaybackChange?.(false)
    }, [onFrameChange, onPlaybackChange, syncPrefetchCenter])

    /**
     * Fired when the composition reaches its last frame.
     * Flush current frame to store, then propagate ended (player will also fire pause).
     */
    const handleEnded = useCallback(() => {
      const frame = playerRef.current?.getCurrentFrame()
      if (typeof frame === 'number') {
        syncPrefetchCenter(frame, true)
        onFrameChange?.(frame)
      }
      onPlaybackChange?.(false)
    }, [onFrameChange, onPlaybackChange, syncPrefetchCenter])

    // ── Attach Player Event Listeners ─────────────────────────────────────────

    useEffect(() => {
      const player = playerRef.current
      if (!player) return

      player.addEventListener('frameupdate', handleFrameUpdate)
      player.addEventListener('play', handlePlay)
      player.addEventListener('pause', handlePause)
      player.addEventListener('ended', handleEnded)

      return () => {
        player.removeEventListener('frameupdate', handleFrameUpdate)
        player.removeEventListener('play', handlePlay)
        player.removeEventListener('pause', handlePause)
        player.removeEventListener('ended', handleEnded)
      }
    }, [handleFrameUpdate, handlePlay, handlePause, handleEnded])

    // ── Render ────────────────────────────────────────────────────────────────

    // First-paint blocker: media clips exist but no signed URLs have resolved.
    // There's literally nothing to render yet, so a full overlay is correct.
    const resolvingUrls = mediaClipCount > 0 && resolvedCount === 0

    // Prefetch (blob caching) is happening while signed URLs are already resolved.
    // The Remotion Player can stream over the signed URLs without the blob cache,
    // so the video is watchable right now — covering the canvas would only get in
    // the way. Show a small badge instead and let playback continue underneath.
    const prefetchInProgress = prefetchProgress.total > 0 && !prefetchProgress.done
    const showBackgroundPrefetch = prefetchInProgress && !resolvingUrls
    const prefetchPct = prefetchProgress.total > 0
      ? Math.round((prefetchProgress.loaded / prefetchProgress.total) * 100)
      : 0

    return (
      <div
        ref={containerRef}
        className={`relative flex size-full items-center justify-center overflow-hidden bg-editor-stage ${className}`}
      >
        {resolvingUrls && (
          <div
            className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/80 text-white"
            aria-live="polite"
            aria-label="Loading preview assets"
          >
            <div className="text-sm font-medium">Loading preview…</div>
            <div className="h-2 w-48 overflow-hidden rounded-full bg-white/20">
              <div className="h-full rounded-full bg-white transition-all duration-300" style={{ width: '0%' }} />
            </div>
          </div>
        )}

        {showBackgroundPrefetch && (
          <div
            className="pointer-events-none absolute right-3 top-3 z-10 flex items-center gap-2 rounded-full bg-black/55 px-2.5 py-1 text-[11px] font-medium text-white backdrop-blur-sm shadow-sm"
            aria-live="polite"
            aria-label={`Caching ${prefetchProgress.loaded} of ${prefetchProgress.total} assets`}
            title="Caching assets for smoother playback"
          >
            <span className="relative inline-block h-3 w-3" aria-hidden>
              <span className="absolute inset-0 rounded-full border border-white/30" />
              <span
                className="absolute inset-0 rounded-full border border-transparent border-t-white animate-spin"
                style={{ animationDuration: '0.9s' }}
              />
            </span>
            <span className="tabular-nums">{prefetchProgress.loaded}/{prefetchProgress.total}</span>
            <span className="tabular-nums text-white/70">· {prefetchPct}%</span>
          </div>
        )}
        {scale > 0 && (
          <div
            className="absolute left-1/2 top-1/2"
            style={{
              width: config.width,
              height: config.height,
              transform: `translate(-50%, -50%) scale(${scale})`,
              transformOrigin: 'center center',
            }}
          >
            <Player
              ref={playerRef}
              component={CompositionComponent}
              inputProps={inputProps as unknown as Record<string, unknown>}
              durationInFrames={durationInFrames}
              compositionWidth={config.width}
              compositionHeight={config.height}
              fps={config.fps}
              style={{ width: '100%', height: '100%' }}
              controls={false}
              loop={false}
              // useEditorKeyboard owns the spacebar shortcut. Leaving Remotion's
              // internal binding on would double-toggle (Player toggles + our
              // window handler toggles → net zero).
              spaceKeyToPlayOrPause={false}
              acknowledgeRemotionLicense
            />
            {/* Sits directly above the Player so the canvas snapshot covers
                the underlying video element while the Slip tool is dragging
                — hides Html5Video's per-seek black flash. Mounted only while
                liveSlip is active; transparent and pointer-passthrough. */}
            <SlipPreviewOverlay
              compositionWidth={config.width}
              compositionHeight={config.height}
              rootRef={containerRef}
              assetUrlMap={assetUrlMap}
            />
            {/* Free-placement drag handle for the currently selected caption.
                Lives inside the scaled wrapper so positioning math is in
                composition pixels; pointer deltas are divided by `scale`. */}
            <CaptionDragOverlay
              compositionWidth={config.width}
              compositionHeight={config.height}
              scale={scale}
              fps={config.fps}
              playerRef={playerRef}
              onSnapGuidesChange={setSnapLines}
            />
            {/* Sibling overlay for selected video clips — same drag/corner-resize
                pattern, but bound to `transform.x/y` and `transform.scale`. Only
                one of the two overlays mounts at a time (driven by which clip
                type is currently selected). */}
            <VideoClipDragOverlay
              compositionWidth={config.width}
              compositionHeight={config.height}
              scale={scale}
              assetUrlMap={assetUrlMap}
              onSnapGuidesChange={setSnapLines}
            />
            {/* Snap guidelines for the active drag/resize. Owned by PreviewCanvas
                so both overlays can write into the same lines array; painted
                on top of the drag boxes (zIndex 7) but ignores pointer events. */}
            <SnapGuidesOverlay
              compositionWidth={config.width}
              compositionHeight={config.height}
              scale={scale}
              lines={snapLines}
            />
          </div>
        )}
      </div>
    )
  },
)

// Required for React DevTools display name on forwardRef components
PreviewCanvas.displayName = 'PreviewCanvas'
