import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  exportTransactionsUrl,
  fmtLiters,
  fmtTime,
  getStations,
  getTransactions,
  type Transaction,
} from '../api/client'
import { useAuth } from '../context/AuthContext'
import {
  SALES_HISTORY_FETCH_LIMIT,
  useStationLiveSales,
} from '../hooks/useStationLiveSales'
import {
  lagosDayEndIso,
  lagosDayStartIso,
  lagosToday,
  paginateItems,
  saleInDateRange,
} from '../lib/salesDateFilter'
import { liveStationId } from '../config/stations'
import { formatSaleAmount } from '../types/sales'

const PAGE_SIZE = 20

export default function TransactionsPage() {
  const { token } = useAuth()
  const [stationId, setStationId] = useState('')
  const [pumpId, setPumpId] = useState('')
  const [product, setProduct] = useState('')
  const [status, setStatus] = useState('')
  const [q, setQ] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [livePage, setLivePage] = useState(1)
  const [localPage, setLocalPage] = useState(1)
  const [selected, setSelected] = useState<Transaction | null>(null)

  const stationsQ = useQuery({
    queryKey: ['stations'],
    queryFn: async () => (await getStations()).data,
  })

  const catalogStations = stationsQ.data || []
  const selectedStation = useMemo(
    () => catalogStations.find((s) => s.station_code === stationId) || catalogStations[0],
    [catalogStations, stationId],
  )
  const liveStationKey = liveStationId(selectedStation)
  const stationFilterCode = stationId || selectedStation?.station_code || ''

  const live = useStationLiveSales({
    stationId: liveStationKey,
    enabled: Boolean(liveStationKey),
    recentLimit: SALES_HISTORY_FETCH_LIMIT,
  })

  const localParams = useMemo(() => {
    const start = dateFrom ? lagosDayStartIso(dateFrom) : undefined
    const end = dateTo ? lagosDayEndIso(dateTo) : undefined
    return {
      page: localPage,
      size: PAGE_SIZE,
      sort: 'received_at,desc',
      station_id: stationFilterCode || undefined,
      pump_id: pumpId || undefined,
      product: product || undefined,
      status: status || undefined,
      q: q || undefined,
      start,
      end,
    }
  }, [localPage, stationFilterCode, pumpId, product, status, q, dateFrom, dateTo])

  const txQ = useQuery({
    queryKey: ['transactions', localParams],
    queryFn: async () => (await getTransactions(localParams)).data,
  })

  const localTotalPages = Math.max(1, Math.ceil((txQ.data?.total || 0) / PAGE_SIZE))

  const resetPages = () => {
    setLivePage(1)
    setLocalPage(1)
  }

  const downloadCsv = () => {
    const url = exportTransactionsUrl({
      station_id: stationFilterCode || undefined,
      pump_id: pumpId || undefined,
      product: product || undefined,
      status: status || undefined,
      q: q || undefined,
      start: dateFrom ? lagosDayStartIso(dateFrom) : undefined,
      end: dateTo ? lagosDayEndIso(dateTo) : undefined,
    })
    const a = document.createElement('a')
    a.href = url
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

  const filteredLive = useMemo(() => {
    let rows = live.sales
    if (dateFrom || dateTo) {
      rows = rows.filter((s) => saleInDateRange(s.receivedAt, dateFrom || null, dateTo || null))
    }
    if (pumpId.trim()) {
      const p = pumpId.trim().toUpperCase()
      rows = rows.filter((s) => s.pumpId.toUpperCase().includes(p))
    }
    if (product.trim()) {
      const prod = product.trim().toUpperCase()
      rows = rows.filter((s) => (s.product || '').toUpperCase().includes(prod))
    }
    if (status.trim()) {
      const st = status.trim().toUpperCase()
      rows = rows.filter((s) => (s.status || '').toUpperCase() === st)
    }
    if (q.trim()) {
      const needle = q.trim().toLowerCase()
      rows = rows.filter((s) => s.transactionId.toLowerCase().includes(needle))
    }
    return rows
  }, [live.sales, pumpId, product, status, q, dateFrom, dateTo])

  const liveTotalPages = Math.max(1, Math.ceil(filteredLive.length / PAGE_SIZE))
  const safeLivePage = Math.min(livePage, liveTotalPages)
  const pagedLive = useMemo(
    () => paginateItems(filteredLive, safeLivePage, PAGE_SIZE),
    [filteredLive, safeLivePage],
  )

  const viewingHistorical = Boolean(dateFrom || dateTo)
  const rangeLabel =
    dateFrom || dateTo
      ? `${dateFrom || '…'} → ${dateTo || '…'} (Africa/Lagos)`
      : `latest ${SALES_HISTORY_FETCH_LIMIT} (live feed)`

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="section-title">Transactions</h1>
          <p className="text-slate-400 text-sm mt-1">
            Live and recent sales from the catalog station · filter by date, then page through results
          </p>
        </div>
        <button type="button" className="btn-secondary" onClick={downloadCsv}>
          Export CSV
        </button>
      </div>

      <div className="card grid md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7 gap-3">
        <select
          className="input"
          value={stationFilterCode}
          onChange={(e) => {
            setStationId(e.target.value)
            resetPages()
          }}
          aria-label="Station"
        >
          {catalogStations.length === 0 && <option value="">No stations yet</option>}
          {catalogStations.map((s) => (
            <option key={s.id} value={s.station_code}>
              {s.name}
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
              resetPages()
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
              resetPages()
            }}
          />
        </label>
        <input
          className="input"
          placeholder="Pump ID"
          value={pumpId}
          onChange={(e) => {
            setPumpId(e.target.value)
            resetPages()
          }}
        />
        <input
          className="input"
          placeholder="Product"
          value={product}
          onChange={(e) => {
            setProduct(e.target.value)
            resetPages()
          }}
        />
        <select
          className="input"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value)
            resetPages()
          }}
        >
          <option value="">All statuses</option>
          <option value="COMPLETED">COMPLETED</option>
          <option value="PENDING">PENDING</option>
        </select>
        <input
          className="input"
          placeholder="Search transaction ID"
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            resetPages()
          }}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-secondary text-xs"
          onClick={() => {
            const today = lagosToday()
            setDateFrom(today)
            setDateTo(today)
            resetPages()
          }}
        >
          Today
        </button>
        <button
          type="button"
          className="btn-secondary text-xs"
          onClick={() => {
            setDateFrom('')
            setDateTo('')
            resetPages()
          }}
        >
          Clear dates
        </button>
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-3">
        <Kpi
          label="Today’s sales"
          value={formatSaleAmount(live.summary?.totalAmount ?? null)}
        />
        <Kpi label="Liters today" value={fmtLiters(live.summary?.totalVolumeLiters)} />
        <Kpi label="Transactions" value={String(live.summary?.transactionCount ?? '—')} />
        <Kpi
          label="Average tx"
          value={formatSaleAmount(live.summary?.averageTransactionAmount ?? null)}
        />
        <Kpi
          label="Live stream"
          value={live.streamStatus}
          tone={live.streamStatus === 'LIVE' ? 'ok' : 'warn'}
        />
      </div>

      {live.restError && (
        <div className="card text-amber-300 text-sm" role="status">
          {live.restError} — keeping last successful live data.
        </div>
      )}

      <div className="card overflow-x-auto">
        <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
          <div>
            <h2 className="text-white font-semibold text-sm">
              {viewingHistorical ? 'Sales search' : 'Recent live sales'} ·{' '}
              {selectedStation?.name || liveStationKey || '—'}
            </h2>
            <p className="text-[11px] text-slate-500 mt-0.5">
              Showing {filteredLive.length ? (safeLivePage - 1) * PAGE_SIZE + 1 : 0}–
              {Math.min(safeLivePage * PAGE_SIZE, filteredLive.length)} of {filteredLive.length} ·{' '}
              {rangeLabel}
            </p>
          </div>
          <button type="button" className="btn-secondary text-xs" onClick={() => live.refresh()}>
            Refresh
          </button>
        </div>
        {live.isLoading && !live.sales.length ? (
          <div className="py-10 text-center text-slate-500 text-sm">Loading sales…</div>
        ) : filteredLive.length === 0 ? (
          <div className="py-10 text-center text-slate-500 text-sm">
            {viewingHistorical
              ? 'No sales match this date range or filters in the recent cloud feed (last ~500 transactions).'
              : 'No sales have been received for this station yet.'}
          </div>
        ) : (
          <>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-400 border-b border-slate-700">
                  <th className="pb-2">Time</th>
                  <th className="pb-2">Station</th>
                  <th className="pb-2">Pump</th>
                  <th className="pb-2">Nozzle</th>
                  <th className="pb-2">Product</th>
                  <th className="pb-2 text-right">Liters</th>
                  <th className="pb-2 text-right">Price/L</th>
                  <th className="pb-2 text-right">Amount</th>
                  <th className="pb-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {pagedLive.map((s) => (
                  <tr key={s.transactionId} className="border-b border-slate-800">
                    <td className="py-2 text-slate-400 whitespace-nowrap">{fmtTime(s.receivedAt)}</td>
                    <td className="py-2 font-mono text-xs">{s.stationId}</td>
                    <td className="py-2 font-mono">
                      {s.pumpId}
                      {live.unmappedPumpIds.includes(s.pumpId) ? (
                        <span className="ml-1 text-amber-400 text-[10px]">unmapped</span>
                      ) : null}
                    </td>
                    <td className="py-2 font-mono text-xs">{s.nozzleId || '—'}</td>
                    <td className="py-2">{s.product || '—'}</td>
                    <td className="py-2 text-right font-mono">{fmtLiters(s.volumeLiters)}</td>
                    <td className="py-2 text-right font-mono">
                      {formatSaleAmount(s.pricePerLiter)}
                    </td>
                    <td className="py-2 text-right font-mono text-emerald-400">
                      {formatSaleAmount(s.amount)}
                    </td>
                    <td className="py-2">{s.status || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex items-center justify-between mt-4 text-sm text-slate-400">
              <span>
                Page {safeLivePage} / {liveTotalPages}
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={safeLivePage <= 1}
                  onClick={() => setLivePage((p) => Math.max(1, p - 1))}
                >
                  Prev
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={safeLivePage >= liveTotalPages}
                  onClick={() => setLivePage((p) => p + 1)}
                >
                  Next
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      <details className="card">
        <summary className="text-sm text-slate-400 cursor-pointer">
          Local catalog transactions (paginated)
        </summary>
        <div className="mt-3 overflow-x-auto">
          {txQ.isError && (
            <div className="text-red-300 text-sm mb-2" role="alert">
              Failed to load local transactions.
            </div>
          )}
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-400 border-b border-slate-700">
                <th className="pb-2">ID</th>
                <th className="pb-2">Station</th>
                <th className="pb-2">Pump</th>
                <th className="pb-2">Product</th>
                <th className="pb-2 text-right">Volume</th>
                <th className="pb-2 text-right">Amount</th>
                <th className="pb-2">Received</th>
              </tr>
            </thead>
            <tbody>
              {txQ.data?.items.map((t) => (
                <tr
                  key={t.id}
                  className={`border-b border-slate-800 cursor-pointer hover:bg-slate-800/50 ${
                    selected?.id === t.id ? 'bg-slate-800' : ''
                  }`}
                  onClick={() => setSelected(t)}
                >
                  <td className="py-2 font-mono text-xs text-emerald-300 max-w-[120px] truncate">
                    {t.id}
                  </td>
                  <td className="py-2">{t.station_id}</td>
                  <td className="py-2 font-mono">{t.pump_id}</td>
                  <td className="py-2">{t.product || '—'}</td>
                  <td className="py-2 text-right font-mono">{fmtLiters(t.volume_liters)}</td>
                  <td className="py-2 text-right font-mono">{formatSaleAmount(t.amount)}</td>
                  <td className="py-2 text-slate-400 whitespace-nowrap">{fmtTime(t.received_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-between mt-4 text-sm text-slate-400">
            <span>{txQ.data?.total ?? 0} total</span>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn-secondary"
                disabled={localPage <= 1}
                onClick={() => setLocalPage((p) => p - 1)}
              >
                Prev
              </button>
              <span className="px-2 py-2">
                Page {localPage} / {localTotalPages}
              </span>
              <button
                type="button"
                className="btn-secondary"
                disabled={localPage >= localTotalPages}
                onClick={() => setLocalPage((p) => p + 1)}
              >
                Next
              </button>
            </div>
          </div>
        </div>
      </details>
    </div>
  )
}

function Kpi({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'ok' | 'warn'
}) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div
        className={`text-sm font-semibold ${
          tone === 'ok' ? 'text-emerald-400' : tone === 'warn' ? 'text-amber-300' : 'text-white'
        }`}
      >
        {value}
      </div>
    </div>
  )
}
