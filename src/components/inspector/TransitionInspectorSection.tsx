import type { Clip, TransitionType, TransitionDirection } from '../../types'
import {
  DEFAULT_MOTION_BLUR_STRENGTH,
  MAX_MOTION_BLUR_STRENGTH,
  MIN_MOTION_BLUR_STRENGTH,
} from '../../types'
import {
  TRANSITION_PRESETS,
  getTransitionPreset,
  isDirectionalTransition,
  getDefaultDirection,
} from '../../engine/transitions'
import { SectionHeader, SliderRowWithReset } from './primitives'

/**
 * Inspector view for a transition selected on the timeline.
 *
 * Renders when `selectedTransition` is set (the user clicked a checkered badge).
 * Provides:
 *   - Type picker — grid of presets that swaps the transition's animation type
 *     in place, preserving the current duration
 *   - Duration slider + numeric input
 *   - Remove button
 *
 * Seam awareness is delegated to the store: `resizeTransition` and the type
 * picker (via `setSeamTransition`) automatically mirror changes to the paired
 * neighbour when this transition sits on a seam.
 */
export function TransitionInspectorSection({
  clip,
  edge,
  neighbour,
  isSeam,
  onChangeType,
  onResize,
  onChangeDirection,
  onChangeMotionBlur,
  onRemove,
  onEditStart,
  onEditEnd,
}: {
  clip: Clip
  edge: 'in' | 'out'
  neighbour: Clip | null
  isSeam: boolean
  onChangeType: (type: TransitionType) => void
  onResize: (durationMs: number) => void
  onChangeDirection: (direction: TransitionDirection) => void
  onChangeMotionBlur: (strength: number) => void
  onRemove: () => void
  onEditStart: () => void
  onEditEnd: () => void
}) {
  const transition = edge === 'in' ? clip.transitionIn : clip.transitionOut
  if (!transition) return null

  // Duration cap: half the host clip (and the neighbour if this is a seam).
  // Floor: one frame at 30fps — same as the timeline drag handles.
  const halfClip = clip.duration / 2
  const halfNeighbour = isSeam && neighbour ? neighbour.duration / 2 : Infinity
  const maxDurationMs = Math.max(33, Math.min(halfClip, halfNeighbour))
  const preset = getTransitionPreset(transition.type)
  const isDirectional = isDirectionalTransition(transition.type)
  const activeDirection: TransitionDirection =
    transition.direction ?? getDefaultDirection(transition.type)
  // Types whose visuals don't include motion blur — hide the strength slider
  // to avoid suggesting it does something.
  const supportsMotionBlur =
    transition.type !== 'none' &&
    transition.type !== 'fade' &&
    transition.type !== 'wipe' &&
    transition.type !== 'blur'
  const motionBlurValue = transition.motionBlurStrength ?? DEFAULT_MOTION_BLUR_STRENGTH

  return (
    <div className="mb-4">
      <SectionHeader label={isSeam ? 'Seam transition' : `Transition (${edge})`} />

      {/* Current type label + edge indicator */}
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] font-medium text-foreground truncate">
            {preset?.label ?? transition.type}
          </p>
          <p className="text-[10px] text-muted-foreground">
            {isSeam ? 'Crosses seam · both clips synced' : edge === 'in' ? 'Fade in' : 'Fade out'}
          </p>
        </div>
      </div>

      {/* Type picker grid */}
      <div className="mb-3">
        <p className="text-[10px] text-muted-foreground mb-1.5">Type</p>
        <div className="grid grid-cols-3 gap-1">
          {TRANSITION_PRESETS.map((p) => {
            const active = p.type === transition.type
            return (
              <button
                key={p.type}
                type="button"
                onClick={() => onChangeType(p.type)}
                className={`flex flex-col items-center gap-0.5 p-1.5 rounded border text-[9px] transition-colors ${
                  active
                    ? 'border-primary bg-primary/15 text-foreground'
                    : 'border-border bg-muted/40 text-muted-foreground hover:border-foreground/30 hover:text-foreground'
                }`}
                title={p.label}
              >
                <span className="w-5 h-5 flex items-center justify-center [&_svg]:w-full [&_svg]:h-full">
                  {p.icon}
                </span>
                <span className="leading-none">{p.label}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Duration slider */}
      <SliderRowWithReset
        label="Length"
        value={transition.durationMs}
        min={33}
        max={Math.max(33, Math.round(maxDurationMs))}
        step={10}
        unit="ms"
        defaultVal={preset?.defaultDurationMs ?? 500}
        formatDisplay={(v) => Math.round(v).toString()}
        onChange={onResize}
        onEditStart={onEditStart}
        onEditEnd={onEditEnd}
      />

      {/* Direction picker — only for slide / pan / wipe */}
      {isDirectional && (
        <div className="mt-3">
          <p className="text-[10px] text-muted-foreground mb-1.5">Direction</p>
          <DirectionPicker
            value={activeDirection}
            onChange={onChangeDirection}
          />
        </div>
      )}

      {/* Motion blur strength — hidden for types that don't produce motion blur */}
      {supportsMotionBlur && (
        <div className="mt-3">
          <SliderRowWithReset
            label="Motion blur"
            value={motionBlurValue}
            min={MIN_MOTION_BLUR_STRENGTH}
            max={MAX_MOTION_BLUR_STRENGTH}
            step={0.05}
            unit="×"
            defaultVal={DEFAULT_MOTION_BLUR_STRENGTH}
            formatDisplay={(v) => v.toFixed(2)}
            onChange={onChangeMotionBlur}
            onEditStart={onEditStart}
            onEditEnd={onEditEnd}
          />
        </div>
      )}

      <button
        type="button"
        onClick={onRemove}
        className="w-full text-[11px] py-1.5 rounded border border-destructive/50 text-destructive hover:bg-destructive hover:text-destructive-foreground transition-colors mt-2"
      >
        Remove transition
      </button>
    </div>
  )
}

/**
 * 4-arrow direction picker. The value is the motion vector: 'left' means the
 * content moves leftward, so visually the up-pointing button is for upward
 * motion, etc. Buttons sit in a compact + shape so the spatial mapping is
 * obvious without labels.
 */
function DirectionPicker({
  value,
  onChange,
}: {
  value: TransitionDirection
  onChange: (direction: TransitionDirection) => void
}) {
  function btn(dir: TransitionDirection, arrow: string, label: string) {
    const active = value === dir
    return (
      <button
        key={dir}
        type="button"
        onClick={() => onChange(dir)}
        aria-label={`Direction: ${label}`}
        title={label}
        className={`flex items-center justify-center w-7 h-7 rounded border text-[12px] font-medium transition-colors ${
          active
            ? 'border-primary bg-primary/15 text-foreground'
            : 'border-border bg-muted/40 text-muted-foreground hover:border-foreground/30 hover:text-foreground'
        }`}
      >
        {arrow}
      </button>
    )
  }

  return (
    <div className="inline-grid grid-cols-3 grid-rows-3 gap-1">
      <div />
      {btn('up', '↑', 'Up')}
      <div />
      {btn('left', '←', 'Left')}
      <div />
      {btn('right', '→', 'Right')}
      <div />
      {btn('down', '↓', 'Down')}
      <div />
    </div>
  )
}
