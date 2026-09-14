import { describe, expect, it } from 'vitest'
import { formatStatusLabel } from '../lib/enumPresentation'
import { statusBadge } from '../lib/reconciliationUi'
import {
  parseMoneyInput,
  stationRangeToUtcIso,
  validateMoneyRange,
} from '../lib/salesDateFilter'
import {
  formatSalesRangeHeading,
  timezonePlainLabel,
} from '../lib/timezoneDisplay'

describe('enumPresentation', () => {
  it('maps reconciliation workflow enums to business labels', () => {
    expect(formatStatusLabel('AWAITING_REPORTED_SALES')).toBe('Awaiting reported sales')
    expect(formatStatusLabel('READY_TO_CLOSE')).toBe('Ready to close')
    expect(formatStatusLabel('NEEDS_ATTENTION')).toBe('Needs attention')
    expect(formatStatusLabel('REVIEW')).toBe('Needs review')
    expect(formatStatusLabel('COMPLETED')).toBe('Completed')
    expect(formatStatusLabel('MISSING_PRODUCT_MAPPING')).toBe('Product not mapped')
    expect(formatStatusLabel('METER_VALUE_MISMATCH')).toBe('Meter values do not match')
  })

  it('never returns raw underscore enums for known values', () => {
    const raw = formatStatusLabel('AWAITING_REPORTED_SALES')
    expect(raw.includes('_')).toBe(false)
    expect(raw.toUpperCase()).not.toBe('AWAITING_REPORTED_SALES')
  })
})

describe('reconciliation statusBadge', () => {
  it('exposes readable text without decorative punctuation', () => {
    expect(statusBadge('AWAITING_REPORTED_SALES').text).toBe('Awaiting reported sales')
    expect(statusBadge('WAITING').text).toBe('Waiting')
    expect(statusBadge('INCOMPLETE').text).toBe('Incomplete')
  })
})

describe('timezoneDisplay', () => {
  it('uses plain Nigeria time wording instead of IANA ids', () => {
    expect(timezonePlainLabel('Africa/Lagos')).toBe('Nigeria time')
    expect(timezonePlainLabel('America/Chicago')).toBe('Nigeria time')
    expect(formatSalesRangeHeading('2026-09-10', '2026-09-10')).toBe('Sep 10, 2026')
    expect(formatSalesRangeHeading('2026-09-10', '2026-09-10')).not.toMatch(/Chicago|Lagos|AMERICA/i)
  })
})

describe('sales time and money filters', () => {
  it('builds UTC bounds for a Nigeria morning window', () => {
    const range = stationRangeToUtcIso({
      dateFrom: '2026-09-10',
      dateTo: '2026-09-10',
      fromTime: '08:00',
      toTime: '12:00',
      timeZone: 'Africa/Lagos',
    })
    expect(range.error).toBeUndefined()
    expect(range.start).toBe('2026-09-10T07:00:00.000Z')
    expect(range.end).toBe('2026-09-10T11:00:59.999Z')
  })

  it('rejects inverted same-day times', () => {
    const range = stationRangeToUtcIso({
      dateFrom: '2026-09-10',
      dateTo: '2026-09-10',
      fromTime: '14:00',
      toTime: '08:00',
      timeZone: 'Africa/Lagos',
    })
    expect(range.error).toMatch(/time/i)
  })

  it('parses and validates amount ranges', () => {
    expect(parseMoneyInput('₦1,250.50')).toBe(1250.5)
    expect(validateMoneyRange('500', '5000', 'Sale amount')).toEqual({ min: 500, max: 5000 })
    expect(validateMoneyRange('5000', '500', 'Sale amount').error).toMatch(/minimum/i)
    expect(validateMoneyRange('-1', '', 'Sale amount').error).toMatch(/negative/i)
  })
})
