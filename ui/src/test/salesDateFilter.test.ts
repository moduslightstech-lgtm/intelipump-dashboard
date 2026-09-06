import { describe, expect, it } from 'vitest'
import {
  lagosDayEndIso,
  lagosDayStartIso,
  paginateItems,
  saleInDateRange,
  toLagosDate,
} from '../lib/salesDateFilter'

describe('salesDateFilter', () => {
  it('maps UTC timestamps to Africa/Lagos calendar dates', () => {
    // 2026-07-15 23:30 UTC = 2026-07-16 00:30 Lagos (UTC+1)
    expect(toLagosDate('2026-07-15T23:30:00.000Z')).toBe('2026-07-16')
    expect(toLagosDate('2026-07-15T10:00:00.000Z')).toBe('2026-07-15')
  })

  it('filters inclusive date ranges in Lagos days', () => {
    const mid = '2026-07-14T12:00:00.000Z'
    expect(saleInDateRange(mid, '2026-07-14', '2026-07-14')).toBe(true)
    expect(saleInDateRange(mid, '2026-07-13', '2026-07-13')).toBe(false)
    expect(saleInDateRange(mid, '2026-07-13', '2026-07-15')).toBe(true)
    expect(saleInDateRange(mid, null, '2026-07-14')).toBe(true)
    expect(saleInDateRange(mid, '2026-07-15', null)).toBe(false)
  })

  it('builds Lagos day bounds for API start/end', () => {
    expect(lagosDayStartIso('2026-07-14')).toBe('2026-07-13T23:00:00.000Z')
    expect(lagosDayEndIso('2026-07-14')).toBe('2026-07-14T22:59:59.999Z')
  })

  it('paginates items', () => {
    const items = Array.from({ length: 45 }, (_, i) => i + 1)
    expect(paginateItems(items, 1, 20)).toEqual(items.slice(0, 20))
    expect(paginateItems(items, 3, 20)).toEqual(items.slice(40, 45))
    expect(paginateItems(items, 0, 20)).toEqual(items.slice(0, 20))
  })
})
