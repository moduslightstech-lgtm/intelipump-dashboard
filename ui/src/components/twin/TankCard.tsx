import { fmtLiters, fmtTime } from '../../api/client'

type Props = { tank: Record<string, any> }

export default function TankCard({ tank }: Props) {
  const src = String(tank.measurementSource || tank.source || 'MANUAL').toUpperCase()
  const live = tank.isLiveTelemetry === true || src === 'AUTOMATED'
  const fill = Number(tank.fillPercent)
  const fillSafe = Number.isFinite(fill) ? Math.max(0, Math.min(100, fill)) : 0
  const product = String(tank.product || '').toUpperCase()
  const barColor =
    product.includes('AGO') || product.includes('DIESEL') ? 'bg-amber-700' : 'bg-blue-700'

  return (
    <article
      className="rounded-lg border border-slate-800 bg-slate-900/80 p-3"
      data-tank-id={tank.id}
      data-source={src}
    >
      <div className="flex justify-between gap-2 items-start">
        <div>
          <div className="text-sm font-semibold text-white">
            {tank.name || tank.tankCode}
          </div>
          <div className="text-[11px] text-slate-500 font-mono">{tank.tankCode}</div>
        </div>
        <span
          className={`text-[10px] uppercase tracking-wide font-semibold px-2 py-0.5 rounded border ${
            live
              ? 'border-emerald-700 text-emerald-300 bg-emerald-950/40'
              : 'border-amber-700 text-amber-200 bg-amber-950/40'
          }`}
        >
          {live
            ? 'Probe'
            : Number(tank.drawnLiters) > 0
              ? 'After sales'
              : 'Source: Manual'}
        </span>
      </div>

      <div className="mt-3 h-3 rounded-full bg-slate-800 overflow-hidden" aria-hidden>
        <div className={`h-full ${barColor}`} style={{ width: `${fillSafe}%` }} />
      </div>

      <div className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1 text-[11px]">
        <span className="text-slate-500">Product</span>
        <span className="text-slate-200 text-right">{tank.product || '—'}</span>
        <span className="text-slate-500">Capacity</span>
        <span className="text-slate-200 text-right">{fmtLiters(tank.capacityLiters)}</span>
        <span className="text-slate-500">Reported</span>
        <span className="text-slate-200 text-right">{fmtLiters(tank.reportedLiters)}</span>
        <span className="text-slate-500">Fill</span>
        <span className="text-slate-200 text-right">
          {Number.isFinite(fill) ? `${fillSafe.toFixed(1)}%` : '—'}
        </span>
        <span className="text-slate-500">Reading time</span>
        <span className="text-slate-400 text-right">{fmtTime(tank.measuredAt)}</span>
        <span className="text-slate-500">Submitted by</span>
        <span className="text-slate-400 text-right truncate">{tank.submittedBy || '—'}</span>
        <span className="text-slate-500">Freshness</span>
        <span className={`text-right ${tank.isStale ? 'text-amber-300' : 'text-emerald-400'}`}>
          {tank.isStale ? 'Stale' : 'OK'}
        </span>
      </div>
      {!live && Number(tank.drawnLiters) > 0 && (
        <p className="mt-2 text-[10px] text-slate-500">
          Last reading {fmtLiters(tank.baselineLiters)} minus {fmtLiters(tank.drawnLiters)} sold.
        </p>
      )}
      {!live && !(Number(tank.drawnLiters) > 0) && (
        <p className="mt-2 text-[10px] text-slate-500">
          Manual tank reading — not live probe telemetry.
        </p>
      )}
    </article>
  )
}
