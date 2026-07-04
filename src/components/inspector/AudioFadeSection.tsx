import { useState } from 'react'
import { MAX_AUDIO_FADE_MS } from '../../types'
import type { Clip } from '../../types'
import { SectionHeader } from './primitives'

/** Common fade-length presets in milliseconds. */
const AUDIO_FADE_PRESETS_MS = [0, 250, 500, 1000, 2000] as const

/**
 * AudioFadeSection — fade-in / fade-out controls for audio clips.
 *
 * Mirrors the CapCut convention: a small envelope visualization shows the
 * actual fade shape (ramp-up → sustain → ramp-down) so users see what they're
 * editing, with chip-row pickers below for one-click presets. A Custom chip
 * flips into an inline numeric input for fine-tuning — same pattern as the
 * Speed section, so the inspector feels internally consistent.
 *
 * Crossfades are implicit: when an adjacent audio clip has a matching fade on
 * the facing edge and the two clips touch on the timeline, the renderer
 * creates an overlap window. The inspector intentionally doesn't surface
 * "crossfade" as a separate concept — the fade you set is the fade you see.
 *
 * The chip max also tracks the clip's own duration (half of it, to leave room
 * for both fades). For very short clips, presets longer than the cap are
 * elided rather than shown disabled.
 */
export function AudioFadeSection({
  clip,
  onFadeChange,
  onEditStart,
  onEditEnd,
}: {
  clip: Clip
  onFadeChange: (edge: 'in' | 'out', durationMs: number) => void
  onEditStart?: () => void
  onEditEnd?: () => void
}) {
  const fadeIn = clip.fadeInMs ?? 0
  const fadeOut = clip.fadeOutMs ?? 0
  const canReset = fadeIn > 0 || fadeOut > 0
  const halfClipMs = Math.max(0, Math.floor(clip.duration / 2))
  const maxMs = Math.max(0, Math.min(MAX_AUDIO_FADE_MS, halfClipMs))

  function handleSectionReset() {
    onEditStart?.()
    onFadeChange('in', 0)
    onFadeChange('out', 0)
    onEditEnd?.()
  }

  function handleEdgeChange(edge: 'in' | 'out', ms: number) {
    onEditStart?.()
    onFadeChange(edge, ms)
    onEditEnd?.()
  }

  return (
    <div className="mb-4">
      <SectionHeader label="Audio Fade" onReset={handleSectionReset} canReset={canReset} />

      <FadeEnvelope fadeInMs={fadeIn} fadeOutMs={fadeOut} durationMs={clip.duration} />

      <FadeEdgeRow
        label="In"
        valueMs={fadeIn}
        maxMs={maxMs}
        onChange={(ms) => handleEdgeChange('in', ms)}
      />

      <FadeEdgeRow
        label="Out"
        valueMs={fadeOut}
        maxMs={maxMs}
        onChange={(ms) => handleEdgeChange('out', ms)}
      />

      <p className="text-[10px] text-muted-foreground/70 leading-tight mt-1">
        Touching clips with facing fades crossfade automatically.
      </p>
    </div>
  )
}

/**
 * Read-only envelope preview: trapezoidal shape whose left ramp is the fade-in
 * and right ramp is the fade-out, sized as a proportion of the clip's
 * duration. Stretches horizontally to the inspector width.
 */
function FadeEnvelope({
  fadeInMs,
  fadeOutMs,
  durationMs,
}: {
  fadeInMs: number
  fadeOutMs: number
  durationMs: number
}) {
  const safeDuration = Math.max(1, durationMs)
  // Cap each ramp at 50% so the path stays well-formed for tiny clips.
  const fadeInRatio = Math.min(0.5, fadeInMs / safeDuration)
  const fadeOutRatio = Math.min(0.5, fadeOutMs / safeDuration)

  const W = 100
  const H = 32
  const peakY = 4
  const baseY = H - 1
  const inEndX = fadeInRatio * W
  const outStartX = W - fadeOutRatio * W

  const path = `M 0 ${baseY} L ${inEndX.toFixed(2)} ${peakY} L ${outStartX.toFixed(2)} ${peakY} L ${W} ${baseY} Z`

  return (
    <div className="mb-2 rounded-md border border-border bg-muted/40 overflow-hidden">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="block w-full h-8"
        aria-hidden
      >
        <path
          d={path}
          className="fill-ring/15 stroke-ring"
          strokeWidth={1.25}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  )
}

function formatFadeLabel(ms: number): string {
  if (ms === 0) return 'Off'
  if (ms >= 1000) {
    return ms % 1000 === 0 ? `${ms / 1000}s` : `${(ms / 1000).toFixed(1)}s`
  }
  return `${(ms / 1000).toFixed(2)}s`
}

function FadeEdgeRow({
  label,
  valueMs,
  maxMs,
  onChange,
}: {
  label: string
  valueMs: number
  maxMs: number
  onChange: (ms: number) => void
}) {
  const [editingCustom, setEditingCustom] = useState(false)
  const [customStr, setCustomStr] = useState((valueMs / 1000).toFixed(2))

  const matchesPreset = AUDIO_FADE_PRESETS_MS.some((p) => Math.abs(valueMs - p) < 1)
  const isCustom = !matchesPreset && valueMs > 0
  const disabled = maxMs === 0

  function commitCustom() {
    const parsed = Number(customStr)
    if (!Number.isNaN(parsed)) {
      const ms = Math.max(0, Math.min(maxMs, Math.round(parsed * 1000)))
      onChange(ms)
    }
    setEditingCustom(false)
  }

  return (
    <div className="flex items-center gap-1.5 mb-1.5">
      <span className="text-[11px] text-muted-foreground w-7 shrink-0">{label}</span>
      <div className="flex flex-wrap gap-1 flex-1">
        {AUDIO_FADE_PRESETS_MS.map((ms) => {
          if (ms > maxMs) return null
          const active = Math.abs(valueMs - ms) < 1
          return (
            <button
              key={ms}
              type="button"
              onClick={() => onChange(ms)}
              disabled={disabled}
              className={`
                px-2 py-0.5 rounded text-[11px] font-medium tabular-nums transition-colors disabled:opacity-40
                ${active
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:bg-muted/80'}
              `}
            >
              {formatFadeLabel(ms)}
            </button>
          )
        })}

        {editingCustom ? (
          <input
            type="number"
            min={0}
            max={maxMs / 1000}
            step={0.05}
            value={customStr}
            onChange={(e) => setCustomStr(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={commitCustom}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitCustom()
              if (e.key === 'Escape') setEditingCustom(false)
            }}
            className="w-16 px-1.5 py-0.5 rounded text-[11px] tabular-nums bg-muted border border-ring text-foreground focus:outline-none"
            aria-label={`Custom fade ${label.toLowerCase()} (seconds)`}
            autoFocus
          />
        ) : (
          <button
            type="button"
            onClick={() => {
              setCustomStr((valueMs / 1000).toFixed(2))
              setEditingCustom(true)
            }}
            disabled={disabled}
            className={`
              px-2 py-0.5 rounded text-[11px] font-medium tabular-nums transition-colors disabled:opacity-40
              ${isCustom
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:bg-muted/80'}
            `}
            title="Type a custom fade length"
          >
            {isCustom ? formatFadeLabel(valueMs) : 'Custom'}
          </button>
        )}
      </div>
    </div>
  )
}
