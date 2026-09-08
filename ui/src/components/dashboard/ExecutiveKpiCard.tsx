import type { ReactNode } from 'react'
import { KPI_ACCENT, type KpiAccent } from './tokens'
import { IconTrendUp } from './icons'

type Props = {
  label: string
  value: string
  accent?: KpiAccent
  icon?: ReactNode
  hint?: string
  trend?: { label: string; direction?: 'up' | 'down' | 'flat' } | null
  className?: string
}

export default function ExecutiveKpiCard({
  label,
  value,
  accent = 'sales',
  icon,
  hint,
  trend,
  className = '',
}: Props) {
  const theme = KPI_ACCENT[accent]
  return (
    <article
      className={`relative overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/70 p-4 ${className}`}
    >
      <div
        className="absolute left-0 top-0 h-full w-0.5 rounded-l-2xl bg-slate-600"
        style={accent !== 'neutral' ? { backgroundColor: theme.accent } : undefined}
        aria-hidden
      />
      <div className="relative flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{label}</div>
          <div className="mt-2 text-2xl font-bold tracking-tight text-white sm:text-[1.65rem] leading-none truncate">
            {value || '—'}
          </div>
          {hint && <div className="mt-2 text-xs text-slate-500 truncate">{hint}</div>}
          {trend && (
            <div
              className={`mt-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                trend.direction === 'down'
                  ? 'bg-red-500/15 text-red-300'
                  : trend.direction === 'flat'
                    ? 'bg-slate-700/60 text-slate-300'
                    : 'bg-emerald-500/15 text-emerald-300'
              }`}
            >
              {trend.direction !== 'flat' && (
                <IconTrendUp className={`h-3 w-3 ${trend.direction === 'down' ? 'rotate-180' : ''}`} />
              )}
              {trend.label}
            </div>
          )}
        </div>
        {icon && (
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/5"
            style={{ backgroundColor: theme.glow, color: theme.accent }}
          >
            {icon}
          </div>
        )}
      </div>
    </article>
  )
}
