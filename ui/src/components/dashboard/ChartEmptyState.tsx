import type { ReactNode } from 'react'
import { IconInbox } from './icons'

type Props = {
  title: string
  description?: string
  icon?: ReactNode
  className?: string
}

export default function ChartEmptyState({
  title,
  description,
  icon,
  className = '',
}: Props) {
  return (
    <div
      className={`flex min-h-[11rem] flex-col items-center justify-center rounded-xl border border-dashed border-slate-700/80 bg-slate-950/40 px-6 py-8 text-center ${className}`}
    >
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-800/80 text-slate-400">
        {icon || <IconInbox className="h-6 w-6" />}
      </div>
      <div className="text-sm font-medium text-slate-300">{title}</div>
      {description && <p className="mt-1 max-w-xs text-xs leading-relaxed text-slate-500">{description}</p>}
    </div>
  )
}
