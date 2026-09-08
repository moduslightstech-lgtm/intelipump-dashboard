import { describe, expect, it } from 'vitest'
import {
  overviewSearchParams,
  parseOverviewFilters,
  relativeTime,
  trendFromPct,
} from '../lib/executiveOverview'

describe('executive overview filters', () => {
  it('round-trips URL filters for bookmarking', () => {
    const parsed = parseOverviewFilters(
      new URLSearchParams('period=last_7_days&comparison=previous_week&station=st-1&product=PMS&sort=volume'),
    )
    expect(parsed.period).toBe('last_7_days')
    expect(parsed.station).toBe('st-1')
    expect(parsed.product).toBe('PMS')
    const qs = overviewSearchParams(parsed).toString()
    expect(qs).toContain('period=last_7_days')
    expect(qs).toContain('station=st-1')
    expect(qs).toContain('product=PMS')
  })

  it('formats relative refresh time without streaming language', () => {
    const now = Date.parse('2026-09-08T13:02:00Z')
    expect(relativeTime('2026-09-08T13:00:00Z', now)).toBe('Updated 2 minutes ago')
    expect(relativeTime('2026-09-08T13:00:00Z', now)).not.toMatch(/API|SSE|MQTT|poll/i)
  })

  it('treats a growing shortage as unfavorable', () => {
    expect(trendFromPct(-12.5).favorable).toBe(false)
    expect(trendFromPct(8.4, false).favorable).toBe(false)
  })
})
