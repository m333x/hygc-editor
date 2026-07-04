/**
 * EditorPage — Non-Linear Editor (NLE) main page for HyGC.
 *
 * This is the full-screen editor interface that hosts all NLE panels:
 * the toolbar, resizable side panels, preview canvas, and timeline.
 *
 * ─── Desktop Layout ──────────────────────────────────────────────────────────
 *
 *   ┌─────────────────────────────────────────────────────────────────────────┐
 *   │ EditorToolbar (44px, fixed)                                             │
 *   │ [← Back] [Title] [Saving…]          [Undo][Redo] | [V][C] | [⊞][⊡]   │
 *   ├────────────────────┬────────────────────────────┬─────────────────────┤
 *   │                    │                            │                     │
 *   │  AssetPanel        │  PreviewCanvas             │  InspectorPanel     │
 *   │  (resizable left)  │  (fills center)            │  (resizable right)  │
 *   │  default: 28%      │                            │  default: 28%       │
 *   │                    │  1080×1920 scaled to fit   │                     │
 *   │  Tabs:             │                            │  Sections:          │
 *   │  Assets / AI / ↑   │                            │  Transform          │
 *   │                    │                            │  Crop               │
 *   │                    │                            │  Speed              │
 *   ├────────────────────┴────────────────────────────┴─────────────────────┤
 *   │ Playback bar (40px)                                                     │
 *   │ [▶ Play] [00:00 / 01:00]                         Zoom [-][═══][+]     │
 *   ├─────────────────────────────────────────────────────────────────────────┤
 *   │ Timeline (~42% height, resizable)                                        │
 *   │ ┌─ Captions ──────────────────────────────────────────────────────┐    │
 *   │ ├─ B-Roll ───[clip1]─────────[clip2]──────────────────────────────┤    │
 *   │ ├─ Voiceover ─[vo1]──────────[vo2]───────────────────────────────┤    │
 *   │ └─ Music ────[bg music]──────────────────────────────────────────┘    │
 *   └─────────────────────────────────────────────────────────────────────────┘
 *
 * ─── Mobile Layout ──────────────────────────────────────────────────────────
 *
 *   The three-panel layout collapses for mobile viewports (< 768px):
 *   - Asset and Inspector panels move into a bottom sheet with tabs
 *   - Preview fills top ~40vh
 *   - Timeline fills middle ~30vh
 *   - Playback bar between preview and timeline
 *   - Bottom sheet fills remaining ~30vh
 *
 * ─── Panel Persistence ──────────────────────────────────────────────────────
 *
 *   Panel sizes (percentages) are saved to localStorage with the key
 *   `hygc:editor:panel-sizes` (migrates from legacy `clipforge:editor:panel-sizes`). On next visit the same sizes are restored.
 *   Group layout is persisted via useDefaultLayout and localStorage.
 *
 * ─── State Management ───────────────────────────────────────────────────────
 *
 *   All editor state lives in the Zustand editor store. This page component:
 *     - Mounts useEditorPersistence to load/save state from Supabase
 *     - Mounts useEditorKeyboard to register global keyboard shortcuts
 *     - Mounts usePlaybackEngine to sync the Zustand store ↔ Remotion Player
 *     - Passes track/caption data down to PreviewCanvas and the timeline
 *     - Does NOT manage its own state beyond which project is loaded
 *
 * ─── Playback Architecture (Phase 3.5) ──────────────────────────────────────
 *
 *   The desktop PreviewCanvas receives a forwarded ref (`canvasRef`) that
 *   exposes the Remotion Player's imperative API (play/pause/seekTo).
 *   `usePlaybackEngine(canvasRef)` bridges the Zustand store to that handle:
 *     - store.isPlaying     → canvas.play() / canvas.pause()
 *     - store.playheadPos   → canvas.seekTo(frame)   [when paused]
 *     - player.frameupdate  → store.setPlayhead(ms)  [during playback]
 *
 *   Note: Only the desktop PreviewCanvas receives the ref. The mobile canvas
 *   is a separate instance wired in Phase 5.8 (Mobile Responsive Pass).
 *
 * SOLID: SRP — this component only handles page-level layout and orchestration.
 *   All business logic, state management, and rendering are delegated to hooks,
 *   stores, and focused child components.
 * SOLID: DIP — depends on the Zustand store interface, not on direct state.
 *
 * @see README.md Section 7.2 for canvas layout specification
 * @see PLAN.md Phase 3.2 for editor layout requirements
 * @see PLAN.md Phase 3.4 for timeline UI (implemented in Timeline.tsx)
 * @see PLAN.md Phase 3.5 for playback system requirements
 * @see PLAN.md Phase 3.6 for inspector panel wiring requirements
 * @see PLAN.md Phase 3.7 for asset panel wiring requirements
 * @see usePlaybackEngine.ts for the Zustand ↔ Remotion Player bridge
 */

import { useRef, useState, useCallback, useEffect, useMemo } from 'react'
import { useParams } from 'react-router'
import {
  ArrowLeftFromLine,
  ArrowRightFromLine,
  ArrowLeftRight,
  Gauge,
  Magnet,
  Minus,
  MousePointer2,
  MoveHorizontal,
  Plus,
  Scissors,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from 'lucide-react'
import {
  Group,
  Panel,
  Separator,
  useDefaultLayout,
} from 'react-resizable-panels'
import { useEditorStore } from '../store/editor-store'
import { usePlaybackStore } from '../store/playback-store'
import { useUIStore } from '../store/ui-store'
import { usePlayback, parseTimeToMs } from '../hooks/usePlayback'
import { MAX_TIMELINE_DURATION_MS } from '../components/timeline/timeline-utils'
import { useEditorKeyboard } from '../hooks/useEditorKeyboard'
import { useEditorPersistence } from '../hooks/useEditorPersistence'
import { usePlaybackEngine } from '../hooks/usePlaybackEngine'
import { useProjectTitle } from '../hooks/useProjectTitle'
import { PreviewCanvas } from '../components/PreviewCanvas'
import type { PreviewCanvasHandle } from '../components/PreviewCanvas'
import { EditorToolbar } from '../components/EditorToolbar'
import { ShortcutCheatsheet } from '../components/ShortcutCheatsheet'
import { AssetPanel } from '../components/AssetPanel'
import { InspectorPanel } from '../components/InspectorPanel'
import { MobileBottomSheet } from '../components/MobileBottomSheet'
import { EditorPageSkeleton } from '../components/EditorPageSkeleton'
import { Timeline } from '../components/timeline'
import { frameToMs } from '../engine/composition-utils'
import type { Clip, ToolMode, Track } from '../types'

// ─── Panel Size Constants ─────────────────────────────────────────────────────

/**
 * react-resizable-panels v4: numeric values are pixels.
 * Side panels and timeline target ~500px for usable desktop layout.
 */
const SIDE_PANEL_MIN = 320
const SIDE_PANEL_DEFAULT = 500
const SIDE_PANEL_MAX = 900
const TIMELINE_MIN = 260
const TIMELINE_DEFAULT = 580
const TIMELINE_MAX = 900

/**
 * Key used by react-resizable-panels to persist sizes in localStorage.
 * Scoped to the editor feature so it doesn't collide with other panel groups.
 */
const LEGACY_PANEL_STORAGE_KEY = 'clipforge:editor:panel-sizes:v8'
const PANEL_STORAGE_KEY = 'hygc:editor:panel-sizes:v8'

if (typeof window !== 'undefined') {
  const current = localStorage.getItem(PANEL_STORAGE_KEY)
  const legacy = localStorage.getItem(LEGACY_PANEL_STORAGE_KEY)
  if (!current && legacy) {
    localStorage.setItem(PANEL_STORAGE_KEY, legacy)
    localStorage.removeItem(LEGACY_PANEL_STORAGE_KEY)
  }
}

// ─── Sub-Components ──────────────────────────────────────────────────────────

/**
 * PanelDivider — a thin draggable resize handle between panels.
 *
 * Uses react-resizable-panels' Separator. The visual indicator
 * (a 1px line with a hover highlight) is rendered inside the handle area.
 *
 * @param direction - 'horizontal' for vertical drag handles (between side panels),
 *                    'vertical' for horizontal drag handles (above timeline).
 */
function PanelDivider({ direction = 'horizontal' }: { direction?: 'horizontal' | 'vertical' }) {
  if (direction === 'vertical') {
    return (
      <Separator
        className="
          h-2.5 flex items-center justify-center group cursor-row-resize
          hover:bg-primary/10 transition-colors
        "
        aria-label="Resize timeline"
      >
        <div className="w-12 h-0.5 rounded-full bg-border group-hover:bg-primary/50 transition-colors" />
      </Separator>
    )
  }

  return (
    <Separator
      className="
        w-2.5 flex items-center justify-center group cursor-col-resize
        hover:bg-primary/10 transition-colors
      "
      aria-label="Resize panel"
    >
      <div className="h-8 w-0.5 rounded-full bg-border group-hover:bg-primary/50 transition-colors" />
    </Separator>
  )
}

/**
 * TimecodeInput — displays current time / duration; click to type a new time and seek.
 *
 * Shows "MM:SS.mmm / MM:SS.mmm". Clicking the current time switches to an input;
 * Enter or blur applies the parsed time (clamped to [0, duration]) and seeks.
 * Escape cancels. Accepts e.g. "1:30", "1:30.5", "90", "00:01:30.250".
 */
function TimecodeInput({
  formattedTime,
  formattedDuration,
  seekMaxMs,
  setPlayhead,
}: {
  formattedTime: string
  formattedDuration: string
  /** Max time the playhead can be set to (timeline length, e.g. 10 min). */
  seekMaxMs: number
  setPlayhead: (ms: number) => void
}) {
  const [editing, setEditing] = useState(false)
  const [inputValue, setInputValue] = useState(formattedTime)
  const inputRef = useRef<HTMLInputElement>(null)

  const commit = useCallback(
    (raw: string) => {
      const ms = parseTimeToMs(raw)
      if (ms !== null) {
        const clamped = Math.max(0, Math.min(ms, seekMaxMs))
        setPlayhead(clamped)
      }
      setEditing(false)
    },
    [seekMaxMs, setPlayhead],
  )

  const cancel = useCallback(() => {
    setInputValue(formattedTime)
    setEditing(false)
  }, [formattedTime])

  useEffect(() => {
    if (editing) {
      setInputValue(formattedTime)
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing, formattedTime])

  useEffect(() => {
    if (!editing) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Enter') {
        e.preventDefault()
        commit((e.target as HTMLInputElement).value)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        cancel()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [editing, commit, cancel])

  if (editing) {
    // Editing state mirrors the display state's typography so the swap is
    // seamless. Width auto-fits the current text via an invisible measuring
    // span layered behind the input (inline-grid trick) — `ch`-based sizing
    // overshoots tabular-nums text because `:` and `.` are narrower than `0`,
    // which made the row visibly grow on every click.
    return (
      <div className="flex items-baseline gap-1.5 shrink-0 px-1.5 py-0.5 rounded bg-editor-chrome-strong ring-2 ring-ring">
        <span className="relative inline-grid">
          <span
            aria-hidden
            className="invisible whitespace-pre col-start-1 row-start-1 text-[16px] leading-none tabular-nums font-semibold tracking-tight"
          >
            {inputValue || formattedTime || ' '}
          </span>
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onBlur={() => commit(inputValue)}
            className="col-start-1 row-start-1 w-full text-[16px] leading-none tabular-nums font-semibold tracking-tight text-editor-on-chrome bg-transparent border-0 p-0 focus:outline-none"
            aria-label="Go to time (e.g. 1:30 or 90.5)"
          />
        </span>
        <span aria-hidden className="text-editor-on-chrome-muted/60 text-[12px] leading-none">·</span>
        <span className="text-[11px] leading-none tabular-nums text-editor-on-chrome-muted">
          {formattedDuration}
        </span>
      </div>
    )
  }

  return (
    // Hero timecode — the editor's signature element. Space Grotesk display
    // weight at 16px on the current time, lighter / smaller on the duration
    // gives the editor a typographic identity that CapCut and shadcn-default
    // NLEs don't have. The dot separator (·) is intentional editorial space
    // instead of "/" which reads more like a fraction than a relationship.
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="flex items-baseline gap-1.5 shrink-0 transition-colors px-1.5 py-0.5 rounded hover:bg-editor-chrome-strong"
      aria-label={`Playhead at ${formattedTime} of ${formattedDuration}. Click to go to a specific time.`}
      title="Click to go to time (e.g. 1:30 or 90.5)"
    >
      <span className="text-[16px] leading-none tabular-nums font-semibold tracking-tight text-editor-on-chrome">
        {formattedTime}
      </span>
      <span aria-hidden className="text-editor-on-chrome-muted/60 text-[12px] leading-none">·</span>
      <span className="text-[11px] leading-none tabular-nums text-editor-on-chrome-muted">
        {formattedDuration}
      </span>
    </button>
  )
}

// ── Chrome button vocabulary ─────────────────────────────────────────────────
//
// The playback bar is dark in both light + dark themes (it shares the
// `editor-chrome` surface with the PreviewCanvas matte), so every button here
// uses `editor-on-chrome*` tokens instead of the theme-aware `muted-foreground`.
//
// One unified ACTIVE / TOGGLED / OPEN tint is used across the bar — `bg-ring/20`
// with full-strength on-chrome text. Picking a single value means "pressed,"
// "popover open," "modifier on," and "tool selected" all carry the same
// recognition. Selected tool modes additionally get a 2px bottom underline so
// they read as a *mode* the editor is in (Select / Slice) rather than just a
// toggle. The Play button is the only solid accent in the bar.
const CHROME_BUTTON_BASE =
  'flex items-center justify-center rounded-md transition-colors shrink-0 disabled:opacity-30 disabled:cursor-not-allowed'
const CHROME_BUTTON_IDLE =
  'text-editor-on-chrome-muted hover:text-editor-on-chrome hover:bg-editor-chrome-strong'
const CHROME_BUTTON_ACTIVE = 'bg-ring/20 text-editor-on-chrome'

/**
 * ChromeIconButton — 32×32 icon-only button (step back/forward, zoom +/−, fit).
 */
function ChromeIconButton({
  onClick,
  active,
  disabled,
  title,
  className = '',
  children,
}: {
  onClick: () => void
  active?: boolean
  disabled?: boolean
  title: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={`
        ${CHROME_BUTTON_BASE} w-8 h-8
        ${active ? CHROME_BUTTON_ACTIVE : CHROME_BUTTON_IDLE}
        ${className}
      `}
    >
      {children}
    </button>
  )
}

/**
 * ChromeLabeledButton — 32 tall, icon + label.
 *
 * Used for tool modes (Select / Slice) and modifiers (Snap, Captions). One
 * active treatment (`CHROME_BUTTON_ACTIVE`) is shared across the bar — the
 * label disambiguates intent, no extra accent needed. Shortcut hints live in
 * the tooltip, never in the visible label.
 */
function ChromeLabeledButton({
  active,
  onClick,
  title,
  shortcut,
  icon,
  label,
  ...rest
}: {
  active: boolean
  onClick: () => void
  title: string
  shortcut?: string
  icon: React.ReactNode
  label: string
  'aria-expanded'?: boolean
  'aria-haspopup'?: 'dialog' | 'menu'
}) {
  const tooltip = shortcut ? `${title} (${shortcut})` : title
  return (
    <button
      type="button"
      onClick={onClick}
      title={tooltip}
      aria-label={tooltip}
      aria-pressed={active}
      {...rest}
      className={`
        ${CHROME_BUTTON_BASE} h-8 px-2.5 gap-1.5 text-xs font-medium
        ${active ? CHROME_BUTTON_ACTIVE : CHROME_BUTTON_IDLE}
      `}
    >
      {icon}
      <span className="hidden lg:inline">{label}</span>
    </button>
  )
}

/** Thin vertical separator between PlaybackBar clusters. */
function BarDivider() {
  return <div className="w-px h-5 bg-editor-border shrink-0 mx-2" aria-hidden />
}

/**
 * PlaybackBar — timeline tools + transport + view controls.
 *
 * Sits directly above the timeline tracks at full window width so every tool
 * is one cursor sweep away from the surface it operates on. The bar reads as
 * three compositional zones — **edit · transport · monitor** — with the
 * transport pinned dead-center so it's predictable regardless of how the user
 * resizes the sidebars:
 *
 *   [Select | Slice]  ·  [Snap] [Captions]   ←flex-1→   ⏮ ▶ ⏭  00:00 · 01:00   ←flex-1→   🔊 ──  ·  − ═══ +  ⊞
 *
 * Compositional zones (left to right):
 *   1. EDIT     — tool modes (Select/Slice) + modifiers (Snap, Captions)
 *   2. TRANSPORT (centered) — step / play / step + timecode
 *   3. MONITOR  — global volume + timeline zoom + fit view
 *
 * Active-state vocabulary:
 *   - Toggle / modifier ON / popover OPEN  → `bg-ring/20` (CHROME_BUTTON_ACTIVE)
 *   - Selected tool mode (Select/Slice)    → `bg-ring/20` + 2px underline
 *   - Primary action (Play idle)           → ghost — same chrome buttons as the
 *     rest of the transport, slightly emphasised by using full on-chrome text
 *     even when not hovered, so it stands out without competing in color
 *
 * All helpers use `editor-on-chrome*` tokens because the bar shares the dark
 * editor surface in both themes.
 */
function PlaybackBar() {
  const playback = usePlayback()
  const playheadMs = usePlaybackStore((s) => s.playheadPosition)
  const composition = useEditorStore((s) => s.composition)
  const zoomLevel = useUIStore((s) => s.zoomLevel)
  const setZoomLevel = useUIStore((s) => s.setZoomLevel)
  const fitTimelineToWindow = useUIStore((s) => s.fitTimelineToWindow)
  const globalAudioVolume = useEditorStore((s) => s.globalAudioVolume)
  const setGlobalAudioVolume = useEditorStore((s) => s.setGlobalAudioVolume)
  const lastNonZeroVolumeRef = useRef(globalAudioVolume > 0 ? globalAudioVolume : 1)
  useEffect(() => {
    if (globalAudioVolume > 0) lastNonZeroVolumeRef.current = globalAudioVolume
  }, [globalAudioVolume])
  const activeToolMode = useUIStore((s) => s.activeToolMode)
  const setToolMode = useUIStore((s) => s.setToolMode)
  const snapEnabled = useUIStore((s) => s.snapEnabled)
  const toggleSnap = useUIStore((s) => s.toggleSnap)

  const frameDurationMs = 1000 / composition.fps

  function handleSetTool(mode: ToolMode) {
    setToolMode(mode)
  }

  return (
    // PlaybackBar shares the dark editor-chrome surface (same as preview matte
    // and timeline header) so the three editing surfaces read as one editor
    // regardless of OS theme.
    <div className="flex items-center h-12 px-3 border-y border-editor-border bg-editor-chrome text-editor-on-chrome shrink-0">
      {/* ── EDIT zone — tools + modifiers (desktop only; mobile uses the bottom sheet) ── */}
      <div className="hidden md:flex items-center gap-1 shrink-0">
        {/* Tool modes (Select / Slice) are exclusive — the active tint is
            enough on its own to communicate which mode the editor is in. */}
        <ChromeLabeledButton
          active={activeToolMode === 'select'}
          onClick={() => handleSetTool('select')}
          title="Select tool"
          shortcut="V"
          icon={
            <MousePointer2
              size={13}
              aria-hidden
              className={activeToolMode === 'select' ? 'fill-current opacity-80' : ''}
            />
          }
          label="Select"
        />
        <ChromeLabeledButton
          active={activeToolMode === 'slice'}
          onClick={() => handleSetTool('slice')}
          title="Slice tool — click a clip to split it"
          shortcut="C"
          icon={
            <Scissors
              size={13}
              aria-hidden
              className={activeToolMode === 'slice' ? 'fill-current opacity-80' : ''}
            />
          }
          label="Slice"
        />

        {/* Track Select Forward / Backward — Premiere's A / Shift+A. Kept as
            icon-only so the bar stays compact; the tool affordance reads from
            the arrow direction and the tooltip carries the shortcut hint. */}
        <ChromeIconButton
          active={activeToolMode === 'track-select-forward'}
          onClick={() => handleSetTool('track-select-forward')}
          title="Track Select Forward — click to select every clip to the right (A)"
        >
          <ArrowRightFromLine size={13} aria-hidden />
        </ChromeIconButton>
        <ChromeIconButton
          active={activeToolMode === 'track-select-backward'}
          onClick={() => handleSetTool('track-select-backward')}
          title="Track Select Backward — click to select every clip to the left (⇧A)"
        >
          <ArrowLeftFromLine size={13} aria-hidden />
        </ChromeIconButton>

        {/* Rate Stretch — Premiere's R. Drag a clip's edge to change its
            playback speed so the existing source material fits the new length,
            without re-trimming. Kept icon-only for parity with the other
            structural tools in this cluster. */}
        <ChromeIconButton
          active={activeToolMode === 'rate-stretch'}
          onClick={() => handleSetTool('rate-stretch')}
          title="Rate Stretch — drag a clip's edge to change its playback speed (R)"
        >
          <Gauge size={13} aria-hidden />
        </ChromeIconButton>

        {/* Slip — Premiere's Y. Drag the clip body left/right to slide the
            source window (inPoint/outPoint together) without moving the clip
            on the timeline. Useful when the cut points are right but the
            chosen portion of the take isn't. */}
        <ChromeIconButton
          active={activeToolMode === 'slip'}
          onClick={() => handleSetTool('slip')}
          title="Slip — drag a clip to slide its source content without moving it (Y)"
        >
          <ArrowLeftRight size={13} aria-hidden />
        </ChromeIconButton>

        <BarDivider />

        {/* Modifier — Snap is the only persistent editor-behavior toggle on
            the bar; caption authoring lives on the left rail's Captions tab. */}
        <ChromeLabeledButton
          active={snapEnabled}
          onClick={toggleSnap}
          title={
            snapEnabled
              ? 'Snap enabled — click to disable (⇧S)'
              : 'Snap disabled — click to enable (⇧S)'
          }
          icon={<Magnet size={13} aria-hidden />}
          label="Snap"
        />

      </div>

      {/* Symmetric spacers around the TRANSPORT zone keep transport centered no
          matter how wide the editor window or sidebars are. */}
      <div className="flex-1" />

      {/* ── TRANSPORT zone — step / play / step + timecode (always visible) ── */}
      <div className="flex items-center gap-1 shrink-0">
        <ChromeIconButton
          onClick={() => playback.setPlayhead(Math.max(0, playheadMs - frameDurationMs))}
          title="Step back one frame"
        >
          <SkipBack size={14} aria-hidden />
        </ChromeIconButton>

        {/* Play / Pause — ghost button in the same chrome vocabulary as its
            siblings. Full on-chrome text (not muted) plus a quietly-tinted
            idle background gives it just enough emphasis to read as primary
            without re-introducing the competing accent fill. */}
        <button
          type="button"
          onClick={playback.togglePlayback}
          aria-label={playback.isPlaying ? 'Pause (Space)' : 'Play (Space)'}
          title={playback.isPlaying ? 'Pause (Space)' : 'Play (Space)'}
          className={`${CHROME_BUTTON_BASE} w-8 h-8 bg-editor-chrome-strong/60 text-editor-on-chrome hover:bg-editor-chrome-strong active:scale-95`}
        >
          {playback.isPlaying ? (
            /* Pause icon */
            <svg width="12" height="12" viewBox="0 0 10 10" fill="currentColor" aria-hidden>
              <rect x="1" y="1" width="3" height="8" />
              <rect x="6" y="1" width="3" height="8" />
            </svg>
          ) : (
            /* Play icon */
            <svg width="12" height="12" viewBox="0 0 10 10" fill="currentColor" aria-hidden>
              <path d="M2 1L9 5L2 9V1Z" />
            </svg>
          )}
        </button>

        <ChromeIconButton
          onClick={() => playback.setPlayhead(Math.min(playback.compositionDuration, playheadMs + frameDurationMs))}
          title="Step forward one frame"
        >
          <SkipForward size={14} aria-hidden />
        </ChromeIconButton>

        {/* Timecode — click to type a time and seek */}
        <TimecodeInput
          formattedTime={playback.formattedTime}
          formattedDuration={playback.formattedDuration}
          seekMaxMs={MAX_TIMELINE_DURATION_MS}
          setPlayhead={playback.setPlayhead}
        />

      </div>

      <div className="flex-1" />

      {/* ── MONITOR zone — volume + zoom + fit view ── */}
      <div className="flex items-center shrink-0">
        {/* Global audio volume — icon + slider, paired as a single control. */}
        <div className="hidden md:flex items-center gap-2 shrink-0" aria-label="Global audio volume">
          <button
            type="button"
            onClick={() => {
              if (globalAudioVolume > 0) {
                lastNonZeroVolumeRef.current = globalAudioVolume
                setGlobalAudioVolume(0)
              } else {
                setGlobalAudioVolume(lastNonZeroVolumeRef.current || 1)
              }
            }}
            className="shrink-0 text-editor-on-chrome-muted hover:text-editor-on-chrome transition-colors"
            aria-label={globalAudioVolume === 0 ? 'Unmute master volume' : 'Mute master volume'}
            title={globalAudioVolume === 0 ? 'Unmute' : 'Mute'}
          >
            {globalAudioVolume === 0 ? (
              <VolumeX size={14} aria-hidden />
            ) : (
              <Volume2 size={14} aria-hidden />
            )}
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={globalAudioVolume}
            onChange={(e) => setGlobalAudioVolume(Number(e.target.value))}
            className="w-16 h-1.5 accent-ring cursor-pointer"
            aria-label="Global audio volume"
            title={`Volume ${Math.round(globalAudioVolume * 100)}%`}
          />
        </div>

        <div className="hidden md:block"><BarDivider /></div>

        {/* Timeline zoom — slider flanked by real Minus / Plus icon buttons so
            the geometry matches the rest of the bar; Fit View resets zoom. */}
        <div className="flex items-center gap-1 shrink-0" aria-label="Timeline zoom">
          <ChromeIconButton
            onClick={() => setZoomLevel(Math.max(10, zoomLevel - 20))}
            title="Zoom out (−)"
          >
            <Minus size={14} aria-hidden />
          </ChromeIconButton>
          <input
            type="range"
            min={10}
            max={500}
            value={zoomLevel}
            onChange={(e) => setZoomLevel(Number(e.target.value))}
            className="w-20 lg:w-28 h-1.5 accent-ring cursor-pointer"
            aria-label="Zoom level"
            title={`Zoom: ${zoomLevel}px/s`}
          />
          <ChromeIconButton
            onClick={() => setZoomLevel(Math.min(500, zoomLevel + 20))}
            title="Zoom in (+)"
          >
            <Plus size={14} aria-hidden />
          </ChromeIconButton>
          <ChromeIconButton
            onClick={fitTimelineToWindow}
            title="Fit timeline to window (\)"
            className="hidden md:flex"
          >
            <MoveHorizontal size={14} aria-hidden />
          </ChromeIconButton>
        </div>
      </div>
    </div>
  )
}

// TimelinePlaceholder has been replaced by the full Timeline component (Phase 3.4).
// The Timeline component is imported from '../components/timeline' above.

// ─── EditorPage Component ─────────────────────────────────────────────────────

/**
 * EditorPage — the full-screen NLE interface.
 *
 * Orchestrates layout and mounts all necessary hooks. All editor state
 * is managed by the Zustand store; this component only handles layout
 * composition and route-level concerns.
 *
 * Route: /editor/:projectId
 *
 * @example
 *   // Accessed via React Router:
 *   <Route path="/editor/:projectId" element={<EditorPage />} />
 */
export default function EditorPage() {
  const { projectId } = useParams<{ projectId: string }>()

  // ── State & Hooks ──

  const tracks = useEditorStore((s) => s.tracks)
  const captionStyle = useEditorStore((s) => s.captionStyle)
  const composition = useEditorStore((s) => s.composition)
  const globalAudioVolume = useEditorStore((s) => s.globalAudioVolume)
  const isPlaying = usePlaybackStore((s) => s.isPlaying)
  const setPlayhead = usePlaybackStore((s) => s.setPlayhead)
  const setPlaying = usePlaybackStore((s) => s.setPlaying)
  const liveSlip = useUIStore((s) => s.liveSlip)

  /**
   * Tracks fed to the preview canvas, with any in-flight Slip drag applied so
   * the Remotion Player scrubs to the new source frame in real time. The
   * commit lives in `slipClip` on the editor store and runs on pointer
   * release — until then we transform a *display copy* of the dragged clip
   * (and its linked `clip_audio` partner) without touching the persistent
   * store. When no slip is active the original `tracks` reference is
   * returned, so PreviewCanvas's `inputProps` memo stays stable and nothing
   * downstream re-renders.
   *
   * The delta arriving from `liveSlip` is already clamped to
   * `[-inPoint, sourceEnd - outPoint]` by the producer (`TimelineClip`), so
   * we apply it directly here without re-clamping.
   */
  const displayTracks = useMemo<Track[]>(() => {
    if (!liveSlip || liveSlip.sourceDeltaMs === 0) return tracks
    const { clipId, sourceDeltaMs } = liveSlip

    // Find the host so we know whether to mirror onto a linked clip_audio.
    let hostClip: Clip | undefined
    let hostTrackType: Track['type'] | undefined
    for (const track of tracks) {
      const found = track.clips.find((c) => c.id === clipId)
      if (found) {
        hostClip = found
        hostTrackType = track.type
        break
      }
    }
    if (!hostClip || !hostTrackType) return tracks

    // Mirror the same linked-audio rule the store's `slipClip` uses so the
    // preview matches what release will commit (a video slip with linked
    // audio also drags the paired `clip_audio` window).
    const isVideoHost = hostTrackType === 'video'
    const audioLinked = isVideoHost ? hostClip.audioLinked !== false : true

    const applySlip = (clip: Clip): Clip => ({
      ...clip,
      inPoint: clip.inPoint + sourceDeltaMs,
      outPoint: clip.outPoint + sourceDeltaMs,
    })

    return tracks.map((track) => ({
      ...track,
      clips: track.clips.map((clip) => {
        if (clip.id === clipId) return applySlip(clip)
        if (
          isVideoHost &&
          audioLinked &&
          track.type === 'clip_audio' &&
          clip.sourceVideoClipId === clipId
        ) {
          return applySlip(clip)
        }
        return clip
      }),
    }))
  }, [tracks, liveSlip])

  const persistence = useEditorPersistence(projectId)
  const projectTitleState = useProjectTitle(projectId, persistence.loadRevision)

  // Register global keyboard shortcuts for the editor session.
  // Space, J/K/L, arrows, Delete, Ctrl+Z/Y are all handled here.
  useEditorKeyboard()

  /**
   * Ref to the desktop PreviewCanvas imperative handle.
   *
   * Passed to `usePlaybackEngine` to bridge the Zustand store's `isPlaying`
   * and `playheadPosition` to the Remotion Player's play/pause/seekTo API.
   *
   * The mobile PreviewCanvas does not receive this ref (Phase 5.8 TODO).
   * Only one Remotion Player should be driven as the authoritative clock at
   * a time; the hidden layout's Player is dormant and receives no commands.
   */
  const canvasRef = useRef<PreviewCanvasHandle>(null)

  // Mount the playback engine — syncs Zustand ↔ Remotion Player (Phase 3.5).
  // This is the only place where store.isPlaying/playheadPosition flow into
  // actual player.play() / player.pause() / player.seekTo() calls.
  usePlaybackEngine(canvasRef)

  // Persist resizable panel layout to localStorage (react-resizable-panels v4).
  const verticalLayout = useDefaultLayout({
    id: `${PANEL_STORAGE_KEY}:vertical`,
    storage: typeof window !== 'undefined' ? localStorage : undefined,
  })
  const horizontalLayout = useDefaultLayout({
    id: `${PANEL_STORAGE_KEY}:horizontal`,
    storage: typeof window !== 'undefined' ? localStorage : undefined,
  })

  // ── Player Callbacks ──

  /**
   * Sync the Remotion Player's current frame to the Zustand playhead position.
   * PreviewCanvas only calls this when isPlaying (it ignores frameupdate when paused).
   * So when paused, the store is updated only by user actions (scrub, timecode, keyboard)
   * and never overwritten by player frame events — which keeps scrubbing and timecode
   * input working. When playing, we get throttled frame updates and the timeline stays
   * in sync.
   */
  function handleFrameChange(frame: number) {
    setPlayhead(frameToMs(frame, composition.fps))
  }

  /**
   * Sync the Remotion Player's play/pause state back to the Zustand store.
   * Fired when the player transitions due to end-of-composition, or when
   * play/pause is initiated externally (e.g., clicking the player area).
   * usePlaybackEngine also calls play/pause — no loop risk because Zustand's
   * set() is idempotent for equal values.
   */
  function handlePlaybackChange(playing: boolean) {
    setPlaying(playing)
  }

  // ── Loading State ──

  if (persistence.loading) {
    return <EditorPageSkeleton />
  }

  // ── Render ──

  return (
    <div className="h-screen flex flex-col bg-background select-none overflow-hidden">
      {/* ── Toolbar (full width, fixed height) ── */}
      <EditorToolbar
        projectId={projectId}
        projectTitle={projectTitleState.title}
        isDirty={persistence.isDirty}
        saving={persistence.saving}
        saveError={persistence.error}
        lastSavedAt={persistence.lastSavedAt}
      />

      {/*
       * ── Desktop Layout ──────────────────────────────────────────────────
       * Hidden on mobile (< md breakpoint). The mobile layout is below.
       *
       * Vertical Group (top: main area | bottom: PlaybackBar + Timeline)
       *
       * The PlaybackBar lives at the top of the timeline panel — spanning the
       * full window width directly above the tracks — so every timeline tool
       * (Select, Slice, Snap, Captions, zoom) is one cursor sweep from the
       * surface it operates on. Resizing the timeline panel grows the tracks;
       * the bar's height is fixed.
       */}
      <div className="flex-1 min-h-0 hidden md:flex flex-col">
        <Group
          orientation="vertical"
          id="editor-vertical"
          defaultLayout={verticalLayout.defaultLayout}
          onLayoutChanged={verticalLayout.onLayoutChanged}
          className="flex-1 min-h-0"
        >
          {/*
           * Main area: horizontal panels [Asset | Preview | Inspector]
           * Fills the available space above the timeline.
           */}
          <Panel defaultSize="65%" minSize="40%" id="main-area">
            <Group
              orientation="horizontal"
              id="editor-horizontal"
              defaultLayout={horizontalLayout.defaultLayout}
              onLayoutChanged={horizontalLayout.onLayoutChanged}
              className="h-full"
            >
              {/* Asset Panel (left sidebar — vertical rail + content) */}
              <Panel
                defaultSize={SIDE_PANEL_DEFAULT}
                minSize={SIDE_PANEL_MIN}
                maxSize={SIDE_PANEL_MAX}
                id="asset-panel"
              >
                <AssetPanel />
              </Panel>

              <PanelDivider direction="horizontal" />

              {/* Preview Canvas (center — fills remaining space) */}
              <Panel defaultSize={1200} minSize={400} id="preview-panel">
                {/* Stage is dark in both light + dark themes (mirrors
                    `--media-surface`) so the 9:16 canvas reads as a video
                    matte regardless of OS theme. */}
                <div className="h-full bg-editor-stage">
                  {/*
                   * Desktop PreviewCanvas: canvasRef for usePlaybackEngine (play/pause/seek).
                   * isPlaying: when false, PreviewCanvas does not push frameupdate → store so
                   * scrubbing and timecode input are not overwritten by player events.
                   */}
                  <PreviewCanvas
                    ref={canvasRef}
                    tracks={displayTracks}
                    captionStyle={captionStyle}
                    composition={composition}
                    globalAudioVolume={globalAudioVolume}
                    isPlaying={isPlaying}
                    onFrameChange={handleFrameChange}
                    onPlaybackChange={handlePlaybackChange}
                    className="w-full h-full"
                  />
                </div>
              </Panel>

              <PanelDivider direction="horizontal" />

              {/* Inspector Panel (right sidebar) */}
              <Panel
                defaultSize={SIDE_PANEL_DEFAULT}
                minSize={SIDE_PANEL_MIN}
                maxSize={SIDE_PANEL_MAX}
                id="inspector-panel"
              >
                <InspectorPanel
                  projectTitle={projectTitleState.title}
                  onProjectTitleChange={projectTitleState.updateTitle}
                />
              </Panel>
            </Group>
          </Panel>

          {/* Vertical resize handle between main area and timeline */}
          <PanelDivider direction="vertical" />

          {/* Timeline panel: PlaybackBar + (optional) slice banner + tracks */}
          <Panel
            defaultSize={TIMELINE_DEFAULT}
            minSize={TIMELINE_MIN}
            maxSize={TIMELINE_MAX}
            id="timeline-panel"
          >
            <div className="flex flex-col h-full">
              {/* Tools + transport + view — full window width, directly above tracks.
                  The active Slice tool button in the bar (and the crosshair
                  cursor on hover) is enough indication of slice mode; pressing
                  V or Esc returns to Select. */}
              <PlaybackBar />

              {/* Timeline tracks fill the remaining height. */}
              <div className="flex-1 min-h-0">
                <Timeline />
              </div>
            </div>
          </Panel>
        </Group>
      </div>

      {/*
       * ── Mobile Layout ────────────────────────────────────────────────────
       * Shown only on mobile (< md breakpoint).
       *
       * Stack (top to bottom):
       *   1. Preview Canvas (~40% of remaining height)
       *   2. Playback bar (40px)
       *   3. Timeline (~30% of remaining height)
       *   4. Bottom Sheet (~30% of remaining height, tabbed)
       */}
      <div className="flex-1 min-h-0 flex flex-col md:hidden">
        {/* Preview — top portion */}
        <div className="flex-[2] min-h-0">
          <PreviewCanvas
            tracks={displayTracks}
            captionStyle={captionStyle}
            composition={composition}
            globalAudioVolume={globalAudioVolume}
            isPlaying={isPlaying}
            onFrameChange={handleFrameChange}
            onPlaybackChange={handlePlaybackChange}
            className="w-full h-full"
          />
        </div>

        {/* Mobile playback bar — tool clusters auto-hide below md.
            Mobile users get tools via the bottom sheet tabs instead. */}
        <PlaybackBar />

        {/* Timeline — middle portion (Phase 3.4 interactive implementation) */}
        <div
          className="flex-[1.5] min-h-0 border-t border-border"
          style={{ minHeight: '100px' }}
        >
          <Timeline />
        </div>

        {/* Bottom sheet — Assets / Inspector / Captions / Export */}
        <div className="flex-[1.5] min-h-0">
          <MobileBottomSheet
          projectTitle={projectTitleState.title}
          onProjectTitleChange={projectTitleState.updateTitle}
        />
        </div>
      </div>

      {/* Keyboard shortcut cheatsheet — portaled, mounted once. Open state
          lives on the UI store so the `?` keybinding and any future toolbar
          help button can both summon this same instance. */}
      <ShortcutCheatsheet />
    </div>
  )
}
