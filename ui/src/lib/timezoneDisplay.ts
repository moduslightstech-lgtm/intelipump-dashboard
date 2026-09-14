/** Display helpers for station business timezones (store UTC, show local). */

export const NIGERIA_TZ = 'Africa/Lagos'
export const NIGERIA_TIME_LABEL = 'Nigeria time'

const NIGERIA_TZ_ALIASES = new Set(['africa/lagos', 'wat', 'west africa time', 'nigeria', 'nigeria time'])

export function isNigeriaTimezone(tz?: string | null): boolean {
  const key = String(tz || '').trim().toLowerCase()
  return !key || NIGERIA_TZ_ALIASES.has(key) || key === 'africa/lagos'
}

/** Never show raw IANA ids like America/Chicago or Africa/Lagos in UI copy. */
export function timezonePlainLabel(tz?: string | null): string {
  if (isNigeriaTimezone(tz)) return NIGERIA_TIME_LABEL
  const key = String(tz || '').trim()
  if (!key) return NIGERIA_TIME_LABEL
  if (/america\/chicago/i.test(key)) return NIGERIA_TIME_LABEL
  return 'Local station time'
}

/** Format YYYY-MM-DD as "Sep 10, 2026" (calendar date, not a zoned instant). */
export function formatCalendarDate(ymd?: string | null): string {
  if (!ymd) return '—'
  const [year, month, day] = ymd.split('-').map(Number)
  if (!year || !month || !day) return ymd
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

export function formatSalesRangeHeading(dateFrom?: string | null, dateTo?: string | null): string {
  if (!dateFrom && !dateTo) return 'All dates'
  if (dateFrom && dateTo && dateFrom === dateTo) return formatCalendarDate(dateFrom)
  if (dateFrom && dateTo) return `${formatCalendarDate(dateFrom)} – ${formatCalendarDate(dateTo)}`
  return formatCalendarDate(dateFrom || dateTo)
}

export function formatClockLabel(hhmm?: string | null): string {
  if (!hhmm) return ''
  const [hRaw, mRaw] = hhmm.split(':')
  const h = Number(hRaw)
  const m = Number(mRaw || 0)
  if (!Number.isFinite(h)) return hhmm
  const d = new Date(Date.UTC(2000, 0, 1, h, m))
  return d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'UTC',
  })
}
