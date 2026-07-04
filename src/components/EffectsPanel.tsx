/**
 * EffectsPanel — palette of draggable effect presets in the asset rail.
 *
 * Premiere-style: each tile is one effect type the user drags onto a video
 * clip in the timeline. Dropping appends a new `EffectInstance` to that
 * clip's effect stack (one at a time — drop twice to stack the same effect
 * twice). Double-clicking a tile applies it to the currently selected video
 * clips instead.
 *
 * The panel publishes the effect type as an HTML5 drag payload under the
 * `application/hygc-effect` MIME type; the drop target and highlight live in
 * TimelineClip. Editing, reordering, and deleting applied effects is the
 * Inspector's job (EffectsSection).
 *
 * SOLID: SRP — only renders the palette + drag setup. Per-frame effect math
 *   lives in `engine/effects.ts`; the stack editor lives in the Inspector.
 */

import {
  Activity,
  Aperture,
  Focus,
  Palette,
  RectangleHorizontal,
  Sparkles,
  Vibrate,
  ZoomIn,
} from 'lucide-react'

import {
  EFFECT_DRAG_MIME_TYPE,
  EFFECT_LABELS,
  createEffectInstance,
  type DraggedEffectPayload,
} from '../engine/effects'
import type { EffectType } from '../types'
import { useEditorStore } from '../store/editor-store'
import { useSelectionStore } from '../store/selection-store'

/** Palette order: color first (most used), then motion, then texture/framing. */
const EFFECT_ORDER: { type: EffectType; icon: React.ReactNode; hint: string }[] = [
  { type: 'look', icon: <Palette size={20} aria-hidden />, hint: 'Color grade presets' },
  { type: 'shake', icon: <Vibrate size={20} aria-hidden />, hint: 'Handheld camera shake' },
  { type: 'pulse', icon: <Activity size={20} aria-hidden />, hint: 'Rhythmic zoom kicks' },
  { type: 'slowZoom', icon: <ZoomIn size={20} aria-hidden />, hint: 'Slow Ken Burns zoom' },
  { type: 'grain', icon: <Sparkles size={20} aria-hidden />, hint: 'Film grain texture' },
  { type: 'vignette', icon: <Aperture size={20} aria-hidden />, hint: 'Darkened frame edges' },
  {
    type: 'letterbox',
    icon: <RectangleHorizontal size={20} aria-hidden />,
    hint: 'Cinematic black bars',
  },
  { type: 'focusIn', icon: <Focus size={20} aria-hidden />, hint: 'Opens blurred, pulls sharp' },
]

/**
 * Apply an effect to every selected clip that sits on an unlocked video
 * track — the double-click fallback for users who don't drag.
 */
function applyToSelectedClips(type: EffectType) {
  const selected = useSelectionStore.getState().selectedClipIds
  if (selected.length === 0) return
  const { tracks, addClipEffect } = useEditorStore.getState()
  for (const track of tracks) {
    if (track.type !== 'video' || track.locked) continue
    for (const clip of track.clips) {
      if (selected.includes(clip.id)) addClipEffect(clip.id, createEffectInstance(type))
    }
  }
}

function EffectCard({
  type,
  icon,
  hint,
}: {
  type: EffectType
  icon: React.ReactNode
  hint: string
}) {
  function handleDragStart(e: React.DragEvent<HTMLDivElement>) {
    const payload: DraggedEffectPayload = { effectType: type }
    e.dataTransfer.setData(EFFECT_DRAG_MIME_TYPE, JSON.stringify(payload))
    e.dataTransfer.effectAllowed = 'copy'
  }

  return (
    <div
      draggable
      onDragStart={handleDragStart}
      onDoubleClick={() => applyToSelectedClips(type)}
      className="group flex flex-col items-center gap-1.5 select-none cursor-grab active:cursor-grabbing"
      title={`${hint}. Drag onto a clip, or double-click to apply to the selected clip.`}
      aria-label={`${EFFECT_LABELS[type]} effect`}
    >
      <div
        className={`
          relative h-16 w-full rounded-lg flex items-center justify-center
          bg-muted/60 text-foreground/85
          border border-border/60
          group-hover:border-primary/50 group-hover:bg-muted/80 group-hover:text-foreground
          transition-colors
        `}
      >
        {icon}
      </div>
      <span className="text-[10px] font-medium text-muted-foreground group-hover:text-foreground leading-none">
        {EFFECT_LABELS[type]}
      </span>
    </div>
  )
}

export function EffectsPanel() {
  return (
    <div className="flex-1 overflow-y-auto p-3 space-y-2">
      <p className="text-[10px] text-muted-foreground/80 leading-snug">
        Drag an effect onto a clip. Stack as many as you like, then reorder or
        tweak them in the Inspector.
      </p>
      <div className="grid grid-cols-3 gap-2.5">
        {EFFECT_ORDER.map(({ type, icon, hint }) => (
          <EffectCard key={type} type={type} icon={icon} hint={hint} />
        ))}
      </div>
    </div>
  )
}
