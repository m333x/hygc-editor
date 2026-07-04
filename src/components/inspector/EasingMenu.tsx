/**
 * EasingMenu — Radix popover for setting a keyframe's incoming/outgoing easing.
 *
 * Opened from a right-click on a `KeyframeMarker` (Inspector ribbon) or a
 * graph diamond (`ClipKeyframeGraph`). Shows the five v1 easings (Linear,
 * Ease In, Ease Out, Ease In-Out, Hold) as labeled rows with tiny SVG curve
 * previews — visual picks, per the no-code-inputs constraint.
 *
 * Two sections: "Incoming" (curve arriving at this keyframe) and "Outgoing"
 * (curve departing toward the next one). Matches Premiere's two-sided model.
 *
 * Anchoring:
 *   The menu is opened from a right-click, so it has no triggering element
 *   the way a button-driven Popover would. We render an invisible 1×1
 *   `PopoverAnchor` `position: fixed` at the click's `clientX`/`clientY` and
 *   let Radix position the floating content relative to that virtual anchor.
 *
 * Why Radix (and not a hand-rolled `position: fixed` div):
 *   The keyframe surfaces this menu opens from sit inside ancestors that
 *   apply CSS `transform` (dnd-kit on track rows). A transformed ancestor
 *   becomes the containing block for any fixed-position descendant, which
 *   then gets clipped by `overflow-hidden` on the track lane. Radix's portal
 *   re-parents the floating content to `document.body`, escaping the timeline
 *   stacking context entirely. As a bonus we get outside-click, Escape, and
 *   focus management for free.
 */

import { Popover as PopoverPrimitive } from 'radix-ui'

import { useEditorStore } from '../../store/editor-store'
import type { AnimatablePropertyId, EasingKind } from '../../types'
import { KeyframeShape } from './keyframe-shapes'

const EASING_OPTIONS: ReadonlyArray<{ id: EasingKind; label: string }> = [
  { id: 'linear', label: 'Linear' },
  { id: 'easeIn', label: 'Ease In' },
  { id: 'easeOut', label: 'Ease Out' },
  { id: 'easeInOut', label: 'Ease In-Out' },
  { id: 'hold', label: 'Hold' },
]

/**
 * SVG path data for a 24×12 curve preview. Each curve runs from (0,12) at the
 * bottom-left to (24,0) at the top-right and shapes the middle according to
 * the easing — purely cosmetic; the actual interpolation math lives in
 * `engine/keyframe-interpolator.ts` (`EASING_FUNCTIONS`).
 */
const EASING_PREVIEWS: Record<EasingKind, string> = {
  linear: 'M 0 12 L 24 0',
  easeIn: 'M 0 12 C 12 12, 18 8, 24 0',
  easeOut: 'M 0 12 C 6 4, 12 0, 24 0',
  easeInOut: 'M 0 12 C 8 12, 16 0, 24 0',
  hold: 'M 0 12 L 22 12 L 22 0 L 24 0',
}

function EasingPreview({ kind }: { kind: EasingKind }) {
  return (
    <svg width={24} height={12} viewBox="0 0 24 12" className="text-muted-foreground">
      <path d={EASING_PREVIEWS[kind]} fill="none" stroke="currentColor" strokeWidth={1.25} />
    </svg>
  )
}

function EasingRow({
  side,
  current,
  onPick,
}: {
  side: 'in' | 'out'
  current: EasingKind
  onPick: (easing: EasingKind) => void
}) {
  // Render the marker half on the side this row controls. The opposite side is
  // a no-op `linear` since we're only previewing the side being picked.
  const sideLabel = side === 'in' ? 'Incoming' : 'Outgoing'
  return (
    <div>
      <p className="px-2 pt-1.5 pb-1 text-[9px] uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
        <span>{sideLabel}</span>
        <span className="text-muted-foreground/60 normal-case tracking-normal text-[9px]">
          {side === 'in' ? 'arrives at keyframe' : 'departs to next'}
        </span>
      </p>
      {EASING_OPTIONS.map((opt) => {
        const active = opt.id === current
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => onPick(opt.id)}
            className={`w-full flex items-center gap-2 px-2 py-1 text-[11px] text-left transition-colors ${
              active
                ? 'bg-primary/15 text-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/60'
            }`}
          >
            <span className="grid place-items-center w-3 h-3 shrink-0">
              <KeyframeShape
                easingIn={side === 'in' ? opt.id : 'linear'}
                easingOut={side === 'out' ? opt.id : 'linear'}
                onlySide={side === 'in' ? 'left' : 'right'}
                selected={active}
                size={12}
                variant="menu"
              />
            </span>
            <EasingPreview kind={opt.id} />
            <span className="flex-1">{opt.label}</span>
          </button>
        )
      })}
    </div>
  )
}

export interface EasingMenuProps {
  clipId: string
  propertyId: AnimatablePropertyId
  keyframeId: string
  currentIn: EasingKind
  currentOut: EasingKind
  /** Anchor position from the right-click event (clientX/clientY). */
  position: { x: number; y: number }
  onClose: () => void
}

export function EasingMenu({
  clipId,
  propertyId,
  keyframeId,
  currentIn,
  currentOut,
  position,
  onClose,
}: EasingMenuProps) {
  const setKeyframeEasing = useEditorStore((s) => s.setKeyframeEasing)

  function pick(side: 'in' | 'out', easing: EasingKind) {
    setKeyframeEasing(clipId, propertyId, keyframeId, side, easing)
  }

  return (
    <PopoverPrimitive.Root
      open
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      {/* Virtual anchor: a 1×1 fixed-position element at the right-click
          coordinates. `asChild` lets Radix forward the anchor ref onto our
          own div so it doesn't introduce an extra wrapper that could be
          caught by an ancestor's pointer / drag handlers. */}
      <PopoverPrimitive.Anchor asChild>
        <div
          aria-hidden
          style={{
            position: 'fixed',
            left: position.x,
            top: position.y,
            width: 1,
            height: 1,
            pointerEvents: 'none',
          }}
        />
      </PopoverPrimitive.Anchor>

      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          side="bottom"
          sideOffset={4}
          collisionPadding={8}
          role="menu"
          // High z-index so the menu floats above every editor surface —
          // since this is portaled to body it lives at the top of the page
          // stacking context, but the explicit value protects against host
          // pages that might layer their own chrome on top.
          className="z-[200] w-44 rounded-md border border-border bg-popover shadow-lg py-1 text-foreground outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
          onOpenAutoFocus={(e) => {
            // Don't pull focus into the menu — keep keyboard focus wherever
            // the user was so Delete / arrow keys still target the keyframe
            // they just right-clicked.
            e.preventDefault()
          }}
        >
          <EasingRow side="in" current={currentIn} onPick={(e) => pick('in', e)} />
          <div className="h-px bg-border my-1" />
          <EasingRow side="out" current={currentOut} onPick={(e) => pick('out', e)} />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}
