import { fmtLiters, fmtNaira, type DayCloseRow } from '../../api/client'
import {
  financialStatus,
  financialVarianceAmount,
  formatFinancialVariance,
  statusBadge,
  workflowStatus,
} from '../../lib/reconciliationUi'

export default function StationReconciliationList({
  rows,
  selectedId,
  onSelect,
  loading,
}: {
  rows: DayCloseRow[]
  selectedId: string | null
  onSelect: (row: DayCloseRow) => void
  loading?: boolean
}) {
  return (
    <div className="card flex flex-col p-3">
      <div className="flex items-center justify-between px-2 pb-2">
        <h2 className="text-white font-semibold">Stations</h2>
        <span className="text-xs text-slate-500">{rows.length}</span>
      </div>
      {loading ? <p className="px-2 py-6 text-sm text-slate-500">Loading stations…</p> : null}
      {!loading && rows.length === 0 ? (
        <p className="px-2 py-8 text-sm text-slate-500 text-center">No stations for these filters</p>
      ) : null}
      <ul className="space-y-2 pr-1" role="listbox" aria-label="Stations">
        {rows.map((row) => {
          const selected = selectedId === row.stationId
          const variance = financialVarianceAmount(row)
          const fin = financialStatus(row)
          return (
            <li key={row.stationId}>
              <button
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => onSelect(row)}
                className={`w-full text-left rounded-xl border px-3 py-3 transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-500 ${
                  selected
                    ? 'bg-slate-800/90 border-emerald-500/50'
                    : 'bg-slate-900/40 border-slate-700 hover:bg-slate-800/60'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-white font-medium">{row.stationName}</div>
                    <div className="text-xs text-slate-500 font-mono">{row.stationCode}</div>
                  </div>
                  <span className="text-slate-500" aria-hidden>
                    ›
                  </span>
                </div>
                <div className="mt-2 flex justify-between gap-2 text-sm font-mono">
                  <span className="text-emerald-300">{fmtNaira(row.financial?.pumpSales ?? row.sales?.amount)}</span>
                  <span className="text-slate-400">
                    {fmtLiters(row.integrity?.pumpLiters ?? row.sales?.volumeLiters)}
                  </span>
                </div>
                <div className="mt-2 space-y-1 text-xs">
                  <div className="flex justify-between gap-2">
                    <span className="text-slate-500">Financial</span>
                    <span className={statusBadge(fin).className}>
                      {fin === 'WAITING'
                        ? 'WAITING'
                        : variance == null
                          ? fin
                          : `${fin} ${formatFinancialVariance(row)}`}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-slate-500">Integrity</span>
                    <span className={statusBadge(row.integrity?.status).className}>
                      {row.integrity?.status || 'WAITING'}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-slate-500">Inventory</span>
                    <span className={statusBadge(row.inventory?.status).className}>
                      {row.inventory?.status || 'INCOMPLETE'}
                    </span>
                  </div>
                </div>
                <div className="mt-2">
                  <span className={statusBadge(workflowStatus(row)).className}>{workflowStatus(row)}</span>
                </div>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
