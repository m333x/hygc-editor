/**
 * useCaptionGeneration — hook that transcribes voiceover audio and places
 * caption clips on the Captions track.
 *
 * This hook is the client-side orchestration layer for Phase 3.8's caption
 * generation feature. It:
 *
 *   1. Locates all audio clips on Voiceover-type tracks in the timeline.
 *   2. For each audio clip, calls the `generate-transcription` Edge Function
 *      with the clip's asset public URL.
 *   3. Receives a Transcript with word-level timestamps and pre-grouped segments.
 *   4. Creates caption Clip objects from the segments, offset by the voiceover
 *      clip's `startTime` on the timeline.
 *   5. Dispatches `addClip` for each caption to the Captions track in the
 *      Zustand editor store.
 *
 * ─── Timeline alignment ───────────────────────────────────────────────────────
 *
 *   Deepgram returns timestamps relative to the start of the audio file.
 *   The voiceover clip on the timeline starts at `clip.startTime` ms.
 *   Therefore, each caption segment's timeline position is:
 *
 *     captionStart = voiceoverClip.startTime + segment.startMs
 *     captionEnd   = voiceoverClip.startTime + segment.endMs
 *
 *   This ensures captions are synchronised to the voiceover clip regardless
 *   of where the clip is placed on the timeline.
 *
 * ─── Track identification ─────────────────────────────────────────────────────
 *
 *   Voiceover track — the first 'audio' track (ordered by `track.order`).
 *   Captions track  — the first 'caption' track (ordered by `track.order`).
 *
 *   If no Captions track exists when generation runs, the hook attempts to add
 *   one via `addTrack('Captions', 'caption')`. This handles projects that were
 *   created before the default tracks included a Captions track.
 *
 * ─── Asset URL resolution ─────────────────────────────────────────────────────
 *
 *   The hook needs the public URL for each audio clip's source asset. Clips
 *   store only an `assetId`, so the hook uses the Supabase client to look up
 *   the asset record. This is a one-time lookup per generation, not per render.
 *
 * ─── Error handling ──────────────────────────────────────────────────────────
 *
 *   - No voiceover clips: `canGenerate` returns false; button is disabled.
 *   - Asset URL not found: per-clip error is logged; other clips still process.
 *   - Edge Function error: the error message is stored in `error` state.
 *   - Partial success: any successfully generated captions are added to the
 *     track even if some clips fail.
 *
 * ─── Existing captions ───────────────────────────────────────────────────────
 *
 *   The hook does NOT clear existing caption clips before generating new ones.
 *   This is intentional: the user may have manually edited some captions.
 *   A future enhancement could add a "Replace all captions" confirmation dialog.
 *
 * SOLID: SRP — only orchestrates transcription and caption clip placement.
 *   No UI rendering, no direct API calls (delegated to Supabase functions client).
 * SOLID: DIP — depends on the editor store interface and the Supabase client
 *   abstraction, not on Deepgram or any other concrete transcription service.
 *
 * @see README.md Section 7.6 "Caption System" for specification
 * @see PLAN.md Phase 3.8 for implementation requirements
 * @see generate-transcription/index.ts for the Edge Function
 * @see editor-store.ts for addClip, addTrack actions
 * @see types.ts for Clip, CaptionStyle, DEFAULT_CLIP_TRANSFORM, DEFAULT_CAPTION_STYLE
 */

import { useState, useCallback } from 'react'
import { useEditorStore } from '../store/editor-store'
import { useEditorHost } from '../host'
import { DEFAULT_CLIP_TRANSFORM, DEFAULT_CAPTION_STYLE } from '../types'
import type { Clip } from '../types'

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * The default label for newly auto-created Captions tracks.
 * Matches the label used by `createDefaultTracks()` in types.ts.
 */
const CAPTIONS_TRACK_LABEL = 'Captions'

/**
 * Default caption clip duration (ms) used when a segment has zero or negative
 * computed duration. Prevents zero-width clips that would be invisible on the
 * timeline.
 */
const MIN_CAPTION_DURATION_MS = 100

// ─── Return Type ─────────────────────────────────────────────────────────────

/**
 * Return value of `useCaptionGeneration`.
 */
export interface UseCaptionGenerationReturn {
  /**
   * Whether caption generation is currently in progress.
   * True while Edge Function calls are outstanding.
   */
  isGenerating: boolean

  /**
   * The most recent error message, or null if no error.
   * Cleared automatically when `generateCaptions` is called again.
   */
  error: string | null

  /**
   * Whether the generate action is available.
   *
   * True when there is at least one audio track with at least one clip.
   * The UI should disable the "Generate Captions" button when this is false
   * and show a tooltip explaining that a voiceover is needed first.
   */
  canGenerate: boolean

  /**
   * Number of caption clips created during the most recent generation run.
   * Useful for showing a success toast: "Created 12 captions".
   * Resets to 0 at the start of each new generation.
   */
  lastGeneratedCount: number

  /**
   * Trigger caption generation.
   *
   * Finds voiceover clips on the timeline, transcribes each one, and places
   * caption clips on the Captions track. Resolves when all clips have been
   * processed (with partial success allowed).
   *
   * @param options.maxWordsPerSegment - Words per caption segment (default: 4)
   * @param options.language           - Audio language ISO 639-1 code (default: 'en')
   */
  generateCaptions(options?: {
    maxWordsPerSegment?: number
    language?: string
  }): Promise<void>
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * useCaptionGeneration — caption generation orchestration hook.
 *
 * @param projectId - The current project ID, used to scope asset lookups.
 *
 * @example
 *   const { isGenerating, error, canGenerate, generateCaptions } =
 *     useCaptionGeneration(projectId)
 *
 *   // Trigger from a button in EditorToolbar or CaptionStylePanel:
 *   <button disabled={!canGenerate || isGenerating} onClick={() => generateCaptions()}>
 *     {isGenerating ? 'Generating…' : 'Generate Captions'}
 *   </button>
 */
export function useCaptionGeneration(projectId?: string): UseCaptionGenerationReturn {
  const host = useEditorHost()

  // ── Store selectors ──

  const tracks = useEditorStore((s) => s.tracks)
  const addClip = useEditorStore((s) => s.addClip)
  const addTrack = useEditorStore((s) => s.addTrack)

  // ── Local state ──

  const [isGenerating, setIsGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastGeneratedCount, setLastGeneratedCount] = useState(0)

  // ── Derived values ──

  /**
   * Identify the first audio track that has at least one clip.
   * This is considered the "Voiceover" track for caption generation.
   *
   * Future: support multi-track transcription by iterating all audio tracks.
   */
  const voiceoverTrack = [...tracks]
    .sort((a, b) => a.order - b.order)
    .find((t) => t.type === 'audio' && t.clips.length > 0)

  // Requires the host transcription capability — the button hides without it.
  const canGenerate =
    !!host.transcribeAudio && voiceoverTrack !== undefined && voiceoverTrack.clips.length > 0

  // ── Main action ──

  const generateCaptions = useCallback(
    async (options?: { maxWordsPerSegment?: number; language?: string }) => {
      if (!canGenerate || isGenerating) return
      const transcribeAudio = host.transcribeAudio
      if (!transcribeAudio) return

      setIsGenerating(true)
      setError(null)
      setLastGeneratedCount(0)

      try {
        // ── Find or create the Captions track ──
        //
        // The Captions track is identified by its type ('caption'). If none
        // exists, we create one before adding clips so that addClip() succeeds.
        // The store's addTrack() gives it a new UUID and the next available order.

        let captionsTrack = [...tracks]
          .sort((a, b) => a.order - b.order)
          .find((t) => t.type === 'caption')

        if (!captionsTrack) {
          addTrack(CAPTIONS_TRACK_LABEL, 'caption')
          // The store update is synchronous (Zustand), so we can re-read immediately.
          // However, 'tracks' in closure is stale — re-read from the store.
          // useEditorStore.getState() bypasses React re-render to get fresh state.
          const freshTracks = useEditorStore.getState().tracks
          captionsTrack = [...freshTracks]
            .sort((a, b) => a.order - b.order)
            .find((t) => t.type === 'caption')
        }

        if (!captionsTrack) {
          setError('Could not find or create a Captions track.')
          return
        }

        const captionsTrackId = captionsTrack.id

        // ── Get the voiceover clips to transcribe ──
        //
        // `voiceoverTrack` is derived from the tracks snapshot at the time
        // this hook was called. Because generation is triggered by a button click
        // (not during render), this is the correct set of clips to process.

        if (!voiceoverTrack) return

        const voiceoverClips = [...voiceoverTrack.clips].sort(
          (a, b) => a.startTime - b.startTime,
        )

        let totalCreated = 0

        // ── Process each voiceover clip ──

        for (const voiceClip of voiceoverClips) {
          // Resolve the clip's audio URL through the host
          const { assetUrlMap } = await host.resolveAssetUrls([voiceClip.assetId])
          const audioUrl = assetUrlMap[voiceClip.assetId]

          if (!audioUrl) {
            console.warn(
              `[useCaptionGeneration] Cannot resolve asset URL for clip ${voiceClip.id}`,
            )
            continue // Skip this clip; process others
          }

          // ── Transcribe through the host capability ──

          let transcript: { segments: Array<{ id: string; startMs: number; endMs: number; text: string }> }
          try {
            transcript = await transcribeAudio({
              audioUrl,
              projectId,
              options: {
                maxWordsPerSegment: options?.maxWordsPerSegment ?? 4,
                language: options?.language ?? 'en',
                punctuate: true,
                filterProfanity: false,
              },
            })
          } catch (fnError) {
            const message = fnError instanceof Error ? fnError.message : 'Transcription failed'
            console.error(`[useCaptionGeneration] Transcription error for clip ${voiceClip.id}:`, message)
            setError(message)
            continue
          }

          // ── Place caption clips on the Captions track ──
          //
          // Each segment becomes one caption clip. Timeline position is computed
          // as voiceoverClip.startTime + segment.startMs (relative to audio start).

          for (const segment of transcript.segments) {
            const captionStart = voiceClip.startTime + segment.startMs
            const captionDuration = Math.max(
              MIN_CAPTION_DURATION_MS,
              segment.endMs - segment.startMs,
            )

            const captionClip: Clip = {
              id: crypto.randomUUID(),
              // Virtual assetId for caption clips (not a real storage asset)
              assetId: `caption-${segment.id}`,
              startTime: captionStart,
              duration: captionDuration,
              inPoint: 0,
              outPoint: captionDuration,
              speed: 1.0,
              transform: { ...DEFAULT_CLIP_TRANSFORM },
              captionText: segment.text,
              // Inherit the global caption style (set by CaptionStylePanel).
              // Individual clips can be overridden in the InspectorPanel.
              captionStyle: { ...DEFAULT_CAPTION_STYLE },
            }

            addClip(captionsTrackId, captionClip)
            totalCreated++
          }
        }

        setLastGeneratedCount(totalCreated)

        if (totalCreated === 0 && !error) {
          setError('No captions were generated. Check that the voiceover clips have valid audio URLs.')
        }
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : 'Unknown error'
        console.error('[useCaptionGeneration] Unexpected error:', caught)
        setError(`Caption generation failed: ${message}`)
      } finally {
        setIsGenerating(false)
      }
    },
    [canGenerate, isGenerating, tracks, voiceoverTrack, addClip, addTrack, projectId, error, host],
  )

  return {
    isGenerating,
    error,
    canGenerate,
    lastGeneratedCount,
    generateCaptions,
  }
}
