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

/** Start of calendar day as UTC ISO for API `start`. */
export function stationDayStartIso(dateYmd: string, timeZone = SALES_TZ): string {
  return new Date(`${dateYmd}T00:00:00${offsetIso(dateYmd, timeZone)}`).toISOString()
}

/** End of calendar day as UTC ISO for API `end`. */
export function stationDayEndIso(dateYmd: string, timeZone = SALES_TZ): string {
  return new Date(`${dateYmd}T23:59:59.999${offsetIso(dateYmd, timeZone)}`).toISOString()
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
