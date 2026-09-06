/**
 * Station schedule helpers (mirrors backend `station_status.is_within_operating_hours`).
 * Weekdays: 0=Mon … 6=Sun.
 */

export type StationScheduleInput = {
  opensAt?: string | null
  closesAt?: string | null
  operatingDays?: number[] | null
  timezone?: string | null
}

/** Parse HTML time / "HH:MM" / "HH:MM:SS" into minutes since midnight. */
export function parseTimeToMinutes(value?: string | null): number | null {
  if (!value) return null
  const m = String(value).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 23 || min > 59) return null
  return h * 60 + min
}

const WEEKDAY_TO_INDEX: Record<string, number> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
}

export function getZonedWeekdayAndMinutes(
  now: Date,
  timeZone: string,
): { weekday: number; minutes: number } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now)

    const weekdayLabel = parts.find((p) => p.type === 'weekday')?.value
    const hour = Number(parts.find((p) => p.type === 'hour')?.value)
    const minute = Number(parts.find((p) => p.type === 'minute')?.value)
    const weekday = weekdayLabel ? WEEKDAY_TO_INDEX[weekdayLabel] : undefined
    if (weekday === undefined || !Number.isFinite(hour) || !Number.isFinite(minute)) {
      return null
    }
    return { weekday, minutes: hour * 60 + minute }
  } catch {
    return null
  }
}

/**
 * Missing open/close times → treat as always within hours (same as backend).
 * Empty operating_days → every day.
 */
export function isWithinOperatingHours(
  schedule: StationScheduleInput,
  now: Date = new Date(),
): boolean {
  const opens = parseTimeToMinutes(schedule.opensAt)
  const closes = parseTimeToMinutes(schedule.closesAt)
  if (opens === null || closes === null) return true

  const tz = (schedule.timezone || 'Africa/Lagos').trim() || 'Africa/Lagos'
  const zoned = getZonedWeekdayAndMinutes(now, tz)
  if (!zoned) return true

  const days = schedule.operatingDays || []
  if (days.length > 0 && !days.includes(zoned.weekday)) return false

  const { minutes } = zoned
  if (opens <= closes) {
    return opens <= minutes && minutes < closes
  }
  // Overnight window (e.g. 22:00–05:45)
  return minutes >= opens || minutes < closes
}

/** OPEN / CLOSED from schedule; UNKNOWN only if timezone resolution fails and times exist. */
export function deriveOperationalStatus(
  schedule: StationScheduleInput,
  now: Date = new Date(),
): 'OPEN' | 'CLOSED' {
  return isWithinOperatingHours(schedule, now) ? 'OPEN' : 'CLOSED'
}

/** Map edge Pi heartbeat status → station connectivity_status values. */
export function mapEdgeToConnectivityStatus(
  edgeStatus?: string | null,
): 'ONLINE' | 'OFFLINE' | 'DEGRADED' | 'UNKNOWN' {
  const v = (edgeStatus || '').toUpperCase()
  if (v === 'ONLINE') return 'ONLINE'
  if (v === 'DELAYED' || v === 'STALE') return 'DEGRADED'
  if (v === 'OFFLINE' || v === 'NEVER_CONNECTED') return 'OFFLINE'
  return 'UNKNOWN'
}
