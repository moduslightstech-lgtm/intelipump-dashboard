import { describe, expect, it } from 'vitest'
import {
  deriveOperationalStatus,
  isWithinOperatingHours,
  mapEdgeToConnectivityStatus,
  parseTimeToMinutes,
} from '../lib/stationSchedule'

describe('parseTimeToMinutes', () => {
  it('parses HH:MM', () => {
    expect(parseTimeToMinutes('05:45')).toBe(5 * 60 + 45)
    expect(parseTimeToMinutes('22:00')).toBe(22 * 60)
  })
})

describe('isWithinOperatingHours', () => {
  const schedule = {
    opensAt: '05:45',
    closesAt: '22:00',
    operatingDays: [0, 1, 2, 3, 4, 5, 6],
    timezone: 'Africa/Lagos',
  }

  it('is open during Lagos daytime', () => {
    // 2026-07-13 12:00 UTC = 13:00 Africa/Lagos (UTC+1)
    const noonUtc = new Date('2026-07-13T12:00:00Z')
    expect(isWithinOperatingHours(schedule, noonUtc)).toBe(true)
    expect(deriveOperationalStatus(schedule, noonUtc)).toBe('OPEN')
  })

  it('is closed late at night in Lagos', () => {
    // 2026-07-13 22:30 UTC = 23:30 Africa/Lagos
    const late = new Date('2026-07-13T22:30:00Z')
    expect(isWithinOperatingHours(schedule, late)).toBe(false)
    expect(deriveOperationalStatus(schedule, late)).toBe('CLOSED')
  })

  it('respects operating days', () => {
    // Monday-only; 2026-07-14 is Tuesday
    const monOnly = { ...schedule, operatingDays: [0] }
    const tueNoon = new Date('2026-07-14T12:00:00Z')
    expect(isWithinOperatingHours(monOnly, tueNoon)).toBe(false)
  })

  it('treats missing times as always open', () => {
    expect(isWithinOperatingHours({ timezone: 'Africa/Lagos' }, new Date())).toBe(true)
  })
})

describe('mapEdgeToConnectivityStatus', () => {
  it('maps edge statuses', () => {
    expect(mapEdgeToConnectivityStatus('ONLINE')).toBe('ONLINE')
    expect(mapEdgeToConnectivityStatus('DELAYED')).toBe('DEGRADED')
    expect(mapEdgeToConnectivityStatus('OFFLINE')).toBe('OFFLINE')
    expect(mapEdgeToConnectivityStatus('NEVER_CONNECTED')).toBe('OFFLINE')
    expect(mapEdgeToConnectivityStatus(null)).toBe('UNKNOWN')
  })
})
