import { productPipeColor } from '../pipe/pipeTheme'

const STATUS = [
  { label: 'Idle', color: '#3b82f6' },
  { label: 'Dispensing', color: '#22c55e' },
  { label: 'Powered off', color: '#64748b' },
  { label: 'Fault', color: '#ef4444' },
  { label: 'Offline', color: '#b91c1c' },
  { label: 'Inactive', color: '#475569' },
]

type Props = {
  products: string[]
}

export default function SchematicLegend({ products }: Props) {
  const uniq = Array.from(new Set(products.filter(Boolean)))
  const fuel = uniq.length
    ? uniq
    : ['PMS', 'AGO', 'DPK']
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 text-[11px] text-slate-400">
      <div>
        <div className="mb-1 font-semibold uppercase tracking-wide text-slate-500">Equipment status</div>
        <div className="flex flex-wrap gap-3">
          {STATUS.map((s) => (
            <span key={s.label} className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-full" style={{ background: s.color }} aria-hidden />
              {s.label}
            </span>
          ))}
        </div>
      </div>
      <div>
        <div className="mb-1 font-semibold uppercase tracking-wide text-slate-500">Fuel / product pipes</div>
        <div className="flex flex-wrap gap-3">
          {fuel.map((p) => (
            <span key={p} className="inline-flex items-center gap-1">
              <span className="h-0.5 w-4 rounded" style={{ background: productPipeColor(p) }} aria-hidden />
              <span className="text-slate-300">{pipeLabel(p)}</span>
            </span>
          ))}
          <span className="inline-flex items-center gap-1 text-slate-500">
            <span className="w-4 border-t border-dashed border-slate-400" aria-hidden />
            Backup
          </span>
        </div>
      </div>
    </div>
  )
}

function pipeLabel(product: string): string {
  const p = product.toUpperCase()
  if (p.includes('AGO') || p.includes('DIESEL')) return 'AGO/Diesel'
  if (p.includes('DPK') || p.includes('KEROSENE')) return 'DPK/Kerosene'
  if (p.includes('PMS') || p.includes('PETROL')) return 'PMS'
  return product
}
