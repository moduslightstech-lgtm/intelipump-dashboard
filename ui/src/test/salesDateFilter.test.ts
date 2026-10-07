import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  lagosDayStartIso,
  paginateItems,
  resolveSalesTimeZone,
  saleInDateRange,
  saleInStationInterval,
  saleOccurrenceIso,
  stationDayEndExclusiveIso,
  stationRangeToUtcIso,
  toLagosDate,
} from '../lib/salesDateFilter'
import { formatSalesRangeHeading } from '../lib/timezoneDisplay'

describe('salesDateFilter', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('maps UTC timestamps to Africa/Lagos calendar dates', () => {
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
    expect(stationDayEndExclusiveIso('2026-07-14')).toBe('2026-07-14T23:00:00.000Z')
  })

  it('paginates items', () => {
    const items = Array.from({ length: 45 }, (_, i) => i + 1)
    expect(paginateItems(items, 1, 20)).toEqual(items.slice(0, 20))
    expect(paginateItems(items, 3, 20)).toEqual(items.slice(40, 45))
    expect(paginateItems(items, 0, 20)).toEqual(items.slice(0, 20))
  })

  it('builds one continuous cross-midnight half-open interval', () => {
    const range = stationRangeToUtcIso({
      dateFrom: '2026-10-06',
      dateTo: '2026-10-07',
      fromTime: '05:00',
      toTime: '01:00',
      timeZone: 'Africa/Lagos',
    })
    expect(range.error).toBeUndefined()
    expect(range.start).toBe('2026-10-06T04:00:00.000Z')
    expect(range.end).toBe('2026-10-07T00:00:00.000Z')

    const cases: [string, boolean][] = [
      ['2026-10-06T04:59:59+01:00', false],
      ['2026-10-06T05:00:00+01:00', true],
      ['2026-10-06T22:03:00+01:00', true],
      ['2026-10-07T00:59:59+01:00', true],
      ['2026-10-07T01:00:00+01:00', false],
      ['2026-10-07T05:30:00+01:00', false],
      ['2026-10-07T06:45:00+01:00', false],
    ]
    for (const [iso, expected] of cases) {
      expect(saleInStationInterval(iso, range.start, range.end)).toBe(expected)
    }
  })

  it('treats America/Chicago station tz as Africa/Lagos for the same window', () => {
    const lagos = stationRangeToUtcIso({
      dateFrom: '2026-10-06',
      dateTo: '2026-10-07',
      fromTime: '05:00',
      toTime: '01:00',
      timeZone: 'Africa/Lagos',
    })
    const chicago = stationRangeToUtcIso({
      dateFrom: '2026-10-06',
      dateTo: '2026-10-07',
      fromTime: '05:00',
      toTime: '01:00',
      timeZone: 'America/Chicago',
    })
    expect(resolveSalesTimeZone('America/Chicago')).toBe('Africa/Lagos')
    expect(chicago.start).toBe(lagos.start)
    expect(chicago.end).toBe(lagos.end)
  })

  it('date-only end uses next-midnight exclusive', () => {
    const range = stationRangeToUtcIso({
      dateFrom: '2026-10-06',
      dateTo: '2026-10-06',
      timeZone: 'Africa/Lagos',
    })
    expect(range.start).toBe('2026-10-05T23:00:00.000Z')
    expect(range.end).toBe('2026-10-06T23:00:00.000Z')
    expect(saleInStationInterval('2026-10-06T23:59:59+01:00', range.start, range.end)).toBe(true)
    expect(saleInStationInterval('2026-10-07T00:00:00+01:00', range.start, range.end)).toBe(false)
  })

  it('rejects inverted intervals with a clear error', () => {
    const range = stationRangeToUtcIso({
      dateFrom: '2026-10-06',
      dateTo: '2026-10-06',
      fromTime: '14:00',
      toTime: '08:00',
      timeZone: 'Africa/Lagos',
    })
    expect(range.error).toMatch(/end must be after start/i)
  })

  it('saleOccurrenceIso prefers completed over late received_at', () => {
    expect(
      saleOccurrenceIso({
        transaction_completed_at: '2026-10-06T21:03:00.000Z',
        received_at: '2026-10-07T04:30:00.000Z',
      }),
    ).toBe('2026-10-06T21:03:00.000Z')
  })

  it('heading includes applied times for cross-midnight windows', () => {
    const heading = formatSalesRangeHeading('2026-10-06', '2026-10-07', '05:00', '01:00')
    expect(heading).toMatch(/Oct 6, 2026/)
    expect(heading).toMatch(/Oct 7, 2026/)
    expect(heading).toMatch(/5:00/)
    expect(heading).toMatch(/1:00/)
  })
})
