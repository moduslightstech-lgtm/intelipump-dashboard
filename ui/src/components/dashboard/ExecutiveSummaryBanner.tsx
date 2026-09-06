import type { ReactNode } from 'react'
import { fmtLiters, fmtNaira } from '../../api/client'
import { IconAlert, IconBuilding, IconCheck, IconCurrency, IconDroplet } from './icons'

type Props = {
  salesToday?: number | null
  salesMonth?: number | null
  litersToday?: number | null
  bestStation?: string | null
  reconHealthy?: boolean | null
  reconLabel?: string | null
  criticalAlerts?: number | null
  businessDate?: string | null
  timezone?: string | null
  children?: ReactNode
}

function HeroMetric({
  label,
  value,
  icon,
  accent,
}: {
  label: string
  value: string
  icon: ReactNode
  accent: string
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-lg" style={{ color: accent, background: `${accent}22` }}>
          {icon}
        </span>
        {label}
      </div>
      <div className="mt-2 truncate text-xl font-bold text-white sm:text-2xl lg:text-3xl tracking-tight">{value}</div>
    </div>
  )
}

export default function ExecutiveSummaryBanner({
  salesToday,
  salesMonth,
  litersToday,
  bestStation,
  reconHealthy,
  reconLabel,
  criticalAlerts,
  businessDate,
  timezone,
}: Props) {
  const critical = Number(criticalAlerts || 0)
  return (
    <section className="relative overflow-hidden rounded-2xl border border-emerald-500/20 bg-gradient-to-br from-emerald-950/50 via-slate-900 to-slate-950 p-5 sm:p-6 shadow-[0_20px_60px_rgba(16,185,129,0.12)]">
      <div
        className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-emerald-500/10 blur-3xl"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute -bottom-24 left-1/3 h-48 w-48 rounded-full bg-cyan-500/10 blur-3xl"
        aria-hidden
      />
      <div className="relative flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-300/90">
            Executive performance
          </p>
          <h2 className="mt-1 text-lg font-bold text-white sm:text-xl">Today&apos;s business pulse</h2>
          <p className="mt-1 text-xs text-slate-400">
            {businessDate || '—'} · {timezone || 'Africa/Lagos'}
          </p>
        </div>
        <div
          className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold ${
            critical > 0
              ? 'border-red-500/40 bg-red-500/10 text-red-300'
              : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
          }`}
        >
          {critical > 0 ? <IconAlert className="h-3.5 w-3.5" /> : <IconCheck className="h-3.5 w-3.5" />}
          {critical > 0 ? `${critical} critical alert${critical === 1 ? '' : 's'}` : 'No critical alerts'}
        </div>
      </div>

      <div className="relative mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <HeroMetric
          label="Sales today"
          value={fmtNaira(salesToday)}
          icon={<IconCurrency className="h-3.5 w-3.5" />}
          accent="#10b981"
        />
        <HeroMetric
          label="Month to date"
          value={fmtNaira(salesMonth)}
          icon={<IconCurrency className="h-3.5 w-3.5" />}
          accent="#34d399"
        />
        <HeroMetric
          label="Liters today"
          value={fmtLiters(litersToday)}
          icon={<IconDroplet className="h-3.5 w-3.5" />}
          accent="#22d3ee"
        />
        <HeroMetric
          label="Top station"
          value={bestStation || '—'}
          icon={<IconBuilding className="h-3.5 w-3.5" />}
          accent="#818cf8"
        />
        <HeroMetric
          label="Reconciliation"
          value={reconLabel || (reconHealthy ? 'Healthy' : 'Needs review')}
          icon={<IconCheck className="h-3.5 w-3.5" />}
          accent={reconHealthy === false ? '#f59e0b' : '#2dd4bf'}
        />
        <HeroMetric
          label="Critical alerts"
          value={String(criticalAlerts ?? 0)}
          icon={<IconAlert className="h-3.5 w-3.5" />}
          accent={critical > 0 ? '#ef4444' : '#22c55e'}
        />
      </div>
    </section>
  )
}
