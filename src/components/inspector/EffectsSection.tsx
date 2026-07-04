/**
 * EffectsSection — Premiere-style effect stack editor for the selected clip.
 *
 * Renders the clip's ordered `EffectInstance[]` as a vertical list of cards.
 * Index 0 processes the source media first; later cards apply on top. Each
 * card offers:
 *
 *   - drag handle  → reorder the stack (dnd-kit sortable)
 *   - eye toggle   → bypass the instance without losing its settings
 *   - copy         → put this one instance on the effect clipboard
 *   - delete       → remove the instance
 *   - param editor → type-specific click-based controls
 *
 * "Copy all" / "Paste" move whole stacks between clips via the ui-store's
 * `effectClipboard`. Pasting appends (Premiere behavior) and re-ids every
 * instance so two clips never share instance ids.
 *
 * New instances arrive by dragging from the Effects panel onto a timeline
 * clip (see EffectsPanel / TimelineClip) — this section only edits what's
 * already applied, plus a shortcut to open that panel when the stack is empty.
 */

import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ClipboardPaste, Copy, Eye, EyeOff, GripVertical, Trash2 } from 'lucide-react'

import type { Clip, EffectInstance, LookPreset } from '../../types'
import { EFFECT_LABELS, LOOK_PRESET_LABELS } from '../../engine/effects'
import { useEditorStore } from '../../store/editor-store'
import { useUIStore } from '../../store/ui-store'
import { SectionHeader, SliderRowWithReset, ToggleButton } from './primitives'

const LOOK_ORDER: LookPreset[] = ['punch', 'film', 'warm', 'cool', 'bw', 'noir']

/** Pulse rate presets — normie-friendly names instead of a raw ms input. */
const PULSE_RATES: { label: string; intervalMs: number }[] = [
  { label: 'Slow', intervalMs: 1000 },
  { label: 'Med', intervalMs: 500 },
  { label: 'Fast', intervalMs: 250 },
]

const pct = (v: number) => String(Math.round(v * 100))

// ─── Per-type parameter editors ──────────────────────────────────────────────

function EffectParamsEditor({
  fx,
  patch,
  onEditStart,
  onEditEnd,
}: {
  fx: EffectInstance
  patch: (p: Partial<EffectInstance>) => void
  onEditStart: () => void
  onEditEnd: () => void
}) {
  const slider = (
    label: string,
    value: number,
    onChange: (v: number) => void,
    opts: { min?: number; max?: number; step?: number; defaultVal: number; format?: (v: number) => string } ,
  ) => (
    <SliderRowWithReset
      label={label}
      value={value}
      min={opts.min ?? 0}
      max={opts.max ?? 1}
      step={opts.step ?? 0.01}
      unit="%"
      defaultVal={opts.defaultVal}
      formatDisplay={opts.format ?? pct}
      onChange={onChange}
      onEditStart={onEditStart}
      onEditEnd={onEditEnd}
    />
  )

  switch (fx.type) {
    case 'look':
      return (
        <>
          <div className="grid grid-cols-3 gap-1 mb-2">
            {LOOK_ORDER.map((preset) => (
              <ToggleButton
                key={preset}
                label={LOOK_PRESET_LABELS[preset]}
                active={fx.preset === preset}
                onToggle={() => patch({ preset })}
              />
            ))}
          </div>
          {slider('Strength', fx.intensity, (v) => patch({ intensity: v }), { defaultVal: 1 })}
        </>
      )

    case 'shake':
      return slider('Amount', fx.amount, (v) => patch({ amount: v }), { defaultVal: 0.5 })

    case 'pulse':
      return (
        <>
          {slider('Amount', fx.amount, (v) => patch({ amount: v }), { defaultVal: 0.5 })}
          <div className="flex gap-1 mb-2">
            {PULSE_RATES.map(({ label, intervalMs }) => (
              <ToggleButton
                key={label}
                label={label}
                active={fx.intervalMs === intervalMs}
                onToggle={() => patch({ intervalMs })}
              />
            ))}
          </div>
        </>
      )

    case 'slowZoom':
      return (
        <>
          <div className="flex gap-1 mb-2">
            {(['in', 'out'] as const).map((direction) => (
              <ToggleButton
                key={direction}
                label={direction === 'in' ? 'Zoom in' : 'Zoom out'}
                active={fx.direction === direction}
                onToggle={() => patch({ direction })}
              />
            ))}
          </div>
          {slider('Amount', fx.amount, (v) => patch({ amount: v }), {
            min: 0.05,
            defaultVal: 0.5,
          })}
        </>
      )

    case 'grain':
      return slider('Amount', fx.amount, (v) => patch({ amount: v }), { defaultVal: 0.5 })

    case 'vignette':
      return slider('Amount', fx.amount, (v) => patch({ amount: v }), { defaultVal: 0.7 })

    case 'letterbox':
      return slider('Size', fx.amount, (v) => patch({ amount: v }), {
        max: 0.15,
        step: 0.005,
        defaultVal: 0.1,
      })

    case 'focusIn':
      return (
        <SliderRowWithReset
          label="Duration"
          value={fx.durationMs}
          min={100}
          max={2000}
          step={50}
          unit="ms"
          defaultVal={500}
          formatDisplay={(v) => String(Math.round(v))}
          onChange={(v) => patch({ durationMs: v })}
          onEditStart={onEditStart}
          onEditEnd={onEditEnd}
        />
      )
  }
}

// ─── Stack card ──────────────────────────────────────────────────────────────

function EffectCard({
  clip,
  fx,
  onEditStart,
  onEditEnd,
  onCopy,
  onRemove,
}: {
  clip: Clip
  fx: EffectInstance
  onEditStart: () => void
  onEditEnd: () => void
  onCopy: () => void
  onRemove: () => void
}) {
  const updateClipEffect = useEditorStore((s) => s.updateClipEffect)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: fx.id,
  })
  const enabled = fx.enabled !== false
  const patch = (p: Partial<EffectInstance>) => updateClipEffect(clip.id, fx.id, p)

  const iconButton =
    'w-5 h-5 grid place-items-center rounded text-muted-foreground hover:text-foreground hover:bg-muted/70 transition-colors'

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`rounded-md border border-border/70 bg-muted/30 ${
        isDragging ? 'z-10 relative shadow-lg opacity-90' : ''
      }`}
    >
      <div className="flex items-center gap-1 px-1.5 py-1">
        <button
          type="button"
          {...attributes}
          {...listeners}
          title="Drag to reorder"
          aria-label={`Reorder ${EFFECT_LABELS[fx.type]}`}
          className="w-5 h-5 grid place-items-center text-muted-foreground/70 hover:text-foreground cursor-grab active:cursor-grabbing touch-none"
        >
          <GripVertical size={12} />
        </button>
        <span className={`flex-1 text-[11px] font-medium ${enabled ? 'text-foreground' : 'text-muted-foreground line-through'}`}>
          {EFFECT_LABELS[fx.type]}
        </span>
        <button
          type="button"
          onClick={() => patch({ enabled: !enabled })}
          title={enabled ? 'Bypass effect' : 'Enable effect'}
          aria-pressed={enabled}
          className={iconButton}
        >
          {enabled ? <Eye size={12} /> : <EyeOff size={12} />}
        </button>
        <button type="button" onClick={onCopy} title="Copy effect" className={iconButton}>
          <Copy size={12} />
        </button>
        <button
          type="button"
          onClick={onRemove}
          title="Delete effect"
          className="w-5 h-5 grid place-items-center rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
        >
          <Trash2 size={12} />
        </button>
      </div>
      <div className={`px-2 pb-1 ${enabled ? '' : 'opacity-50 pointer-events-none'}`}>
        <EffectParamsEditor fx={fx} patch={patch} onEditStart={onEditStart} onEditEnd={onEditEnd} />
      </div>
    </div>
  )
}

// ─── Section ─────────────────────────────────────────────────────────────────

export function EffectsSection({
  clip,
  onEditStart,
  onEditEnd,
}: {
  clip: Clip
  onEditStart: () => void
  onEditEnd: () => void
}) {
  const removeClipEffect = useEditorStore((s) => s.removeClipEffect)
  const moveClipEffect = useEditorStore((s) => s.moveClipEffect)
  const setClipEffects = useEditorStore((s) => s.setClipEffects)
  const effectClipboard = useUIStore((s) => s.effectClipboard)
  const setEffectClipboard = useUIStore((s) => s.setEffectClipboard)
  const setAssetTab = useUIStore((s) => s.setAssetTab)

  const stack = clip.effects ?? []

  // 4px activation distance so plain clicks on the grip don't start a sort.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const from = stack.findIndex((fx) => fx.id === active.id)
    const to = stack.findIndex((fx) => fx.id === over.id)
    if (from < 0 || to < 0) return
    moveClipEffect(clip.id, from, to)
  }

  function handlePaste() {
    if (!effectClipboard || effectClipboard.length === 0) return
    setClipEffects(clip.id, [
      ...stack,
      // Fresh ids: instance ids key the sortable list and seed shake phase —
      // they must be unique per clip.
      ...effectClipboard.map((fx) => ({ ...fx, id: crypto.randomUUID() })),
    ])
  }

  const chipButton =
    'flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors'

  return (
    <div className="mb-4">
      <SectionHeader
        label="Effects"
        onReset={() => setClipEffects(clip.id, [])}
        canReset={stack.length > 0}
      />

      {(stack.length > 0 || (effectClipboard?.length ?? 0) > 0) && (
        <div className="flex gap-1 mb-2">
          {stack.length > 0 && (
            <button
              type="button"
              onClick={() => setEffectClipboard(stack.map((fx) => ({ ...fx })))}
              title="Copy all effects on this clip"
              className={chipButton}
            >
              <Copy size={10} />
              Copy all
            </button>
          )}
          {(effectClipboard?.length ?? 0) > 0 && (
            <button
              type="button"
              onClick={handlePaste}
              title="Paste copied effects onto this clip"
              className={chipButton}
            >
              <ClipboardPaste size={10} />
              Paste {effectClipboard!.length === 1 ? 'effect' : `${effectClipboard!.length} effects`}
            </button>
          )}
        </div>
      )}

      {stack.length === 0 ? (
        <div className="rounded-md border border-dashed border-border/70 px-2 py-3 text-center">
          <p className="text-[10px] text-muted-foreground mb-1.5">
            No effects on this clip yet. Drag one from the Effects panel onto
            the clip in the timeline.
          </p>
          <button
            type="button"
            onClick={() => setAssetTab('effects')}
            className="text-[10px] font-medium text-primary hover:underline"
          >
            Browse effects
          </button>
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={stack.map((fx) => fx.id)} strategy={verticalListSortingStrategy}>
            <div className="space-y-1.5">
              {stack.map((fx) => (
                <EffectCard
                  key={fx.id}
                  clip={clip}
                  fx={fx}
                  onEditStart={onEditStart}
                  onEditEnd={onEditEnd}
                  onCopy={() => setEffectClipboard([{ ...fx }])}
                  onRemove={() => removeClipEffect(clip.id, fx.id)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
    </div>
  )
}
