import type { ReactNode } from 'react'
import { IconInbox } from './icons'

type Props = {
  title: string
  description?: string
  icon?: ReactNode
  className?: string
  compact?: boolean
  actions?: ReactNode
}

export default function ChartEmptyState({
  title,
  description,
  icon,
  className = '',
  compact = false,
  actions,
}: Props) {
  return (
    <div
      className={`flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-700/80 bg-slate-950/40 text-center ${
        compact ? 'min-h-[4.5rem] px-4 py-4' : 'min-h-[11rem] px-6 py-8'
      } ${className}`}
    >
      {!compact && (
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-800/80 text-slate-400">
          {icon || <IconInbox className="h-6 w-6" />}
        </div>
      )}
      <div className="text-sm font-medium text-slate-300">{title}</div>
      {description && <p className="mt-1 max-w-md text-xs leading-relaxed text-slate-500">{description}</p>}
      {actions && <div className="mt-3 flex flex-wrap justify-center gap-2">{actions}</div>}
    </div>
  )
}
