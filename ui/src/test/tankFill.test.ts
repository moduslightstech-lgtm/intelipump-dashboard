import { describe, expect, it } from 'vitest'
import { TANK_INNER_H } from '../components/twin/schematic/constants'
import { clamp, liquidHeight, tankFillPercent, tankLevelKind } from '../components/twin/schematic/tankFill'

describe('tankFillPercent', () => {
  it('uses volume/capacity for the PMS lab example (~41.6%)', () => {
    const fill = tankFillPercent({ reportedLiters: 10.39, capacityLiters: 25 })
    expect(fill).toBeCloseTo(41.56, 1)
  })

  it('clamps over-capacity and negative values', () => {
    expect(tankFillPercent({ reportedLiters: 40, capacityLiters: 25 })).toBe(100)
    expect(tankFillPercent({ reportedLiters: -4, capacityLiters: 25 })).toBe(0)
    expect(clamp(-10, 0, 100)).toBe(0)
    expect(clamp(140, 0, 100)).toBe(100)
  })

  it('falls back to fillPercent when volume is missing', () => {
    expect(tankFillPercent({ fillPercent: 50 })).toBe(50)
    expect(tankFillPercent({})).toBe(0)
  })
})

describe('liquidHeight is a vertical level', () => {
  it('zero / half / full of internal height', () => {
    expect(liquidHeight(0, TANK_INNER_H)).toBe(0)
    expect(liquidHeight(50, TANK_INNER_H)).toBeCloseTo(TANK_INNER_H / 2)
    expect(liquidHeight(100, TANK_INNER_H)).toBe(TANK_INNER_H)
  })

  it('maps 41.6% to ~41.6% of inner height, not width', () => {
    const h = liquidHeight(41.56, TANK_INNER_H)
    expect(h).toBeCloseTo(TANK_INNER_H * 0.4156, 2)
    expect(h).toBeLessThan(TANK_INNER_H)
  })
})

describe('tankLevelKind', () => {
  it('separates liquid level from operational status', () => {
    expect(tankLevelKind(50, 'NORMAL')).toBe('NORMAL')
    expect(tankLevelKind(28, 'NORMAL')).toBe('LOW')
    expect(tankLevelKind(10, 'NORMAL')).toBe('CRITICAL')
    expect(tankLevelKind(80, 'LOW')).toBe('LOW')
    expect(tankLevelKind(80, 'CRITICAL_LOW')).toBe('CRITICAL')
  })
})
