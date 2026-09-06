import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  approveReconciliation,
  calculateReconciliation,
  createReconciliation,
  fmtNaira,
  getReconciliation,
  getReconciliationItems,
  getReconciliations,
  getStations,
  rejectReconciliation,
  reopenReconciliation,
  submitReconciliation,
  type ReconciliationItem,
  type ReconciliationRun,
} from '../api/client'

function todayLagos() {
  try {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' })
  } catch {
    return new Date().toISOString().slice(0, 10)
  }
}

function num(v: number | string | null | undefined) {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isNaN(n) ? null : n
}

function fmtNum(v: number | string | null | undefined) {
  const n = num(v)
  if (n == null) return '—'
  return n.toLocaleString('en-NG', { maximumFractionDigits: 2 })
}

function fmtPct(v: number | string | null | undefined) {
  const n = num(v)
  if (n == null) return '—'
  return `${n.toFixed(2)}%`
}

function statusBadge(status: string) {
  const s = status.toUpperCase()
  if (s === 'MATCHED' || s === 'APPROVED' || s === 'WITHIN_TOLERANCE') return 'badge-ok'
  if (s === 'VARIANCE' || s === 'REJECTED' || s === 'CRITICAL') return 'badge-critical'
  if (s === 'MISSING_DATA' || s === 'SUBMITTED' || s === 'IN_PROGRESS' || s === 'DRAFT') return 'badge-warn'
  return 'badge-info'
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat-card">
      <div className="label-text">{label}</div>
      <div className="text-xl font-bold text-white">{value}</div>
    </div>
  )
}

export default function ReconciliationsPage() {
  const qc = useQueryClient()
  const [businessDate, setBusinessDate] = useState(todayLagos)
  const [stationId, setStationId] = useState('')
  const [status, setStatus] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const stationsQ = useQuery({
    queryKey: ['stations'],
    queryFn: async () => (await getStations()).data,
  })

  const listParams = useMemo(
    () => ({
      business_date: businessDate || undefined,
      station_id: stationId || undefined,
      status: status || undefined,
    }),
    [businessDate, stationId, status],
  )

  const runsQ = useQuery({
    queryKey: ['reconciliations', listParams],
    queryFn: async () => (await getReconciliations(listParams)).data,
  })

  const detailQ = useQuery({
    queryKey: ['reconciliations', selectedId],
    queryFn: async () => (await getReconciliation(selectedId!)).data,
    enabled: !!selectedId,
  })

  const itemsQ = useQuery({
    queryKey: ['reconciliations', selectedId, 'items'],
    queryFn: async () => (await getReconciliationItems(selectedId!)).data,
    enabled: !!selectedId,
  })

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['reconciliations'] })
  }

  const createMut = useMutation({
    mutationFn: () =>
      createReconciliation({
        station_id: stationId,
        business_date: businessDate,
        reconciliation_type: 'DAILY',
      }),
    onSuccess: (res) => {
      invalidate()
      setSelectedId(res.data.id)
    },
  })

  const actionMut = useMutation({
    mutationFn: async ({
      action,
      id,
      comment,
    }: {
      action: 'calculate' | 'submit' | 'approve' | 'reject' | 'reopen'
      id: string
      comment?: string
    }) => {
      if (action === 'calculate') return calculateReconciliation(id)
      if (action === 'submit') return submitReconciliation(id, comment)
      if (action === 'approve') return approveReconciliation(id, comment)
      if (action === 'reject') return rejectReconciliation(id, comment)
      return reopenReconciliation(id, comment)
    },
    onSuccess: () => invalidate(),
  })

  const run: ReconciliationRun | undefined = detailQ.data
  const items: ReconciliationItem[] = itemsQ.data ?? run?.items ?? []

  const salesItem = items.find((i) => i.reference_type === 'CAPTURED_SALES')
  const paymentItems = items.filter((i) => i.reference_type === 'PAYMENT_SUMMARY')
  const expectedSales =
    num(salesItem?.expected_value) ??
    paymentItems.reduce((sum, i) => sum + (num(i.expected_value) ?? num(i.actual_value) ?? 0), 0)
  const capturedSales = num(salesItem?.actual_value)
  const salesVariance =
    num(salesItem?.variance_value) ??
    (expectedSales != null && capturedSales != null ? capturedSales - expectedSales : null)

  const matchedCount = items.filter((i) => {
    const s = i.status.toUpperCase()
    return s === 'MATCHED' || s === 'WITHIN_TOLERANCE' || s === 'OK'
  }).length
  const varianceCount = items.filter((i) => i.status.toUpperCase() === 'VARIANCE').length
  const missingCount = items.filter((i) => i.status.toUpperCase() === 'MISSING_DATA').length

  const askComment = (label: string) => window.prompt(`${label} comment (optional)`) ?? undefined

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="section-title">Reconciliations</h1>
          <p className="text-slate-400 text-sm mt-1">
            Daily sales variance runs · totalizers, payments, and tank checks
          </p>
        </div>
        {runsQ.isFetching && <span className="text-xs text-slate-500">Refreshing…</span>}
      </div>

      <div className="card grid md:grid-cols-4 gap-3">
        <div>
          <label className="label-text block mb-1">Business date</label>
          <input
            className="input w-full"
            type="date"
            value={businessDate}
            onChange={(e) => {
              setBusinessDate(e.target.value)
              setSelectedId(null)
            }}
          />
        </div>
        <div>
          <label className="label-text block mb-1">Station</label>
          <select
            className="input w-full"
            value={stationId}
            onChange={(e) => {
              setStationId(e.target.value)
              setSelectedId(null)
            }}
          >
            <option value="">All stations</option>
            {stationsQ.data?.map((s) => (
              <option key={s.id} value={s.station_code}>
                {s.name} ({s.station_code})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label-text block mb-1">Status</label>
          <select
            className="input w-full"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value)
              setSelectedId(null)
            }}
          >
            <option value="">All statuses</option>
            <option value="DRAFT">DRAFT</option>
            <option value="IN_PROGRESS">IN_PROGRESS</option>
            <option value="SUBMITTED">SUBMITTED</option>
            <option value="APPROVED">APPROVED</option>
            <option value="REJECTED">REJECTED</option>
          </select>
        </div>
        <div className="flex items-end">
          <button
            type="button"
            className="btn-primary w-full"
            disabled={!stationId || !businessDate || createMut.isPending}
            onClick={() => createMut.mutate()}
          >
            Create run
          </button>
        </div>
      </div>

      {selectedId && (
        <div className="card flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-secondary"
            disabled={actionMut.isPending}
            onClick={() => actionMut.mutate({ action: 'calculate', id: selectedId })}
          >
            Recalculate
          </button>
          <button
            type="button"
            className="btn-secondary"
            disabled={actionMut.isPending}
            onClick={() =>
              actionMut.mutate({ action: 'submit', id: selectedId, comment: askComment('Submit') })
            }
          >
            Submit
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={actionMut.isPending}
            onClick={() =>
              actionMut.mutate({ action: 'approve', id: selectedId, comment: askComment('Approve') })
            }
          >
            Approve
          </button>
          <button
            type="button"
            className="btn-secondary"
            disabled={actionMut.isPending}
            onClick={() =>
              actionMut.mutate({ action: 'reject', id: selectedId, comment: askComment('Reject') })
            }
          >
            Reject
          </button>
          <button
            type="button"
            className="btn-secondary"
            disabled={actionMut.isPending}
            onClick={() =>
              actionMut.mutate({ action: 'reopen', id: selectedId, comment: askComment('Reopen') })
            }
          >
            Reopen
          </button>
          {run && <span className={`${statusBadge(run.status)} ml-auto`}>{run.status}</span>}
        </div>
      )}

      {(createMut.isError || actionMut.isError || runsQ.isError) && (
        <div className="card border-red-800 text-red-300 text-sm" role="alert">
          {(createMut.error || actionMut.error || runsQ.error)?.toString() ||
            'Reconciliation request failed'}
        </div>
      )}

      {selectedId && (
        <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
          <Stat label="Expected sales" value={fmtNaira(expectedSales)} />
          <Stat label="Captured sales" value={fmtNaira(capturedSales)} />
          <Stat label="Sales variance" value={fmtNaira(salesVariance)} />
          <Stat label="Matched" value={String(matchedCount)} />
          <Stat label="Variance" value={String(varianceCount)} />
          <Stat label="Missing data" value={String(missingCount)} />
        </div>
      )}

      <div className="grid lg:grid-cols-3 gap-4">
        <div className="card overflow-x-auto">
          <h2 className="text-white font-semibold mb-3">Runs</h2>
          {(runsQ.data?.length ?? 0) === 0 && !runsQ.isLoading ? (
            <div className="py-12 text-center text-slate-500 text-sm">
              No reconciliation runs for these filters
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-400 border-b border-slate-700">
                  <th className="pb-2">Date</th>
                  <th className="pb-2">Station</th>
                  <th className="pb-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {runsQ.data?.map((r) => (
                  <tr
                    key={r.id}
                    className={`border-b border-slate-800 cursor-pointer hover:bg-slate-800/40 ${
                      selectedId === r.id ? 'bg-slate-800/60' : ''
                    }`}
                    onClick={() => setSelectedId(r.id)}
                  >
                    <td className="py-2 text-white whitespace-nowrap">{r.business_date}</td>
                    <td className="py-2 text-slate-300">{r.station_id}</td>
                    <td className="py-2">
                      <span className={statusBadge(r.status)}>{r.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="lg:col-span-2 card overflow-x-auto">
          <h2 className="text-white font-semibold mb-3">Line items</h2>
          {!selectedId ? (
            <div className="py-16 text-center text-slate-500 text-sm">Select a run to view items</div>
          ) : itemsQ.isLoading || detailQ.isLoading ? (
            <div className="py-16 text-center text-slate-500 text-sm">Loading items…</div>
          ) : items.length === 0 ? (
            <div className="py-16 text-center text-slate-500 text-sm">
              No items yet — click Recalculate
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-400 border-b border-slate-700">
                  <th className="pb-2">Station</th>
                  <th className="pb-2">Pump</th>
                  <th className="pb-2">Nozzle</th>
                  <th className="pb-2">Product</th>
                  <th className="pb-2 text-right">Opening</th>
                  <th className="pb-2 text-right">Closing</th>
                  <th className="pb-2 text-right">Expected</th>
                  <th className="pb-2 text-right">Actual</th>
                  <th className="pb-2 text-right">Variance</th>
                  <th className="pb-2 text-right">Var %</th>
                  <th className="pb-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const isVariance = item.status.toUpperCase() === 'VARIANCE'
                  return (
                    <tr
                      key={item.id}
                      className={`border-b border-slate-800 ${
                        isVariance ? 'bg-red-950/40 text-red-200' : ''
                      }`}
                    >
                      <td className="py-2 text-white">{item.station_id}</td>
                      <td className="py-2 font-mono text-slate-300">{item.pump_id || '—'}</td>
                      <td className="py-2 font-mono text-slate-300">{item.nozzle_id || '—'}</td>
                      <td className="py-2">{item.product || item.reference_type}</td>
                      <td className="py-2 text-right font-mono">{fmtNum(item.opening_value)}</td>
                      <td className="py-2 text-right font-mono">{fmtNum(item.closing_value)}</td>
                      <td className="py-2 text-right font-mono">{fmtNum(item.expected_value)}</td>
                      <td className="py-2 text-right font-mono">{fmtNum(item.actual_value)}</td>
                      <td className="py-2 text-right font-mono">{fmtNum(item.variance_value)}</td>
                      <td className="py-2 text-right font-mono">{fmtPct(item.variance_percentage)}</td>
                      <td className="py-2">
                        <span className={statusBadge(item.status)}>{item.status}</span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}
