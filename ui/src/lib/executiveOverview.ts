export const PERIOD_OPTIONS = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'last_7_days', label: 'Last 7 days' },
  { id: 'last_30_days', label: 'Last 30 days' },
  { id: 'this_month', label: 'This month' },
  { id: 'previous_month', label: 'Previous month' },
  { id: 'custom', label: 'Custom range' },
] as const

export const COMPARISON_OPTIONS = [
  { id: 'previous_period', label: 'Previous period' },
  { id: 'previous_day', label: 'Previous day' },
  { id: 'previous_week', label: 'Previous week' },
  { id: 'previous_month', label: 'Previous month' },
  { id: 'same_period_last_month', label: 'Same period last month' },
  { id: 'none', label: 'No comparison' },
] as const

export type OverviewFilters = {
  period: string
  comparison: string
  station: string
  product: string
  start: string
  end: string
  sort: string
}

export const DEFAULT_FILTERS: OverviewFilters = {
  period: 'today',
  comparison: 'previous_period',
  station: '',
  product: '',
  start: '',
  end: '',
  sort: 'sales',
}

export function parseOverviewFilters(search: URLSearchParams): OverviewFilters {
  const period = search.get('period') || DEFAULT_FILTERS.period
  return {
    period,
    comparison: search.get('comparison') || DEFAULT_FILTERS.comparison,
    station: search.get('station') || '',
    product: search.get('product') || '',
    start: search.get('start') || '',
    end: search.get('end') || '',
    sort: search.get('sort') || DEFAULT_FILTERS.sort,
  }
}

export function overviewSearchParams(filters: OverviewFilters): URLSearchParams {
  const next = new URLSearchParams()
  if (filters.period && filters.period !== DEFAULT_FILTERS.period) next.set('period', filters.period)
  if (filters.comparison && filters.comparison !== DEFAULT_FILTERS.comparison) {
    next.set('comparison', filters.comparison)
  }
  if (filters.station) next.set('station', filters.station)
  if (filters.product && filters.product !== 'all') next.set('product', filters.product)
  if (filters.period === 'custom' && filters.start) next.set('start', filters.start)
  if (filters.period === 'custom' && filters.end) next.set('end', filters.end)
  if (filters.sort && filters.sort !== DEFAULT_FILTERS.sort) next.set('sort', filters.sort)
  return next
}

export function num(value: number | string | null | undefined): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'Updated just now'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return 'Updated just now'
  const seconds = Math.max(0, Math.round((now - then) / 1000))
  if (seconds < 45) return 'Updated just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `Updated ${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `Updated ${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `Updated ${days} day${days === 1 ? '' : 's'} ago`
}

export type TrendDirection = 'up' | 'down' | 'flat'

export function trendFromPct(
  pct: number | string | null | undefined,
  favorableUp = true,
): { direction: TrendDirection; favorable: boolean | null } {
  const n = num(pct)
  if (n == null) return { direction: 'flat', favorable: null }
  if (n === 0) return { direction: 'flat', favorable: null }
  const up = n > 0
  const direction: TrendDirection = up ? 'up' : 'down'
  const favorable = favorableUp ? up : !up
  return { direction, favorable }
}

export function formatPct(pct: number | string | null | undefined): string | null {
  const n = num(pct)
  if (n == null) return null
  const abs = Math.abs(n).toFixed(1).replace(/\.0$/, '.0')
  return `${abs}%`
}
