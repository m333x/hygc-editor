/**
 * TrackHeader — the left-side fixed header for a single timeline track row.
 *
 * Displays the track's identity and controls, and serves as the drag handle
 * for DnD Kit track reordering (via `dragHandleProps`). This component is
 * intentionally narrowly-scoped:
 *   - Shows: type indicator dot, track label (double-click to edit inline),
 *     mute toggle, lock toggle, and a visible-on-hover delete button.
 *   - Exposes a `dragHandleProps` receiver for the grip icon so that only
 *     the grip initiates a reorder drag, not an accidental label click.
 *
 * Why inline label editing:
 *   The spec calls for editable track labels directly in the header row. A
 *   single dedicated input that replaces the label span on double-click keeps
 *   the edit flow low-friction and avoids a separate modal/popover.
 *
 * SOLID: SRP — only manages track header display and its local edit state.
 *   All state mutations go through the Zustand store via the hooks passed in.
 * SOLID: ISP — the `dragHandleProps` prop is a narrow interface — the caller
 *   (Timeline.tsx via useSortable) provides only the listeners/attributes needed
 *   for DnD Kit, and TrackHeader doesn't need to know about sortable internals.
 *
 * @see PLAN.md Phase 3.4 "Track header (left): label (editable), mute/lock toggles, grip handle for reorder"
 * @see src/features/editor/store/editor-store.ts for renameTrack, toggleTrackMute, toggleTrackLock
 */

import { useState, useRef, useCallback } from 'react'
import {
  ChevronsDown,
  Eye,
  EyeOff,
  Headphones,
  Volume2,
  VolumeX,
  Lock,
  LockOpen,
} from 'lucide-react'
import type { DraggableAttributes } from '@dnd-kit/core'
import type { SyntheticListenerMap } from '@dnd-kit/core/dist/hooks/utilities'
import type { Track } from '../../types'
import { TRACK_TYPE_CONFIG } from './timeline-utils'

// ─── Component Props ──────────────────────────────────────────────────────────

export interface TrackHeaderProps {
  /** The track this header represents. */
  track: Track

  /**
   * DnD Kit sensor listeners (onPointerDown, onKeyDown, etc.) to attach to
   * the grip handle element. Passed down from the parent's `useSortable` call.
   * Making this a dedicated prop rather than spreading onto the whole header
   * ensures only the grip icon initiates a drag.
   */
  dragHandleProps: {
    listeners: SyntheticListenerMap | undefined
    attributes: DraggableAttributes
  }

  /**
   * Whether this track is being actively dragged (sortable isDragging state).
   * Used to dim the header slightly during drag for visual feedback.
   */
  isDragging?: boolean

  /** Called when the user confirms a label rename. */
  onRename: (trackId: string, newLabel: string) => void

  /** Called when the user clicks the mute toggle. */
  onToggleMute: (trackId: string) => void

  /**
   * Called when the user clicks the solo toggle. Audio-only.
   * Soloing mutes every other audio track; clicking on an already-soloed
   * track un-solos (restores every audio track to its prior un-muted state).
   */
  onToggleSolo: (trackId: string) => void

  /**
   * Whether this track is currently the only audible audio track. Used to
   * render the solo button in its active state and swap its aria label.
   */
  isSoloed?: boolean

  /** Called when the user toggles visual-track output. */
  onToggleVisibility: (trackId: string) => void

  /** Called when the user clicks the lock toggle. */
  onToggleLock: (trackId: string) => void

  /**
   * Called when the user clicks the delete (trash) button.
   * The parent is responsible for confirmation dialogs if the track has clips.
   */
  onDelete: (trackId: string) => void
}

// ─── Sub-components ───────────────────────────────────────────────────────────

/**
 * GripIcon — three horizontal lines indicating a draggable grip handle.
 * Rendered as a micro SVG for crispness at small sizes.
 */
function GripIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="currentColor"
      aria-hidden
      className="text-editor-on-chrome-muted"
    >
      <rect y="2" width="10" height="1.2" rx="0.6" />
      <rect y="4.4" width="10" height="1.2" rx="0.6" />
      <rect y="6.8" width="10" height="1.2" rx="0.6" />
    </svg>
  )
}

// ─── TrackHeader Component ────────────────────────────────────────────────────

/**
 * TrackHeader renders the fixed-left portion of a track row.
 *
 * @example
 *   <TrackHeader
 *     track={track}
 *     dragHandleProps={{ listeners, attributes }}
 *     onRename={(id, label) => renameTrack(id, label)}
 *     onToggleMute={(id) => toggleTrackMute(id)}
 *     onToggleLock={(id) => toggleTrackLock(id)}
 *     onDelete={(id) => removeTrack(id)}
 *   />
 */
export function TrackHeader({
  track,
  dragHandleProps,
  isDragging = false,
  onRename,
  onToggleMute,
  onToggleSolo,
  isSoloed = false,
  onToggleVisibility,
  onToggleLock,
  onDelete,
}: TrackHeaderProps) {
  // ── Inline label edit state ──

  const [isEditing, setIsEditing] = useState(false)
  const [editLabel, setEditLabel] = useState(track.label)
  const inputRef = useRef<HTMLInputElement>(null)

  /** Confirm the pending label change and exit edit mode. */
  const commitRename = useCallback(() => {
    const trimmed = editLabel.trim()
    if (trimmed && trimmed !== track.label) {
      onRename(track.id, trimmed)
    } else {
      // Restore original if user cleared the field
      setEditLabel(track.label)
    }
    setIsEditing(false)
  }, [editLabel, track.id, track.label, onRename])

  /** Enter inline edit mode — select all text for easy replacement. */
  function startEdit() {
    setEditLabel(track.label)
    setIsEditing(true)
    // Focus happens via autoFocus on the input element
  }

  function handleInputKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitRename()
    } else if (e.key === 'Escape') {
      setEditLabel(track.label)
      setIsEditing(false)
    }
  }

  // ── Track type indicator ──

  const typeConfig = TRACK_TYPE_CONFIG[track.type]
  const isAudioTrack = track.type === 'audio' || track.type === 'clip_audio'
  const isVisualTrack = track.type === 'video' || track.type === 'caption'
  const isVisible = track.visible ?? true

  return (
    <div
      className={`
        h-12 flex items-center gap-1 px-1.5 select-none group
        text-editor-on-chrome
        ${isDragging ? 'opacity-60' : ''}
      `}
      data-track-id={track.id}
    >
      {/* ── Grip handle (DnD Kit drag initiation) ──
          Stays visible at 50% opacity so users can discover reorder without
          having to hover. Lifts to 100% on hover. */}
      <button
        className="
          shrink-0 w-4 h-5 flex items-center justify-center
          cursor-grab active:cursor-grabbing
          rounded hover:bg-editor-chrome-strong transition-all touch-none
          opacity-50 group-hover:opacity-100
        "
        {...dragHandleProps.listeners}
        {...dragHandleProps.attributes}
        aria-label="Drag to reorder track"
        title="Drag to reorder"
        tabIndex={-1}
      >
        <GripIcon />
      </button>

      {/* ── Type indicator dot ── */}
      <div
        className={`w-1.5 h-1.5 rounded-full shrink-0 ${typeConfig.dotClass}`}
        title={`${typeConfig.label} track`}
        aria-label={`Track type: ${typeConfig.label}`}
      />

      {/* ── Auto-duck indicator ──
          Only appears when the track is actively ducking. Kept small and
          desaturated so it reads as a status badge, not another control. */}
      {isAudioTrack && track.ducking?.enabled && (
        <span
          className="shrink-0 text-editor-on-chrome-muted/80 inline-flex items-center"
          title="Auto-duck under voiceover"
          aria-label="Auto-duck under voiceover is on"
        >
          <ChevronsDown size={10} aria-hidden />
        </span>
      )}

      {/* ── Track label (editable on double-click) ── */}
      <div className="flex-1 min-w-0 overflow-visible">
        {isEditing ? (
          <input
            ref={inputRef}
            value={editLabel}
            onChange={(e) => setEditLabel(e.target.value)}
            onBlur={commitRename}
            onKeyDown={handleInputKeyDown}
            className="
              w-full text-[10px] font-medium bg-transparent
              border-b border-ring outline-none text-editor-on-chrome
              leading-tight py-0
            "
            maxLength={40}
            autoFocus
            aria-label="Edit track name"
          />
        ) : (
          <span
            className="
              block text-xs font-medium text-editor-on-chrome
              cursor-text leading-tight overflow-visible whitespace-nowrap
            "
            title={track.label}
            onDoubleClick={startEdit}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && startEdit()}
            aria-label={`Track name: ${track.label}. Double-click to edit.`}
          >
            {track.label}
          </span>
        )}
      </div>

      {/* ── Action buttons (always visible) ──
          Mute/lock states use neutral editor tokens instead of yellow/blue
          tailwind defaults so they harmonize with the brand and don't compete
          with the clip palette for attention. */}
      <div className="flex items-center gap-0.5 shrink-0">
        {/* Mute or visibility toggle, depending on track type. */}
        {isAudioTrack && (
          <button
            onClick={() => onToggleMute(track.id)}
            className={`
              w-5 h-5 flex items-center justify-center rounded transition-colors
              ${
                track.muted
                  ? 'bg-editor-chrome-strong text-editor-on-chrome hover:bg-editor-chrome-strong/80'
                  : 'text-editor-on-chrome-muted hover:bg-editor-chrome-strong hover:text-editor-on-chrome'
              }
            `}
            title={track.muted ? 'Unmute track' : 'Mute track'}
            aria-label={track.muted ? 'Unmute track' : 'Mute track'}
            aria-pressed={track.muted}
          >
            {track.muted ? <VolumeX size={11} aria-hidden /> : <Volume2 size={11} aria-hidden />}
          </button>
        )}

        {/* Solo toggle — silences every other audio track. Active state uses
            the editor's ring accent so it reads as "spotlight on this track"
            rather than the neutral chrome we use for mute/lock. */}
        {isAudioTrack && (
          <button
            onClick={() => onToggleSolo(track.id)}
            className={`
              w-5 h-5 flex items-center justify-center rounded transition-colors
              ${
                isSoloed
                  ? 'bg-ring/15 text-ring hover:bg-ring/25'
                  : 'text-editor-on-chrome-muted hover:bg-editor-chrome-strong hover:text-editor-on-chrome'
              }
            `}
            title={isSoloed ? 'Un-solo track' : 'Solo track'}
            aria-label={isSoloed ? 'Un-solo track' : 'Solo track'}
            aria-pressed={isSoloed}
          >
            <Headphones size={11} aria-hidden />
          </button>
        )}

        {isVisualTrack && (
          <button
            onClick={() => onToggleVisibility(track.id)}
            className={`
              w-5 h-5 flex items-center justify-center rounded transition-colors
              ${
                !isVisible
                  ? 'bg-editor-chrome-strong text-editor-on-chrome hover:bg-editor-chrome-strong/80'
                  : 'text-editor-on-chrome-muted hover:bg-editor-chrome-strong hover:text-editor-on-chrome'
              }
            `}
            title={isVisible ? 'Hide track' : 'Show track'}
            aria-label={isVisible ? 'Hide track' : 'Show track'}
            aria-pressed={!isVisible}
          >
            {isVisible ? <Eye size={11} aria-hidden /> : <EyeOff size={11} aria-hidden />}
          </button>
        )}

        {/* Lock toggle */}
        <button
          onClick={() => onToggleLock(track.id)}
          className={`
            w-5 h-5 flex items-center justify-center rounded transition-colors
            ${
              track.locked
                ? 'bg-editor-chrome-strong text-editor-on-chrome hover:bg-editor-chrome-strong/80'
                : 'text-editor-on-chrome-muted hover:bg-editor-chrome-strong hover:text-editor-on-chrome'
            }
          `}
          title={track.locked ? 'Unlock track' : 'Lock track (prevents clip edits)'}
          aria-label={track.locked ? 'Unlock track' : 'Lock track'}
          aria-pressed={track.locked}
        >
          {track.locked ? <Lock size={11} aria-hidden /> : <LockOpen size={11} aria-hidden />}
        </button>

        {/* Delete track button — Clip Audio is non-deletable, but we still
            reserve its 20px slot so every track header's mute + lock icons
            land at the same x-coordinate. Without this spacer, Clip Audio's
            icons would sit ~22px further right than every other track. */}
        {track.type !== 'clip_audio' ? (
          <button
            onClick={() => onDelete(track.id)}
            className="
              w-5 h-5 flex items-center justify-center rounded
              text-editor-on-chrome-muted/60 hover:text-destructive hover:bg-destructive/10
              opacity-0 group-hover:opacity-100 transition-colors
            "
            title="Delete track"
            aria-label="Delete track"
          >
            {/* × symbol */}
            <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor" aria-hidden>
              <path d="M1 1L7 7M7 1L1 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        ) : (
          <span aria-hidden className="w-5 h-5 shrink-0" />
        )}
      </div>
    </div>
  )
}
