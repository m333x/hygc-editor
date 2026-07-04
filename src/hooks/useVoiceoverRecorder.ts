/**
 * useVoiceoverRecorder — microphone recording lifecycle for the Voiceover panel.
 *
 * Encapsulates the browser plumbing (getUserMedia, MediaRecorder, AnalyserNode)
 * so the panel UI stays declarative. Responsibilities:
 *   - Detect support and request mic permission lazily on first record.
 *   - Enumerate input devices and let the user pick one (when more than one).
 *   - Drive a 3-2-1 countdown before mic-hot, then start MediaRecorder.
 *   - Mirror play/pause to the playback store so the timeline plays as the
 *     user narrates (the defining UX of a voiceover surface in any NLE).
 *   - Surface a live audio level (0..1 RMS) for the VU meter.
 *   - Produce a final Blob + measured duration + the timeline position at
 *     which recording began, so the caller can drop the clip exactly there.
 *
 * SOLID: SRP — owns the recorder lifecycle only. The panel decides what to
 *   do with the result; the editor store decides where the clip lands.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { usePlaybackStore } from '../store/playback-store'

// ─── Public types ─────────────────────────────────────────────────────────────

export type VoiceoverRecorderStatus =
  | 'idle'
  | 'unsupported'
  | 'permission-denied'
  | 'requesting'
  | 'countdown'
  | 'recording'
  | 'paused'
  | 'processing'
  | 'review'

export interface VoiceoverRecorderResult {
  blob: Blob
  mimeType: string
  durationMs: number
  /** Snapshot of `playheadPosition` at the moment the user pressed Record. */
  startedAtTimelineMs: number
}

export interface UseVoiceoverRecorder {
  status: VoiceoverRecorderStatus
  /** Elapsed recording time in ms (pauses while paused). */
  elapsedMs: number
  /** Countdown seconds remaining (3 → 2 → 1) while `status === 'countdown'`. */
  countdownRemaining: number
  /** 0..1 RMS amplitude from the analyser (smoothed). */
  audioLevel: number
  /** Available audio-input devices (only populated after first permission grant). */
  devices: MediaDeviceInfo[]
  selectedDeviceId: string | null
  setSelectedDeviceId: (id: string) => void
  /** Most recent error message for the UI to surface (non-fatal). */
  error: string | null
  /** Result blob from the most recent successful stop. Cleared on `discard`. */
  result: VoiceoverRecorderResult | null
  startRecording: () => Promise<void>
  pauseRecording: () => void
  resumeRecording: () => void
  stopRecording: () => Promise<VoiceoverRecorderResult | null>
  discard: () => void
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

const COUNTDOWN_SECONDS = 3
const ELAPSED_TICK_MS = 100
const LEVEL_SMOOTHING = 0.6

/**
 * Recording quality knobs.
 *
 * 192 kbps Opus mono at 48 kHz is essentially transparent for spoken voice —
 * well above the ~96 kbps the browser would pick by default. AAC needs more
 * bits than Opus to match perceptual quality, so we lift its target slightly.
 * 48 kHz is the native rate of every modern OS audio stack, so requesting it
 * avoids an extra resampling pass between the mic and the encoder.
 */
const TARGET_SAMPLE_RATE = 48000
const TARGET_CHANNEL_COUNT = 1
const TARGET_OPUS_BPS = 192_000
const TARGET_AAC_BPS = 256_000

/** Pick the best-supported MIME type for `MediaRecorder` on this browser. */
function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/webm',
    'audio/mp4',
  ]
  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) return mime
  }
  return undefined
}

function bitrateForMime(mime: string | undefined): number {
  if (!mime) return TARGET_OPUS_BPS
  if (mime.includes('mp4') || mime.includes('aac') || mime.includes('mp4a')) return TARGET_AAC_BPS
  return TARGET_OPUS_BPS
}

/**
 * Measure the duration of a recorded blob by loading it into a hidden `<audio>`.
 * More reliable than summing `MediaRecorder` chunk timestamps, which are
 * monotonic-clock-based and skew slightly from the actual decoded length.
 *
 * Some browsers (notably Chrome with WebM/Opus) emit `duration === Infinity`
 * until the file is fully scanned — we seek to a large position to force the
 * decoder to scan, then read `duration` after the next `durationchange`.
 */
function measureBlobDurationMs(blob: Blob): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob)
    const audio = new Audio()
    audio.preload = 'metadata'
    let settled = false
    const finish = (ms: number) => {
      if (settled) return
      settled = true
      URL.revokeObjectURL(url)
      resolve(Math.max(0, Math.round(ms)))
    }
    audio.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        finish(audio.duration * 1000)
      } else {
        audio.currentTime = Number.MAX_SAFE_INTEGER
      }
    })
    audio.addEventListener('durationchange', () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        finish(audio.duration * 1000)
      }
    })
    audio.addEventListener('error', () => finish(0))
    setTimeout(() => finish(0), 5000)
    audio.src = url
  })
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

function detectInitialStatus(): VoiceoverRecorderStatus {
  if (typeof window === 'undefined') return 'idle'
  const supported =
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function' &&
    typeof MediaRecorder !== 'undefined'
  return supported ? 'idle' : 'unsupported'
}

export function useVoiceoverRecorder(): UseVoiceoverRecorder {
  const [status, setStatus] = useState<VoiceoverRecorderStatus>(detectInitialStatus)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [countdownRemaining, setCountdownRemaining] = useState(0)
  const [audioLevel, setAudioLevel] = useState(0)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<VoiceoverRecorderResult | null>(null)

  // Refs for objects that must survive renders without re-creating them.
  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const rafIdRef = useRef<number | null>(null)
  const elapsedIntervalRef = useRef<number | null>(null)
  const elapsedAccumRef = useRef(0)
  const elapsedStartRef = useRef(0)
  const countdownTimeoutRef = useRef<number | null>(null)
  const timelineStartRef = useRef(0)
  const mimeTypeRef = useRef<string>('')

  // ─── Cleanup helpers ────────────────────────────────────────────────────────

  const stopMeter = useCallback(() => {
    if (rafIdRef.current != null) {
      cancelAnimationFrame(rafIdRef.current)
      rafIdRef.current = null
    }
    setAudioLevel(0)
  }, [])

  const stopElapsedTimer = useCallback(() => {
    if (elapsedIntervalRef.current != null) {
      window.clearInterval(elapsedIntervalRef.current)
      elapsedIntervalRef.current = null
    }
  }, [])

  const teardownStream = useCallback(() => {
    stopMeter()
    if (sourceNodeRef.current) {
      try { sourceNodeRef.current.disconnect() } catch { /* noop */ }
      sourceNodeRef.current = null
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => { /* noop */ })
      audioContextRef.current = null
    }
    analyserRef.current = null
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
  }, [stopMeter])

  // Stop everything on unmount.
  useEffect(() => {
    return () => {
      stopElapsedTimer()
      if (countdownTimeoutRef.current != null) {
        window.clearTimeout(countdownTimeoutRef.current)
      }
      teardownStream()
      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        try { recorderRef.current.stop() } catch { /* noop */ }
      }
    }
  }, [stopElapsedTimer, teardownStream])

  // ─── Meter loop ─────────────────────────────────────────────────────────────

  const startMeter = useCallback(() => {
    const analyser = analyserRef.current
    if (!analyser) return
    const buf = new Uint8Array(analyser.fftSize)
    let smoothed = 0
    const tick = () => {
      analyser.getByteTimeDomainData(buf)
      let sumSq = 0
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128
        sumSq += v * v
      }
      const rms = Math.sqrt(sumSq / buf.length)
      smoothed = smoothed * LEVEL_SMOOTHING + rms * (1 - LEVEL_SMOOTHING)
      setAudioLevel(Math.min(1, smoothed * 1.6))
      rafIdRef.current = requestAnimationFrame(tick)
    }
    rafIdRef.current = requestAnimationFrame(tick)
  }, [])

  // ─── Elapsed timer ──────────────────────────────────────────────────────────

  const startElapsedTimer = useCallback(() => {
    elapsedStartRef.current = performance.now()
    stopElapsedTimer()
    elapsedIntervalRef.current = window.setInterval(() => {
      const now = performance.now()
      setElapsedMs(elapsedAccumRef.current + (now - elapsedStartRef.current))
    }, ELAPSED_TICK_MS)
  }, [stopElapsedTimer])

  const pauseElapsedTimer = useCallback(() => {
    const now = performance.now()
    elapsedAccumRef.current += now - elapsedStartRef.current
    stopElapsedTimer()
    setElapsedMs(elapsedAccumRef.current)
  }, [stopElapsedTimer])

  // ─── Device enumeration ─────────────────────────────────────────────────────

  const refreshDevices = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return
    try {
      const list = await navigator.mediaDevices.enumerateDevices()
      const inputs = list.filter((d) => d.kind === 'audioinput')
      setDevices(inputs)
      setSelectedDeviceId((prev) => {
        if (prev && inputs.some((d) => d.deviceId === prev)) return prev
        const def = inputs.find((d) => d.deviceId === 'default') ?? inputs[0]
        return def?.deviceId ?? null
      })
    } catch {
      // Device enumeration is best-effort; ignore.
    }
  }, [])

  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.addEventListener) return
    const handler = () => { refreshDevices().catch(() => { /* noop */ }) }
    navigator.mediaDevices.addEventListener('devicechange', handler)
    return () => navigator.mediaDevices.removeEventListener('devicechange', handler)
  }, [refreshDevices])

  // ─── Core: getUserMedia + start recorder ────────────────────────────────────

  const beginRecording = useCallback(async () => {
    // Acquire stream. We pin sampleRate/channelCount/sampleSize so the
    // browser hands us a clean 48 kHz / 16-bit / mono pipeline instead of
    // whatever default the OS happens to negotiate (often 44.1 kHz stereo,
    // which then gets downmixed and resampled before encoding).
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: selectedDeviceId ? { exact: selectedDeviceId } : undefined,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: TARGET_SAMPLE_RATE,
          channelCount: TARGET_CHANNEL_COUNT,
          sampleSize: 16,
        },
      })
    } catch (err) {
      const name = (err as DOMException)?.name
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setStatus('permission-denied')
      } else {
        setError((err as Error).message || 'Could not access microphone')
        setStatus('idle')
      }
      return
    }
    streamRef.current = stream

    // Refresh devices now that labels are available (browsers gate labels
    // behind a granted-permission state).
    refreshDevices().catch(() => { /* noop */ })

    // Wire analyser
    type AudioContextCtor = typeof AudioContext
    const Ctor =
      (window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor })
        .AudioContext ??
      (window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor })
        .webkitAudioContext
    if (Ctor) {
      const ctx = new Ctor()
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      source.connect(analyser)
      audioContextRef.current = ctx
      sourceNodeRef.current = source
      analyserRef.current = analyser
      startMeter()
    }

    // Wire recorder. Explicit `audioBitsPerSecond` matters — the browser's
    // default is conservative (often ~64–96 kbps) and the difference between
    // that and 192 kbps Opus is immediately audible on plosives and sibilants.
    const mime = pickMimeType()
    mimeTypeRef.current = mime ?? ''
    const recorderOptions: MediaRecorderOptions = {
      audioBitsPerSecond: bitrateForMime(mime),
      ...(mime ? { mimeType: mime } : {}),
    }
    const recorder = new MediaRecorder(stream, recorderOptions)
    chunksRef.current = []
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data && event.data.size > 0) chunksRef.current.push(event.data)
    })
    recorderRef.current = recorder
    recorder.start(250)

    // Start the timeline so the user narrates over the b-roll. This is the
    // defining behaviour of a voiceover surface.
    usePlaybackStore.getState().setPlaying(true)

    // Reset and start the elapsed counter.
    elapsedAccumRef.current = 0
    setElapsedMs(0)
    startElapsedTimer()
    setStatus('recording')
  }, [refreshDevices, selectedDeviceId, startElapsedTimer, startMeter])

  // ─── Public actions ─────────────────────────────────────────────────────────

  const startRecording = useCallback(async () => {
    if (status === 'unsupported') return
    setError(null)
    setResult(null)
    timelineStartRef.current = usePlaybackStore.getState().playheadPosition
    setStatus('requesting')

    // 3-2-1 countdown before mic-hot, so the user has time to breathe.
    setCountdownRemaining(COUNTDOWN_SECONDS)
    setStatus('countdown')
    let remaining = COUNTDOWN_SECONDS
    const tick = () => {
      remaining -= 1
      if (remaining <= 0) {
        setCountdownRemaining(0)
        beginRecording().catch(() => { /* handled inside */ })
      } else {
        setCountdownRemaining(remaining)
        countdownTimeoutRef.current = window.setTimeout(tick, 1000)
      }
    }
    countdownTimeoutRef.current = window.setTimeout(tick, 1000)
  }, [beginRecording, status])

  const pauseRecording = useCallback(() => {
    const rec = recorderRef.current
    if (!rec || rec.state !== 'recording') return
    rec.pause()
    pauseElapsedTimer()
    stopMeter()
    usePlaybackStore.getState().setPlaying(false)
    setStatus('paused')
  }, [pauseElapsedTimer, stopMeter])

  const resumeRecording = useCallback(() => {
    const rec = recorderRef.current
    if (!rec || rec.state !== 'paused') return
    rec.resume()
    startElapsedTimer()
    startMeter()
    usePlaybackStore.getState().setPlaying(true)
    setStatus('recording')
  }, [startElapsedTimer, startMeter])

  const stopRecording = useCallback(async (): Promise<VoiceoverRecorderResult | null> => {
    const rec = recorderRef.current
    if (!rec) return null
    setStatus('processing')
    usePlaybackStore.getState().setPlaying(false)

    const blob: Blob = await new Promise((resolve) => {
      rec.addEventListener(
        'stop',
        () => {
          const mime = mimeTypeRef.current || rec.mimeType || 'audio/webm'
          resolve(new Blob(chunksRef.current, { type: mime }))
        },
        { once: true },
      )
      try { rec.stop() } catch {
        resolve(new Blob(chunksRef.current, { type: mimeTypeRef.current || 'audio/webm' }))
      }
    })

    stopElapsedTimer()
    teardownStream()

    const durationMs = await measureBlobDurationMs(blob)
    const finalDuration = durationMs > 0 ? durationMs : elapsedAccumRef.current + 0

    const next: VoiceoverRecorderResult = {
      blob,
      mimeType: mimeTypeRef.current || blob.type || 'audio/webm',
      durationMs: Math.max(100, Math.round(finalDuration)),
      startedAtTimelineMs: timelineStartRef.current,
    }
    setResult(next)
    setStatus('review')
    return next
  }, [stopElapsedTimer, teardownStream])

  const discard = useCallback(() => {
    setResult(null)
    setElapsedMs(0)
    elapsedAccumRef.current = 0
    setError(null)
    setStatus('idle')
  }, [])

  return {
    status,
    elapsedMs,
    countdownRemaining,
    audioLevel,
    devices,
    selectedDeviceId,
    setSelectedDeviceId,
    error,
    result,
    startRecording,
    pauseRecording,
    resumeRecording,
    stopRecording,
    discard,
  }
}
