/**
 * CaptionStylePanel — caption generation trigger and global style configuration.
 *
 * This panel is the primary interface for Phase 3.8's caption system. It
 * combines two responsibilities:
 *
 *   1. Generation: A "Generate Captions" button that triggers the
 *      `useCaptionGeneration` hook to transcribe voiceover audio and place
 *      caption clips on the Captions track.
 *
 *   2. Styling: Controls that configure the global `captionStyle` in the
 *      Zustand editor store, which the Remotion composition reads when
 *      rendering caption text overlays.
 *
 * ─── Layout ──────────────────────────────────────────────────────────────────
 *
 *   ┌─ Generate Captions ──────────────────────────────────────────────────┐
 *   │  [Generate Captions ▶]  (disabled if no voiceover clips)             │
 *   │  "Transcribes voiceover audio and places caption clips on the        │
 *   │   Captions track. Costs 2 credits/min of audio."                     │
 *   ├─ Presets ─────────────────────────────────────────────────────────────┤
 *   │  [Bold Impact] [Modern Sans] [Minimal] [Neon]                         │
 *   ├─ Style Controls ───────────────────────────────────────────────────────┤
 *   │  Font: [Impact ▾]  Size: [S][M][L][XL]                               │
 *   │  Color: ████  Outline: ████  Width: ─────── 3px                       │
 *   │  Position: [Top][Center][Bottom]                                       │
 *   │  Y Offset: ────────── -100px                                           │
 *   │  Anim In: [pop-in ▾]  Anim Out: [none ▾]                              │
 *   │  [✓] Word highlight  ████                                              │
 *   │  Drop shadow: [2px 2px 4px rgba(0,0,0,0.8)]                           │
 *   │  Background: ████████                                                  │
 *   └──────────────────────────────────────────────────────────────────────┘
 *
 * ─── Style Presets ───────────────────────────────────────────────────────────
 *
 *   Presets are one-click configurations that set all style properties at once.
 *   They are designed to match the most popular YouTube Shorts caption styles:
 *
 *   Bold Impact  — White Impact font, black outline, pop-in animation,
 *                  golden word highlight. The "classic" viral-video look.
 *
 *   Modern Sans  — Montserrat Bold, white with semi-transparent background,
 *                  fade-in animation, blue word highlight. Clean and readable.
 *
 *   Minimal      — Roboto Regular, white, no outline, no animation.
 *                  For content where subtlety is preferred over flashiness.
 *
 *   Neon         — Oswald Bold, cyan text with dark background box,
 *                  slide-up animation, yellow word highlight. Eye-catching.
 *
 * ─── Global vs per-clip style ────────────────────────────────────────────────
 *
 *   The CaptionStylePanel edits the global `captionStyle` (persisted to
 *   `projects.editor_state`). All caption clips that do not have a per-clip
 *   `captionStyle` override will use this global style at render time.
 *
 *   Per-clip overrides are accessible in the InspectorPanel when a caption
 *   clip is selected — the CaptionClipSection renders the same controls
 *   for just that clip. See `InspectorPanel.tsx` for details.
 *
 * SOLID: SRP — only manages caption generation trigger and global style UI.
 *   The store write and Edge Function call are delegated to their respective
 *   hooks (useEditorStore, useCaptionGeneration).
 * SOLID: DIP — depends on the editor store interface and the useCaptionGeneration
 *   hook's abstraction, not on any specific transcription provider.
 *
 * @see README.md Section 7.6 "Caption System" for full styling specification
 * @see PLAN.md Phase 3.8 for caption generation and styling requirements
 * @see useCaptionGeneration.ts for the caption generation hook
 * @see InspectorPanel.tsx CaptionClipSection for per-clip style overrides
 * @see types.ts CaptionStyle, CaptionFontSize, CaptionPosition, CaptionAnimation
 */

import { SlidersHorizontal, RotateCcw, ChevronDown, ChevronRight } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useEditorStore } from '../store/editor-store'
import { useSelectionStore } from '../store/selection-store'
import { DEFAULT_CAPTION_STYLE } from '../types'
import type { CaptionStyle, CaptionFontSize, CaptionPosition, CaptionAnimation, Clip } from '../types'
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group'
import { Slider } from '../ui/slider'
import { Popover, PopoverTrigger, PopoverContent } from '../ui/popover'

/**
 * Pixel sizes for each fontSize preset. Mirrors FONT_SIZE_MAP in the
 * composition; duplicated locally so the panel can seed Custom mode from
 * the current preset and show the active px in the slider readout.
 */
const FONT_SIZE_PX: Record<CaptionFontSize, number> = { S: 36, M: 48, L: 64, XL: 80 }
const CUSTOM_SIZE_TOKEN = 'CUSTOM'
const CUSTOM_SIZE_MIN = 16
const CUSTOM_SIZE_MAX = 280
const CUSTOM_SIZE_STEP = 1

/**
 * Outline width is exposed as four named steps. The internal field stays a
 * number so existing presets, render code, and per-clip overrides keep working
 * unchanged — but normies see "Thin / Medium / Bold" instead of "5px".
 *
 * Values outside the named bucket (e.g. a 5px preset) snap to the nearest
 * bucket on display. The closest match heuristic uses the lookup below.
 */
const OUTLINE_STEPS = [
  { value: 0, label: 'None' },
  { value: 2, label: 'Thin' },
  { value: 4, label: 'Med' },
  { value: 6, label: 'Bold' },
] as const

/**
 * Font weight is presented as four named tiers. Display-family fonts (Bangers,
 * Impact, …) only ship a single naturally-heavy weight, so picking "Light" or
 * "Reg" on those triggers synthetic-thinning that looks bad — the renderer
 * still respects the user's choice, but the default seed for those families
 * is 400, not 700.
 */
const WEIGHT_STEPS = [
  { value: 300, label: 'Light' },
  { value: 400, label: 'Reg' },
  { value: 700, label: 'Bold' },
  { value: 900, label: 'Black' },
] as const

function matchWeightStep(weight: number): number {
  let best: number = WEIGHT_STEPS[0].value
  let bestDist = Math.abs(weight - best)
  for (const step of WEIGHT_STEPS) {
    const dist = Math.abs(weight - step.value)
    if (dist < bestDist) {
      best = step.value
      bestDist = dist
    }
  }
  return best
}

/**
 * Text-case toggle. Labels are written in the case they apply — `AA` is upper,
 * `aa` is lower — so the user sees what each button does without reading the
 * tooltip. "Aa" stands in for "leave the user's typing alone".
 */
const CASE_STEPS = [
  { value: 'none',       label: 'Aa',    title: 'As typed' },
  { value: 'uppercase',  label: 'AA',    title: 'ALL CAPS' },
  { value: 'lowercase',  label: 'aa',    title: 'all lower' },
  { value: 'capitalize', label: 'Title', title: 'Title Case' },
] as const

function matchOutlineStep(width: number): number {
  let best: number = OUTLINE_STEPS[0].value
  let bestDist = Math.abs(width - best)
  for (const step of OUTLINE_STEPS) {
    const dist = Math.abs(width - step.value)
    if (dist < bestDist) {
      best = step.value
      bestDist = dist
    }
  }
  return best
}

/**
 * Transitions are presented as a single preset that bundles enter + exit.
 * Most TikTok/Shorts captions never use a distinct out animation, so
 * collapsing the two selects into one preset matches the actual mental model.
 * Power users can still override via the Advanced disclosure.
 *
 * Transitions live in their own top-level section of the panel — they are
 * deliberately decoupled from visual Style presets so picking a look (Comic,
 * Neon, …) never silently changes how captions enter or exit.
 */
interface TransitionPreset {
  id: string
  label: string
  in: CaptionAnimation
  out: CaptionAnimation
}

const TRANSITION_PRESETS: TransitionPreset[] = [
  { id: 'none',       label: 'None',       in: 'none',        out: 'none' },
  { id: 'pop',        label: 'Pop',        in: 'pop-in',      out: 'none' },
  { id: 'fade',       label: 'Fade',       in: 'fade-in',     out: 'none' },
  { id: 'slide-up',   label: 'Slide up',   in: 'slide-up',    out: 'none' },
  { id: 'slide-down', label: 'Slide down', in: 'slide-down',  out: 'none' },
]

const TRANSITION_CUSTOM_TOKEN = '__custom__'

function matchTransitionPreset(inAnim: CaptionAnimation, outAnim: CaptionAnimation): string {
  for (const p of TRANSITION_PRESETS) {
    if (p.in === inAnim && p.out === outAnim) return p.id
  }
  return TRANSITION_CUSTOM_TOKEN
}

/**
 * Drop shadow is presented as 3 visual presets — most users want "off",
 * "subtle blur", or "comic-book stamp". A 4th "Custom" entry appears only
 * when the underlying CSS string doesn't match any preset.
 */
const SHADOW_PRESETS = [
  { id: 'none', label: 'None', value: '' },
  { id: 'soft', label: 'Soft', value: '0 4px 12px rgba(0,0,0,0.45)' },
  { id: 'hard', label: 'Hard', value: '6px 6px 0 rgba(0,0,0,1)' },
] as const

const SHADOW_CUSTOM_TOKEN = '__custom__'

function matchShadowPreset(shadow: string): string {
  const normalized = (shadow || '').replace(/\s+/g, '')
  for (const p of SHADOW_PRESETS) {
    if (p.value.replace(/\s+/g, '') === normalized) return p.id
  }
  return SHADOW_CUSTOM_TOKEN
}

/**
 * Parse a backgroundColor value into a color + alpha pair. Accepts both
 * `rgba(...)` and `#rrggbb` forms — and the empty string, which means
 * "no background". The parser is intentionally lenient: unknown shapes fall
 * back to opaque black so the UI never explodes on stale data.
 */
function parseBackground(bg: string): { color: string; alpha: number; on: boolean } {
  if (!bg) return { color: '#000000', alpha: 0.5, on: false }
  const rgba = bg.match(/^\s*rgba?\(\s*([^)]+)\s*\)\s*$/i)
  if (rgba) {
    const parts = rgba[1].split(',').map((s) => s.trim())
    const r = Number(parts[0])
    const g = Number(parts[1])
    const b = Number(parts[2])
    const a = parts[3] !== undefined ? Number(parts[3]) : 1
    const hex =
      '#' +
      [r, g, b]
        .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
        .join('')
    return { color: hex, alpha: Number.isFinite(a) ? a : 1, on: true }
  }
  if (/^#[0-9a-f]{6}$/i.test(bg.trim())) {
    return { color: bg.trim(), alpha: 1, on: true }
  }
  return { color: '#000000', alpha: 0.5, on: true }
}

function formatBackground(color: string, alpha: number): string {
  const m = color.match(/^#?([0-9a-f]{6})$/i)
  if (!m) return ''
  const hex = m[1]
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  const clamped = Math.max(0, Math.min(1, alpha))
  return `rgba(${r}, ${g}, ${b}, ${clamped.toFixed(2)})`
}

/**
 * Shape used by the click-based shadow editor. A simple single-layer shadow
 * is enough to cover the "I want a punchy drop shadow under my caption"
 * use case without exposing raw CSS to non-technical users.
 *
 * Multi-layer shadows (e.g. the Glow / Neon presets) can't be edited via the
 * sliders without losing layers — that's a deliberate trade-off. Those
 * shadows are owned by the top-level preset cards; editing them here would
 * mean re-implementing a full shadow stack editor which is overkill.
 */
interface ShadowParts {
  x: number
  y: number
  blur: number
  color: string  // '#RRGGBB'
  alpha: number  // 0..1
}

const DEFAULT_SHADOW_PARTS: ShadowParts = {
  x: 4,
  y: 4,
  blur: 4,
  color: '#000000',
  alpha: 0.7,
}

/**
 * Parse the first layer of a CSS box-/text-shadow string into its parts.
 *
 * Supports the canonical `X Y BLUR COLOR` form. Trailing layers (everything
 * past the first comma at depth 0) are discarded — the editor is single-layer
 * by design.
 *
 * Returns `null` when the string is empty or doesn't fit the shape; callers
 * fall back to {@link DEFAULT_SHADOW_PARTS} so the UI always has values to
 * render against.
 */
function parseShadow(shadow: string): ShadowParts | null {
  if (!shadow) return null
  // Split on top-level commas only. Commas inside `rgb(...)` / `rgba(...)`
  // mustn't break the layer apart.
  const firstLayer = splitTopLevelComma(shadow)[0]
  if (!firstLayer) return null

  // Pull out the color first (rgba / rgb / hex / named) so what's left is just numbers.
  const colorMatch = firstLayer.match(/rgba?\([^)]+\)|#[0-9a-f]{3,8}/i)
  if (!colorMatch) return null
  const colorStr = colorMatch[0]
  const rest = firstLayer.replace(colorStr, '').trim()
  const nums = rest.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? []
  if (nums.length < 2) return null

  const [x = 0, y = 0, blur = 0] = nums

  // Normalize color into #RRGGBB + alpha.
  let color = '#000000'
  let alpha = 1
  const rgba = colorStr.match(/^rgba?\(([^)]+)\)$/i)
  if (rgba) {
    const parts = rgba[1].split(',').map((s) => Number(s.trim()))
    const r = parts[0] ?? 0
    const g = parts[1] ?? 0
    const b = parts[2] ?? 0
    alpha = parts[3] !== undefined ? parts[3] : 1
    color =
      '#' +
      [r, g, b]
        .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
        .join('')
  } else if (colorStr.startsWith('#')) {
    // Expand 3-digit hex; clip 8-digit hex's alpha into the alpha field.
    const hex = colorStr.slice(1)
    if (hex.length === 3) {
      color = '#' + hex.split('').map((c) => c + c).join('')
      alpha = 1
    } else if (hex.length === 6) {
      color = colorStr
      alpha = 1
    } else if (hex.length === 8) {
      color = '#' + hex.slice(0, 6)
      alpha = parseInt(hex.slice(6, 8), 16) / 255
    }
  }

  return { x, y, blur, color, alpha: Math.max(0, Math.min(1, alpha)) }
}

function formatShadow({ x, y, blur, color, alpha }: ShadowParts): string {
  const m = color.match(/^#?([0-9a-f]{6})$/i)
  const r = m ? parseInt(m[1].slice(0, 2), 16) : 0
  const g = m ? parseInt(m[1].slice(2, 4), 16) : 0
  const b = m ? parseInt(m[1].slice(4, 6), 16) : 0
  const a = Math.max(0, Math.min(1, alpha)).toFixed(2)
  return `${Math.round(x)}px ${Math.round(y)}px ${Math.round(blur)}px rgba(${r}, ${g}, ${b}, ${a})`
}

/** Splits a CSS list on commas that aren't inside parentheses. */
function splitTopLevelComma(input: string): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  for (const ch of input) {
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    if (ch === ',' && depth === 0) {
      out.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  if (current.trim()) out.push(current.trim())
  return out
}

// ─── Style Presets ────────────────────────────────────────────────────────────

/**
 * Caption style presets.
 *
 * Each preset provides a complete CaptionStyle override. Applying a preset
 * replaces the entire global captionStyle (no merging). This prevents
 * unexpected combinations from previous custom edits.
 *
 * Future work: Allow "favourite" presets saved per-user in their profile.
 */
interface CaptionPreset {
  id: string
  label: string
  style: CaptionStyle
}

const CAPTION_PRESETS: CaptionPreset[] = [
  {
    id: 'background',
    label: 'Background',
    style: {
      fontFamily: 'Inter',
      fontSize: 'L',
      color: '#FFFFFF',
      outlineColor: '#000000',
      outlineWidth: 0,
      position: 'bottom',
      yOffset: 0,
      xOffset: 0,
      animationIn: 'fade-in',
      animationOut: 'none',
      wordHighlight: false,
      wordHighlightColor: '#FFFFFF',
      dropShadow: '',
      backgroundColor: 'rgba(90,90,90,0.95)',
    },
  },
  {
    id: 'comic',
    label: 'Comic',
    // Bangers is a heavy italic comic font — yellow fill, thick black outline,
    // and a hard offset drop-shadow give it the classic "POW!" panel look.
    style: {
      fontFamily: 'Bangers',
      fontSize: 'XL',
      color: '#FFE600',
      outlineColor: '#000000',
      outlineWidth: 7,
      position: 'bottom',
      yOffset: 0,
      xOffset: 0,
      animationIn: 'pop-in',
      animationOut: 'none',
      wordHighlight: true,
      wordHighlightColor: '#FF3D00',
      dropShadow: '8px 8px 0 rgba(0,0,0,1)',
      backgroundColor: '',
    },
  },
  {
    id: 'glow',
    label: 'Glow',
    // Inter SemiBold/Bold reads as a clean modern sans; soft blue glow gives it
    // a subtle premium feel without overwhelming the type.
    style: {
      fontFamily: 'Inter',
      fontSize: 'L',
      color: '#FFFFFF',
      outlineColor: '#FFFFFF',
      outlineWidth: 0,
      position: 'bottom',
      yOffset: 0,
      xOffset: 0,
      animationIn: 'fade-in',
      animationOut: 'none',
      wordHighlight: true,
      wordHighlightColor: '#A5D8FF',
      dropShadow: '0 0 22px rgba(150,200,255,0.95), 0 0 44px rgba(150,200,255,0.55)',
      backgroundColor: '',
    },
  },
  {
    id: 'neon-pink',
    label: 'Neon',
    // Luckiest Guy is naturally chunky and casual — perfect canvas for a
    // saturated pink with magenta glow. No outline; the glow does the lifting.
    style: {
      fontFamily: 'Luckiest Guy',
      fontSize: 'L',
      color: '#FF45D3',
      outlineColor: '#FF45D3',
      outlineWidth: 0,
      position: 'bottom',
      yOffset: 0,
      xOffset: 0,
      animationIn: 'slide-up',
      animationOut: 'none',
      wordHighlight: true,
      wordHighlightColor: '#FFFFFF',
      dropShadow: '0 0 18px rgba(255,69,211,0.95), 0 0 36px rgba(255,69,211,0.65)',
      backgroundColor: '',
    },
  },
  {
    id: 'outline',
    label: 'Outline',
    // Fredoka is a heavy rounded sans — pairs beautifully with a thick black
    // outline for the friendly "sticker" style.
    style: {
      fontFamily: 'Fredoka',
      fontSize: 'L',
      color: '#FFFFFF',
      outlineColor: '#000000',
      outlineWidth: 6,
      position: 'bottom',
      yOffset: 0,
      xOffset: 0,
      animationIn: 'pop-in',
      animationOut: 'none',
      wordHighlight: false,
      wordHighlightColor: '#FFD700',
      dropShadow: '',
      backgroundColor: '',
    },
  },
]

/** Sentinel for the "Custom" tile — opens the fine-grained controls instead of applying a preset. */
const CUSTOM_PRESET_ID = '__custom__'

// ─── Helper: Available Options ───────────────────────────────────────────────

const FONT_FAMILIES = [
  'Inter',
  'Montserrat',
  'Bangers',
  'Luckiest Guy',
  'Fredoka',
  'Anton',
  'Bebas Neue',
  'Impact',
  'Oswald',
  'Roboto',
  'Arial',
  'Georgia',
] as const
const FONT_SIZES: CaptionFontSize[] = ['S', 'M', 'L', 'XL']
const POSITIONS: CaptionPosition[] = ['top', 'center', 'bottom']
const ANIMATIONS: CaptionAnimation[] = [
  'none', 'pop-in', 'fade-in', 'slide-up', 'slide-down', 'slide-left', 'slide-right',
]

// ─── Sub-Components ──────────────────────────────────────────────────────────

// ─── Color Swatch Popover ────────────────────────────────────────────────────

/**
 * Curated colour presets surfaced inside the swatch popover. Chosen to cover
 * the most common caption colour vocabularies (high-contrast monochrome,
 * vibrant accents, and a couple of viral-Shorts staples) without
 * overwhelming the user with a full picker.
 */
const COLOR_PRESETS = [
  '#FFFFFF', '#000000', '#FFE600', '#FFD700',
  '#FF3D00', '#FF45D3', '#A5D8FF', '#B5FF00',
] as const

/**
 * Single swatch button that opens a Popover with preset chips, a hex input,
 * and a native picker. Wraps the previous tiny `<input type="color">` style
 * with something normies can navigate without having to know hex codes.
 *
 * @param value - Current colour as a `#RRGGBB` string.
 * @param onChange - Called with the new colour on any user action.
 * @param ariaLabel - Accessible label for the trigger button.
 */
interface ColorSwatchPopoverProps {
  value: string
  onChange: (color: string) => void
  ariaLabel?: string
}

function ColorSwatchPopover({ value, onChange, ariaLabel }: ColorSwatchPopoverProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel ?? 'Pick colour'}
          className="w-7 h-6 rounded border border-border cursor-pointer"
          style={{ backgroundColor: value }}
        />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-2">
        <div className="grid grid-cols-4 gap-1.5 mb-2">
          {COLOR_PRESETS.map((c) => {
            const active = c.toLowerCase() === value.toLowerCase()
            return (
              <button
                key={c}
                type="button"
                onClick={() => onChange(c)}
                className={`
                  h-7 w-full rounded border transition-colors
                  ${active ? 'border-primary ring-2 ring-primary/40' : 'border-border hover:border-foreground/40'}
                `}
                style={{ backgroundColor: c }}
                aria-label={c}
              />
            )
          })}
        </div>
        <div className="flex items-center gap-1.5">
          <input
            type="color"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="w-7 h-7 rounded border border-border bg-transparent cursor-pointer shrink-0"
            aria-label="Custom colour"
          />
          <input
            type="text"
            value={value}
            onChange={(e) => {
              const v = e.target.value.trim()
              // Only commit when we have a valid hex — otherwise keystrokes
              // mid-edit would propagate junk to the renderer.
              if (/^#[0-9a-f]{6}$/i.test(v)) onChange(v)
            }}
            className="flex-1 bg-muted rounded px-2 py-1 text-[10px] font-mono text-foreground border border-border focus:outline-none focus:border-primary"
            aria-label="Hex value"
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** Section heading with divider — matches the InspectorPanel style. */
function SectionHeader({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 mb-2 mt-3">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <div className="flex-1 h-px bg-border" />
    </div>
  )
}

/** Compact row with a label on the left. */
function ControlRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 mb-2">
      <label className="text-[10px] text-muted-foreground w-14 shrink-0">{label}</label>
      {children}
    </div>
  )
}

// ─── Style Section Header ─────────────────────────────────────────────────────

/**
 * Section header for the Style block that doubles as the edit-target indicator.
 * Matches the visual rhythm of other SectionHeader instances (Font, Color, …)
 * but reserves the right-hand side for a mode tag so the user always knows
 * what their next click will affect:
 *   - No caption selection → "Default" tag. Style edits update the global
 *     default that new captions inherit.
 *   - With selection → "N selected · Reset" link. Style edits write per-clip
 *     overrides; "Reset" drops them so the captions inherit the global again.
 *
 * Replaces an earlier bordered banner that ate vertical space and visually
 * competed with the generate/add controls above it.
 */
interface StyleSectionHeaderProps {
  selectionCount: number
  onResetToGlobal: () => void
}

function StyleSectionHeader({ selectionCount, onResetToGlobal }: StyleSectionHeaderProps) {
  const isSelectionMode = selectionCount > 0

  return (
    <div className="flex items-center gap-2 mb-2 mt-3">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        Style
      </span>
      <div className="flex-1 h-px bg-border" />
      {isSelectionMode ? (
        <span
          className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground"
          title="Style edits apply to the selected captions as per-clip overrides."
        >
          <span className="font-medium text-foreground">
            {selectionCount} selected
          </span>
          <span aria-hidden className="text-border">·</span>
          <button
            onClick={onResetToGlobal}
            className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
            title="Drop per-clip overrides so these captions inherit the global default."
          >
            <RotateCcw size={10} aria-hidden />
            Reset
          </button>
        </span>
      ) : (
        <span
          className="text-[10px] text-muted-foreground/80"
          title="Style edits update the default that new captions inherit. Select captions in the timeline to restyle them individually."
        >
          Default
        </span>
      )}
    </div>
  )
}

// ─── Preset Picker ────────────────────────────────────────────────────────────

/**
 * PresetPicker — 4-button row for quick caption style presets.
 *
 * Each button applies a complete CaptionStyle via `setCaptionStyle`.
 * The active preset is highlighted when the current store style matches a
 * preset's configuration exactly.
 *
 * Design note: preset matching uses a shallow comparison of key style
 * properties rather than deep equality to avoid false negatives from
 * floating-point or whitespace differences in CSS values.
 */
interface PresetPickerProps {
  currentStyle: CaptionStyle
  onApplyPreset: (style: CaptionStyle) => void
  customActive: boolean
  onSelectCustom: () => void
}

/**
 * Maps a CaptionFontSize preset to the pixel size used at composition time.
 * Mirrors FONT_SIZE_MAP in ShortComposition.tsx — duplicated here so we can
 * compute the thumbnail's scale ratio (thumbFont / renderFont).
 */
const RENDER_FONT_SIZE: Record<string, number> = { S: 36, M: 48, L: 64, XL: 80 }
const THUMB_FONT_SIZE = 16

/**
 * Scale every `Npx` value inside a CSS shadow string by `scale`. We keep at
 * least 0.5px so soft glows don't collapse to zero. Non-pixel tokens (colors,
 * keywords, `0` without a unit) are passed through unchanged.
 *
 * Example: `scaleShadow('6px 6px 0 #000', 0.25)` → `1.5px 1.5px 0 #000`.
 */
function scaleShadow(shadow: string, scale: number): string {
  if (!shadow) return ''
  return shadow.replace(/(-?\d+(?:\.\d+)?)px/g, (_, num) => {
    const scaled = parseFloat(num) * scale
    const sign = scaled < 0 ? -1 : 1
    const abs = Math.max(0.5, Math.abs(scaled))
    return `${(sign * abs).toFixed(2).replace(/\.?0+$/, '')}px`
  })
}

/**
 * Renders a small "Hey there!" sample styled like the preset so the user
 * sees the look at a glance.
 *
 * Critical: the preset's stroke (outlineWidth) and dropShadow are sized for
 * the 64–80px composition font. Rendered at 16px they overwhelm the text and
 * produce a double-stamped look. We rescale both by the thumb/render ratio so
 * each tile reads cleanly.
 */
function PresetThumbnail({ style }: { style: CaptionStyle }) {
  const renderFontSize = RENDER_FONT_SIZE[style.fontSize] ?? 64
  const scale = THUMB_FONT_SIZE / renderFontSize

  // Thumbnail-sized stroke: never thicker than ~1.6px, otherwise it stamps over the glyphs.
  const thumbOutlineWidth = Math.min(1.6, Math.max(0, style.outlineWidth * scale))

  const stroke =
    thumbOutlineWidth > 0
      ? [
          [1, 0], [-1, 0], [0, 1], [0, -1],
          [1, 1], [-1, -1], [1, -1], [-1, 1],
        ]
          .map(([x, y]) => `${x * thumbOutlineWidth}px ${y * thumbOutlineWidth}px 0 ${style.outlineColor}`)
          .join(', ')
      : ''

  const scaledDropShadow = scaleShadow(style.dropShadow, scale)
  const textShadow = [scaledDropShadow, stroke].filter(Boolean).join(', ')

  // Display-family fonts (Bangers, Luckiest Guy) already carry their own weight,
  // and forcing `font-weight: 700` on top can trigger a "faux-bold" synthetic
  // stroke in some browsers that thickens the glyphs unevenly. Skip the
  // override for these — let the font's natural weight do the work.
  const isDisplayFamily = ['Bangers', 'Luckiest Guy', 'Anton', 'Bebas Neue', 'Impact']
    .includes(style.fontFamily)

  // Mixed-case looks more natural in Bangers/Luckiest Guy than ALL CAPS at
  // thumbnail size; the actual render keeps user text as-is.
  const sample = 'Hey there!'

  return (
    <div
      className="flex items-center justify-center w-full h-full px-3 py-2"
      style={{ backgroundColor: 'transparent' }}
    >
      <span
        style={{
          fontFamily: style.fontFamily,
          color: style.color,
          fontWeight: isDisplayFamily ? 400 : 800,
          fontSize: THUMB_FONT_SIZE,
          lineHeight: 1.05,
          textAlign: 'center',
          textShadow: textShadow || undefined,
          backgroundColor: style.backgroundColor || undefined,
          padding: style.backgroundColor ? '4px 10px' : 0,
          borderRadius: style.backgroundColor ? 6 : 0,
          letterSpacing: isDisplayFamily ? 0.5 : 0.2,
          // Allow wrapping so multi-word samples stack like the mockup tiles.
          whiteSpace: 'normal',
          wordBreak: 'normal',
          maxWidth: '100%',
        }}
      >
        {sample}
      </span>
    </div>
  )
}

function PresetPicker({
  currentStyle,
  onApplyPreset,
  customActive,
  onSelectCustom,
}: PresetPickerProps) {
  /**
   * A preset is considered "active" if its core style fingerprint matches
   * the current style. We hash on the visually distinctive properties so a
   * tiny tweak doesn't deselect the preset, but a clear divergence does.
   */
  function isPresetActive(preset: CaptionPreset): boolean {
    const s = preset.style
    return (
      s.fontFamily === currentStyle.fontFamily &&
      s.color === currentStyle.color &&
      s.outlineWidth === currentStyle.outlineWidth &&
      (s.backgroundColor || '') === (currentStyle.backgroundColor || '') &&
      (s.dropShadow || '') === (currentStyle.dropShadow || '')
    )
  }

  return (
    <div className="grid grid-cols-3 gap-2">
      {CAPTION_PRESETS.map((preset) => {
        const active = isPresetActive(preset)
        return (
          <button
            key={preset.id}
            onClick={() => onApplyPreset(preset.style)}
            className={`
              group flex flex-col gap-1 items-center transition-transform
              active:scale-[0.97]
            `}
            title={`Apply "${preset.label}" preset`}
          >
            <div
              className={`
                relative w-full aspect-[4/3] rounded-lg overflow-hidden
                flex items-center justify-center
                bg-gradient-to-br from-muted to-muted/60
                border transition-colors
                ${active
                  ? 'border-primary ring-2 ring-primary/40'
                  : 'border-border group-hover:border-border/80'
                }
              `}
            >
              <PresetThumbnail style={preset.style} />
            </div>
            <span
              className={`text-[10px] leading-tight ${
                active ? 'text-foreground font-medium' : 'text-muted-foreground'
              }`}
            >
              {preset.label}
            </span>
          </button>
        )
      })}

      {/* ── Custom tile — opens the fine-grained controls. ── */}
      <button
        key={CUSTOM_PRESET_ID}
        onClick={onSelectCustom}
        className="group flex flex-col gap-1 items-center transition-transform active:scale-[0.97]"
        title="Customize all caption style properties"
      >
        <div
          className={`
            relative w-full aspect-[4/3] rounded-lg overflow-hidden
            flex items-center justify-center
            bg-gradient-to-br from-foreground/5 to-foreground/10
            border transition-colors
            ${customActive
              ? 'border-primary ring-2 ring-primary/40'
              : 'border-border group-hover:border-border/80'
            }
          `}
        >
          <div className="rounded-full bg-background border border-border w-8 h-8 flex items-center justify-center">
            <SlidersHorizontal size={14} className="text-foreground" />
          </div>
        </div>
        <span
          className={`text-[10px] leading-tight ${
            customActive ? 'text-foreground font-medium' : 'text-muted-foreground'
          }`}
        >
          Custom
        </span>
      </button>
    </div>
  )
}

// ─── TransitionPicker ─────────────────────────────────────────────────────────

/**
 * TransitionPicker — top-level section for caption enter/exit animation.
 *
 * Lives in its own section parallel to Style so picking a visual preset
 * (Comic, Neon, …) never silently changes how captions enter or exit. The
 * primary row exposes the 5 common presets as buttons; an Advanced disclosure
 * still lets power users pick `in` and `out` independently.
 */
interface TransitionPickerProps {
  style: CaptionStyle
  onStyleChange: (update: Partial<CaptionStyle>) => void
}

function TransitionPicker({ style, onStyleChange }: TransitionPickerProps) {
  const currentId = matchTransitionPreset(style.animationIn, style.animationOut)
  const [advancedOpen, setAdvancedOpen] = useState(currentId === TRANSITION_CUSTOM_TOKEN)

  return (
    <div>
      <div className="grid grid-cols-5 gap-1.5 mb-2">
        {TRANSITION_PRESETS.map((preset) => {
          const active = currentId === preset.id
          return (
            <button
              key={preset.id}
              type="button"
              onClick={() => onStyleChange({ animationIn: preset.in, animationOut: preset.out })}
              className={`
                px-1 py-1.5 rounded border text-[10px] font-medium transition-colors
                ${active
                  ? 'border-primary bg-primary/10 text-foreground ring-1 ring-primary/40'
                  : 'border-border bg-muted/40 text-muted-foreground hover:text-foreground hover:border-border/80'
                }
              `}
              title={`Apply "${preset.label}" transition`}
            >
              {preset.label}
            </button>
          )
        })}
      </div>

      <button
        type="button"
        onClick={() => setAdvancedOpen((v) => !v)}
        className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors mb-1.5"
      >
        {advancedOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        Advanced
      </button>

      {advancedOpen && (
        <>
          <ControlRow label="In">
            <select
              value={style.animationIn}
              onChange={(e) => onStyleChange({ animationIn: e.target.value as CaptionAnimation })}
              className="flex-1 bg-muted rounded px-2 py-0.5 text-[10px] text-foreground border border-border focus:outline-none focus:border-primary"
            >
              {ANIMATIONS.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </ControlRow>

          <ControlRow label="Out">
            <select
              value={style.animationOut}
              onChange={(e) => onStyleChange({ animationOut: e.target.value as CaptionAnimation })}
              className="flex-1 bg-muted rounded px-2 py-0.5 text-[10px] text-foreground border border-border focus:outline-none focus:border-primary"
            >
              {ANIMATIONS.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </ControlRow>
        </>
      )}
    </div>
  )
}

// ─── CaptionStyleControls ─────────────────────────────────────────────────────

/**
 * CaptionStyleControls — fine-grained controls for all CaptionStyle properties.
 *
 * Renders controls for:
 *   - Font family (select)
 *   - Font size (S/M/L/XL button group)
 *   - Text color (native color input)
 *   - Outline color and width (color input + range slider)
 *   - Position anchor (top/center/bottom button group)
 *   - Y offset (number input)
 *   - Animation in/out (selects)
 *   - Word highlight toggle and color
 *   - Drop shadow (text input for CSS value)
 *   - Background color (color + opacity)
 *
 * Each control calls `onStyleChange` with the partial update, which is
 * then merged via `setCaptionStyle` in the Zustand store.
 *
 * @see CaptionStyle in types.ts for the full property list
 */
interface CaptionStyleControlsProps {
  style: CaptionStyle
  onStyleChange: (update: Partial<CaptionStyle>) => void
}

function CaptionStyleControls({ style, onStyleChange }: CaptionStyleControlsProps) {
  const [fineTuneOpen, setFineTuneOpen] = useState(false)
  const shadowPresetId = matchShadowPreset(style.dropShadow)
  const bg = parseBackground(style.backgroundColor)
  // Click-based shadow editor surfaces sliders for X / Y / blur / color when
  // the user picks "Custom" (or already has a non-preset value). It only
  // exposes the first shadow layer — multi-layer presets (Glow, Neon) live
  // in the top-level preset cards and aren't user-editable here.
  const shadowParts = parseShadow(style.dropShadow) ?? DEFAULT_SHADOW_PARTS
  const writeShadow = (next: Partial<ShadowParts>) =>
    onStyleChange({ dropShadow: formatShadow({ ...shadowParts, ...next }) })
  return (
    <div>
      {/* ── Font ── */}
      <SectionHeader label="Font" />

      <ControlRow label="Family">
        <select
          value={style.fontFamily}
          onChange={(e) => onStyleChange({ fontFamily: e.target.value })}
          className="flex-1 bg-muted rounded px-2 py-0.5 text-[10px] text-foreground border border-border focus:outline-none focus:border-primary"
        >
          {FONT_FAMILIES.map((f) => (
            <option key={f} value={f}>{f}</option>
          ))}
        </select>
      </ControlRow>

      <ControlRow label="Size">
        <ToggleGroup
          type="single"
          value={style.fontSizePx !== undefined ? CUSTOM_SIZE_TOKEN : style.fontSize}
          onValueChange={(val) => {
            if (!val) return
            if (val === CUSTOM_SIZE_TOKEN) {
              // Seed Custom mode with the px value of whatever preset is active,
              // so the slider doesn't jump on the first interaction.
              onStyleChange({ fontSizePx: FONT_SIZE_PX[style.fontSize] ?? 64 })
            } else {
              onStyleChange({ fontSize: val as CaptionFontSize, fontSizePx: undefined })
            }
          }}
          size="sm"
          variant="outline"
          className="flex-1 grid grid-cols-5"
        >
          {FONT_SIZES.map((size) => (
            <ToggleGroupItem key={size} value={size} className="text-[10px] font-medium">
              {size}
            </ToggleGroupItem>
          ))}
          <ToggleGroupItem value={CUSTOM_SIZE_TOKEN} className="text-[10px] font-medium">
            Custom
          </ToggleGroupItem>
        </ToggleGroup>
      </ControlRow>

      {style.fontSizePx !== undefined && (
        <ControlRow label="">
          <Slider
            min={CUSTOM_SIZE_MIN}
            max={CUSTOM_SIZE_MAX}
            step={CUSTOM_SIZE_STEP}
            value={[style.fontSizePx]}
            onValueChange={([v]) => onStyleChange({ fontSizePx: Math.round(v) })}
            className="flex-1"
          />
          <span className="text-[10px] tabular-nums text-muted-foreground w-10 text-right shrink-0">
            {Math.round(style.fontSizePx)}px
          </span>
        </ControlRow>
      )}

      <ControlRow label="Weight">
        <ToggleGroup
          type="single"
          value={String(matchWeightStep(style.fontWeight ?? 700))}
          onValueChange={(val) => {
            if (!val) return
            onStyleChange({ fontWeight: Number(val) })
          }}
          size="sm"
          variant="outline"
          className="flex-1 grid grid-cols-4"
        >
          {WEIGHT_STEPS.map((step) => (
            <ToggleGroupItem
              key={step.value}
              value={String(step.value)}
              className="text-[10px] font-medium"
              title={`Set font weight to ${step.label} (${step.value})`}
            >
              {step.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </ControlRow>

      <ControlRow label="Style">
        <button
          type="button"
          onClick={() =>
            onStyleChange({
              fontStyle: (style.fontStyle ?? 'normal') === 'italic' ? 'normal' : 'italic',
            })
          }
          className={`
            inline-flex items-center justify-center h-7 w-9 rounded border text-[12px] font-serif italic transition-colors
            ${(style.fontStyle ?? 'normal') === 'italic'
              ? 'bg-primary/20 text-primary border-primary/40 ring-1 ring-primary/40'
              : 'bg-muted/40 text-muted-foreground border-border hover:text-foreground hover:border-border/80'
            }
          `}
          title="Italic"
          aria-pressed={(style.fontStyle ?? 'normal') === 'italic'}
        >
          I
        </button>
        <ToggleGroup
          type="single"
          value={style.textTransform ?? 'none'}
          onValueChange={(val) => {
            if (!val) return
            onStyleChange({ textTransform: val as CaptionStyle['textTransform'] })
          }}
          size="sm"
          variant="outline"
          className="flex-1 grid grid-cols-4"
        >
          {CASE_STEPS.map((step) => (
            <ToggleGroupItem
              key={step.value}
              value={step.value}
              className="text-[10px] font-medium"
              title={step.title}
            >
              {step.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </ControlRow>

      {/* ── Spacing ── */}
      <SectionHeader label="Spacing" />

      <ControlRow label="Line">
        <Slider
          min={0.8}
          max={2.5}
          step={0.05}
          value={[style.lineHeight ?? 1.3]}
          onValueChange={([v]) => onStyleChange({ lineHeight: Math.round(v * 100) / 100 })}
          className="flex-1"
          aria-label="Line height"
        />
        <span className="text-[10px] tabular-nums text-muted-foreground w-10 text-right shrink-0">
          {(style.lineHeight ?? 1.3).toFixed(2)}
        </span>
      </ControlRow>

      <ControlRow label="Kerning">
        <Slider
          min={-5}
          max={20}
          step={0.5}
          value={[style.letterSpacing ?? 0]}
          onValueChange={([v]) => onStyleChange({ letterSpacing: Math.round(v * 2) / 2 })}
          className="flex-1"
          aria-label="Letter spacing"
        />
        <span className="text-[10px] tabular-nums text-muted-foreground w-10 text-right shrink-0">
          {(style.letterSpacing ?? 0).toFixed(1)}px
        </span>
      </ControlRow>

      {/* ── Color ── */}
      <SectionHeader label="Color" />

      <ControlRow label="Text">
        <div className="flex items-center gap-1.5 flex-1">
          <ColorSwatchPopover
            value={style.color}
            onChange={(c) => onStyleChange({ color: c })}
            ariaLabel="Text colour"
          />
          <span className="text-[10px] text-muted-foreground font-mono flex-1 truncate">
            {style.color}
          </span>
        </div>
      </ControlRow>

      <ControlRow label="Outline">
        <div className="flex items-center gap-1.5 flex-1">
          <ColorSwatchPopover
            value={style.outlineColor}
            onChange={(c) => onStyleChange({ outlineColor: c })}
            ariaLabel="Outline colour"
          />
          <span className="text-[10px] text-muted-foreground font-mono flex-1 truncate">
            {style.outlineColor}
          </span>
        </div>
      </ControlRow>

      <ControlRow label="Weight">
        <ToggleGroup
          type="single"
          value={String(matchOutlineStep(style.outlineWidth))}
          onValueChange={(val) => {
            if (!val) return
            onStyleChange({ outlineWidth: Number(val) })
          }}
          size="sm"
          variant="outline"
          className="flex-1 grid grid-cols-4"
        >
          {OUTLINE_STEPS.map((step) => (
            <ToggleGroupItem
              key={step.value}
              value={String(step.value)}
              className="text-[10px] font-medium"
            >
              {step.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </ControlRow>

      {/* ── Position ── */}
      <SectionHeader label="Position" />

      <ControlRow label="Anchor">
        <ToggleGroup
          type="single"
          value={style.position}
          onValueChange={(val) => {
            if (!val) return
            // Picking an anchor should snap the caption to that anchor — not
            // just shift it relative to the current free-drag offsets. Clear
            // X/Y so the user's intent ("put it at the top") is honoured.
            onStyleChange({ position: val as CaptionPosition, xOffset: 0, yOffset: 0 })
          }}
          size="sm"
          variant="outline"
          className="flex-1 grid grid-cols-3"
        >
          {POSITIONS.map((pos) => (
            <ToggleGroupItem key={pos} value={pos} className="text-[10px] capitalize">
              {pos}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </ControlRow>

      {/* Fine-tune disclosure — drag the caption on the canvas for normal use;
          the px inputs are here only for power users who want exact placement. */}
      <button
        type="button"
        onClick={() => setFineTuneOpen((v) => !v)}
        className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors mb-1.5"
      >
        {fineTuneOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        Fine-tune
      </button>

      {fineTuneOpen && (
        <>
          <ControlRow label="Nudge X">
            <input
              type="number"
              value={Math.round(style.xOffset ?? 0)}
              min={-540}
              max={540}
              step={10}
              onChange={(e) => onStyleChange({ xOffset: Number(e.target.value) })}
              className="flex-1 bg-muted rounded px-2 py-0.5 text-[10px] tabular-nums text-foreground border border-border focus:outline-none focus:border-primary"
            />
            <span className="text-[10px] text-muted-foreground w-4 shrink-0">px</span>
          </ControlRow>

          <ControlRow label="Nudge Y">
            <input
              type="number"
              value={Math.round(style.yOffset)}
              min={-960}
              max={960}
              step={10}
              onChange={(e) => onStyleChange({ yOffset: Number(e.target.value) })}
              className="flex-1 bg-muted rounded px-2 py-0.5 text-[10px] tabular-nums text-foreground border border-border focus:outline-none focus:border-primary"
            />
            <span className="text-[10px] text-muted-foreground w-4 shrink-0">px</span>
          </ControlRow>
        </>
      )}

      {/* ── Effects ── */}
      <SectionHeader label="Effects" />

      {/* Word highlight */}
      <div className="flex items-center gap-2 mb-2">
        <label className="text-[10px] text-muted-foreground w-14 shrink-0">Highlight</label>
        <button
          onClick={() => onStyleChange({ wordHighlight: !style.wordHighlight })}
          className={`
            flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] transition-colors
            ${style.wordHighlight
              ? 'bg-primary/20 text-primary border border-primary/40'
              : 'bg-muted text-muted-foreground border border-border'
            }
          `}
          title="Toggle karaoke-style word highlighting"
        >
          <span
            className={`w-2 h-2 rounded-full ${style.wordHighlight ? 'bg-primary' : 'bg-muted-foreground/40'}`}
            aria-hidden
          />
          {style.wordHighlight ? 'On' : 'Off'}
        </button>
        {style.wordHighlight && (
          <ColorSwatchPopover
            value={style.wordHighlightColor}
            onChange={(c) => onStyleChange({ wordHighlightColor: c })}
            ariaLabel="Highlight colour"
          />
        )}
      </div>

      {/* Shadow — visual presets up top; "Custom" reveals click-based sliders. */}
      <ControlRow label="Shadow">
        <ToggleGroup
          type="single"
          value={shadowPresetId}
          onValueChange={(val) => {
            if (!val) return
            if (val === SHADOW_CUSTOM_TOKEN) {
              // Switching to Custom seeds with a sensible single-layer shadow
              // so the user sees an immediate effect they can dial in.
              onStyleChange({ dropShadow: formatShadow(DEFAULT_SHADOW_PARTS) })
              return
            }
            const preset = SHADOW_PRESETS.find((p) => p.id === val)
            if (!preset) return
            onStyleChange({ dropShadow: preset.value })
          }}
          size="sm"
          variant="outline"
          className="flex-1 grid grid-cols-4"
        >
          {SHADOW_PRESETS.map((preset) => (
            <ToggleGroupItem key={preset.id} value={preset.id} className="text-[10px] font-medium">
              {preset.label}
            </ToggleGroupItem>
          ))}
          <ToggleGroupItem value={SHADOW_CUSTOM_TOKEN} className="text-[10px] font-medium">
            Custom
          </ToggleGroupItem>
        </ToggleGroup>
      </ControlRow>

      {shadowPresetId === SHADOW_CUSTOM_TOKEN && (
        <div className="rounded-md border border-border bg-muted/30 p-2 mb-2 space-y-1.5">
          <ControlRow label="Offset X">
            <Slider
              min={-20}
              max={20}
              step={1}
              value={[shadowParts.x]}
              onValueChange={([v]) => writeShadow({ x: v })}
              className="flex-1"
              aria-label="Shadow horizontal offset"
            />
            <span className="text-[10px] tabular-nums text-muted-foreground w-8 text-right shrink-0">
              {Math.round(shadowParts.x)}px
            </span>
          </ControlRow>
          <ControlRow label="Offset Y">
            <Slider
              min={-20}
              max={20}
              step={1}
              value={[shadowParts.y]}
              onValueChange={([v]) => writeShadow({ y: v })}
              className="flex-1"
              aria-label="Shadow vertical offset"
            />
            <span className="text-[10px] tabular-nums text-muted-foreground w-8 text-right shrink-0">
              {Math.round(shadowParts.y)}px
            </span>
          </ControlRow>
          <ControlRow label="Blur">
            <Slider
              min={0}
              max={40}
              step={1}
              value={[shadowParts.blur]}
              onValueChange={([v]) => writeShadow({ blur: v })}
              className="flex-1"
              aria-label="Shadow blur"
            />
            <span className="text-[10px] tabular-nums text-muted-foreground w-8 text-right shrink-0">
              {Math.round(shadowParts.blur)}px
            </span>
          </ControlRow>
          <ControlRow label="Color">
            <ColorSwatchPopover
              value={shadowParts.color}
              onChange={(c) => writeShadow({ color: c })}
              ariaLabel="Shadow colour"
            />
            <Slider
              min={0}
              max={1}
              step={0.05}
              value={[shadowParts.alpha]}
              onValueChange={([a]) => writeShadow({ alpha: a })}
              className="flex-1"
              aria-label="Shadow opacity"
            />
            <span className="text-[10px] tabular-nums text-muted-foreground w-8 text-right shrink-0">
              {Math.round(shadowParts.alpha * 100)}%
            </span>
          </ControlRow>
        </div>
      )}

      {/* Background as switch + swatch + opacity slider. */}
      <div className="flex items-center gap-2 mb-2">
        <label className="text-[10px] text-muted-foreground w-14 shrink-0">BG</label>
        <button
          type="button"
          onClick={() => {
            if (bg.on) {
              onStyleChange({ backgroundColor: '' })
            } else {
              onStyleChange({ backgroundColor: formatBackground(bg.color, bg.alpha) })
            }
          }}
          className={`
            flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] transition-colors
            ${bg.on
              ? 'bg-primary/20 text-primary border border-primary/40'
              : 'bg-muted text-muted-foreground border border-border'
            }
          `}
          title="Toggle background box"
        >
          <span
            className={`w-2 h-2 rounded-full ${bg.on ? 'bg-primary' : 'bg-muted-foreground/40'}`}
            aria-hidden
          />
          {bg.on ? 'On' : 'Off'}
        </button>
        {bg.on && (
          <>
            <ColorSwatchPopover
              value={bg.color}
              onChange={(c) => onStyleChange({ backgroundColor: formatBackground(c, bg.alpha) })}
              ariaLabel="Background colour"
            />
            <Slider
              min={0}
              max={1}
              step={0.05}
              value={[bg.alpha]}
              onValueChange={([a]) => onStyleChange({ backgroundColor: formatBackground(bg.color, a) })}
              className="flex-1"
              aria-label="Background opacity"
            />
            <span className="text-[10px] tabular-nums text-muted-foreground w-8 text-right shrink-0">
              {Math.round(bg.alpha * 100)}%
            </span>
          </>
        )}
      </div>

    </div>
  )
}

// ─── CaptionStylePanel Component ──────────────────────────────────────────────

/**
 * CaptionStylePanel — the main caption configuration panel.
 *
 * Renders the full caption UI: generate button, presets, and style controls.
 * Reads `captionStyle` from the Zustand store and dispatches `setCaptionStyle`
 * for all changes.
 *
 * Used in two contexts:
 *   1. Desktop: shown in the MobileBottomSheet's Captions tab on mobile,
 *      and as a free-standing panel accessible from the editor toolbar.
 *   2. InspectorPanel: the `CaptionClipSection` renders a subset of these
 *      controls for per-clip style overrides when a caption clip is selected.
 *
 * Caption *creation* (Generate / Add) lives in {@link CaptionGeneratorPanel};
 * compose both panels in the captions tab when both surfaces are needed.
 */
export interface CaptionStylePanelProps {
  /**
   * When true, the panel renders without the outer card border and padding,
   * suitable for embedding inside InspectorPanel or another panel.
   * Default: false (renders as a standalone scrollable panel).
   */
  inline?: boolean
}

export function CaptionStylePanel({ inline = false }: CaptionStylePanelProps = {}) {
  // ── Store ──

  const globalCaptionStyle = useEditorStore((s) => s.captionStyle)
  const setCaptionStyle = useEditorStore((s) => s.setCaptionStyle)
  const selectedClipIds = useSelectionStore((s) => s.selectedClipIds)
  const tracks = useEditorStore((s) => s.tracks)
  const updateClipCaptionStyle = useEditorStore((s) => s.updateClipCaptionStyle)
  const clearClipCaptionStyle = useEditorStore((s) => s.clearClipCaptionStyle)
  const beginHistoryTransaction = useEditorStore((s) => s.beginHistoryTransaction)
  const commitHistoryTransaction = useEditorStore((s) => s.commitHistoryTransaction)
  const styleTransactionTimerRef = useRef<number | null>(null)
  const styleTransactionActiveRef = useRef(false)

  // ── Resolve target: selected caption clips, or fall back to the global default. ──
  //
  // Every caption clip on every caption track is in scope; we filter the
  // current selection down to caption-track clips so selecting a video clip
  // doesn't accidentally switch the panel into "per-clip" mode.
  const selectedCaptionClips = useMemo<Clip[]>(() => {
    if (selectedClipIds.length === 0) return []
    const idSet = new Set(selectedClipIds)
    const out: Clip[] = []
    for (const track of tracks) {
      if (track.type !== 'caption') continue
      for (const clip of track.clips) {
        if (idSet.has(clip.id)) out.push(clip)
      }
    }
    return out
  }, [selectedClipIds, tracks])

  const hasSelection = selectedCaptionClips.length > 0

  // The style displayed in the picker:
  //   - If a single caption is selected: its effective style (override or global).
  //   - If multiple are selected: the first one's effective style (controls still
  //     write to all selected clips on change).
  //   - Otherwise: the global default.
  const displayedStyle: CaptionStyle = hasSelection
    ? (selectedCaptionClips[0].captionStyle ?? globalCaptionStyle ?? DEFAULT_CAPTION_STYLE)
    : globalCaptionStyle

  // ── Custom drawer state ──

  const matchesAnyPreset = CAPTION_PRESETS.some(
    (p) =>
      p.style.fontFamily === displayedStyle.fontFamily &&
      p.style.color === displayedStyle.color &&
      p.style.outlineWidth === displayedStyle.outlineWidth &&
      (p.style.backgroundColor || '') === (displayedStyle.backgroundColor || '') &&
      (p.style.dropShadow || '') === (displayedStyle.dropShadow || ''),
  )
  const [customOpen, setCustomOpen] = useState(!matchesAnyPreset)

  // ── Handlers ──

  /**
   * Write a style change to the right target. With a caption selection active,
   * every selected caption gets the update via `updateClipCaptionStyle` (which
   * merges into the per-clip override). With no selection we update the global
   * default that future captions inherit from.
   */
  function handleStyleChange(update: Partial<CaptionStyle>) {
    scheduleStyleTransaction()
    if (hasSelection) {
      for (const clip of selectedCaptionClips) {
        updateClipCaptionStyle(clip.id, update)
      }
    } else {
      setCaptionStyle(update)
    }
  }

  /**
   * Apply a visual preset to the active target. Strips `animationIn` and
   * `animationOut` so that picking a look (Comic, Neon, …) never changes
   * the user's transition choice — those live in the Transitions section.
   */
  function handlePresetApply(presetStyle: CaptionStyle) {
    const { animationIn: _i, animationOut: _o, ...visualOnly } = presetStyle
    void _i; void _o
    finishStyleTransaction()
    beginHistoryTransaction('Apply caption preset')
    if (hasSelection) {
      for (const clip of selectedCaptionClips) {
        updateClipCaptionStyle(clip.id, visualOnly)
      }
    } else {
      setCaptionStyle(visualOnly)
    }
    commitHistoryTransaction()
    setCustomOpen(false)
  }

  function handleSelectCustom() {
    setCustomOpen((prev) => !prev)
  }

  function finishStyleTransaction() {
    if (styleTransactionTimerRef.current !== null) {
      window.clearTimeout(styleTransactionTimerRef.current)
      styleTransactionTimerRef.current = null
    }
    if (!styleTransactionActiveRef.current) return
    styleTransactionActiveRef.current = false
    commitHistoryTransaction()
  }

  function scheduleStyleTransaction() {
    if (!styleTransactionActiveRef.current) {
      beginHistoryTransaction('Caption style edit')
      styleTransactionActiveRef.current = true
    }
    if (styleTransactionTimerRef.current !== null) {
      window.clearTimeout(styleTransactionTimerRef.current)
    }
    styleTransactionTimerRef.current = window.setTimeout(finishStyleTransaction, 700)
  }

  useEffect(() => {
    return () => {
      if (styleTransactionTimerRef.current !== null) {
        window.clearTimeout(styleTransactionTimerRef.current)
        styleTransactionTimerRef.current = null
      }
      if (styleTransactionActiveRef.current) {
        styleTransactionActiveRef.current = false
        commitHistoryTransaction()
      }
    }
  }, [commitHistoryTransaction])

  /**
   * Drop per-clip overrides on the selection, letting those captions inherit
   * the global default again. Visible only when a selection is active.
   */
  function handleResetSelectionToGlobal() {
    finishStyleTransaction()
    beginHistoryTransaction('Reset caption style overrides')
    for (const clip of selectedCaptionClips) {
      clearClipCaptionStyle(clip.id)
    }
    commitHistoryTransaction()
  }

  // ── Render ──

  const content = (
    <>
      {/* ── Style Presets (header doubles as the edit-target indicator) ── */}
      <StyleSectionHeader
        selectionCount={selectedCaptionClips.length}
        onResetToGlobal={handleResetSelectionToGlobal}
      />
      <PresetPicker
        currentStyle={displayedStyle}
        onApplyPreset={handlePresetApply}
        customActive={customOpen}
        onSelectCustom={handleSelectCustom}
      />

      {/* ── Fine-grained Style Controls (Custom panel) ── */}
      {customOpen && (
        <CaptionStyleControls style={displayedStyle} onStyleChange={handleStyleChange} />
      )}

      {/* ── Transitions (separate from Style on purpose) ── */}
      <SectionHeader label="Transitions" />
      <TransitionPicker style={displayedStyle} onStyleChange={handleStyleChange} />
    </>
  )

  if (inline) {
    return <div className="py-1">{content}</div>
  }

  return (
    <div className="flex flex-col h-full bg-card border-l border-border">
      {/* Panel header */}
      <div className="px-3 pt-3 pb-2 shrink-0 border-b border-border">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Captions
        </p>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3">
        {content}
      </div>
    </div>
  )
}
