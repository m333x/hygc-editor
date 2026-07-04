import { describe, it, expect } from 'vitest'
import {
  buildLookFilter,
  buildMotionTransform,
  buildMediaFilter,
  focusInBlurPx,
  grainJitter,
  migrateLegacyEffects,
  LOOK_PRESETS,
} from '../effects'
import type { EffectInstance, LegacyClipEffects, LookPreset } from '../../types'

describe('effects', () => {
  it('look at intensity 0 is identity (empty filter)', () => {
    for (const preset of Object.keys(LOOK_PRESETS) as LookPreset[]) {
      expect(buildLookFilter({ preset, intensity: 0 })).toBe('')
    }
  })

  it('look intensity scales toward the preset recipe', () => {
    const full = buildLookFilter({ preset: 'punch', intensity: 1 })
    expect(full).toBe('contrast(1.15) saturate(1.35)')
    const half = buildLookFilter({ preset: 'punch', intensity: 0.5 })
    expect(half).toBe('contrast(1.075) saturate(1.175)')
  })

  it('motion transform is deterministic: same inputs, same output', () => {
    const stack: EffectInstance[] = [
      { id: 'fx-1', type: 'shake', amount: 0.8 },
      { id: 'fx-2', type: 'pulse', intervalMs: 500, amount: 0.5 },
      { id: 'fx-3', type: 'slowZoom', direction: 'in', amount: 0.6 },
    ]
    const a = buildMotionTransform(stack, 'clip-abc', 1234, 5000)
    const b = buildMotionTransform(stack, 'clip-abc', 1234, 5000)
    expect(a).toBe(b)
    expect(a).not.toBe('')
    // different clip id → different shake phase
    expect(buildMotionTransform(stack, 'clip-xyz', 1234, 5000)).not.toBe(a)
  })

  it('no active effects produce no transform or filter', () => {
    expect(buildMotionTransform([], 'clip-a', 1000, 5000)).toBe('')
    expect(buildMediaFilter([], 1000)).toBeUndefined()
    expect(
      buildMotionTransform([{ id: 'x', type: 'shake', amount: 0 }], 'clip-a', 1000, 5000),
    ).toBe('')
  })

  it('disabled instances contribute nothing', () => {
    const stack: EffectInstance[] = [
      { id: 'x', type: 'shake', amount: 0.8, enabled: false },
      { id: 'y', type: 'look', preset: 'punch', intensity: 1, enabled: false },
    ]
    expect(buildMotionTransform(stack, 'clip-a', 1000, 5000)).toBe('')
    expect(buildMediaFilter(stack, 1000)).toBeUndefined()
  })

  it('stack order controls processing order (index 0 innermost)', () => {
    const shake: EffectInstance = { id: 's', type: 'shake', amount: 1 }
    const zoom: EffectInstance = { id: 'z', type: 'slowZoom', direction: 'in', amount: 1 }
    const shakeFirst = buildMotionTransform([shake, zoom], 'c', 2000, 4000)
    const zoomFirst = buildMotionTransform([zoom, shake], 'c', 2000, 4000)
    expect(shakeFirst).not.toBe(zoomFirst)
    // CSS transforms apply right-to-left, so the stack's first effect must be
    // the rightmost part of the string. Halfway through a full zoom-in the
    // slow-zoom part is exactly scale(1.125).
    expect(shakeFirst.startsWith('scale(1.125)')).toBe(true)
    expect(zoomFirst.endsWith('scale(1.125)')).toBe(true)
  })

  it('same effect type can stack multiple times', () => {
    const stack: EffectInstance[] = [
      { id: 'a', type: 'look', preset: 'punch', intensity: 1 },
      { id: 'b', type: 'look', preset: 'bw', intensity: 1 },
    ]
    expect(buildMediaFilter(stack, 0)).toBe(
      'contrast(1.15) saturate(1.35) contrast(1.25) grayscale(1)',
    )
  })

  it('focus-in blurs at start, sharp after the window', () => {
    const focusIn = { durationMs: 500 }
    expect(focusInBlurPx(focusIn, 0)).toBe(16)
    expect(focusInBlurPx(focusIn, 250)).toBeGreaterThan(0)
    expect(focusInBlurPx(focusIn, 500)).toBe(0)
    expect(focusInBlurPx(focusIn, 9999)).toBe(0)
  })

  it('slow zoom in starts at 1 and ends larger; out is the reverse', () => {
    const zoomIn: EffectInstance[] = [{ id: 'z', type: 'slowZoom', direction: 'in', amount: 1 }]
    expect(buildMotionTransform(zoomIn, 'c', 0, 4000)).toBe('')
    expect(buildMotionTransform(zoomIn, 'c', 4000, 4000)).toBe('scale(1.25)')
    const zoomOut: EffectInstance[] = [{ id: 'z', type: 'slowZoom', direction: 'out', amount: 1 }]
    expect(buildMotionTransform(zoomOut, 'c', 0, 4000)).toBe('scale(1.25)')
    expect(buildMotionTransform(zoomOut, 'c', 4000, 4000)).toBe('')
  })

  it('migrates a legacy flat effects object into a stack in render order', () => {
    const legacy: LegacyClipEffects = {
      vignette: 0.8,
      look: { preset: 'film', intensity: 0.7 },
      shake: 0.4,
      focusIn: { durationMs: 300 },
    }
    const stack = migrateLegacyEffects(legacy)!
    expect(stack.map((fx) => fx.type)).toEqual(['look', 'shake', 'vignette', 'focusIn'])
    expect(stack.every((fx) => typeof fx.id === 'string' && fx.id.length > 0)).toBe(true)
    const look = stack[0]
    expect(look.type === 'look' && look.preset === 'film' && look.intensity === 0.7).toBe(true)
    // already-migrated stacks pass through untouched; empty objects vanish
    expect(migrateLegacyEffects(stack)).toBe(stack)
    expect(migrateLegacyEffects({})).toBeUndefined()
    expect(migrateLegacyEffects(undefined)).toBeUndefined()
  })

  it('grain jitter is deterministic per frame and bounded', () => {
    for (const frame of [0, 1, 7, 100, 8641]) {
      const a = grainJitter(frame)
      expect(a).toEqual(grainJitter(frame))
      expect(Math.abs(a.dx)).toBeLessThanOrEqual(32)
      expect(Math.abs(a.dy)).toBeLessThanOrEqual(32)
    }
    // consecutive frames move — that's the boil
    expect(grainJitter(10)).not.toEqual(grainJitter(11))
  })
})
