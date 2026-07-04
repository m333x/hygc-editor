import { describe, it, expect } from 'vitest'
import { applySnap, applySnapMove, applySnapToEnd } from '../timeline-utils'

// SNAP_THRESHOLD_PX is 8px in timeline-utils; at pxPerMs = 0.1, that's 80ms.
const PX_PER_MS = 0.1

describe('applySnap', () => {
  it('snaps a value within threshold to the nearest snap point', () => {
    expect(applySnap(520, [0, 500, 1000], 5000, PX_PER_MS)).toBe(500)
  })

  it('returns the original value when no snap point is in range', () => {
    expect(applySnap(700, [0, 500, 1000], 5000, PX_PER_MS)).toBe(700)
  })

  it('snaps to the playhead when it is the nearest candidate', () => {
    expect(applySnap(248, [0, 500, 1000], 250, PX_PER_MS)).toBe(250)
  })

  it('snaps to 0 (timeline origin) implicitly', () => {
    expect(applySnap(40, [500, 1000], 5000, PX_PER_MS)).toBe(0)
  })
})

describe('applySnapMove', () => {
  const duration = 1000

  it('snaps the leading (end) edge forward to an upcoming clip start', () => {
    // Dragging forward: end is 4980, target start at 5000 (Δ=20ms ≤ 80ms threshold).
    // The trailing start at 3980 is 20ms from 4000 too — equal pull from both edges.
    // We expect the start-edge snap (≤ tie-break) so newStart = 4000.
    const startMs = 3980
    const out = applySnapMove(startMs, duration, [4000, 5000], 99_999, PX_PER_MS)
    expect(out).toBe(4000)
  })

  it('snaps the leading edge when the trailing edge has no candidate', () => {
    // Trailing start = 3500 (no snap points nearby). Leading end = 4500 → snaps to 4520 (Δ=20).
    // Resulting startMs should shift by +20 so end lands on 4520.
    const startMs = 3500
    const out = applySnapMove(startMs, duration, [4520], 99_999, PX_PER_MS)
    expect(out).toBe(3520)
  })

  it('snaps the trailing edge when the leading edge has no candidate', () => {
    // Trailing start = 1020 (within 80ms of 1000); leading end = 2020 (no snap points).
    const startMs = 1020
    const out = applySnapMove(startMs, duration, [1000], 99_999, PX_PER_MS)
    expect(out).toBe(1000)
  })

  it('picks the closer edge when both have snap candidates', () => {
    // Trailing start = 1010 → snaps to 1000 (Δ=10).
    // Leading end = 2010 → snaps to 2050 (Δ=40).
    // Trailing wins (closer): newStart = 1000.
    const startMs = 1010
    const out = applySnapMove(startMs, duration, [1000, 2050], 99_999, PX_PER_MS)
    expect(out).toBe(1000)
  })

  it('lets the leading edge win when it is the closer match', () => {
    // Trailing start = 1050 → snaps to 1000 (Δ=-50).
    // Leading end = 2050 → snaps to 2060 (Δ=+10).
    // Leading wins (smaller |Δ|): newStart = 1050 + 10 = 1060 (end lands on 2060).
    const startMs = 1050
    const out = applySnapMove(startMs, duration, [1000, 2060], 99_999, PX_PER_MS)
    expect(out).toBe(1060)
  })

  it('returns the value unchanged when neither edge is in range', () => {
    const startMs = 1500
    // Snap points are >100ms away from both 1500 and 2500.
    const out = applySnapMove(startMs, duration, [1000, 3000], 99_999, PX_PER_MS)
    expect(out).toBe(1500)
  })

  it('snaps the leading edge to the playhead during forward drag', () => {
    // Trailing start = 3500 (no candidates nearby). Leading end = 4500 → playhead at 4520 (Δ=20).
    const startMs = 3500
    const out = applySnapMove(startMs, duration, [], 4520, PX_PER_MS)
    expect(out).toBe(3520)
  })
})

describe('applySnapToEnd', () => {
  it('mirrors applySnap behaviour for the end edge', () => {
    expect(applySnapToEnd(4980, [5000], 0, PX_PER_MS)).toBe(5000)
    expect(applySnapToEnd(4500, [5000], 0, PX_PER_MS)).toBe(4500)
  })
})
