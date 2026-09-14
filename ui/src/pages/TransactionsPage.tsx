import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import {
  exportTransactionsUrl,
  fmtLiters,
  fmtNaira,
  fmtTime,
  getStations,
  getTransactions,
  stationLabel,
  type Transaction,
} from '../api/client'
import { CompactInput, CompactSelect } from '../components/forms/CompactFields'
import { useAuth } from '../context/AuthContext'
import { formatStatusLabel } from '../lib/enumPresentation'
import {
  stationRangeToUtcIso,
  stationToday,
  validateMoneyRange,
} from '../lib/salesDateFilter'
import {
  formatClockLabel,
  formatSalesRangeHeading,
  NIGERIA_TZ,
  timezonePlainLabel,
} from '../lib/timezoneDisplay'

const PAGE_SIZES = [10, 20, 50, 100]

function statusBadge(status?: string | null) {
  const s = (status || '').toUpperCase()
  if (s === 'COMPLETED') return 'badge-ok'
  if (s === 'DISPENSING' || s === 'IN_PROGRESS') return 'badge-open'
  if (s === 'REJECTED' || s === 'FAILED') return 'badge-critical'
  if (s === 'PENDING') return 'badge-warn'
  return 'badge-info'
}

function readParam(sp: URLSearchParams, key: string, fallback = '') {
  return sp.get(key) ?? fallback
}

export default function TransactionsPage() {
  const { token } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const [moreFilters, setMoreFilters] = useState(false)
  const [selected, setSelected] = useState<Transaction | null>(null)
  const [filterError, setFilterError] = useState<string | null>(null)

  const today = stationToday(NIGERIA_TZ)

  // Draft filter fields (applied on Apply / Enter)
  const [stationId, setStationId] = useState(() => readParam(searchParams, 'station'))
  const [dateFrom, setDateFrom] = useState(() => readParam(searchParams, 'from', today))
  const [dateTo, setDateTo] = useState(() => readParam(searchParams, 'to', today))
  const [fromTime, setFromTime] = useState(() => readParam(searchParams, 'fromTime'))
  const [toTime, setToTime] = useState(() => readParam(searchParams, 'toTime'))
  const [status, setStatus] = useState(() => readParam(searchParams, 'status'))
  const [q, setQ] = useState(() => readParam(searchParams, 'q'))
  const [minAmount, setMinAmount] = useState(() => readParam(searchParams, 'minAmount'))
  const [maxAmount, setMaxAmount] = useState(() => readParam(searchParams, 'maxAmount'))
  const [minUnitPrice, setMinUnitPrice] = useState(() => readParam(searchParams, 'minUnitPrice'))
  const [maxUnitPrice, setMaxUnitPrice] = useState(() => readParam(searchParams, 'maxUnitPrice'))
  const [page, setPage] = useState(() => Math.max(1, Number(readParam(searchParams, 'page', '1')) || 1))
  const [pageSize, setPageSize] = useState(() => {
    const n = Number(readParam(searchParams, 'size', '20'))
    return PAGE_SIZES.includes(n) ? n : 20
  })

  // Applied snapshot used for queries
  const [applied, setApplied] = useState(() => ({
    stationId: readParam(searchParams, 'station'),
    dateFrom: readParam(searchParams, 'from', today),
    dateTo: readParam(searchParams, 'to', today),
    fromTime: readParam(searchParams, 'fromTime'),
    toTime: readParam(searchParams, 'toTime'),
    status: readParam(searchParams, 'status'),
    q: readParam(searchParams, 'q'),
    minAmount: readParam(searchParams, 'minAmount'),
    maxAmount: readParam(searchParams, 'maxAmount'),
    minUnitPrice: readParam(searchParams, 'minUnitPrice'),
    maxUnitPrice: readParam(searchParams, 'maxUnitPrice'),
  }))

  const stationsQ = useQuery({
    queryKey: ['stations'],
    queryFn: async () => (await getStations()).data,
  })

  const catalogStations = stationsQ.data || []
  const selectedStation = useMemo(
    () =>
      catalogStations.find(
        (s) =>
          s.station_code === (applied.stationId || stationId) ||
          s.id === (applied.stationId || stationId),
      ) || catalogStations[0],
    [catalogStations, applied.stationId, stationId],
  )
  const stationFilter =
    applied.stationId || selectedStation?.station_code || selectedStation?.mqtt_station_id || ''
  const tz = selectedStation?.timezone || NIGERIA_TZ

  const moneyAmt = validateMoneyRange(applied.minAmount, applied.maxAmount, 'Sale amount')
  const moneyPrice = validateMoneyRange(applied.minUnitPrice, applied.maxUnitPrice, 'Unit price')
  const range = stationRangeToUtcIso({
    dateFrom: applied.dateFrom,
    dateTo: applied.dateTo,
    fromTime: applied.fromTime,
    toTime: applied.toTime,
    timeZone: tz,
  })

  const params = useMemo(() => {
    const err = moneyAmt.error || moneyPrice.error || range.error
    if (err) return null
    return {
      page,
      size: pageSize,
      sort: 'received_at,desc',
      station_id: stationFilter || undefined,
      status: applied.status || undefined,
      q: applied.q || undefined,
      date_from: applied.dateFrom || undefined,
      date_to: applied.dateTo || undefined,
      from_time: applied.fromTime || undefined,
      to_time: applied.toTime || undefined,
      timezone: tz,
      min_amount: moneyAmt.min != null ? String(moneyAmt.min) : undefined,
      max_amount: moneyAmt.max != null ? String(moneyAmt.max) : undefined,
      min_unit_price: moneyPrice.min != null ? String(moneyPrice.min) : undefined,
      max_unit_price: moneyPrice.max != null ? String(moneyPrice.max) : undefined,
    }
  }, [
    page,
    pageSize,
    stationFilter,
    applied,
    tz,
    moneyAmt.error,
    moneyAmt.min,
    moneyAmt.max,
    moneyPrice.error,
    moneyPrice.min,
    moneyPrice.max,
    range.error,
  ])

  const txQ = useQuery({
    queryKey: ['transactions', params],
    queryFn: async () => (await getTransactions(params || {})).data,
    enabled: Boolean(params),
  })

  const syncUrl = useCallback(
    (next: typeof applied, nextPage: number, nextSize: number) => {
      const sp = new URLSearchParams()
      if (next.stationId) sp.set('station', next.stationId)
      if (next.dateFrom) sp.set('from', next.dateFrom)
      if (next.dateTo) sp.set('to', next.dateTo)
      if (next.fromTime) sp.set('fromTime', next.fromTime)
      if (next.toTime) sp.set('toTime', next.toTime)
      if (next.status) sp.set('status', next.status)
      if (next.q) sp.set('q', next.q)
      if (next.minAmount) sp.set('minAmount', next.minAmount)
      if (next.maxAmount) sp.set('maxAmount', next.maxAmount)
      if (next.minUnitPrice) sp.set('minUnitPrice', next.minUnitPrice)
      if (next.maxUnitPrice) sp.set('maxUnitPrice', next.maxUnitPrice)
      if (nextPage > 1) sp.set('page', String(nextPage))
      if (nextSize !== 20) sp.set('size', String(nextSize))
      setSearchParams(sp, { replace: true })
    },
    [setSearchParams],
  )

  const applyFilters = (opts?: { page?: number }) => {
    const draft = {
      stationId: stationId || selectedStation?.station_code || '',
      dateFrom,
      dateTo,
      fromTime,
      toTime,
      status,
      q: q.trim(),
      minAmount: minAmount.trim(),
      maxAmount: maxAmount.trim(),
      minUnitPrice: minUnitPrice.trim(),
      maxUnitPrice: maxUnitPrice.trim(),
    }
    const amt = validateMoneyRange(draft.minAmount, draft.maxAmount, 'Sale amount')
    const price = validateMoneyRange(draft.minUnitPrice, draft.maxUnitPrice, 'Unit price')
    const win = stationRangeToUtcIso({
      dateFrom: draft.dateFrom,
      dateTo: draft.dateTo,
      fromTime: draft.fromTime,
      toTime: draft.toTime,
      timeZone: selectedStation?.timezone || NIGERIA_TZ,
    })
    const err = amt.error || price.error || win.error || null
    setFilterError(err)
    if (err) return
    const nextPage = opts?.page ?? 1
    setApplied(draft)
    setPage(nextPage)
    syncUrl(draft, nextPage, pageSize)
  }

  const clearFilters = () => {
    const day = stationToday(selectedStation?.timezone || NIGERIA_TZ)
    setStationId(selectedStation?.station_code || '')
    setDateFrom(day)
    setDateTo(day)
    setFromTime('')
    setToTime('')
    setStatus('')
    setQ('')
    setMinAmount('')
    setMaxAmount('')
    setMinUnitPrice('')
    setMaxUnitPrice('')
    setFilterError(null)
    const draft = {
      stationId: selectedStation?.station_code || '',
      dateFrom: day,
      dateTo: day,
      fromTime: '',
      toTime: '',
      status: '',
      q: '',
      minAmount: '',
      maxAmount: '',
      minUnitPrice: '',
      maxUnitPrice: '',
    }
    setApplied(draft)
    setPage(1)
    syncUrl(draft, 1, pageSize)
  }

  const previousDay = () => {
    if (!applied.dateFrom) return
    const d = new Date(`${applied.dateFrom}T12:00:00Z`)
    d.setUTCDate(d.getUTCDate() - 1)
    const ymd = d.toISOString().slice(0, 10)
    setDateFrom(ymd)
    setDateTo(ymd)
    const draft = { ...applied, dateFrom: ymd, dateTo: ymd }
    setApplied(draft)
    setPage(1)
    syncUrl(draft, 1, pageSize)
  }

  useEffect(() => {
    if (catalogStations.length && !applied.stationId && selectedStation?.station_code) {
      setStationId(selectedStation.station_code)
      setApplied((prev) => ({ ...prev, stationId: selectedStation.station_code }))
    }
  }, [catalogStations.length, applied.stationId, selectedStation?.station_code])

  const total = txQ.data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const items = txQ.data?.items || []

  const downloadCsv = () => {
    if (!params) {
      setFilterError(filterError || 'Fix filter validation before exporting.')
      return
    }
    const url = exportTransactionsUrl({
      station_id: params.station_id,
      status: params.status,
      q: params.q,
      date_from: params.date_from,
      date_to: params.date_to,
      from_time: params.from_time,
      to_time: params.to_time,
      timezone: params.timezone,
      min_amount: params.min_amount,
      max_amount: params.max_amount,
      min_unit_price: params.min_unit_price,
      max_unit_price: params.max_unit_price,
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

  const chips: { key: string; label: string; clear: () => void }[] = []
  if (applied.fromTime || applied.toTime) {
    chips.push({
      key: 'time',
      label: `${formatClockLabel(applied.fromTime || '00:00')}–${formatClockLabel(applied.toTime || '23:59')}`,
      clear: () => {
        setFromTime('')
        setToTime('')
        const draft = { ...applied, fromTime: '', toTime: '' }
        setApplied(draft)
        setPage(1)
        syncUrl(draft, 1, pageSize)
      },
    })
  }
  if (applied.minAmount || applied.maxAmount) {
    chips.push({
      key: 'amount',
      label: `Amount: ₦${applied.minAmount || '…'}–₦${applied.maxAmount || '…'}`,
      clear: () => {
        setMinAmount('')
        setMaxAmount('')
        const draft = { ...applied, minAmount: '', maxAmount: '' }
        setApplied(draft)
        setPage(1)
        syncUrl(draft, 1, pageSize)
      },
    })
  }
  if (applied.minUnitPrice || applied.maxUnitPrice) {
    chips.push({
      key: 'price',
      label: `Unit price: ₦${applied.minUnitPrice || '…'}–₦${applied.maxUnitPrice || '…'}/L`,
      clear: () => {
        setMinUnitPrice('')
        setMaxUnitPrice('')
        const draft = { ...applied, minUnitPrice: '', maxUnitPrice: '' }
        setApplied(draft)
        setPage(1)
        syncUrl(draft, 1, pageSize)
      },
    })
  }
  if (applied.status) {
    chips.push({
      key: 'status',
      label: formatStatusLabel(applied.status),
      clear: () => {
        setStatus('')
        const draft = { ...applied, status: '' }
        setApplied(draft)
        setPage(1)
        syncUrl(draft, 1, pageSize)
      },
    })
  }

  const onFilterKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      applyFilters()
    }
  }

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-[1600px]">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="section-title">Sales</h1>
          <p className="text-slate-400 text-sm mt-1">
            Sales for {formatSalesRangeHeading(applied.dateFrom, applied.dateTo)} · Times shown in{' '}
            {timezonePlainLabel(tz)}
          </p>
        </div>
        <button type="button" className="btn-secondary btn-compact" onClick={downloadCsv}>
          Export CSV
        </button>
      </div>

      <form
        className="card space-y-3 sticky top-0 z-10 bg-slate-800/95 backdrop-blur-sm"
        onSubmit={(e) => {
          e.preventDefault()
          applyFilters()
        }}
        onKeyDown={onFilterKeyDown}
      >
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7 items-end">
          <CompactSelect
            label="Station"
            value={selectedStation?.station_code || stationId}
            onChange={(e) => setStationId(e.target.value)}
          >
            {catalogStations.length === 0 && <option value="">No stations yet</option>}
            {catalogStations.map((s) => (
              <option key={s.id} value={s.station_code}>
                {stationLabel(s)}
              </option>
            ))}
          </CompactSelect>
          <CompactInput
            label="From date"
            type="date"
            value={dateFrom}
            max={dateTo || undefined}
            onChange={(e) => setDateFrom(e.target.value)}
          />
          <CompactInput
            label="To date"
            type="date"
            value={dateTo}
            min={dateFrom || undefined}
            onChange={(e) => setDateTo(e.target.value)}
          />
          <CompactSelect label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            <option value="COMPLETED">Complete</option>
            <option value="DISPENSING">Dispensing</option>
            <option value="PENDING">Pending</option>
            <option value="REJECTED">Rejected</option>
          </CompactSelect>
          <CompactInput
            label="Transaction ID"
            placeholder="Search ID"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="xl:col-span-1"
          />
          <div className="flex gap-2 items-end">
            <button type="submit" className="btn-primary btn-compact flex-1">
              Apply filters
            </button>
          </div>
          <div className="flex gap-2 items-end">
            <button type="button" className="btn-secondary btn-compact flex-1" onClick={clearFilters}>
              Clear filters
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 lg:hidden">
          <button
            type="button"
            className="text-xs text-sky-300 hover:underline"
            onClick={() => setMoreFilters((v) => !v)}
            aria-expanded={moreFilters}
          >
            {moreFilters ? 'Hide more filters' : 'More filters'}
          </button>
        </div>

        <div className={`${moreFilters ? 'grid' : 'hidden'} lg:grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 items-end`}>
          <CompactInput
            label="From time"
            type="time"
            value={fromTime}
            onChange={(e) => setFromTime(e.target.value)}
          />
          <CompactInput label="To time" type="time" value={toTime} onChange={(e) => setToTime(e.target.value)} />
          <CompactInput
            label="Min sale amount (₦)"
            inputMode="decimal"
            placeholder="500"
            value={minAmount}
            onChange={(e) => setMinAmount(e.target.value)}
          />
          <CompactInput
            label="Max sale amount (₦)"
            inputMode="decimal"
            placeholder="5000"
            value={maxAmount}
            onChange={(e) => setMaxAmount(e.target.value)}
          />
          <CompactInput
            label="Min unit price (₦/L)"
            inputMode="decimal"
            placeholder="1100"
            value={minUnitPrice}
            onChange={(e) => setMinUnitPrice(e.target.value)}
          />
          <CompactInput
            label="Max unit price (₦/L)"
            inputMode="decimal"
            placeholder="1250"
            value={maxUnitPrice}
            onChange={(e) => setMaxUnitPrice(e.target.value)}
          />
        </div>

        {filterError ? (
          <p className="text-sm text-red-300" role="alert">
            {filterError}
          </p>
        ) : null}
      </form>

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi label={`Sales · ${formatSalesRangeHeading(applied.dateFrom, applied.dateTo)}`} value={fmtNaira(txQ.data?.total_amount)} />
        <Kpi label="Volume" value={fmtLiters(txQ.data?.total_volume)} />
        <Kpi label="Transactions" value={String(params ? total : 0)} />
        <Kpi label="Average" value={fmtNaira(txQ.data?.average_amount)} />
      </div>

      <div className="card overflow-x-auto">
        <div className="flex items-start justify-between mb-3 gap-3 flex-wrap">
          <div>
            <h2 className="text-white font-semibold text-sm">{stationLabel(selectedStation)}</h2>
            <p className="text-xs text-slate-400 mt-0.5">{formatSalesRangeHeading(applied.dateFrom, applied.dateTo)}</p>
            {chips.length > 0 ? (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {chips.map((c) => (
                  <button key={c.key} type="button" className="filter-chip" onClick={c.clear} title="Remove filter">
                    {c.label}
                    <span aria-hidden className="text-slate-500">
                      ×
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <label className="text-xs text-slate-400">
            Page size
            <select
              className="input-compact ml-2 w-auto inline-block"
              value={pageSize}
              onChange={(e) => {
                const size = Number(e.target.value)
                setPageSize(size)
                setPage(1)
                syncUrl(applied, 1, size)
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
          <div className="py-8 text-center" role="alert">
            <p className="text-red-300 text-sm mb-3">Could not load transactions.</p>
            <button type="button" className="btn-secondary btn-compact" onClick={() => txQ.refetch()}>
              Retry
            </button>
          </div>
        ) : !params || items.length === 0 ? (
          <div className="py-8 text-center space-y-3" data-testid="sales-empty">
            <p className="text-white font-medium text-sm">No sales found</p>
            <p className="text-slate-400 text-sm max-w-md mx-auto">
              No transactions match the selected filters. Try changing the date, time, price range, or station.
            </p>
            <div className="flex flex-wrap gap-2 justify-center">
              <button type="button" className="btn-secondary btn-compact" onClick={clearFilters}>
                Clear filters
              </button>
              {applied.dateFrom === applied.dateTo ? (
                <button type="button" className="btn-secondary btn-compact" onClick={previousDay}>
                  Previous day
                </button>
              ) : null}
            </div>
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
                      <span className={statusBadge(t.status)}>{formatStatusLabel(t.status)}</span>
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

        {params && items.length > 0 ? (
          <div className="flex items-center justify-between mt-4 text-sm text-slate-400">
            <span>
              {total ? (page - 1) * pageSize + 1 : 0}–{Math.min(page * pageSize, total)} of {total}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn-secondary btn-compact"
                disabled={page <= 1}
                onClick={() => {
                  const p = page - 1
                  setPage(p)
                  syncUrl(applied, p, pageSize)
                }}
              >
                Previous
              </button>
              <span className="px-2 py-2">
                Page {page} / {totalPages}
              </span>
              <button
                type="button"
                className="btn-secondary btn-compact"
                disabled={page >= totalPages}
                onClick={() => {
                  const p = page + 1
                  setPage(p)
                  syncUrl(applied, p, pageSize)
                }}
              >
                Next
              </button>
            </div>
          </div>
        ) : null}
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
          <p>Time: {fmtTime(selected.received_at, tz)}</p>
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
