import { useState } from 'react'
import type { Clip, ClipTransform } from '../../types'
import { SliderRowWithReset } from './primitives'
import { SNAP_THRESHOLDS, snapToDefault } from './inspector-utils'

function isCropDefault(crop: ClipTransform['crop']): boolean {
  return (
    crop.top === 0 && crop.right === 0 && crop.bottom === 0 && crop.left === 0
  )
}

/**
 * CropSection — top/right/bottom/left crop sliders.
 *
 * Range sliders with clickable values and reset. Section reset sets all edges to 0.
 */
export function CropSection({
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
  const { crop } = clip.transform
  // Default to closed — 9:16 ad workflows almost never crop; revealing four
  // sliders by default is decision-soup for Sam. Auto-opens if crop is set
  // so users editing an existing crop don't have to hunt for it.
  const hasCrop = !isCropDefault(crop)
  const [manuallyOpen, setManuallyOpen] = useState(false)
  const open = hasCrop || manuallyOpen

  const updateCrop = (edge: keyof typeof crop, value: number) => {
    const snapped = snapToDefault(value, 0, SNAP_THRESHOLDS.crop)
    onTransformChange({ crop: { ...crop, [edge]: snapped } })
  }

  const resetCrop = () => {
    onTransformChange({
      crop: { top: 0, right: 0, bottom: 0, left: 0 },
    })
  }

  return (
    <div className="mb-4">
      {/* Disclosure header — replaces the always-on SectionHeader so Crop
          starts collapsed. Caret rotates 90° when open. Reset stays inline
          and only shows when there's something to reset. */}
      <div className="flex items-center gap-2 mb-2">
        <button
          type="button"
          onClick={() => setManuallyOpen((v) => !v)}
          aria-expanded={open}
          className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground transition-colors"
        >
          <svg
            width="9"
            height="9"
            viewBox="0 0 9 9"
            fill="currentColor"
            aria-hidden
            className={`transition-transform ${open ? 'rotate-90' : ''}`}
          >
            <path d="M2 1L7 4.5L2 8V1Z" />
          </svg>
          Crop
        </button>
        <div className="flex-1 h-px bg-border" />
        {hasCrop && (
          <button
            type="button"
            onClick={resetCrop}
            className="text-[10px] text-muted-foreground hover:text-foreground transition-colors shrink-0"
            title="Reset crop"
          >
            Reset
          </button>
        )}
      </div>

      {open && (
        <div>
          <SliderRowWithReset
            label="Top"
            value={crop.top}
            min={0}
            max={50}
            step={1}
            unit="%"
            defaultVal={0}
            onChange={(v) => updateCrop('top', v)}
            onEditStart={onEditStart}
            onEditEnd={onEditEnd}
          />
          <SliderRowWithReset
            label="Right"
            value={crop.right}
            min={0}
            max={50}
            step={1}
            unit="%"
            defaultVal={0}
            onChange={(v) => updateCrop('right', v)}
            onEditStart={onEditStart}
            onEditEnd={onEditEnd}
          />
          <SliderRowWithReset
            label="Bottom"
            value={crop.bottom}
            min={0}
            max={50}
            step={1}
            unit="%"
            defaultVal={0}
            onChange={(v) => updateCrop('bottom', v)}
            onEditStart={onEditStart}
            onEditEnd={onEditEnd}
          />
          <SliderRowWithReset
            label="Left"
            value={crop.left}
            min={0}
            max={50}
            step={1}
            unit="%"
            defaultVal={0}
            onChange={(v) => updateCrop('left', v)}
            onEditStart={onEditStart}
            onEditEnd={onEditEnd}
          />
        </div>
      )}
    </div>
  )
}
