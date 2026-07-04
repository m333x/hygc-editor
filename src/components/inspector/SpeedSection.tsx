import { useState, useRef } from 'react'
import type { Clip } from '../../types'
import { SectionHeader, ToggleButton } from './primitives'
import { SNAP_THRESHOLDS, snapToDefault } from './inspector-utils'

const SPEED_PRESETS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const
const DEFAULT_SPEED = 1

/**
 * SpeedSection — playback speed (slider + clickable value + reset) and freeze-frame.
 *
 * Preset chips and range slider are inline. Click the value to type a custom speed.
 * Section reset restores speed to 1× and clears freeze frame.
 */
export function SpeedSection({
  clip,
  onSpeedChange,
  onFreezeFrameToggle,
  hideFreezeFrame = false,
}: {
  clip: Clip
  onSpeedChange: (speed: number) => void
  onFreezeFrameToggle: (enabled: boolean) => void
  /** Audio clips have no frames — hide the freeze toggle entirely. */
  hideFreezeFrame?: boolean
}) {
  const isFrozen = clip.freezeFrame !== undefined
  const isSpeedDefault = Math.abs(clip.speed - DEFAULT_SPEED) < 0.01
  const canResetSpeed = !isSpeedDefault || isFrozen
  const isCustom = !isSpeedDefault && !SPEED_PRESETS.some((p) => Math.abs(clip.speed - p) < 0.01)
  const [editingCustom, setEditingCustom] = useState(false)
  const [customStr, setCustomStr] = useState(clip.speed.toFixed(2))
  const customInputRef = useRef<HTMLInputElement>(null)

  function commitCustom() {
    const parsed = Number(customStr)
    if (!Number.isNaN(parsed)) {
      const clamped = Math.max(0.25, Math.min(4, parsed))
      onSpeedChange(snapToDefault(clamped, DEFAULT_SPEED, SNAP_THRESHOLDS.speed))
    }
    setEditingCustom(false)
  }

  function handleSectionReset() {
    onSpeedChange(DEFAULT_SPEED)
    if (isFrozen) onFreezeFrameToggle(false)
  }

  return (
    <div className="mb-4">
      <SectionHeader
        label="Speed"
        onReset={handleSectionReset}
        canReset={canResetSpeed}
      />

      {/* Preset chips. The redundant range slider was removed: users either
          pick a preset or type a custom value via the "Custom" chip — that's
          one decision per axis instead of two. */}
      <div className="flex flex-wrap gap-1 mb-2">
        {SPEED_PRESETS.map((s) => {
          const active = Math.abs(clip.speed - s) < 0.01
          return (
            <button
              key={s}
              type="button"
              onClick={() => onSpeedChange(snapToDefault(s, DEFAULT_SPEED, SNAP_THRESHOLDS.speed))}
              disabled={isFrozen}
              className={`
                px-2 py-0.5 rounded text-[11px] font-medium tabular-nums transition-colors disabled:opacity-40
                ${active
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:bg-muted/80'}
              `}
            >
              {s}×
            </button>
          )
        })}

        {/* Custom-value chip — collapses the old slider+button row into one
            affordance. Active when the speed doesn't match a preset. */}
        {editingCustom ? (
          <input
            ref={customInputRef}
            type="number"
            min={0.25}
            max={4}
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
            aria-label="Custom speed (0.25 – 4)"
            autoFocus
          />
        ) : (
          <button
            type="button"
            onClick={() => {
              setCustomStr(clip.speed.toFixed(2))
              setEditingCustom(true)
            }}
            disabled={isFrozen}
            className={`
              px-2 py-0.5 rounded text-[11px] font-medium tabular-nums transition-colors disabled:opacity-40
              ${isCustom
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:bg-muted/80'}
            `}
            title="Type a custom speed"
          >
            {isCustom ? `${clip.speed.toFixed(2)}×` : 'Custom'}
          </button>
        )}
      </div>

      {/* Freeze frame stays — common request for product ads (hold on the
          hero shot while voiceover lands the value prop). Suppressed for
          audio clips, which have no frame to hold. */}
      {!hideFreezeFrame && (
        <>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[11px] text-muted-foreground w-14 shrink-0">Freeze</span>
            <div className="flex gap-1 flex-1">
              <ToggleButton
                label="Freeze Frame"
                active={isFrozen}
                onToggle={() => onFreezeFrameToggle(!isFrozen)}
              />
            </div>
          </div>

          {isFrozen && clip.freezeFrame !== undefined && (
            <div className="flex items-center gap-2 mt-1 mb-1">
              <span className="text-[11px] text-muted-foreground w-14 shrink-0">At</span>
              <span className="text-[11px] tabular-nums text-ring">
                {(clip.freezeFrame / 1000).toFixed(3)}s
              </span>
              <span className="text-[10px] text-muted-foreground/60">
                (source time)
              </span>
            </div>
          )}
        </>
      )}
    </div>
  )
}
