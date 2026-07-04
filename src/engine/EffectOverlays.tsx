/**
 * EffectOverlays — grain / vignette / letterbox layers for a video clip.
 *
 * Rendered as siblings AFTER the clip media inside VideoClipBody's wrapper, so
 * they cover the clip's frame but are NOT affected by the media-only effects
 * (look grade, focus blur, shake) — grain lives on the "print", camera motion
 * lives in the scene.
 *
 * Receives the clip's full effect stack and renders each enabled overlay
 * instance in stack order — later instances paint on top of earlier ones
 * (DOM sibling order), matching the Inspector's top-to-bottom processing
 * order. Non-overlay effect types in the stack are ignored here.
 *
 * Everything here is an <Img> or a plain div: the only primitives verified to
 * rasterize on all three render paths (preview Player, server Chromium render,
 * WebCodecs web export). No canvas, no blend modes, no background-image url().
 */

import { Fragment, memo } from 'react'
import { AbsoluteFill, Img, useCurrentFrame, useVideoConfig } from 'remotion'
import type { EffectInstance } from '../types'
import { grainJitter } from './effects'
import { GRAIN_TILE_URI, GRAIN_TILE_SIZE, VIGNETTE_URI } from './effect-assets'

/** Tiles render at 2× native so grain particles are ~2px in a 1080p frame. */
const GRAIN_DISPLAY_SIZE = GRAIN_TILE_SIZE * 2
/** Bleed margin so per-frame jitter never exposes an untiled edge. */
const GRAIN_BLEED_PX = 64
/** Full-strength grain is still translucent — it's texture, not a gray wash. */
const GRAIN_MAX_OPACITY = 0.3
/**
 * Grain "boil" rate in Hz. Real film grain re-randomizes slower than 30fps —
 * ~10Hz reads as classic film emulation — and each boil step invalidates the
 * full-screen noise layer, so stepping at 10Hz instead of every frame cuts
 * repaints 3× (the preview lagged when a text-shadowed caption sat on top of
 * a layer that moved every single frame).
 */
const GRAIN_BOIL_HZ = 10

/**
 * The tile grid never changes between frames — only the parent's transform
 * jitters. memo() keeps per-frame reconciliation away from the 12 <Img>s.
 */
const GrainTiles = memo(function GrainTiles({ cols, rows }: { cols: number; rows: number }) {
  return (
    <>
      {Array.from({ length: cols * rows }, (_, i) => (
        <Img
          key={i}
          src={GRAIN_TILE_URI}
          style={{
            position: 'absolute',
            left: (i % cols) * GRAIN_DISPLAY_SIZE,
            top: Math.floor(i / cols) * GRAIN_DISPLAY_SIZE,
            width: GRAIN_DISPLAY_SIZE,
            height: GRAIN_DISPLAY_SIZE,
          }}
        />
      ))}
    </>
  )
})

export function EffectOverlays({ effects }: { effects: EffectInstance[] }) {
  const frame = useCurrentFrame()
  const { width, height, fps } = useVideoConfig()

  // ponytail: 12 static <Img> tiles instead of canvas/background-repeat — the
  // web renderer only guarantees <Img>. Upgrade to one canvas if its support
  // is ever verified there.
  const cols = Math.ceil((width + GRAIN_BLEED_PX * 2) / GRAIN_DISPLAY_SIZE)
  const rows = Math.ceil((height + GRAIN_BLEED_PX * 2) / GRAIN_DISPLAY_SIZE)
  // Quantized boil step: deterministic (pure function of frame + fps), and
  // between steps the transform string is unchanged → no DOM write, no repaint.
  const boilStep = Math.max(1, Math.round(fps / GRAIN_BOIL_HZ))
  const { dx, dy } = grainJitter(Math.floor(frame / boilStep))

  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      {effects.map((fx) => {
        if (fx.enabled === false) return null

        if (fx.type === 'grain' && fx.amount > 0) {
          return (
            <div
              key={fx.id}
              style={{
                position: 'absolute',
                left: -GRAIN_BLEED_PX,
                top: -GRAIN_BLEED_PX,
                width: cols * GRAIN_DISPLAY_SIZE,
                height: rows * GRAIN_DISPLAY_SIZE,
                transform: `translate(${dx}px, ${dy}px)`,
                opacity: fx.amount * GRAIN_MAX_OPACITY,
                // Own compositor layer: the jitter translate must not force a
                // repaint of whatever overlaps it (video below, captions above).
                willChange: 'transform',
              }}
            >
              <GrainTiles cols={cols} rows={rows} />
            </div>
          )
        }

        if (fx.type === 'vignette' && fx.amount > 0) {
          return (
            <Img
              key={fx.id}
              src={VIGNETTE_URI}
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                objectFit: 'fill',
                opacity: fx.amount,
              }}
            />
          )
        }

        if (fx.type === 'letterbox' && fx.amount > 0) {
          return (
            <Fragment key={fx.id}>
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  height: `${fx.amount * 100}%`,
                  backgroundColor: '#000',
                }}
              />
              <div
                style={{
                  position: 'absolute',
                  bottom: 0,
                  left: 0,
                  right: 0,
                  height: `${fx.amount * 100}%`,
                  backgroundColor: '#000',
                }}
              />
            </Fragment>
          )
        }

        return null
      })}
    </AbsoluteFill>
  )
}
