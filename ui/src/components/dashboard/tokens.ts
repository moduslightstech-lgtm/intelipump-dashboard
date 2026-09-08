/** Executive dashboard visual tokens — premium dark sales theme. */

export const DASH_COLORS = {
  bg: '#0b1220',
  panel: '#111827',
  panelElevated: '#152033',
  border: '#1e293b',
  muted: '#94a3b8',
  text: '#f1f5f9',
  sales: '#10b981',
  salesGlow: 'rgba(16, 185, 129, 0.18)',
  volume: '#22d3ee',
  volumeGlow: 'rgba(34, 211, 238, 0.16)',
  transactions: '#818cf8',
  transactionsGlow: 'rgba(129, 140, 248, 0.18)',
  ticket: '#f59e0b',
  ticketGlow: 'rgba(245, 158, 11, 0.16)',
  stations: '#2dd4bf',
  stationsGlow: 'rgba(45, 212, 191, 0.16)',
  online: '#34d399',
  onlineGlow: 'rgba(52, 211, 153, 0.16)',
  offline: '#f87171',
  offlineGlow: 'rgba(248, 113, 113, 0.16)',
  rejected: '#fb923c',
  rejectedGlow: 'rgba(251, 146, 60, 0.16)',
  critical: '#ef4444',
  warning: '#f59e0b',
  info: '#38bdf8',
  ok: '#22c55e',
} as const

export type KpiAccent =
  | 'neutral'
  | 'sales'
  | 'volume'
  | 'transactions'
  | 'ticket'
  | 'stations'
  | 'online'
  | 'offline'
  | 'rejected'
  | 'critical'
  | 'warning'
  | 'teal'
  | 'indigo'

export const KPI_ACCENT: Record<
  KpiAccent,
  { accent: string; glow: string; soft: string }
> = {
  neutral: { accent: '#64748b', glow: 'rgba(15,23,42,0.2)', soft: 'from-slate-800/40 to-transparent' },
  sales: { accent: DASH_COLORS.sales, glow: DASH_COLORS.salesGlow, soft: 'from-emerald-500/20 to-transparent' },
  volume: { accent: DASH_COLORS.volume, glow: DASH_COLORS.volumeGlow, soft: 'from-cyan-400/20 to-transparent' },
  transactions: {
    accent: DASH_COLORS.transactions,
    glow: DASH_COLORS.transactionsGlow,
    soft: 'from-indigo-400/20 to-transparent',
  },
  ticket: { accent: DASH_COLORS.ticket, glow: DASH_COLORS.ticketGlow, soft: 'from-amber-400/20 to-transparent' },
  stations: { accent: DASH_COLORS.stations, glow: DASH_COLORS.stationsGlow, soft: 'from-teal-400/20 to-transparent' },
  online: { accent: DASH_COLORS.online, glow: DASH_COLORS.onlineGlow, soft: 'from-emerald-400/15 to-transparent' },
  offline: { accent: DASH_COLORS.offline, glow: DASH_COLORS.offlineGlow, soft: 'from-red-400/20 to-transparent' },
  rejected: { accent: DASH_COLORS.rejected, glow: DASH_COLORS.rejectedGlow, soft: 'from-orange-400/20 to-transparent' },
  critical: { accent: DASH_COLORS.critical, glow: 'rgba(239,68,68,0.18)', soft: 'from-red-500/20 to-transparent' },
  warning: { accent: DASH_COLORS.warning, glow: DASH_COLORS.ticketGlow, soft: 'from-amber-500/20 to-transparent' },
  teal: { accent: DASH_COLORS.stations, glow: DASH_COLORS.stationsGlow, soft: 'from-teal-400/20 to-transparent' },
  indigo: {
    accent: DASH_COLORS.transactions,
    glow: DASH_COLORS.transactionsGlow,
    soft: 'from-indigo-400/20 to-transparent',
  },
}

export function productColor(product?: string | null): string {
  const p = (product || '').toUpperCase()
  if (p.includes('UNMAPPED') || p === 'UNKNOWN' || p === 'NOT MAPPED') return '#64748b'
  if (p.includes('AGO') || p.includes('DIESEL')) return '#f59e0b'
  if (p.includes('DPK') || p.includes('KEROSENE')) return '#8b5cf6'
  if (p.includes('LPG')) return '#14b8a6'
  if (p.includes('PMS') || p.includes('PETROL') || p.includes('GASOLINE')) return '#3b82f6'
  return '#64748b'
}
