/**
 * TransitionsPanel — palette of draggable transition presets in the asset rail.
 *
 * Mirrors the AssetPanel's tab layout: a grid of tiles the user drags onto
 * the timeline. Each tile encodes its transition type + default duration as
 * an HTML5 drag payload using the `application/hygc-transition` MIME type,
 * picked up by TimelineClip's drop handlers.
 *
 * Three drop targets are recognised by the timeline:
 *
 *   - Left edge of a clip → set `transitionIn`
 *   - Right edge of a clip → set `transitionOut`
 *   - Seam between two adjacent clips → set both at once
 *
 * The panel itself has no awareness of those targets — it just publishes the
 * preset. The transport sits in TimelineClip / TrackContent.
 *
 * A Recent row sits above the main grid once the user has dragged at least
 * one transition; it persists across sessions via localStorage.
 *
 * Editing applied transitions is the Inspector's job — clicking a transition
 * badge in the timeline populates the right-side Inspector, not this panel.
 *
 * SOLID: SRP — only renders the palette + drag setup. Animation math lives in
 *   `engine/transitions.tsx`; editing UI lives in the Inspector.
 *
 * @see engine/transitions.tsx for the registry of presets
 * @see TimelineClip.tsx for the drop targets and selection click
 * @see InspectorPanel.tsx for the editing surface
 */

import { useCallback, useEffect, useState } from 'react'
import {
  TRANSITION_PRESETS,
  TRANSITION_DRAG_MIME_TYPE,
  type DraggedTransitionPayload,
  type TransitionPreset,
} from '../engine/transitions'
import type { TransitionType } from '../types'
import { useUIStore } from '../store/ui-store'

// ─── Recents ────────────────────────────────────────────────────────────────

const RECENTS_STORAGE_KEY = 'hygc:transitions:recent'
const RECENTS_MAX = 3

const PRESET_TYPES = new Set(TRANSITION_PRESETS.map((p) => p.type))

function loadRecents(): TransitionType[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(RECENTS_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((t): t is TransitionType => typeof t === 'string' && PRESET_TYPES.has(t as TransitionType))
      .slice(0, RECENTS_MAX)
  } catch {
    return []
  }
}

function saveRecents(types: TransitionType[]) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(RECENTS_STORAGE_KEY, JSON.stringify(types))
  } catch {
    // localStorage may be unavailable (private mode, quota); recents are non-essential.
  }
}

function useRecentTransitions() {
  const [recents, setRecents] = useState<TransitionType[]>(() => loadRecents())

  const record = useCallback((type: TransitionType) => {
    setRecents((prev) => {
      const next = [type, ...prev.filter((t) => t !== type)].slice(0, RECENTS_MAX)
      saveRecents(next)
      return next
    })
  }, [])

  // Keep multiple open editor instances in sync.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === RECENTS_STORAGE_KEY) setRecents(loadRecents())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  return [recents, record] as const
}

// ─── Card ────────────────────────────────────────────────────────────────────

interface TransitionCardProps {
  preset: TransitionPreset
  onDragStart: (type: TransitionType) => void
  onDragEnd: () => void
}

function TransitionCard({ preset, onDragStart, onDragEnd }: TransitionCardProps) {
  function handleDragStart(e: React.DragEvent<HTMLDivElement>) {
    const payload: DraggedTransitionPayload = {
      type: preset.type,
      durationMs: preset.defaultDurationMs,
    }
    e.dataTransfer.setData(TRANSITION_DRAG_MIME_TYPE, JSON.stringify(payload))
    e.dataTransfer.effectAllowed = 'copy'
    onDragStart(preset.type)
  }

  return (
    <div
      draggable
      onDragStart={handleDragStart}
      onDragEnd={onDragEnd}
      className={`
        group flex flex-col items-center gap-1.5 select-none
        cursor-grab active:cursor-grabbing
      `}
      title={`Drag ${preset.label} onto a clip edge or seam`}
      aria-label={`${preset.label} transition`}
    >
      <div
        className={`
          relative h-16 w-full rounded-lg flex items-center justify-center
          bg-muted/60 text-foreground/85
          border border-border/60
          group-hover:border-primary/50 group-hover:bg-muted/80 group-hover:text-foreground
          transition-colors
        `}
      >
        {preset.icon}
      </div>
      <span className="text-[10px] font-medium text-muted-foreground group-hover:text-foreground leading-none">
        {preset.label}
      </span>
    </div>
  )
}

// ─── Panel ──────────────────────────────────────────────────────────────────

export function TransitionsPanel() {
  const setTransitionDragActive = useUIStore((s) => s.setTransitionDragActive)
  const [recents, recordRecent] = useRecentTransitions()

  const recentPresets = recents
    .map((type) => TRANSITION_PRESETS.find((p) => p.type === type))
    .filter((p): p is TransitionPreset => Boolean(p))

  function handleDragStart(type: TransitionType) {
    setTransitionDragActive(true)
    recordRecent(type)
  }

  function handleDragEnd() {
    setTransitionDragActive(false)
  }

  return (
    <div className="flex-1 overflow-y-auto p-3 space-y-4">
      {recentPresets.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80">
            Recent
          </h3>
          <div className="grid grid-cols-3 gap-2.5">
            {recentPresets.map((preset) => (
              <TransitionCard
                key={`recent-${preset.type}`}
                preset={preset}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
              />
            ))}
          </div>
        </section>
      )}

      <section className="space-y-2">
        {recentPresets.length > 0 && (
          <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80">
            All
          </h3>
        )}
        <div className="grid grid-cols-3 gap-2.5">
          {TRANSITION_PRESETS.map((preset) => (
            <TransitionCard
              key={preset.type}
              preset={preset}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
            />
          ))}
        </div>
      </section>
    </div>
  )
}
