/**
 * useExport — React hook for managing video export lifecycle in the editor.
 *
 * Two export paths:
 *
 *   1. Local (always available on capable browsers): renders the composition
 *      in-browser with WebCodecs via the engine's web-export and downloads the
 *      MP4 directly. No server, no credits.
 *
 *   2. Server (optional host capability — EditorHost.serverExport): submits a
 *      render job, subscribes to progress updates, and provides download URLs
 *      and export history. When the host doesn't provide `serverExport`, the
 *      server path is disabled and the ExportPanel hides its UI.
 *
 * State machine (shared by both paths):
 *   idle → submitting → (queued | processing) → completed | failed → idle
 */

import { useState, useEffect, useCallback } from 'react'
import { useEditorHost } from '../host'
import type { ExportOptions, ExportResolution, ServerExportRecord } from '../host'
import { useEditorStore } from '../store/editor-store'
import { DEFAULT_COMPOSITION_CONFIG } from '../types'
import {
  renderProjectOnWeb,
  downloadBlob,
  canExportOnWeb,
  type WebExportCodec,
} from '../engine/web-export'

/** Native composition width per resolution preset, used to derive web-render scale. */
const RESOLUTION_WIDTH: Record<ExportResolution, number> = {
  '720p': 720,
  '1080p': 1080,
  '2160p': 2160,
}

// ─── Module-level history cache ──────────────────────────────────────────────────

/**
 * In-memory cache of export history per project, keyed by project id.
 *
 * The ExportPanel mounts lazily inside a Radix Popover — without a cache the
 * hook would re-fetch (and the UI would flash "Loading…") on every open.
 *
 * Cache semantics:
 *   - Fresh (< HISTORY_TTL_MS): opens render instantly, no network round-trip.
 *   - Stale: opens render instantly from cache, then silently refresh.
 *   - Completed exports invalidate the cache so the new render appears
 *     immediately without waiting for the TTL.
 */
interface HistoryCacheEntry {
  data: ServerExportRecord[]
  fetchedAt: number
}
const historyCache = new Map<string, HistoryCacheEntry>()
const HISTORY_TTL_MS = 60_000

function isFresh(entry: HistoryCacheEntry | undefined): entry is HistoryCacheEntry {
  return !!entry && Date.now() - entry.fetchedAt < HISTORY_TTL_MS
}

// ─── Types ──────────────────────────────────────────────────────────────────────

/**
 * Export state phases. Drives the ExportPanel UI rendering.
 */
export type ExportPhase =
  | 'idle'
  | 'submitting'
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'

/**
 * Return type of the useExport hook.
 */
export interface UseExportReturn {
  /** Current phase of the export lifecycle. */
  phase: ExportPhase

  /** Progress value between 0 and 1 (only meaningful during 'processing'). */
  progress: number

  /** Error message if the export failed. */
  error: string | null

  /** The active export job ID (null when idle). */
  jobId: string | null

  /** The export record ID (null when idle or if creation failed). */
  exportId: string | null

  /** Download URL for the completed export (null until completed). */
  downloadUrl: string | null

  /** Output asset id when a server render completes (for Save to Library). */
  outputAssetId: string | null

  /** Number of credits charged for the current/last export. */
  creditsCharged: number

  /** Whether an export can be started (not already in progress). */
  canExport: boolean

  /** Whether the host provides server-side export (credits, history, etc.). */
  canServerExport: boolean

  /** Whether this browser supports client-side WebCodecs export. */
  canWebExport: boolean

  /** Past server exports for this project. Always empty without serverExport. */
  exportHistory: ServerExportRecord[]

  /** Whether the export history is loading. */
  historyLoading: boolean

  /**
   * Start a server export with the given options.
   * Reads the current timeline state from the Zustand store.
   * No-op when the host doesn't provide serverExport.
   */
  startExport: (options: ExportOptions) => Promise<void>

  /**
   * Render the export client-side via WebCodecs and download the MP4 directly.
   * No server, no credits. Reads the current timeline from the Zustand store.
   */
  exportOnWeb: (options: ExportOptions, codec?: WebExportCodec) => Promise<void>

  /**
   * Reset the export state back to idle.
   * Used after dismissing a completed or failed export.
   */
  resetExport: () => void

  /**
   * Refresh the export history list.
   */
  refreshHistory: () => Promise<void>

  /**
   * Get the credit cost for the given export options. Returns 0 when the host
   * has no server export (the panel hides cost UI in that case).
   */
  getCreditCost: (input: Pick<ExportOptions, 'resolution' | 'fps' | 'quality'>) => number
}

// ─── Hook ───────────────────────────────────────────────────────────────────────

/**
 * useExport — manages the export lifecycle for a project.
 *
 * @param projectId - The current project's UUID (from route params)
 * @returns Export state and actions for the ExportPanel component
 */
export function useExport(projectId: string | undefined): UseExportReturn {
  const host = useEditorHost()
  const serverExport = host.serverExport

  // ── State ──

  const [phase, setPhase] = useState<ExportPhase>('idle')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const [exportId, setExportId] = useState<string | null>(null)
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null)
  const [outputAssetId, setOutputAssetId] = useState<string | null>(null)
  const [creditsCharged, setCreditsCharged] = useState(0)
  const [exportHistory, setExportHistory] = useState<ServerExportRecord[]>(() =>
    projectId ? (historyCache.get(projectId)?.data ?? []) : [],
  )
  const [historyLoading, setHistoryLoading] = useState(false)
  const [canWebExport, setCanWebExport] = useState(false)

  /** Access the editor store to get the serializable timeline state. */
  const getSerializableState = useEditorStore((s) => s.getSerializableState)

  // ── WebCodecs capability probe ──
  // Run once on mount so the ExportPanel can offer the client-side fast path
  // only on browsers that can actually encode it (Chrome/Firefox with WebCodecs).
  useEffect(() => {
    let cancelled = false
    canExportOnWeb(DEFAULT_COMPOSITION_CONFIG.width, DEFAULT_COMPOSITION_CONFIG.height).then(
      (ok) => {
        if (!cancelled) setCanWebExport(ok)
      },
    )
    return () => {
      cancelled = true
    }
  }, [])

  // ── Server job subscription ──

  useEffect(() => {
    if (!serverExport || !jobId || phase === 'idle' || phase === 'submitting') {
      return
    }

    const unsubscribe = serverExport.subscribeToJob(jobId, (update) => {
      if (typeof update.progress === 'number') {
        setProgress(update.progress)
      }

      switch (update.status) {
        case 'processing':
          setPhase('processing')
          break

        case 'completed':
          setPhase('completed')
          setProgress(1)
          if (typeof update.outputAssetId === 'string') setOutputAssetId(update.outputAssetId)
          // Fetch the download URL
          if (exportId) {
            serverExport.getDownloadUrl(exportId).then((url) => {
              setDownloadUrl(url)
            })
          } else if (update.outputUrl) {
            setDownloadUrl(update.outputUrl)
          }
          break

        case 'failed':
          setPhase('failed')
          setError(update.errorMessage ?? 'Export failed. Please try again.')
          break

        case 'canceled':
          setPhase('failed')
          setError('Export was canceled.')
          break
      }
    })

    return unsubscribe
  }, [serverExport, jobId, exportId, phase])

  // ── Load Export History ──

  const refreshHistory = useCallback(async () => {
    if (!projectId || !serverExport) return

    // Only show the spinner when we have nothing to render yet — silent
    // background refresh otherwise, so re-opening the popover doesn't flash.
    const cached = historyCache.get(projectId)
    if (!cached || cached.data.length === 0) setHistoryLoading(true)

    try {
      const exports = await serverExport.listHistory(projectId)
      historyCache.set(projectId, { data: exports, fetchedAt: Date.now() })
      setExportHistory(exports)
    } finally {
      setHistoryLoading(false)
    }
  }, [projectId, serverExport])

  // Load export history on mount and when projectId changes — but only fetch
  // when the cache is missing or stale.
  useEffect(() => {
    if (!projectId || !serverExport) return
    if (isFresh(historyCache.get(projectId))) return
    refreshHistory()
  }, [projectId, serverExport, refreshHistory])

  // Refresh history when an export completes. Invalidate the cache first so
  // the new render shows up immediately instead of waiting for the TTL.
  useEffect(() => {
    if (phase === 'completed' && projectId && serverExport) {
      historyCache.delete(projectId)
      refreshHistory()
    }
  }, [phase, projectId, serverExport, refreshHistory])

  // ── Actions ──

  /**
   * Start a server export render job through the host.
   */
  const startExport = useCallback(
    async (options: ExportOptions) => {
      if (!serverExport) return
      if (!projectId) {
        setError('No project loaded. Save the project first.')
        return
      }

      // Prevent double-submission
      if (phase !== 'idle' && phase !== 'completed' && phase !== 'failed') {
        return
      }

      // Reset state
      setPhase('submitting')
      setProgress(0)
      setError(null)
      setDownloadUrl(null)
      setOutputAssetId(null)

      try {
        const timeline = getSerializableState()

        const response = await serverExport.start({
          projectId,
          options,
          timeline,
        })

        setJobId(response.jobId)
        setExportId(response.exportId)
        setCreditsCharged(response.creditsCharged)
        setPhase('queued')
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to start export.'
        setError(message)
        setPhase('failed')
      }
    },
    [serverExport, projectId, phase, getSerializableState],
  )

  /**
   * Client-side export: render the composition in-browser with WebCodecs and
   * download the MP4 directly. No render job, no credits. Reuses the same
   * phase machine for UI feedback (processing → completed).
   */
  const exportOnWeb = useCallback(
    async (options: ExportOptions, codec: WebExportCodec = 'h264') => {
      if (!projectId) {
        setError('No project loaded. Save the project first.')
        return
      }
      if (phase !== 'idle' && phase !== 'completed' && phase !== 'failed') {
        return
      }

      setPhase('processing')
      setProgress(0)
      setError(null)
      setDownloadUrl(null)
      setOutputAssetId(null)
      setCreditsCharged(0)

      try {
        const timeline = getSerializableState()
        const composition = { ...timeline.composition, fps: options.fps }
        const outWidth = RESOLUTION_WIDTH[options.resolution]
        const scale = outWidth / composition.width

        // Pre-flight: H.265/AV1 encode isn't available on every WebCodecs browser
        // even when H.264 is. Check the actual output dimensions before rendering
        // so the user gets a clear message instead of a cryptic encoder failure.
        if (codec !== 'h264') {
          const outHeight = Math.round(outWidth * (composition.height / composition.width))
          if (!(await canExportOnWeb(outWidth, outHeight, codec))) {
            setError(
              `This browser can't encode ${codec.toUpperCase()} locally. Use H.264 or the server export.`,
            )
            setPhase('failed')
            return
          }
        }

        const blob = await renderProjectOnWeb(
          { ...timeline, composition },
          {
            resolveAssetUrls: (ids) => host.resolveAssetUrls(ids),
            scale,
            codec,
            onProgress: setProgress,
          },
        )

        downloadBlob(blob, options.filename ?? `export-${projectId}`)
        setProgress(1)
        setPhase('completed')
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Local export failed.'
        setError(message)
        setPhase('failed')
      }
    },
    [projectId, phase, getSerializableState, host],
  )

  /**
   * Reset export state back to idle.
   */
  const resetExport = useCallback(() => {
    setPhase('idle')
    setProgress(0)
    setError(null)
    setJobId(null)
    setExportId(null)
    setDownloadUrl(null)
    setOutputAssetId(null)
    setCreditsCharged(0)
  }, [])

  /**
   * Get the credit cost for an export configuration. Delegates to the host;
   * 0 when the host has no server export.
   */
  const getCreditCost = useCallback(
    (input: Pick<ExportOptions, 'resolution' | 'fps' | 'quality'>): number =>
      serverExport?.getCost(input) ?? 0,
    [serverExport],
  )

  // ── Derived State ──

  const canExport =
    !!projectId &&
    (phase === 'idle' || phase === 'completed' || phase === 'failed')

  return {
    phase,
    progress,
    error,
    jobId,
    exportId,
    downloadUrl,
    outputAssetId,
    creditsCharged,
    canExport,
    canServerExport: !!serverExport,
    canWebExport,
    exportHistory,
    historyLoading,
    startExport,
    exportOnWeb,
    resetExport,
    refreshHistory,
    getCreditCost,
  }
}
