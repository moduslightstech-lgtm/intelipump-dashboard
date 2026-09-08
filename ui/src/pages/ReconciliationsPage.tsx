import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  closeDayClose,
  fmtNaira,
  getDayCloseAudit,
  getDayCloses,
  getStations,
  recalculateDayClose,
  reopenDayClose,
  usePreviousOpening,
  type DayCloseRow,
} from '../api/client'
import { apiErrorMessage } from '../lib/apiError'
import { useAuth } from '../context/AuthContext'
import { normalizeRole } from '../lib/roles'
import {
  filterCounts,
  formatFinancialVariance,
  matchesStatusFilter,
  todayBusinessDate,
  type StatusFilter,
} from '../lib/reconciliationUi'
import HowReconciliationWorks from '../components/reconciliation/HowReconciliationWorks'
import StationReconciliationList from '../components/reconciliation/StationReconciliationList'
import ReconciliationWorkspace from '../components/reconciliation/ReconciliationWorkspace'

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat-card">
      <div className="label-text">{label}</div>
      <div className="text-lg font-bold text-white">{value}</div>
    </div>
  )
}

export default function ReconciliationsPage() {
  const qc = useQueryClient()
  const { user } = useAuth()
  const isAdmin = normalizeRole(user?.normalizedRole || user?.role) === 'ADMIN'
  const [params, setParams] = useSearchParams()
  const businessDate = params.get('date') || todayBusinessDate()
  const selectedId = params.get('station')
  const [stationFilter, setStationFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('')
  const [comment, setComment] = useState('')
  const [mobileWorkspace, setMobileWorkspace] = useState(Boolean(selectedId))
  const isDesktop = useMinWidth(1200)

  const stationsQ = useQuery({
    queryKey: ['stations'],
    queryFn: async () => (await getStations()).data,
  })

  const rowsQ = useQuery({
    queryKey: ['day-closes', businessDate, stationFilter],
    queryFn: async () =>
      (
        await getDayCloses({
          business_date: businessDate || undefined,
          station_id: stationFilter || undefined,
        })
      ).data,
  })

  const allRows = rowsQ.data ?? []
  const counts = useMemo(() => filterCounts(allRows), [allRows])
  const rows = useMemo(
    () => allRows.filter((row) => matchesStatusFilter(row, statusFilter)),
    [allRows, statusFilter],
  )
  const selected = allRows.find((r) => r.stationId === selectedId) ?? rows.find((r) => r.stationId === selectedId) ?? null

  const auditQ = useQuery({
    queryKey: ['day-close-audit', selected?.stationId, selected?.businessDate],
    queryFn: async () => (await getDayCloseAudit(selected!.stationId, selected!.businessDate)).data,
    enabled: Boolean(isAdmin && selected),
  })

  useEffect(() => {
    if (selectedId) return
    if (rows.length === 1) {
      setParams(
        (current) => {
          const next = new URLSearchParams(current)
          next.set('station', rows[0].stationId)
          next.set('date', rows[0].businessDate || businessDate)
          return next
        },
        { replace: true },
      )
      setMobileWorkspace(true)
    }
  }, [rows, selectedId, businessDate, setParams])

  function selectStation(row: DayCloseRow) {
    setParams((current) => {
      const next = new URLSearchParams(current)
      next.set('station', row.stationId)
      next.set('date', row.businessDate || businessDate)
      return next
    })
    setMobileWorkspace(true)
  }

  function updateDate(value: string) {
    setParams((current) => {
      const next = new URLSearchParams(current)
      next.set('date', value)
      next.delete('station')
      return next
    })
    setMobileWorkspace(false)
  }

  const recalcMut = useMutation({
    mutationFn: (row: DayCloseRow) =>
      recalculateDayClose({ station_id: row.stationId, business_date: row.businessDate }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['day-closes'] }),
  })
  const closeMut = useMutation({
    mutationFn: (row: DayCloseRow) =>
      closeDayClose({
        station_id: row.stationId,
        business_date: row.businessDate,
        comment: comment || undefined,
        approve_variance: row.workflowStatus === 'REVIEW_REQUIRED',
      }),
    onSuccess: () => {
      setComment('')
      void qc.invalidateQueries({ queryKey: ['day-closes'] })
    },
  })
  const reopenMut = useMutation({
    mutationFn: (row: DayCloseRow) =>
      reopenDayClose({ station_id: row.stationId, business_date: row.businessDate, comment: comment || undefined }),
    onSuccess: () => {
      setComment('')
      void qc.invalidateQueries({ queryKey: ['day-closes'] })
    },
  })
  const previousMut = useMutation({
    mutationFn: (row: DayCloseRow) =>
      usePreviousOpening({ station_id: row.stationId, business_date: row.businessDate }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['day-closes'] }),
  })

  const actionError = recalcMut.error || closeMut.error || reopenMut.error || previousMut.error

  return (
    <div className="p-4 pb-8 md:p-6 md:pb-10 space-y-4">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="section-title">Reconciliation</h1>
          <p className="text-slate-400 text-sm mt-1">Financial, transaction integrity and tank inventory</p>
        </div>
        <div className="text-sm text-slate-500">{formatHeaderDate(businessDate)}</div>
      </div>

      <HowReconciliationWorks />

      <div className="card grid md:grid-cols-3 gap-3 py-3">
        <div>
          <label className="label-text block mb-1">Business date</label>
          <input className="input w-full" type="date" value={businessDate} onChange={(e) => updateDate(e.target.value)} />
        </div>
        <div>
          <label className="label-text block mb-1">Station</label>
          <select
            className="input w-full"
            value={stationFilter}
            onChange={(e) => setStationFilter(e.target.value)}
          >
            <option value="">All stations</option>
            {stationsQ.data?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.station_code})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label-text block mb-1">Status</label>
          <select
            className="input w-full"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          >
            <option value="">All ({counts.all})</option>
            <option value="NEEDS_ATTENTION">Needs attention ({counts.needsAttention})</option>
            <option value="INCOMPLETE">Incomplete ({counts.incomplete})</option>
            <option value="READY_TO_CLOSE">Ready to close ({counts.ready})</option>
            <option value="CLOSED">Closed ({counts.closed})</option>
          </select>
        </div>
      </div>

      {(rowsQ.isError || actionError) && (
        <div className="card border-red-800 text-red-300 text-sm" role="alert">
          {apiErrorMessage(rowsQ.error || actionError, 'Could not load reconciliation')}
        </div>
      )}

      <div className="grid grid-cols-2 xl:grid-cols-5 gap-3">
        <Stat label="Needs attention" value={String(counts.needsAttention)} />
        <Stat label="Incomplete" value={String(counts.incomplete)} />
        <Stat label="Ready to close" value={String(counts.ready)} />
        <Stat
          label="Pump sales"
          value={fmtNaira(selected?.financial?.pumpSales ?? selected?.sales?.amount)}
        />
        <Stat
          label="Financial variance"
          value={selected ? formatFinancialVariance(selected) : '—'}
        />
      </div>

      {isDesktop ? (
      <div className="grid grid-cols-[minmax(280px,22rem)_minmax(0,1fr)] items-start gap-4">
        <div className="min-w-0">
          <StationReconciliationList
            rows={rows}
            selectedId={selectedId}
            onSelect={selectStation}
            loading={rowsQ.isLoading}
          />
        </div>
        <div className="min-w-0">
          <ReconciliationWorkspace
          data={selected}
          loading={rowsQ.isLoading && !selected}
          actions={{
            isAdmin,
            canEnterSales: isAdmin,
            comment,
            setComment,
            onRecalculate: selected ? () => recalcMut.mutate(selected) : undefined,
            onClose: selected ? () => closeMut.mutate(selected) : undefined,
            onReopen: selected ? () => reopenMut.mutate(selected) : undefined,
            onUsePrevious: selected ? () => previousMut.mutate(selected) : undefined,
            onSavedSales: async () => {
              await qc.invalidateQueries({ queryKey: ['day-closes'] })
            },
            pending: {
              recalc: recalcMut.isPending,
              close: closeMut.isPending,
              reopen: reopenMut.isPending,
              previous: previousMut.isPending,
            },
            audit: auditQ.data,
            auditLoading: auditQ.isLoading,
          }}
          />
        </div>
      </div>
      ) : (
      <div>
        {selected && mobileWorkspace ? (
          <ReconciliationWorkspace
            data={selected}
            loading={rowsQ.isLoading && !selected}
            onBackToStations={() => setMobileWorkspace(false)}
            backLabel="Stations"
            actions={{
              isAdmin,
              canEnterSales: isAdmin,
              comment,
              setComment,
              onRecalculate: () => recalcMut.mutate(selected),
              onClose: () => closeMut.mutate(selected),
              onReopen: () => reopenMut.mutate(selected),
              onUsePrevious: () => previousMut.mutate(selected),
              onSavedSales: async () => {
                await qc.invalidateQueries({ queryKey: ['day-closes'] })
              },
              pending: {
                recalc: recalcMut.isPending,
                close: closeMut.isPending,
                reopen: reopenMut.isPending,
                previous: previousMut.isPending,
              },
              audit: auditQ.data,
              auditLoading: auditQ.isLoading,
            }}
          />
        ) : (
          <StationReconciliationList
            rows={rows}
            selectedId={selectedId}
            onSelect={selectStation}
            loading={rowsQ.isLoading}
          />
        )}
      </div>
      )}
    </div>
  )
}

function useMinWidth(px: number) {
  const [matches, setMatches] = useState(false)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(`(min-width: ${px}px)`)
    const onChange = () => setMatches(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [px])
  return matches
}

function formatHeaderDate(iso: string) {
  const [year, month, day] = iso.split('-').map(Number)
  if (!year || !month || !day) return iso
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
}
