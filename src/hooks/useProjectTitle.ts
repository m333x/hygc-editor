/**
 * useProjectTitle — fetch and update the current project's title (name).
 *
 * Used by EditorToolbar (display) and InspectorPanel (display + edit).
 * Reads and persists through the host's projects API.
 */

import { useState, useEffect, useCallback } from 'react'
import { useEditorHost } from '../host'

export interface UseProjectTitleReturn {
  /** Current project title, or null while loading / if missing. */
  title: string | null
  /** True while the initial fetch is in progress. */
  loading: boolean
  /** Error message from fetch or update. Null if no error. */
  error: string | null
  /** Update the project title. Persists through the host and updates local state. */
  updateTitle: (newTitle: string) => Promise<void>
}

export function useProjectTitle(
  projectId: string | undefined,
  /** Bumps when `useEditorPersistence` finishes load/seed — refetch the title. */
  loadRevision?: number,
): UseProjectTitleReturn {
  const host = useEditorHost()
  const [title, setTitle] = useState<string | null>(null)
  const [loading, setLoading] = useState(!!projectId)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!projectId) {
      setTitle(null)
      setLoading(false)
      setError(null)
      return
    }

    let cancelled = false

    async function fetchTitle() {
      setLoading(true)
      setError(null)
      const { data, error: fetchError } = await host.projects.get(projectId!)

      if (cancelled) return

      if (fetchError || !data) {
        setError(fetchError?.message ?? 'Project not found')
        setTitle(null)
      } else {
        setTitle(data.title ?? null)
      }
      setLoading(false)
    }

    fetchTitle()
    return () => {
      cancelled = true
    }
  }, [projectId, loadRevision, host])

  const updateTitle = useCallback(
    async (newTitle: string) => {
      if (!projectId) return
      const trimmed = newTitle.trim()
      const { error: updateError } = await host.projects.rename(projectId, trimmed || 'Untitled')

      if (updateError) {
        setError(updateError.message)
        return
      }
      setError(null)
      setTitle(trimmed || 'Untitled')
    },
    [projectId, host],
  )

  return { title, loading, error, updateTitle }
}
