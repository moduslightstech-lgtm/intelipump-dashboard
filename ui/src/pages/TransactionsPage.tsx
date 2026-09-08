import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  exportTransactionsUrl,
  fmtLiters,
  fmtNaira,
  fmtTime,
  getStations,
  getTransactions,
  humanizeEnum,
  stationLabel,
  type Transaction,
} from '../api/client'
import { useAuth } from '../context/AuthContext'
import { stationDayEndIso, stationDayStartIso, stationToday } from '../lib/salesDateFilter'

const PAGE_SIZES = [10, 20, 50, 100]

function statusBadge(status?: string | null) {
  const s = (status || '').toUpperCase()
  if (s === 'COMPLETED') return 'badge-ok'
  if (s === 'DISPENSING' || s === 'IN_PROGRESS') return 'badge-open'
  if (s === 'REJECTED' || s === 'FAILED') return 'badge-critical'
  if (s === 'PENDING') return 'badge-warn'
  return 'badge-info'
}

export default function TransactionsPage() {
  const { token } = useAuth()
  const [stationId, setStationId] = useState('')
  const [pumpId, setPumpId] = useState('')
  const [product, setProduct] = useState('')
  const [status, setStatus] = useState('')
  const [q, setQ] = useState('')
  const [dateFrom, setDateFrom] = useState(() => stationToday())
  const [dateTo, setDateTo] = useState(() => stationToday())
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [selected, setSelected] = useState<Transaction | null>(null)

  const stationsQ = useQuery({
    queryKey: ['stations'],
    queryFn: async () => (await getStations()).data,
  })

  const catalogStations = stationsQ.data || []
  const selectedStation = useMemo(
    () => catalogStations.find((s) => s.station_code === stationId || s.id === stationId) || catalogStations[0],
    [catalogStations, stationId],
  )
  const stationFilter = stationId || selectedStation?.station_code || selectedStation?.mqtt_station_id || ''
  const tz = selectedStation?.timezone || 'Africa/Lagos'

  const params = useMemo(
    () => ({
      page,
      size: pageSize,
      sort: 'received_at,desc',
      station_id: stationFilter || undefined,
      pump_id: pumpId || undefined,
      product: product || undefined,
      status: status || undefined,
      q: q || undefined,
      start: dateFrom ? stationDayStartIso(dateFrom, tz) : undefined,
      end: dateTo ? stationDayEndIso(dateTo, tz) : undefined,
    }),
    [page, pageSize, stationFilter, pumpId, product, status, q, dateFrom, dateTo, tz],
  )

  const txQ = useQuery({
    queryKey: ['transactions', params],
    queryFn: async () => (await getTransactions(params)).data,
  })

  const total = txQ.data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const items = txQ.data?.items || []

  const resetPage = () => setPage(1)

  const downloadCsv = () => {
    const url = exportTransactionsUrl({
      station_id: stationFilter || undefined,
      pump_id: pumpId || undefined,
      product: product || undefined,
      status: status || undefined,
      q: q || undefined,
      start: dateFrom ? stationDayStartIso(dateFrom, tz) : undefined,
      end: dateTo ? stationDayEndIso(dateTo, tz) : undefined,
    })
    const a = document.createElement('a')
    a.setAttribute('download', 'transactions.csv')
    fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.blob())
      .then((blob) => {
        const objectUrl = URL.createObjectURL(blob)
        a.href = objectUrl
        a.click()
        URL.revokeObjectURL(objectUrl)
      })
      .catch(() => alert('Export failed'))
  }

  const rangeLabel =
    dateFrom || dateTo
      ? `${dateFrom || '…'} → ${dateTo || '…'} (${tz})`
      : `All dates (${tz})`

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-[1600px]">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="section-title">Transactions</h1>
          <p className="text-slate-400 text-sm mt-1">
            Sales for the selected date range and station timezone. KPI cards use the same filters as the table.
          </p>
        </div>
        <button type="button" className="btn-secondary" onClick={downloadCsv}>
          Export CSV
        </button>
      </div>

      <div className="card grid md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7 gap-3 sticky top-0 z-10 bg-slate-800">
        <select
          className="input"
          value={selectedStation?.station_code || ''}
          onChange={(e) => {
            setStationId(e.target.value)
            resetPage()
          }}
          aria-label="Station"
        >
          {catalogStations.length === 0 && <option value="">No stations yet</option>}
          {catalogStations.map((s) => (
            <option key={s.id} value={s.station_code}>
              {stationLabel(s)}
            </option>
          ))}
        </select>
        <label className="block text-xs text-slate-400">
          From date
          <input
            type="date"
            className="input mt-1 w-full"
            value={dateFrom}
            max={dateTo || undefined}
            onChange={(e) => {
              setDateFrom(e.target.value)
              resetPage()
            }}
          />
        </label>
        <label className="block text-xs text-slate-400">
          To date
          <input
            type="date"
            className="input mt-1 w-full"
            value={dateTo}
            min={dateFrom || undefined}
            onChange={(e) => {
              setDateTo(e.target.value)
              resetPage()
            }}
          />
        </label>
        <input
          className="input"
          placeholder="Pump ID"
          value={pumpId}
          onChange={(e) => {
            setPumpId(e.target.value)
            resetPage()
          }}
        />
        <input
          className="input"
          placeholder="Product"
          value={product}
          onChange={(e) => {
            setProduct(e.target.value)
            resetPage()
          }}
        />
        <select
          className="input"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value)
            resetPage()
          }}
        >
          <option value="">All statuses</option>
          <option value="COMPLETED">Completed</option>
          <option value="DISPENSING">Dispensing</option>
          <option value="PENDING">Pending</option>
          <option value="REJECTED">Rejected</option>
        </select>
        <input
          className="input"
          placeholder="Search transaction ID"
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            resetPage()
          }}
        />
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi label={`Sales (${rangeLabel})`} value={fmtNaira(txQ.data?.total_amount)} />
        <Kpi label="Volume" value={fmtLiters(txQ.data?.total_volume)} />
        <Kpi label="Transactions" value={String(total)} />
        <Kpi label="Average" value={fmtNaira(txQ.data?.average_amount)} />
      </div>

      <div className="card overflow-x-auto">
        <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
          <h2 className="text-white font-semibold text-sm">
            {stationLabel(selectedStation)} · {rangeLabel}
          </h2>
          <label className="text-xs text-slate-400">
            Page size
            <select
              className="input ml-2 w-auto"
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value))
                resetPage()
              }}
            >
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </div>

        {txQ.isLoading ? (
          <div className="space-y-2" aria-busy="true">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-8 rounded bg-slate-800 animate-pulse" />
            ))}
          </div>
        ) : txQ.isError ? (
          <div className="py-10 text-center" role="alert">
            <p className="text-red-300 text-sm mb-3">Could not load transactions.</p>
            <button type="button" className="btn-secondary" onClick={() => txQ.refetch()}>
              Retry
            </button>
          </div>
        ) : items.length === 0 ? (
          <div className="py-10 text-center text-slate-500 text-sm">
            No transactions match this station, date range, and filters.
          </div>
        ) : (
          <table className="w-full text-sm table-fixed min-w-[960px]">
            <thead>
              <tr className="text-slate-400 border-b border-slate-700">
                <th className="py-2 pr-3 text-left w-[12%]">Time</th>
                <th className="py-2 pr-3 text-left w-[14%]">Station</th>
                <th className="py-2 pr-3 text-left w-[10%]">Pump</th>
                <th className="py-2 pr-3 text-left w-[8%]">Product</th>
                <th className="py-2 pr-3 text-right w-[9%]">Volume</th>
                <th className="py-2 pr-3 text-right w-[9%]">Unit price</th>
                <th className="py-2 pr-3 text-right w-[11%]">Amount</th>
                <th className="py-2 pr-3 text-left w-[10%]">Status</th>
                <th className="py-2 pr-3 text-left w-[10%]">Issues</th>
                <th className="py-2 text-right w-[7%]">Details</th>
              </tr>
            </thead>
            <tbody>
              {items.map((t) => {
                const mappedProduct = Boolean(t.product)
                const mappedNozzle = Boolean(t.nozzle_id)
                return (
                  <tr key={t.id} className="border-b border-slate-800" data-testid="tx-row">
                    <td className="py-2 pr-3 text-slate-400 whitespace-nowrap">{fmtTime(t.received_at, tz)}</td>
                    <td className="py-2 pr-3 truncate" title={t.station_id}>
                      {stationLabel(selectedStation)}
                    </td>
                    <td className="py-2 pr-3 font-mono">{t.pump_id}</td>
                    <td className="py-2 pr-3">
                      {mappedProduct ? (
                        t.product
                      ) : (
                        <span className="text-amber-300" title="No product mapping for this nozzle or sale">
                          Not mapped
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono tabular-nums">{fmtLiters(t.volume_liters)}</td>
                    <td className="py-2 pr-3 text-right font-mono tabular-nums">{fmtNaira(t.price_per_liter)}</td>
                    <td className="py-2 pr-3 text-right font-mono tabular-nums text-emerald-400" data-testid="tx-amount">
                      {fmtNaira(t.amount)}
                    </td>
                    <td className="py-2 pr-3" data-testid="tx-status">
                      <span className={statusBadge(t.status)}>{humanizeEnum(t.status)}</span>
                    </td>
                    <td className="py-2 pr-3">
                      {!mappedProduct || !mappedNozzle ? (
                        <span className="badge-warn" title="Missing product or nozzle mapping">
                          Not mapped
                        </span>
                      ) : (
                        <span className="text-slate-600">—</span>
                      )}
                    </td>
                    <td className="py-2 text-right">
                      <button type="button" className="btn-secondary text-xs px-2 py-1" onClick={() => setSelected(t)}>
                        Details
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}

        <div className="flex items-center justify-between mt-4 text-sm text-slate-400">
          <span>
            {total ? (page - 1) * pageSize + 1 : 0}–{Math.min(page * pageSize, total)} of {total}
          </span>
          <div className="flex gap-2">
            <button type="button" className="btn-secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Previous
            </button>
            <span className="px-2 py-2">
              Page {page} / {totalPages}
            </span>
            <button
              type="button"
              className="btn-secondary"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        </div>
      </div>

      {selected && (
        <div className="card text-sm space-y-1" role="region" aria-label="Transaction details">
          <div className="flex justify-between">
            <h3 className="text-white font-semibold">Transaction details</h3>
            <button type="button" className="btn-secondary text-xs" onClick={() => setSelected(null)}>
              Close
            </button>
          </div>
          <p className="font-mono text-xs text-slate-400 break-all">ID {selected.id}</p>
          <p>Nozzle: {selected.nozzle_id || 'Not mapped'}</p>
          <p>Device: {selected.device_id || '—'}</p>
          <p>MQTT station id: {selected.station_id}</p>
        </div>
      )}
    </div>
  )
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-sm font-semibold text-white">{value}</div>
    </div>
  )
}
