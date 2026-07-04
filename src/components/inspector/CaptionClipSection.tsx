import { useState } from 'react'
import type {
  Clip,
  CaptionStyle,
  CaptionFontSize,
  CaptionPosition,
} from '../../types'
import { DEFAULT_CAPTION_STYLE } from '../../types'
import { ToggleGroup, ToggleGroupItem } from '../../ui/toggle-group'
import { KeyframedSliderRow } from './primitives'

/** Mirrors FONT_SIZE_MAP in the composition; used to seed Custom mode. */
const INSPECTOR_FONT_SIZE_PX: Record<CaptionFontSize, number> = { S: 36, M: 48, L: 64, XL: 80 }
const INSPECTOR_CUSTOM_SIZE_TOKEN = 'CUSTOM'

const CAPTION_FONT_SIZES: CaptionFontSize[] = ['S', 'M', 'L', 'XL']
const CAPTION_POSITIONS: CaptionPosition[] = ['top', 'center', 'bottom']

/**
 * CaptionClipSection — Inspector section for caption-type clips.
 *
 * Shown instead of Crop / Speed / Transform when the selected clip is on a
 * caption track. Scoped to the per-clip values that commonly vary per caption:
 *
 *   - Caption text — edits `clip.captionText`.
 *   - Position anchor (top/center/bottom) and Size (S/M/L/XL) — quick layout
 *     tweaks for individual lines.
 *   - X / Y offset — pixel-level free placement, mirrored by the draggable
 *     overlay on the preview canvas.
 *
 * Font, colour, outline, shadow, animation, etc. live in the left-rail
 * **Captions** tab. That panel auto-targets the current selection, so picking
 * a preset there writes directly to this clip. Duplicating those controls
 * here was the source of two complaints: the font dropdowns drifted apart and
 * users couldn't tell which control was authoritative.
 */
export interface CaptionClipSectionProps {
  clip: Clip
  onTextChange: (text: string) => void
  onStyleChange: (update: Partial<CaptionStyle>) => void
  onResetStyle: () => void
  onEditStart: () => void
  onEditEnd: () => void
  /** Switch the left asset rail to the Captions tab. */
  onOpenCaptionsTab: () => void
}

/** Sentinel value used inside the Position toggle group to represent the
 *  "Custom" disclosure — sits alongside the three anchor values without
 *  being one. Treated specially in the change handler. */
const INSPECTOR_CUSTOM_POSITION_TOKEN = 'CUSTOM'

export function CaptionClipSection({
  clip,
  onTextChange,
  onStyleChange,
  onResetStyle,
  onEditStart,
  onEditEnd,
  onOpenCaptionsTab,
}: CaptionClipSectionProps) {
  // Per-clip override > global default. The Inspector always shows a coherent
  // baseline so the user isn't editing against blank values.
  const effectiveStyle = clip.captionStyle ?? DEFAULT_CAPTION_STYLE
  const hasOverride = clip.captionStyle !== undefined

  // Custom-position disclosure: shown automatically when the clip already has
  // non-zero offsets or a keyframe track on either offset (so a fresh open of
  // an animated caption surfaces the controls), otherwise toggled manually.
  const hasOffsetKeyframes = (clip.keyframeTracks ?? []).some(
    (t) => t.propertyId === 'caption.xOffset' || t.propertyId === 'caption.yOffset',
  )
  const hasCustomOffsets =
    (effectiveStyle.xOffset ?? 0) !== 0 ||
    (effectiveStyle.yOffset ?? 0) !== 0 ||
    hasOffsetKeyframes
  const [customPositionManualOpen, setCustomPositionManualOpen] = useState(false)
  const customPositionActive = hasCustomOffsets || customPositionManualOpen

  return (
    <div className="mb-4">
      {/* ── Caption Text ── */}
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Caption Text
        </span>
        <div className="flex-1 h-px bg-border" />
      </div>

      <textarea
        value={clip.captionText ?? ''}
        onFocus={onEditStart}
        onBlur={onEditEnd}
        onChange={(e) => onTextChange(e.target.value)}
        rows={3}
        className="w-full bg-muted rounded px-2 py-1.5 text-xs text-foreground border border-border focus:outline-none focus:border-primary resize-none"
        placeholder="Caption text…"
        aria-label="Caption text"
      />

      {/* ── Layout (position + size + free offsets) ── */}
      <div className="flex items-center justify-between mt-3 mb-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Layout
        </span>
        {hasOverride && (
          <button
            onClick={onResetStyle}
            className="text-[10px] text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2"
            title="Drop the per-clip override and inherit the global default"
          >
            Reset to global
          </button>
        )}
        {!hasOverride && (
          <span className="text-[10px] text-muted-foreground/60">Inheriting global</span>
        )}
      </div>

      {/* Position picker — Top / Center / Bottom / Custom.
       *
       * Mutually exclusive: Custom is a fourth option that takes over the row
       * when the user wants free X/Y placement. While Custom is active the
       * anchor highlight is suppressed (the offsets are doing the placement);
       * picking an anchor clears the offsets and snaps back to anchor mode.
       *
       * The stored `position` still keeps its last value while in Custom mode
       * so the renderer always has an anchor to compute the offset relative
       * to — the toggle just hides that detail from the user. */}
      <div className="flex items-center gap-2 mb-1.5">
        <label className="text-[10px] text-muted-foreground w-14 shrink-0">Position</label>
        <ToggleGroup
          type="single"
          value={
            customPositionActive ? INSPECTOR_CUSTOM_POSITION_TOKEN : effectiveStyle.position
          }
          onValueChange={(val) => {
            // Empty val = user clicked the active option. Keep the current
            // selection so the row never empties.
            if (!val) return
            if (val === INSPECTOR_CUSTOM_POSITION_TOKEN) {
              setCustomPositionManualOpen(true)
              return
            }
            // Anchor picked — exit Custom and clear free-drag offsets so the
            // anchor's intent is honoured.
            setCustomPositionManualOpen(false)
            const newAnchor = val as CaptionPosition
            const offsetsChanged =
              (effectiveStyle.xOffset ?? 0) !== 0 || (effectiveStyle.yOffset ?? 0) !== 0
            if (newAnchor !== effectiveStyle.position || offsetsChanged) {
              onStyleChange({ position: newAnchor, xOffset: 0, yOffset: 0 })
            }
          }}
          size="sm"
          variant="outline"
          className="flex-1 grid grid-cols-4"
        >
          {CAPTION_POSITIONS.map((pos) => (
            <ToggleGroupItem key={pos} value={pos} className="text-[10px] capitalize">
              {pos}
            </ToggleGroupItem>
          ))}
          <ToggleGroupItem
            value={INSPECTOR_CUSTOM_POSITION_TOKEN}
            className="text-[10px] font-medium"
          >
            Custom
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      {customPositionActive && (
        <>
          <KeyframedSliderRow
            clip={clip}
            propertyId="caption.xOffset"
            label="X"
            min={-540}
            max={540}
            step={1}
            unit="px"
            defaultVal={DEFAULT_CAPTION_STYLE.xOffset ?? 0}
            onEditStart={onEditStart}
            onEditEnd={onEditEnd}
          />
          <KeyframedSliderRow
            clip={clip}
            propertyId="caption.yOffset"
            label="Y"
            min={-960}
            max={960}
            step={1}
            unit="px"
            defaultVal={DEFAULT_CAPTION_STYLE.yOffset ?? 0}
            onEditStart={onEditStart}
            onEditEnd={onEditEnd}
          />
        </>
      )}

      {/* Size */}
      <div className="flex items-center gap-2 mb-1.5">
        <label className="text-[10px] text-muted-foreground w-14 shrink-0">Size</label>
        <ToggleGroup
          type="single"
          value={effectiveStyle.fontSizePx !== undefined ? INSPECTOR_CUSTOM_SIZE_TOKEN : effectiveStyle.fontSize}
          onValueChange={(val) => {
            if (!val) return
            if (val === INSPECTOR_CUSTOM_SIZE_TOKEN) {
              onStyleChange({ fontSizePx: INSPECTOR_FONT_SIZE_PX[effectiveStyle.fontSize] ?? 64 })
            } else {
              onStyleChange({ fontSize: val as CaptionFontSize, fontSizePx: undefined })
            }
          }}
          size="sm"
          variant="outline"
          className="flex-1 grid grid-cols-5"
        >
          {CAPTION_FONT_SIZES.map((size) => (
            <ToggleGroupItem key={size} value={size} className="text-[10px] font-medium">
              {size}
            </ToggleGroupItem>
          ))}
          <ToggleGroupItem value={INSPECTOR_CUSTOM_SIZE_TOKEN} className="text-[10px] font-medium">
            Custom
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      {effectiveStyle.fontSizePx !== undefined && (
        <KeyframedSliderRow
          clip={clip}
          propertyId="caption.fontSizePx"
          label="Size"
          min={16}
          max={280}
          step={1}
          unit="px"
          defaultVal={DEFAULT_CAPTION_STYLE.fontSizePx ?? 48}
          onEditStart={onEditStart}
          onEditEnd={onEditEnd}
        />
      )}

      <button
        type="button"
        onClick={onOpenCaptionsTab}
        className="mt-3 w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-[10px] font-medium border border-border bg-background text-foreground hover:bg-muted transition-colors"
      >
        Open Captions tab
        <span aria-hidden className="text-[10px]">→</span>
      </button>
    </div>
  )
}
