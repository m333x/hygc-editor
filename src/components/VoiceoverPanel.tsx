/**
 * VoiceoverPanel — left-rail surface for recording your own voiceover.
 *
 * The "AI Voice" tile in the AI Generate tab links to a generator for synthetic
 * voiceovers. This panel is the human counterpart: hit Record, the timeline
 * starts playing, you narrate, you stop. The recording is uploaded as an audio
 * asset and dropped on the Voiceover track at the playhead position from which
 * recording started — the same flow a creator would use in CapCut, Premiere,
 * or Descript.
 *
 * All MediaRecorder / AnalyserNode plumbing lives in `useVoiceoverRecorder`.
 * This component is just the UI on top of that hook, plus the save-to-timeline
 * commit step (upload → place clip).
 *
 * SOLID: SRP — owns the recording UI and the commit step only. The recorder
 *   hook owns the browser APIs; the editor store decides where the clip lands.
 */

import { useCallback, useState } from 'react'
import { Mic, Square, Pause, Play, RotateCcw, Trash2, Loader2, Info } from 'lucide-react'

import { useEditorHost } from '../host'
import { useEditorStore } from '../store/editor-store'
import { usePlaybackStore } from '../store/playback-store'
import { useVoiceoverRecorder } from '../hooks/useVoiceoverRecorder'
import type { VoiceoverRecorderResult } from '../hooks/useVoiceoverRecorder'
import { editorToast } from './EditorToast'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
}

function mimeToExt(mime: string): string {
  if (mime.includes('mp4')) return 'm4a'
  if (mime.includes('ogg')) return 'ogg'
  if (mime.includes('wav')) return 'wav'
  return 'webm'
}

/**
 * MediaRecorder returns codec-suffixed types like `audio/webm;codecs=opus`.
 * Storage and the asset service accept the bare media type — strip everything
 * from the first `;` onward so the File we upload carries the canonical MIME.
 */
function canonicalMime(mime: string): string {
  return mime.split(';')[0].trim().toLowerCase() || 'audio/webm'
}

function timestampSuffix(): string {
  const d = new Date()
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`
}

// ─── Component ───────────────────────────────────────────────────────────────

export interface VoiceoverPanelProps {
  /** Required for uploads. When undefined, controls fall back to disabled. */
  projectId?: string
}

export function VoiceoverPanel({ projectId }: VoiceoverPanelProps) {
  const recorder = useVoiceoverRecorder()
  const { useAssetLibrary } = useEditorHost()
  const assets = useAssetLibrary(projectId)
  const [reviewUrl, setReviewUrl] = useState<string | null>(null)
  const [committing, setCommitting] = useState(false)

  // Build (and tear down) the preview URL when a result becomes available.
  // useState + manual revoke is cleaner than useEffect because we want the URL
  // to disappear the moment the user discards or commits — without waiting for
  // a render cycle.
  function setResultPreview(result: VoiceoverRecorderResult | null) {
    setReviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return result ? URL.createObjectURL(result.blob) : null
    })
  }

  // ─── Commit: upload + place clip ───────────────────────────────────────────

  const commitRecording = useCallback(async () => {
    if (!recorder.result || !projectId) return
    setCommitting(true)
    try {
      const { blob, mimeType, durationMs, startedAtTimelineMs } = recorder.result
      const canonical = canonicalMime(mimeType)
      const file = new File(
        [blob],
        `Voiceover ${timestampSuffix()}.${mimeToExt(canonical)}`,
        { type: canonical },
      )

      const asset = await assets.upload(file, projectId, 'audio', { duration_ms: durationMs })
      if (!asset) return // useAssets surfaces the error in `assets.error`

      const tracks = useEditorStore.getState().tracks
      let target =
        tracks.find((t) => t.type === 'audio' && /voiceover/i.test(t.label)) ??
        tracks.find((t) => t.type === 'audio')

      if (!target) {
        useEditorStore.getState().addTrack('Voiceover', 'audio')
        target = useEditorStore
          .getState()
          .tracks.find((t) => t.type === 'audio' && /voiceover/i.test(t.label))
      }
      if (!target) {
        editorToast.info('Add an audio track first, then save the recording.')
        return
      }

      useEditorStore.getState().addAssetClipToTrack(target.id, {
        assetId: asset.id,
        assetType: 'audio',
        startTime: startedAtTimelineMs,
        duration: durationMs,
        sourceDurationMs: durationMs,
      })

      usePlaybackStore.getState().setPlayhead(startedAtTimelineMs + durationMs)
      editorToast.success('Voiceover saved to timeline')
      setResultPreview(null)
      recorder.discard()
    } finally {
      setCommitting(false)
    }
  }, [assets, projectId, recorder])

  // ─── Stop wrapper that captures the result into the preview URL ────────────

  const handleStop = useCallback(async () => {
    const result = await recorder.stopRecording()
    setResultPreview(result)
  }, [recorder])

  const handleDiscard = useCallback(() => {
    setResultPreview(null)
    recorder.discard()
  }, [recorder])

  const handleReRecord = useCallback(async () => {
    setResultPreview(null)
    recorder.discard()
    await recorder.startRecording()
  }, [recorder])

  // ─── Status-derived UI flags ───────────────────────────────────────────────

  const isCountdown = recorder.status === 'countdown'
  const isRecording = recorder.status === 'recording'
  const isPaused = recorder.status === 'paused'
  const isProcessing = recorder.status === 'processing'
  const isReview = recorder.status === 'review' && recorder.result
  const isUnsupported = recorder.status === 'unsupported'
  const isDenied = recorder.status === 'permission-denied'

  const canRecord = !isUnsupported && !isDenied && !isProcessing && !!projectId

  return (
    <div className="flex-1 overflow-y-auto p-3 space-y-3">
      {/* Header */}
      <div>
        <h2 className="text-xs font-semibold text-foreground">Record voiceover</h2>
        <p className="text-[10px] text-muted-foreground mt-0.5 leading-snug">
          Narrate over your timeline. The recording lands on the Voiceover track
          where the playhead is now.
        </p>
      </div>

      {/* Device picker — only when there's a real choice. */}
      {recorder.devices.length > 1 && !isRecording && !isPaused && !isCountdown && (
        <label className="block">
          <span className="text-[10px] font-medium text-muted-foreground">
            Microphone
          </span>
          <select
            value={recorder.selectedDeviceId ?? ''}
            onChange={(e) => recorder.setSelectedDeviceId(e.target.value)}
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-[11px] text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            {recorder.devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || 'Microphone'}
              </option>
            ))}
          </select>
        </label>
      )}

      {/* Permission / capability messages */}
      {isUnsupported && (
        <div className="p-2 rounded-md bg-destructive/10 border border-destructive/20">
          <p className="text-[10px] text-destructive leading-snug">
            Recording requires a modern browser on a secure (HTTPS) connection.
          </p>
        </div>
      )}
      {isDenied && (
        <div className="p-2 rounded-md bg-destructive/10 border border-destructive/20">
          <p className="text-[10px] text-destructive leading-snug">
            Microphone access blocked. Enable it in your browser settings and
            reload the page.
          </p>
        </div>
      )}
      {recorder.error && !isUnsupported && !isDenied && (
        <div className="p-2 rounded-md bg-destructive/10 border border-destructive/20">
          <p className="text-[10px] text-destructive leading-snug">{recorder.error}</p>
        </div>
      )}
      {assets.error && (
        <div className="p-2 rounded-md bg-destructive/10 border border-destructive/20">
          <p className="text-[10px] text-destructive leading-snug">{assets.error}</p>
        </div>
      )}

      {/* Countdown */}
      {isCountdown && (
        <div className="flex flex-col items-center justify-center py-6 select-none">
          <div className="text-5xl font-semibold tabular-nums text-primary leading-none">
            {recorder.countdownRemaining}
          </div>
          <p className="text-[10px] text-muted-foreground mt-2">
            Get ready…
          </p>
        </div>
      )}

      {/* Recording / paused state — meter + timer + transport */}
      {(isRecording || isPaused) && (
        <div className="space-y-3">
          {/* Timer */}
          <div className="flex items-center justify-center gap-2">
            <span
              className={`w-2 h-2 rounded-full ${
                isRecording ? 'bg-destructive animate-pulse' : 'bg-muted-foreground'
              }`}
              aria-hidden
            />
            <span className="text-2xl font-medium tabular-nums text-foreground">
              {formatElapsed(recorder.elapsedMs)}
            </span>
          </div>

          {/* VU meter */}
          <VuMeter level={isRecording ? recorder.audioLevel : 0} />

          {/* Transport */}
          <div className="flex items-center gap-2">
            {isRecording ? (
              <button
                type="button"
                onClick={recorder.pauseRecording}
                className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium border border-border bg-background text-foreground hover:bg-muted transition-colors"
                title="Pause recording"
              >
                <Pause size={13} className="shrink-0" />
                Pause
              </button>
            ) : (
              <button
                type="button"
                onClick={recorder.resumeRecording}
                className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium border border-border bg-background text-foreground hover:bg-muted transition-colors"
                title="Resume recording"
              >
                <Play size={13} className="shrink-0" />
                Resume
              </button>
            )}
            <button
              type="button"
              onClick={handleStop}
              className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors"
              title="Stop recording"
            >
              <Square size={13} className="shrink-0 fill-current" />
              Stop
            </button>
          </div>
        </div>
      )}

      {/* Processing (between Stop and Review) */}
      {isProcessing && (
        <div className="flex items-center justify-center gap-2 py-6 text-muted-foreground">
          <Loader2 size={14} className="animate-spin" aria-hidden />
          <span className="text-[11px]">Finishing up…</span>
        </div>
      )}

      {/* Review */}
      {isReview && recorder.result && (
        <div className="space-y-3">
          <div className="rounded-lg border border-border bg-muted/30 p-2.5">
            <div className="flex items-baseline justify-between mb-1.5">
              <span className="text-[10px] font-medium text-muted-foreground">
                Preview
              </span>
              <span className="text-[10px] tabular-nums text-muted-foreground">
                {formatElapsed(recorder.result.durationMs)}
              </span>
            </div>
            {reviewUrl && (
              <audio
                controls
                src={reviewUrl}
                className="w-full"
                style={{ height: 32 }}
              />
            )}
          </div>

          <button
            type="button"
            onClick={commitRecording}
            disabled={committing || !projectId}
            className={`
              w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-colors
              ${committing || !projectId
                ? 'bg-muted text-muted-foreground cursor-not-allowed'
                : 'bg-primary text-primary-foreground hover:bg-primary/90'
              }
            `}
          >
            {committing ? (
              <>
                <Loader2 size={13} className="animate-spin shrink-0" />
                Saving…
              </>
            ) : (
              <>
                <Mic size={13} className="shrink-0" />
                Save to timeline
              </>
            )}
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleReRecord}
              disabled={committing}
              className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-[11px] font-medium border border-border bg-background text-foreground hover:bg-muted transition-colors disabled:opacity-50"
              title="Discard this take and start a new one"
            >
              <RotateCcw size={11} className="shrink-0" />
              Re-record
            </button>
            <button
              type="button"
              onClick={handleDiscard}
              disabled={committing}
              className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-[11px] font-medium border border-border bg-background text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50"
              title="Throw this take away"
            >
              <Trash2 size={11} className="shrink-0" />
              Discard
            </button>
          </div>
        </div>
      )}

      {/* Idle: the big Record button */}
      {(recorder.status === 'idle' || recorder.status === 'requesting') && (
        <button
          type="button"
          onClick={() => recorder.startRecording()}
          disabled={!canRecord || recorder.status === 'requesting'}
          className={`
            w-full flex items-center justify-center gap-2 px-3 py-3 rounded-lg text-xs font-medium transition-colors
            ${canRecord && recorder.status !== 'requesting'
              ? 'bg-primary text-primary-foreground hover:bg-primary/90'
              : 'bg-muted text-muted-foreground cursor-not-allowed'
            }
          `}
          title={
            !projectId
              ? 'Open a project to record'
              : isDenied
                ? 'Microphone access blocked'
                : isUnsupported
                  ? 'Recording not supported in this browser'
                  : 'Start recording your voiceover'
          }
        >
          {recorder.status === 'requesting' ? (
            <>
              <Loader2 size={13} className="animate-spin shrink-0" />
              Requesting mic…
            </>
          ) : (
            <>
              <span className="w-2.5 h-2.5 rounded-full bg-destructive shrink-0" aria-hidden />
              Record
            </>
          )}
        </button>
      )}

      {/* Footer hint */}
      {!isRecording && !isPaused && !isCountdown && !isReview && (
        <div className="flex items-start gap-1.5 pt-1">
          <Info size={10} className="text-muted-foreground/60 mt-0.5 shrink-0" aria-hidden />
          <p className="text-[9px] text-muted-foreground/70 leading-snug">
            Tip: the timeline plays while you record so you can narrate against
            your b-roll. Generate captions from this clip in the Captions tab.
          </p>
        </div>
      )}
    </div>
  )
}

// ─── VU meter ────────────────────────────────────────────────────────────────

/**
 * Twelve-segment horizontal VU meter. Colour shifts amber above ~-6dBFS and
 * red above ~-3dBFS so users can see when they're clipping without having to
 * know the units.
 */
function VuMeter({ level }: { level: number }) {
  const SEGMENTS = 12
  const lit = Math.round(level * SEGMENTS)
  return (
    <div
      className="flex items-center gap-[2px] h-2"
      role="meter"
      aria-label="Microphone level"
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={Number(level.toFixed(2))}
    >
      {Array.from({ length: SEGMENTS }).map((_, i) => {
        const active = i < lit
        let colour = 'bg-primary/70'
        if (i >= SEGMENTS - 2) colour = 'bg-destructive'
        else if (i >= SEGMENTS - 4) colour = 'bg-amber-500'
        return (
          <span
            key={i}
            className={`flex-1 h-full rounded-[1px] transition-colors ${
              active ? colour : 'bg-muted'
            }`}
            aria-hidden
          />
        )
      })}
    </div>
  )
}
