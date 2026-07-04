/**
 * EditorToolbar — top toolbar bar for the NLE editor.
 *
 * Renders a compact, single-row toolbar at the top of the editor page with
 * two project-level zones:
 *
 *   Left zone:
 *     - Brand mark (returns to Content Planner; morphs to an arrow on hover)
 *     - Project title (truncated)
 *     - Auto-save status badge (Unsaved / Saving... / Save error)
 *
 *   Right zone:
 *     - Undo / Redo history buttons
 *     - Separator
 *     - Export button — opens popover with resolution picker and progress
 *
 * Everything that *operates on the timeline or its clips* (Select / Slice
 * tools, Snap toggle, Captions popover, timeline Fit View / zoom) lives in
 * the PlaybackBar above the timeline tracks — see EditorPage.tsx. Keeping the
 * top toolbar to project-level controls and the timeline header to editing
 * controls follows IMG.LY's separation and means tools sit next to the
 * surface they affect.
 *
 * Persistence status:
 *   Reads `isDirty`, `saving`, and `error` from the persistence hook output
 *   via props so the toolbar stays decoupled from the persistence hook itself.
 *
 * Export:
 *   The Export button opens a popover containing the ExportPanel component.
 *   The ExportPanel manages its own Realtime subscription for render progress
 *   tracking and is isolated in its own component (ExportToolbarButton) to
 *   prevent Realtime-driven re-renders from cascading to the toolbar.
 *
 * SOLID: SRP — only handles project-level toolbar rendering and dispatching
 *   store actions for history. Export UI is delegated to ExportPanel.
 * SOLID: DIP — depends on the Zustand store interface and the useExport hook
 *   abstraction.
 *
 * @see EditorPage.tsx — PlaybackBar that hosts timeline tools above the tracks
 * @see ExportPanel.tsx for the full export UI
 */

import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router'
import {
  AlertCircle,
  ArrowLeft,
  Check,
  Download,
  Loader2,
  Redo2,
  Undo2,
} from 'lucide-react'
import { useEditorStore } from '../store/editor-store'
import { useEditorHost } from '../host'
import { ExportPanel } from './ExportPanel'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '../ui/popover'

// ─── Props ───────────────────────────────────────────────────────────────────

export interface EditorToolbarProps {
  /** ID of the current project, shown in the title area. */
  projectId: string | undefined

  /** Display name of the project (from Supabase). Falls back to projectId if null. */
  projectTitle?: string | null

  /** Whether unsaved changes exist in the editor state. */
  isDirty: boolean

  /** Whether an auto-save is currently in flight. */
  saving: boolean

  /** Auto-save error message, if any. */
  saveError: string | null

  /**
   * Epoch ms of the most recent successful save (or the server's `updated_at`
   * on initial load). Null if the project has never been saved.
   */
  lastSavedAt: number | null
}

// ─── ExportToolbarButton ─────────────────────────────────────────────────────

/**
 * ExportToolbarButton — compact toolbar button that opens an export popover.
 *
 * Renders a small "Export" button in the toolbar right zone (Phase 3.9).
 * Clicking it opens a popover containing the full ExportPanel with resolution
 * picker, credit cost display, progress bar, and download button.
 *
 * Isolated as its own component so the ExportPanel's re-renders (Realtime
 * progress updates) don't cascade to the rest of the toolbar.
 *
 * Surface is rendered through Radix Popover (portaled to body) so it escapes
 * the editor's stacking contexts — the timeline tracks and resizable panels
 * can no longer paint over the popover content.
 *
 * @see ExportPanel.tsx for the full export UI
 * @see PLAN.md Phase 3.9 "Export button in toolbar"
 */
function ExportToolbarButton({ projectId }: { projectId: string | undefined }) {
  const [isOpen, setIsOpen] = useState(false)

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <button
          aria-label="Export video"
          className={`
            flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-colors
            ${
              isOpen
                ? 'bg-primary text-primary-foreground'
                : 'bg-primary/10 text-primary hover:bg-primary/20'
            }
          `}
        >
          <Download size={14} className="shrink-0" aria-hidden />
          <span className="hidden md:inline">Export</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-[360px] p-0 rounded-2xl border-border/70 bg-popover/95 backdrop-blur-xl shadow-[0_24px_60px_-20px_oklch(0_0_0/0.25),0_2px_6px_-2px_oklch(0_0_0/0.08)]"
        aria-label="Export settings"
      >
        <ExportPanel
          projectId={projectId}
          onExportComplete={() => setIsOpen(false)}
        />
      </PopoverContent>
    </Popover>
  )
}

// ─── Sub-Components ──────────────────────────────────────────────────────────

/**
 * IconButton — a small icon-only toolbar button.
 *
 * Used for Undo and Redo. The timeline-side icon buttons (Snap, Fit View,
 * etc.) live in PlaybackBar and use chrome-styled tokens instead.
 */
function IconButton({
  onClick,
  disabled,
  active,
  title,
  children,
}: {
  onClick: () => void
  disabled?: boolean
  active?: boolean
  title: string
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={`
        flex items-center justify-center w-8 h-8 rounded-md text-xs transition-colors
        disabled:opacity-30 disabled:cursor-not-allowed
        ${
          active
            ? 'bg-primary/15 text-primary'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground'
        }
      `}
    >
      {children}
    </button>
  )
}

/** Thin vertical separator between toolbar groups. */
function Separator() {
  return <div className="w-px h-5 bg-border mx-0.5 shrink-0" aria-hidden />
}

// ─── Brand Mark ──────────────────────────────────────────────────────────────

/**
 * Static conic gradient for the HyGC brand mark. Duplicated (not imported)
 * from `@shared/config/gradients` — this package has no dependency on the
 * host app, so the palette is a local literal like the rest of this file's
 * design tokens (see `TRACK_TYPE_CONFIG` in timeline-utils.ts for precedent).
 */
const BRAND_MARK_CONIC =
  'conic-gradient(from 215deg at 50% 50% in oklch, ' +
  'oklch(0.58 0.20 268), ' +
  'oklch(0.66 0.18 322), ' +
  'oklch(0.70 0.16 42), ' +
  'oklch(0.66 0.15 200), ' +
  'oklch(0.58 0.20 268))'

/** The HyGC "H" glyph, same geometry as the sidebar/auth brand mark. */
function HGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 1024 1024" fill="currentColor" className={className} aria-hidden>
      <polygon points="214,266 326,334 326,733 214,812" />
      <polygon points="355,204 478,280 478,470 512,470 512,554 478,554 478,753 355,826" />
      <polygon points="669,204 546,280 546,470 512,470 512,554 546,554 546,753 669,826" />
      <polygon points="810,266 698,334 698,733 810,812" />
    </svg>
  )
}

/**
 * BrandBackButton — the toolbar's exit affordance.
 *
 * Renders the same gradient brand mark used in the app sidebar and auth
 * screen, so the editor's top-left corner reads as "HyGC", not "a tool with
 * a back button". Hovering (or focusing) crossfades the H glyph into an
 * arrow, so the mark reveals its function as a nav control without ever
 * needing a text label — the same trick CapCut and Arc use on their
 * top-left logo.
 */
function BrandBackButton({ path, title }: { path: string; title: string }) {
  return (
    <Link
      to={path}
      title={title}
      aria-label={title}
      className="group/back relative flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] shadow-sm outline-none transition-shadow duration-200 hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring/40"
      style={{ backgroundImage: BRAND_MARK_CONIC }}
    >
      <HGlyph className="absolute h-3.5 w-3.5 text-white opacity-100 drop-shadow-[0_1px_0_oklch(0_0_0/0.25)] transition-opacity duration-200 ease-out group-hover/back:opacity-0 group-focus-visible/back:opacity-0" />
      <ArrowLeft
        size={14}
        aria-hidden
        className="absolute text-white opacity-0 transition-opacity duration-200 ease-out group-hover/back:opacity-100 group-focus-visible/back:opacity-100"
      />
    </Link>
  )
}

// ─── Save Status ─────────────────────────────────────────────────────────────

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * Compact relative formatter, e.g. "just now", "2m ago", "1h ago", "Mar 5".
 *
 * We deliberately don't expose sub-minute precision ("8s ago"). The tick
 * interval is 30s, so a "Xs ago" label could be up to 30s stale within the
 * same minute — appearing precise when the cadence can't back it up. "Just
 * now" is the honest read for the first 60s.
 */
function formatSavedRelative(savedAt: number, now: number): string {
  const diff = now - savedAt
  if (diff < MINUTE) return 'just now'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`
  return new Date(savedAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })
}

/** Absolute time used in tooltip, e.g. "Saved at 2:14:08 PM". */
function formatSavedAbsolute(savedAt: number): string {
  return new Date(savedAt).toLocaleTimeString()
}

/**
 * SaveStatusIndicator — compact pill showing the current persistence state.
 *
 * Renders one of four states in priority order:
 *   1. error    — destructive AlertCircle + "Save failed" (tooltip = error)
 *   2. saving   — spinning Loader2 + "Saving…"
 *   3. dirty    — small muted dot only (no label — see note below)
 *   4. saved    — success Check + "Saved {relative}" (tooltip = absolute time)
 *
 * Why no "Unsaved changes" label: autosave debounces at 2s, so the dirty state
 * flashes briefly on nearly every edit. A loud label there reads like a
 * warning and erodes trust in autosave (cf. Linear/Figma, which stay silent
 * during the autosave window). The dot keeps the signal present for users who
 * want it, without the alarm.
 *
 * Below the `sm` breakpoint the resting "Saved …" state hides entirely — it's
 * the default state with the lowest information value and the editor toolbar
 * needs the horizontal space for the title and tool buttons. Transient states
 * (saving, error) and the dirty dot stay visible at every size.
 *
 * Re-renders itself every 30s so the relative "saved" label stays current
 * without the rest of the toolbar paying for it.
 */
function SaveStatusIndicator({
  isDirty,
  saving,
  saveError,
  lastSavedAt,
}: {
  isDirty: boolean
  saving: boolean
  saveError: string | null
  lastSavedAt: number | null
}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  const savedLabel = useMemo(
    () => (lastSavedAt ? formatSavedRelative(lastSavedAt, now) : null),
    [lastSavedAt, now]
  )

  if (saveError) {
    return (
      <span
        className="flex items-center gap-1 text-xs text-destructive/85 shrink-0"
        title={saveError}
        role="status"
      >
        <AlertCircle size={12} aria-hidden />
        <span className="hidden sm:inline">Save failed</span>
      </span>
    )
  }

  if (saving) {
    return (
      <span
        className="flex items-center gap-1 text-xs text-muted-foreground/80 shrink-0"
        role="status"
      >
        <Loader2 size={12} className="animate-spin" aria-hidden />
        <span className="hidden sm:inline">Saving…</span>
      </span>
    )
  }

  if (isDirty) {
    return (
      <span
        className="flex items-center shrink-0"
        title="Unsaved changes"
        role="status"
      >
        <span
          className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50"
          aria-hidden
        />
        <span className="sr-only">Unsaved changes</span>
      </span>
    )
  }

  if (savedLabel && lastSavedAt) {
    return (
      <span
        className="hidden sm:flex items-center gap-1 text-xs text-muted-foreground/60 shrink-0"
        title={`Saved at ${formatSavedAbsolute(lastSavedAt)}`}
        role="status"
      >
        <Check size={12} className="text-success" aria-hidden />
        <span>Saved {savedLabel}</span>
      </span>
    )
  }

  return null
}

// ─── Toolbar Component ────────────────────────────────────────────────────────

/**
 * EditorToolbar — renders the project-level NLE toolbar.
 *
 * Left: Brand mark (back), Project title, Save status.
 * Right: Undo, Redo, Export.
 *
 * All timeline-editing tools (Select, Slice, Snap, Captions, Fit View, zoom)
 * live in PlaybackBar directly above the tracks — see EditorPage.tsx.
 *
 * @example
 *   <EditorToolbar
 *     projectId={projectId}
 *     projectTitle={project?.title}
 *     isDirty={persistence.isDirty}
 *     saving={persistence.saving}
 *     saveError={persistence.error}
 *   />
 */
export function EditorToolbar({
  projectId,
  projectTitle,
  isDirty,
  saving,
  saveError,
  lastSavedAt,
}: EditorToolbarProps) {
  // ── Store Selectors ──

  const undo = useEditorStore((s) => s.undo)
  const redo = useEditorStore((s) => s.redo)
  const canUndo = useEditorStore((s) => s.canUndo)
  const canRedo = useEditorStore((s) => s.canRedo)

  // ── Derived Values ──

  const { exit } = useEditorHost()
  const displayTitle = projectTitle ?? projectId ?? 'New Project'

  // ── Render ──

  return (
    <div
      className="flex items-center gap-1 h-12 px-3 border-b border-border/60 bg-background/95 backdrop-blur-md shrink-0 relative"
      role="toolbar"
      aria-label="Editor toolbar"
    >
      {/* ── Left Zone: Navigation + Title ── */}

      {exit && (
        <>
          <BrandBackButton path={exit.path} title={exit.title ?? 'Back'} />
          <Separator />
        </>
      )}

      {/* Project title — typographic anchor for the toolbar. Slight tracking
          tightening (-0.01em) lands the Space Grotesk display at a confident
          read without pretending to be a hero. */}
      <span
        className="text-[15px] font-semibold truncate max-w-40 sm:max-w-64 text-foreground -tracking-[0.01em]"
        title={displayTitle}
      >
        {displayTitle}
      </span>

      {/* Auto-save status — positioned immediately after the title */}
      <SaveStatusIndicator
        isDirty={isDirty}
        saving={saving}
        saveError={saveError}
        lastSavedAt={lastSavedAt}
      />

      {/* Spacer — pushes history + export to the right */}
      <div className="flex-1" />

      {/* ── Right Zone: Undo / Redo ── */}

      <IconButton
        onClick={undo}
        disabled={!canUndo()}
        title="Undo (Ctrl+Z)"
      >
        <Undo2 size={14} aria-hidden />
      </IconButton>

      <IconButton
        onClick={redo}
        disabled={!canRedo()}
        title="Redo (Ctrl+Shift+Z)"
      >
        <Redo2 size={14} aria-hidden />
      </IconButton>

      <Separator />

      {/*
       * ── Export ──
       *
       * Isolated component with its own popover. The ExportPanel inside the
       * popover manages its own Realtime subscription for progress updates,
       * so it must be isolated to prevent re-renders from propagating to the
       * toolbar during export.
       */}
      <ExportToolbarButton projectId={projectId} />
    </div>
  )
}
