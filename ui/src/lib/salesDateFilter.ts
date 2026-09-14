/** Calendar date helpers for sales filtering (station timezone, default Africa/Lagos). */

export const SALES_TZ = 'Africa/Lagos'

export function stationToday(timeZone = SALES_TZ): string {
  return new Date().toLocaleDateString('en-CA', { timeZone })
}

export function lagosToday(): string {
  return stationToday(SALES_TZ)
}

/** YYYY-MM-DD in the given timezone for an ISO timestamp. */
export function toStationDate(iso: string, timeZone = SALES_TZ): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-CA', { timeZone })
}

export function toLagosDate(iso: string): string {
  return toStationDate(iso, SALES_TZ)
}

function offsetIso(dateYmd: string, timeZone: string): string {
  const noonUtc = new Date(`${dateYmd}T12:00:00.000Z`)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'shortOffset',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(noonUtc)
  const tzName = parts.find((p) => p.type === 'timeZoneName')?.value || 'GMT+1'
  const m = tzName.match(/([+-])(\d{1,2})(?::?(\d{2}))?/)
  if (!m) return '+01:00'
  const hh = m[2].padStart(2, '0')
  const mm = (m[3] || '00').padStart(2, '0')
  return `${m[1]}${hh}:${mm}`
}

/** Local wall-clock instant on a calendar day → UTC ISO. `timeHHmm` is HH:MM or HH:MM:SS. */
export function stationDateTimeIso(
  dateYmd: string,
  timeHHmm: string,
  timeZone = SALES_TZ,
  ms = 0,
): string {
  const time = /^\d{2}:\d{2}(:\d{2})?$/.test(timeHHmm) ? timeHHmm : '00:00'
  const withSec = time.length === 5 ? `${time}:00` : time
  const padMs = String(Math.max(0, Math.min(999, ms))).padStart(3, '0')
  return new Date(`${dateYmd}T${withSec}.${padMs}${offsetIso(dateYmd, timeZone)}`).toISOString()
}

/** Start of calendar day as UTC ISO for API `start`. */
export function stationDayStartIso(dateYmd: string, timeZone = SALES_TZ): string {
  return stationDateTimeIso(dateYmd, '00:00:00', timeZone, 0)
}

/** End of calendar day as UTC ISO for API `end`. */
export function stationDayEndIso(dateYmd: string, timeZone = SALES_TZ): string {
  return stationDateTimeIso(dateYmd, '23:59:59', timeZone, 999)
}

/**
 * Inclusive local time window on [dateFrom, dateTo] in station TZ → UTC start/end.
 * Empty fromTime → start of dateFrom; empty toTime → end of dateTo.
 */
export function stationRangeToUtcIso(opts: {
  dateFrom?: string | null
  dateTo?: string | null
  fromTime?: string | null
  toTime?: string | null
  timeZone?: string
}): { start?: string; end?: string; error?: string } {
  const tz = opts.timeZone || SALES_TZ
  const dateFrom = opts.dateFrom || opts.dateTo
  const dateTo = opts.dateTo || opts.dateFrom
  if (!dateFrom || !dateTo) return {}
  if (dateFrom > dateTo) return { error: 'From date must be on or before To date.' }

  const fromTime = (opts.fromTime || '').trim()
  const toTime = (opts.toTime || '').trim()
  if (fromTime && !/^\d{2}:\d{2}/.test(fromTime)) {
    return { error: 'From time must be a valid time (HH:MM).' }
  }
  if (toTime && !/^\d{2}:\d{2}/.test(toTime)) {
    return { error: 'To time must be a valid time (HH:MM).' }
  }
  if (dateFrom === dateTo && fromTime && toTime && fromTime > toTime) {
    return { error: 'From time must be before or equal to To time on the same day.' }
  }

  const start = stationDateTimeIso(dateFrom, fromTime || '00:00:00', tz, 0)
  const end = stationDateTimeIso(dateTo, toTime ? (toTime.length === 5 ? `${toTime}:59` : toTime) : '23:59:59', tz, toTime ? 999 : 999)
  // Inclusive end: when only HH:MM given, use that minute's last millisecond.
  const endIso = toTime && toTime.length === 5
    ? stationDateTimeIso(dateTo, `${toTime}:59`, tz, 999)
    : end
  if (new Date(start).getTime() > new Date(endIso).getTime()) {
    return { error: 'The selected time range is invalid.' }
  }
  return { start, end: endIso }
}

/** Parse currency/number input (strips ₦ , spaces). */
export function parseMoneyInput(raw: string): number | null {
  const cleaned = String(raw || '')
    .replace(/[₦,\s]/g, '')
    .trim()
  if (!cleaned) return null
  const n = Number(cleaned)
  if (!Number.isFinite(n)) return null
  return n
}

export function validateMoneyRange(
  minRaw: string,
  maxRaw: string,
  label: string,
): { min?: number; max?: number; error?: string } {
  const min = parseMoneyInput(minRaw)
  const max = parseMoneyInput(maxRaw)
  if (min != null && min < 0) return { error: `${label} minimum cannot be negative.` }
  if (max != null && max < 0) return { error: `${label} maximum cannot be negative.` }
  if (min != null && max != null && min > max) {
    return { error: `${label} minimum cannot be greater than maximum.` }
  }
  return {
    ...(min != null ? { min } : {}),
    ...(max != null ? { max } : {}),
  }
}

export function lagosDayStartIso(dateYmd: string): string {
  return stationDayStartIso(dateYmd, SALES_TZ)
}

export function lagosDayEndIso(dateYmd: string): string {
  return stationDayEndIso(dateYmd, SALES_TZ)
}

/** Inclusive calendar-date filter using Africa/Lagos dates. */
export function saleInDateRange(
  receivedAt: string,
  dateFrom?: string | null,
  dateTo?: string | null,
  timeZone = SALES_TZ,
): boolean {
  const day = toStationDate(receivedAt, timeZone)
  if (!day) return false
  if (dateFrom && day < dateFrom) return false
  if (dateTo && day > dateTo) return false
  return true
}

export function paginateItems<T>(items: T[], page: number, pageSize: number): T[] {
  const p = Math.max(1, page)
  const size = Math.max(1, pageSize)
  const start = (p - 1) * size
  return items.slice(start, start + size)
}
