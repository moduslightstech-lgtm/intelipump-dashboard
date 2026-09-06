/** Calendar date helpers for sales filtering (Africa/Lagos business day). */

export const SALES_TZ = 'Africa/Lagos'

export function lagosToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: SALES_TZ })
}

/** YYYY-MM-DD in Africa/Lagos for an ISO timestamp. */
export function toLagosDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-CA', { timeZone: SALES_TZ })
}

/** Inclusive calendar-date filter using Africa/Lagos dates. */
export function saleInDateRange(
  receivedAt: string,
  dateFrom?: string | null,
  dateTo?: string | null,
): boolean {
  const day = toLagosDate(receivedAt)
  if (!day) return false
  if (dateFrom && day < dateFrom) return false
  if (dateTo && day > dateTo) return false
  return true
}

/** Start of Lagos calendar day as UTC ISO (for local API `start`). */
export function lagosDayStartIso(dateYmd: string): string {
  return new Date(`${dateYmd}T00:00:00+01:00`).toISOString()
}

/** End of Lagos calendar day as UTC ISO (for local API `end`). */
export function lagosDayEndIso(dateYmd: string): string {
  return new Date(`${dateYmd}T23:59:59.999+01:00`).toISOString()
}

export function paginateItems<T>(items: T[], page: number, pageSize: number): T[] {
  const p = Math.max(1, page)
  const size = Math.max(1, pageSize)
  const start = (p - 1) * size
  return items.slice(start, start + size)
}
