import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

type Props = {
  title: string
  action?: { to: string; label: string }
  children: ReactNode
  className?: string
  bodyClassName?: string
}

export default function DashboardPanel({
  title,
  action,
  children,
  className = '',
  bodyClassName = '',
}: Props) {
  return (
    <section
      className={`rounded-2xl border border-slate-700/80 bg-gradient-to-b from-slate-900/95 to-slate-950/90 p-5 shadow-[0_10px_40px_rgba(0,0,0,0.28)] ${className}`}
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-wide text-white sm:text-base">{title}</h2>
        {action && (
          <Link to={action.to} className="text-xs font-medium text-emerald-400 hover:text-emerald-300">
            {action.label}
          </Link>
        )}
      </div>
      <div className={bodyClassName}>{children}</div>
    </section>
  )
}
