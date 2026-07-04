import { describe, it, expect } from 'vitest'
import { snapMove, snapScale } from '../snapping'

const CW = 1080
const CH = 1920

function move(centerX: number, centerY: number, opts?: Partial<Parameters<typeof snapMove>[0]>) {
  return snapMove({
    centerX,
    centerY,
    width: CW,
    height: CH,
    compositionWidth: CW,
    compositionHeight: CH,
    threshold: 8,
    ...opts,
  })
}

describe('snapMove', () => {
  it('snaps center to canvas center when within threshold', () => {
    const r = move(CW / 2 + 5, CH / 2 - 3)
    expect(r.centerX).toBe(CW / 2)
    expect(r.centerY).toBe(CH / 2)
    expect(r.lines).toHaveLength(2)
    expect(r.lines).toContainEqual({ axis: 'v', position: CW / 2 })
    expect(r.lines).toContainEqual({ axis: 'h', position: CH / 2 })
  })

  it('does not snap when outside threshold', () => {
    const r = move(CW / 2 + 50, CH / 2 + 50)
    expect(r.centerX).toBe(CW / 2 + 50)
    expect(r.centerY).toBe(CH / 2 + 50)
    expect(r.lines).toHaveLength(0)
  })

  it('snaps left edge of smaller box to canvas left', () => {
    // half-size box, center 4px right of where its left edge would touch x=0
    const halfWidth = CW / 2 / 2 // 270
    const r = move(halfWidth + 3, 500, { width: CW / 2, height: CH / 2 })
    expect(r.centerX).toBe(halfWidth)
    expect(r.lines).toContainEqual({ axis: 'v', position: 0 })
  })

  it('snaps right edge of smaller box to canvas right', () => {
    const halfWidth = CW / 2 / 2 // 270
    const r = move(CW - halfWidth - 4, 500, { width: CW / 2, height: CH / 2 })
    expect(r.centerX).toBe(CW - halfWidth)
    expect(r.lines).toContainEqual({ axis: 'v', position: CW })
  })

  it('snaps each axis independently', () => {
    // X snaps to center, Y is far from any snap
    const r = move(CW / 2 + 2, 200, { width: CW / 2, height: CH / 2 })
    expect(r.centerX).toBe(CW / 2)
    expect(r.centerY).toBe(200)
    expect(r.lines).toHaveLength(1)
    expect(r.lines[0].axis).toBe('v')
  })

  it('picks the closest candidate when multiple are in range', () => {
    // A tiny box with width=10 and centerX=5 has both "center=5" (left edge to 0)
    // and "center=cw/2=540" in play — left edge should win since it's closer.
    const r = move(5, 500, { width: 10, height: 10 })
    expect(r.centerX).toBe(5)
    expect(r.lines).toContainEqual({ axis: 'v', position: 0 })
  })
})

describe('snapScale', () => {
  it('snaps to 1.0 when close', () => {
    expect(snapScale(0.97)).toBe(1.0)
    expect(snapScale(1.03)).toBe(1.0)
  })

  it('snaps to 0.5 and 2.0', () => {
    expect(snapScale(0.51)).toBe(0.5)
    expect(snapScale(1.98)).toBe(2.0)
  })

  it('returns unchanged when outside threshold', () => {
    expect(snapScale(0.6)).toBe(0.6)
    expect(snapScale(1.2)).toBe(1.2)
  })

  it('respects custom threshold', () => {
    expect(snapScale(0.9, 0.15)).toBe(1.0)
    expect(snapScale(0.9, 0.05)).toBe(0.9)
  })
})
