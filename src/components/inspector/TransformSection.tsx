import { DEFAULT_CLIP_TRANSFORM } from '../../types'
import type { Clip, ClipTransform } from '../../types'
import {
  KeyframedSliderRow,
  SectionHeader,
  ToggleButton,
} from './primitives'
import { SNAP_THRESHOLDS } from './inspector-utils'

function isTransformDefault(transform: ClipTransform): boolean {
  const op = transform.opacity ?? 1
  return (
    transform.x === DEFAULT_CLIP_TRANSFORM.x &&
    transform.y === DEFAULT_CLIP_TRANSFORM.y &&
    Math.abs(transform.scale - DEFAULT_CLIP_TRANSFORM.scale) < 0.001 &&
    transform.rotation === DEFAULT_CLIP_TRANSFORM.rotation &&
    transform.flipH === DEFAULT_CLIP_TRANSFORM.flipH &&
    transform.flipV === DEFAULT_CLIP_TRANSFORM.flipV &&
    Math.abs(op - (DEFAULT_CLIP_TRANSFORM.opacity ?? 1)) < 0.001 &&
    transform.crop.top === DEFAULT_CLIP_TRANSFORM.crop.top &&
    transform.crop.right === DEFAULT_CLIP_TRANSFORM.crop.right &&
    transform.crop.bottom === DEFAULT_CLIP_TRANSFORM.crop.bottom &&
    transform.crop.left === DEFAULT_CLIP_TRANSFORM.crop.left
  )
}

/**
 * TransformSection — scale, position, rotation, and flip controls.
 *
 * Range sliders with clickable values (inline number input) and reset buttons.
 * Section reset restores full default transform.
 */
export function TransformSection({
  clip,
  onTransformChange,
  onEditStart,
  onEditEnd,
}: {
  clip: Clip
  onTransformChange: (transform: Partial<ClipTransform>) => void
  onEditStart: () => void
  onEditEnd: () => void
}) {
  const { transform } = clip

  return (
    <div className="mb-4">
      <SectionHeader
        label="Transform"
        onReset={() => onTransformChange({ ...DEFAULT_CLIP_TRANSFORM })}
        canReset={!isTransformDefault(transform)}
      />

      <KeyframedSliderRow
        clip={clip}
        propertyId="transform.scale"
        label="Zoom"
        min={10}
        max={400}
        step={1}
        unit="%"
        defaultVal={100}
        displayScale={100}
        snapThreshold={SNAP_THRESHOLDS.scale * 100}
        onEditStart={onEditStart}
        onEditEnd={onEditEnd}
      />

      <KeyframedSliderRow
        clip={clip}
        propertyId="transform.x"
        label="X"
        min={-2000}
        max={2000}
        step={1}
        unit="px"
        defaultVal={0}
        snapThreshold={SNAP_THRESHOLDS.position}
        onEditStart={onEditStart}
        onEditEnd={onEditEnd}
      />
      <KeyframedSliderRow
        clip={clip}
        propertyId="transform.y"
        label="Y"
        min={-2000}
        max={2000}
        step={1}
        unit="px"
        defaultVal={0}
        snapThreshold={SNAP_THRESHOLDS.position}
        onEditStart={onEditStart}
        onEditEnd={onEditEnd}
      />

      <KeyframedSliderRow
        clip={clip}
        propertyId="transform.rotation"
        label="Rotation"
        min={-360}
        max={360}
        step={1}
        unit="°"
        defaultVal={0}
        snapThreshold={SNAP_THRESHOLDS.rotation}
        onEditStart={onEditStart}
        onEditEnd={onEditEnd}
      />

      <KeyframedSliderRow
        clip={clip}
        propertyId="transform.opacity"
        label="Opacity"
        min={0}
        max={100}
        step={1}
        unit="%"
        defaultVal={100}
        displayScale={100}
        snapThreshold={2}
        onEditStart={onEditStart}
        onEditEnd={onEditEnd}
      />

      <div className="flex items-center gap-2 mb-1">
        <span className="text-[10px] text-muted-foreground w-14 shrink-0">Flip</span>
        <div className="flex gap-1 flex-1">
          <ToggleButton
            label="H"
            active={transform.flipH}
            onToggle={() => onTransformChange({ flipH: !transform.flipH })}
          />
          <ToggleButton
            label="V"
            active={transform.flipV}
            onToggle={() => onTransformChange({ flipV: !transform.flipV })}
          />
        </div>
      </div>
    </div>
  )
}
