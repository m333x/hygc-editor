/**
 * useEditorPersistence — auto-save and load for editor state.
 *
 * Handles the persistence layer between the Zustand editor store and the
 * host's project storage (see EditorHost.projects). Provides:
 *
 *   - Auto-save: debounced writes when the persistent state changes
 *   - Load: hydrate the store from a saved project on editor mount
 *   - Seeding: when the host implements `projects.seed` and the loaded
 *     timeline is empty, the host-built initial state is applied and persisted
 *   - Save status: tracks whether a save is in progress or has errored
 *
 * Debounce strategy:
 *   Editor mutations (clip moves, trims, etc.) can happen very frequently
 *   during drag operations. Auto-save is debounced to 2 seconds after the
 *   last mutation to avoid excessive writes while ensuring changes are
 *   persisted promptly.
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import { useEditorStore } from '../store/editor-store'
import { useEditorHost } from '../host'
import type { SerializedEditorState } from '../types'

// ─── Constants ───────────────────────────────────────────────────────────────

/** Auto-save debounce delay in milliseconds. */
const AUTOSAVE_DEBOUNCE_MS = 2000

/**
 * True when the saved timeline is empty enough that a host seed (e.g. from a
 * linked UGC ad) should populate it: no tracks, or no clips on the video track.
 */
export function isTimelineEmptyForSeed(state: SerializedEditorState | null): boolean {
  if (!state?.tracks?.length) return true
  const video = state.tracks.find((t) => t.type === 'video')
  return !video?.clips?.length
}

// ─── Return Type ─────────────────────────────────────────────────────────────

export interface UseEditorPersistenceReturn {
  /** Whether the editor state is currently being loaded from the host. */
  loading: boolean

  /** Whether an auto-save write is in progress. */
  saving: boolean

  /** Last error from loading or saving. Null if no error. */
  error: string | null

  /** Whether there are unsaved changes. */
  isDirty: boolean

  /**
   * Epoch ms of the most recent successful save (or, on initial load, the
   * server's `updated_at` for the project). Null if the project has never
   * been saved and no load has completed.
   */
  lastSavedAt: number | null

  /** Manually trigger a save (bypasses debounce). */
  saveNow: () => Promise<void>

  /**
   * Increments after each successful load (including host seed). Pass to
   * `useProjectTitle` so the toolbar title refetches after the project title
   * is updated in storage.
   */
  loadRevision: number
}

// ─── Hook Implementation ─────────────────────────────────────────────────────

/**
 * Manage editor state persistence for a project.
 *
 * On mount, loads the editor state from the host. While mounted, subscribes to
 * the Zustand store's serializable state and auto-saves on changes (debounced).
 *
 * @param projectId - The project id to load/save state for. If null/undefined,
 *   persistence is disabled (e.g., for unsaved new projects).
 */
export function useEditorPersistence(projectId: string | undefined): UseEditorPersistenceReturn {
  const host = useEditorHost()
  const [loading, setLoading] = useState(!!projectId)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isDirty, setIsDirty] = useState(false)
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null)
  const [loadRevision, setLoadRevision] = useState(0)
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSavedJson = useRef<string>('')

  const loadState = useEditorStore((s) => s.loadState)
  const getSerializableState = useEditorStore((s) => s.getSerializableState)
  const resetState = useEditorStore((s) => s.resetState)

  // ── Load State on Mount ──

  useEffect(() => {
    if (!projectId) {
      setLoading(false)
      return
    }

    const pid = projectId
    let cancelled = false

    async function loadProject() {
      setLoading(true)
      setError(null)

      const { data, error: fetchError } = await host.projects.get(pid)

      if (cancelled) return

      if (fetchError || !data) {
        setError(`Failed to load project: ${fetchError?.message ?? 'not found'}`)
        setLoading(false)
        setLoadRevision((r) => r + 1)
        return
      }

      let savedState = data.editor_state
      const serverUpdatedAt = data.updated_at ? new Date(data.updated_at).getTime() : null

      // Host seeding — e.g. HyGC builds an initial timeline from a linked UGC ad.
      let seeded: { state: SerializedEditorState; title: string } | null = null
      if (host.projects.seed && isTimelineEmptyForSeed(savedState)) {
        seeded = await host.projects.seed(pid)
        if (cancelled) return
      }

      if (seeded) {
        savedState = seeded.state
        loadState(seeded.state)
        lastSavedJson.current = JSON.stringify(seeded.state)
        await host.projects.saveState(pid, seeded.state)
        await host.projects.rename(pid, seeded.title)
        setLastSavedAt(Date.now())
      } else if (savedState) {
        loadState(savedState)
        lastSavedJson.current = JSON.stringify(savedState)
        setLastSavedAt(serverUpdatedAt)
      } else {
        resetState()
        lastSavedJson.current = ''
        setLastSavedAt(null)
      }

      setLoading(false)
      setLoadRevision((r) => r + 1)
    }

    loadProject()

    return () => {
      cancelled = true
    }
  }, [projectId, loadState, resetState, host])

  // ── Auto-Save on State Changes ──

  useEffect(() => {
    if (!projectId) return

    // Subscribe to the Zustand store for serializable state changes
    const unsubscribe = useEditorStore.subscribe((state) => {
      const serializable = {
        tracks: state.tracks,
        captionStyle: state.captionStyle,
        composition: state.composition,
        globalAudioVolume: state.globalAudioVolume,
      }
      const currentJson = JSON.stringify(serializable)

      if (currentJson === lastSavedJson.current) {
        setIsDirty(false)
        return
      }

      setIsDirty(true)

      // Debounce the save
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current)
      }

      debounceTimer.current = setTimeout(async () => {
        setSaving(true)
        setError(null)

        const { error: saveError } = await host.projects.saveState(
          projectId,
          serializable as SerializedEditorState,
        )

        if (saveError) {
          setError(`Auto-save failed: ${saveError.message}`)
        } else {
          lastSavedJson.current = currentJson
          setIsDirty(false)
          setLastSavedAt(Date.now())
        }

        setSaving(false)
      }, AUTOSAVE_DEBOUNCE_MS)
    })

    return () => {
      unsubscribe()
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current)
      }
    }
  }, [projectId, host])

  // ── Manual Save ──

  const saveNow = useCallback(async () => {
    if (!projectId) return

    // Cancel pending debounced save
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current)
    }

    setSaving(true)
    setError(null)

    const serializable = getSerializableState()
    const { error: saveError } = await host.projects.saveState(projectId, serializable)

    if (saveError) {
      setError(`Save failed: ${saveError.message}`)
    } else {
      lastSavedJson.current = JSON.stringify(serializable)
      setIsDirty(false)
      setLastSavedAt(Date.now())
    }

    setSaving(false)
  }, [projectId, getSerializableState, host])

  return { loading, saving, error, isDirty, lastSavedAt, saveNow, loadRevision }
}
