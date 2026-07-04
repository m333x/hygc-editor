import { useState, useRef, useEffect, useMemo } from 'react'
import { ChevronLeft, ChevronRight, Diamond } from 'lucide-react'

import { ANIMATABLE_PROPERTIES } from '../../engine/animatable-properties'
import { resolveKeyframedValue } from '../../engine/keyframe-interpolator'
import { useEditorStore } from '../../store/editor-store'
import { usePlaybackStore } from '../../store/playback-store'
import type { AnimatablePropertyId, Clip } from '../../types'
import { KeyframeRibbon } from './KeyframeRibbon'
import { snapToDefault } from './inspector-utils'

/** Section heading with optional reset button. Bumped from 10→11px primary,
 *  9→10px reset, so the inspector reads at standard external-monitor scaling. */
export function SectionHeader({
  label,
  onReset,
  canReset,
}: {
  label: string
  onReset?: () => void
  canReset?: boolean
}) {
  return (
    <div className="flex items-center gap-2 mb-2">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <div className="flex-1 h-px bg-border" />
      {onReset && canReset && (
        <button
          type="button"
          onClick={onReset}
          className="text-[10px] text-muted-foreground hover:text-foreground transition-colors shrink-0"
          title="Reset to defaults"
        >
          Reset
        </button>
      )}
    </div>
  )
}

/**
 * Slider row with range control, clickable value (toggles to number input), and reset.
 * Click the value to type a custom number; blur or Enter commits. Slider and reset stay visible.
 */
export function SliderRowWithReset({
  label,
  value,
  min,
  max,
  step,
  unit,
  defaultVal,
  formatDisplay = (v) => String(Math.round(v)),
  onChange,
  onEditStart,
  onEditEnd,
  disabled,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  defaultVal: number
  formatDisplay?: (v: number) => string
  onChange: (v: number) => void
  onEditStart?: () => void
  onEditEnd?: () => void
  disabled?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [inputStr, setInputStr] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const stepVal = step ?? 1
  const clamped = Math.max(min, Math.min(max, value))
  const displayValue = formatDisplay(clamped) + (unit ?? '')

  useEffect(() => {
    if (editing) {
      setInputStr(String(clamped))
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing, clamped])

  function commitInput() {
    const parsed = Number(inputStr)
    if (!Number.isNaN(parsed)) {
      const c = Math.max(min, Math.min(max, parsed))
      onEditStart?.()
      onChange(snapToDefault(c, defaultVal, stepVal * 2))
      onEditEnd?.()
    }
    setEditing(false)
  }

  function handleSliderChange(v: number) {
    onChange(snapToDefault(v, defaultVal, stepVal * 2))
  }

  return (
    <div className="flex items-center gap-2 mb-2">
      <label className="text-[11px] text-muted-foreground w-14 shrink-0">{label}</label>
      <input
        type="range"
        min={min}
        max={max}
        step={stepVal}
        value={clamped}
        onPointerDown={onEditStart}
        onPointerUp={onEditEnd}
        onPointerCancel={onEditEnd}
        onBlur={onEditEnd}
        onChange={(e) => handleSliderChange(Number(e.target.value))}
        disabled={disabled}
        className="flex-1 h-1 accent-ring disabled:opacity-40 min-w-0"
      />
      {editing ? (
        <>
          <input
            ref={inputRef}
            type="number"
            min={min}
            max={max}
            step={stepVal}
            value={inputStr}
            onChange={(e) => setInputStr(e.target.value)}
            onBlur={commitInput}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitInput()
              if (e.key === 'Escape') setEditing(false)
            }}
            className="w-14 px-1.5 py-0.5 text-[11px] tabular-nums rounded bg-muted border border-ring text-foreground focus:outline-none"
          />
          {unit && <span className="text-[11px] text-muted-foreground shrink-0">{unit}</span>}
        </>
      ) : (
        <button
          type="button"
        onClick={() => !disabled && setEditing(true)}
          disabled={disabled}
          className="w-14 shrink-0 text-[11px] tabular-nums text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded border border-transparent hover:border-border text-right disabled:opacity-40"
          title="Click to enter value"
        >
          {displayValue}
        </button>
      )}
      <button
        type="button"
        onClick={() => {
          onEditStart?.()
          onChange(defaultVal)
          onEditEnd?.()
        }}
        disabled={disabled}
        title="Reset to default"
        className="text-[10px] text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded border border-border hover:border-foreground/30 shrink-0 disabled:opacity-40"
      >
        Reset
      </button>
    </div>
  )
}

/** A toggle button for binary properties (flip H/V, freeze frame). */
export function ToggleButton({
  label,
  active,
  onToggle,
  disabled,
}: {
  label: string
  active: boolean
  onToggle: () => void
  disabled?: boolean
}) {
  return (
    <button
      onClick={onToggle}
      disabled={disabled}
      className={`
        flex-1 text-[10px] py-1 rounded transition-colors
        disabled:opacity-40 disabled:cursor-not-allowed
        ${active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/80'}
      `}
    >
      {label}
    </button>
  )
}

// ─── Keyframe-aware inspector row ────────────────────────────────────────────

/**
 * Stopwatch toggle button — the Premiere-style affordance that enables or
 * disables keyframing on a property. When inactive (outline diamond), the
 * slider writes to the clip's static baseline. When active (filled diamond),
 * the slider writes a keyframe at the current playhead.
 */
function StopwatchButton({
  active,
  onToggle,
  title,
}: {
  active: boolean
  onToggle: () => void
  title: string
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={title}
      aria-pressed={active}
      className={`shrink-0 w-5 h-5 grid place-items-center rounded-md transition-colors ${
        active
          ? 'text-primary bg-primary/10 hover:bg-primary/15 shadow-[0_0_0_1px_color-mix(in_oklch,var(--primary)_30%,transparent),0_0_8px_color-mix(in_oklch,var(--primary)_25%,transparent)]'
          : 'text-muted-foreground hover:text-foreground hover:bg-muted/60'
      }`}
    >
      <Diamond
        size={11}
        strokeWidth={2}
        fill={active ? 'currentColor' : 'none'}
      />
    </button>
  )
}

const KEYFRAME_TIME_EPSILON_MS = 0.5

/**
 * Slider row with a Premiere-style stopwatch + prev/next-keyframe nav.
 *
 * - Stopwatch OFF: identical behavior to `SliderRowWithReset` — edits go to
 *   the clip's static `transform.*` baseline.
 * - Stopwatch ON: clicking creates the first keyframe at the playhead; any
 *   value change at a different playhead position creates a new keyframe;
 *   editing at an existing keyframe's time updates it in place. Prev/next
 *   arrows jump the playhead between keyframes. A filled diamond glyph in
 *   the value column indicates the playhead is sitting on a keyframe.
 *
 * The component reads everything it needs from the editor/playback stores
 * itself, so callers only pass the clip + property registry shape. This keeps
 * `TransformSection` (and any future keyframable section) free of keyframe
 * plumbing.
 */
export function KeyframedSliderRow({
  clip,
  propertyId,
  label,
  min,
  max,
  step,
  unit,
  defaultVal,
  displayScale = 1,
  snapThreshold,
  formatDisplay = (v) => String(Math.round(v)),
  onEditStart,
  onEditEnd,
  disabled,
}: {
  clip: Clip
  propertyId: AnimatablePropertyId
  label: string
  /** Min in DISPLAY units. */
  min: number
  /** Max in DISPLAY units. */
  max: number
  step?: number
  unit?: string
  /** Default in DISPLAY units. */
  defaultVal: number
  /**
   * Multiplier applied when converting stored → display. e.g. 100 for opacity
   * (stored as 0..1, displayed as 0..100%).
   */
  displayScale?: number
  /** Snap-to-default threshold in DISPLAY units. */
  snapThreshold?: number
  formatDisplay?: (v: number) => string
  onEditStart?: () => void
  onEditEnd?: () => void
  disabled?: boolean
}) {
  const playheadPosition = usePlaybackStore((s) => s.playheadPosition)
  const setPlayhead = usePlaybackStore((s) => s.setPlayhead)
  const enableKeyframing = useEditorStore((s) => s.enableKeyframing)
  const disableKeyframing = useEditorStore((s) => s.disableKeyframing)
  const setPropertyAtPlayhead = useEditorStore((s) => s.setPropertyAtPlayhead)
  const updateClipTransform = useEditorStore((s) => s.updateClipTransform)
  const updateClipCaptionStyle = useEditorStore((s) => s.updateClipCaptionStyle)

  const [editing, setEditing] = useState(false)
  const [inputStr, setInputStr] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const stepVal = step ?? 1

  const property = ANIMATABLE_PROPERTIES[propertyId]
  const track = useMemo(
    () => clip.keyframeTracks?.find((t) => t.propertyId === propertyId),
    [clip.keyframeTracks, propertyId],
  )
  const keyframingActive = !!track

  // Clip-local playhead time, clamped to [0, duration]. Out-of-range playheads
  // (e.g. user scrubbed past the clip) snap to the nearest edge — matches
  // Premiere: keyframe edits still target the closest valid time.
  const clipLocalMs = Math.max(0, Math.min(clip.duration, playheadPosition - clip.startTime))

  const storedBaseline = property.read(clip)
  const storedValue = track
    ? resolveKeyframedValue(track, clipLocalMs, storedBaseline)
    : storedBaseline
  const displayValue = storedValue * displayScale

  const clampedDisplay = Math.max(min, Math.min(max, displayValue))
  const formattedValue = formatDisplay(clampedDisplay) + (unit ?? '')

  // Are we currently sitting exactly on an existing keyframe?
  const onKeyframe = useMemo(() => {
    if (!track) return false
    return track.keyframes.some((k) => Math.abs(k.timeMs - clipLocalMs) <= KEYFRAME_TIME_EPSILON_MS)
  }, [track, clipLocalMs])

  useEffect(() => {
    if (editing) {
      setInputStr(String(clampedDisplay))
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing, clampedDisplay])

  function applySnap(displayInput: number): number {
    if (snapThreshold === undefined) return displayInput
    return Math.abs(displayInput - defaultVal) <= snapThreshold ? defaultVal : displayInput
  }

  function commitValue(displayInput: number) {
    const clamped = Math.max(min, Math.min(max, applySnap(displayInput)))
    const stored = clamped / displayScale
    if (keyframingActive) {
      setPropertyAtPlayhead(clip.id, propertyId, clipLocalMs, stored)
      return
    }
    // Stopwatch OFF: route through the dedicated baseline writer for the
    // property family so undo labels stay recognizable ("Update transform" /
    // "Caption style override") and the patch handler stays the sole writer
    // for that surface. Both writers go through the property registry's
    // `write` indirectly via the slice of the field they update.
    if (propertyId.startsWith('transform.')) {
      const propKey = propertyId.slice('transform.'.length)
      updateClipTransform(clip.id, { [propKey]: stored } as Parameters<
        typeof updateClipTransform
      >[1])
    } else if (propertyId.startsWith('caption.')) {
      const propKey = propertyId.slice('caption.'.length)
      updateClipCaptionStyle(clip.id, { [propKey]: stored } as Parameters<
        typeof updateClipCaptionStyle
      >[1])
    } else {
      // Unknown family — fall back to the keyframe-aware writer, which uses
      // the registry's `write` directly. Future property families don't need
      // to update this switch.
      setPropertyAtPlayhead(clip.id, propertyId, clipLocalMs, stored)
    }
  }

  function handleSliderChange(v: number) {
    commitValue(v)
  }

  function handleReset() {
    onEditStart?.()
    commitValue(defaultVal)
    onEditEnd?.()
  }

  function commitInput() {
    const parsed = Number(inputStr)
    if (!Number.isNaN(parsed)) {
      onEditStart?.()
      commitValue(parsed)
      onEditEnd?.()
    }
    setEditing(false)
  }

  function handleStopwatchToggle() {
    if (keyframingActive) {
      disableKeyframing(clip.id, propertyId)
    } else {
      enableKeyframing(clip.id, propertyId, clipLocalMs)
    }
  }

  function jumpToAdjacentKeyframe(direction: 'prev' | 'next') {
    if (!track || track.keyframes.length === 0) return
    if (direction === 'prev') {
      const target = [...track.keyframes]
        .reverse()
        .find((k) => k.timeMs < clipLocalMs - KEYFRAME_TIME_EPSILON_MS)
      if (target) setPlayhead(clip.startTime + target.timeMs)
    } else {
      const target = track.keyframes.find(
        (k) => k.timeMs > clipLocalMs + KEYFRAME_TIME_EPSILON_MS,
      )
      if (target) setPlayhead(clip.startTime + target.timeMs)
    }
  }

  const navDisabled = !keyframingActive || !track || track.keyframes.length === 0
  const hasPrev =
    !!track && track.keyframes.some((k) => k.timeMs < clipLocalMs - KEYFRAME_TIME_EPSILON_MS)
  const hasNext =
    !!track && track.keyframes.some((k) => k.timeMs > clipLocalMs + KEYFRAME_TIME_EPSILON_MS)

  return (
    <>
    <div className="flex items-center gap-2 mb-2">
      <StopwatchButton
        active={keyframingActive}
        onToggle={handleStopwatchToggle}
        title={keyframingActive ? `Disable keyframing on ${label}` : `Enable keyframing on ${label}`}
      />
      <label className="text-[11px] text-muted-foreground w-10 shrink-0">{label}</label>
      <input
        type="range"
        min={min}
        max={max}
        step={stepVal}
        value={clampedDisplay}
        onPointerDown={onEditStart}
        onPointerUp={onEditEnd}
        onPointerCancel={onEditEnd}
        onBlur={onEditEnd}
        onChange={(e) => handleSliderChange(Number(e.target.value))}
        disabled={disabled}
        className="flex-1 h-1 accent-ring disabled:opacity-40 min-w-0"
      />
      {editing ? (
        <>
          <input
            ref={inputRef}
            type="number"
            min={min}
            max={max}
            step={stepVal}
            value={inputStr}
            onChange={(e) => setInputStr(e.target.value)}
            onBlur={commitInput}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitInput()
              if (e.key === 'Escape') setEditing(false)
            }}
            className="w-14 px-1.5 py-0.5 text-[11px] tabular-nums rounded bg-muted border border-ring text-foreground focus:outline-none"
          />
          {unit && <span className="text-[11px] text-muted-foreground shrink-0">{unit}</span>}
        </>
      ) : (
        <button
          type="button"
          onClick={() => !disabled && setEditing(true)}
          disabled={disabled}
          className={`w-14 shrink-0 text-[11px] tabular-nums px-1.5 py-0.5 rounded border text-right disabled:opacity-40 ${
            onKeyframe
              ? 'text-primary border-primary/40 hover:border-primary'
              : 'text-muted-foreground border-transparent hover:text-foreground hover:border-border'
          }`}
          title={onKeyframe ? 'On a keyframe' : 'Click to enter value'}
        >
          {formattedValue}
        </button>
      )}
      {keyframingActive ? (
        <div className="flex items-center shrink-0 rounded-md border border-border/60 bg-muted/40 overflow-hidden">
          <button
            type="button"
            onClick={() => jumpToAdjacentKeyframe('prev')}
            disabled={navDisabled || !hasPrev}
            title="Previous keyframe"
            className="w-5 h-5 grid place-items-center text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
          >
            <ChevronLeft size={12} />
          </button>
          <span aria-hidden className="w-px h-3 bg-border/70" />
          <button
            type="button"
            onClick={() => jumpToAdjacentKeyframe('next')}
            disabled={navDisabled || !hasNext}
            title="Next keyframe"
            className="w-5 h-5 grid place-items-center text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
          >
            <ChevronRight size={12} />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={handleReset}
          disabled={disabled}
          title="Reset to default"
          className="text-[10px] text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded border border-border hover:border-foreground/30 shrink-0 disabled:opacity-40"
        >
          Reset
        </button>
      )}
    </div>
    {track && (
      <KeyframeRibbon clip={clip} propertyId={propertyId} track={track} />
    )}
    </>
  )
}
