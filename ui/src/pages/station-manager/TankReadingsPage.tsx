import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  correctTankReadingBatch,
  fmtLiters,
  getStationManagerCurrentReadings,
  getStationManagerHistory,
  getStationManagerStations,
  getTankReadingAudit,
  saveTankReadingDraft,
  submitTankReadings,
} from '../../api/client'
import { Link } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { formatStatusLabel } from '../../lib/enumPresentation'
import { normalizeRole } from '../../lib/roles'
import TankReadingSummary from '../../components/tank-readings/TankReadingSummary'

type Mode = 'create' | 'continue' | 'view' | 'correct'

function formatBusinessDate(iso?: string | null) {
  if (!iso) return '—'
  const [year, month, day] = iso.split('-').map(Number)
  if (!year || !month || !day) return iso
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

function formatDateTimeInZone(iso?: string | null, timeZone?: string | null) {
  if (!iso) return '—'
  const dt = new Date(iso)
  if (Number.isNaN(dt.getTime())) return iso
  return dt.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: timeZone || undefined,
  })
}

function draftHasValues(draft: Record<string, any>) {
  return Object.values(draft).some((row) => {
    if (!row) return false
    return (
      String(row.closing_volume_liters ?? '').trim() !== '' ||
      String(row.notes ?? '').trim() !== '' ||
      String(row.measured_level_mm ?? '').trim() !== '' ||
      String(row.water_level_mm ?? '').trim() !== '' ||
      String(row.temperature_celsius ?? '').trim() !== ''
    )
  })
}

function statusDisplay(uiStatus?: string | null, isLate?: boolean, isLatePreview?: boolean) {
  if (isLate || isLatePreview) return 'Late submission'
  return formatStatusLabel(uiStatus || 'NOT_STARTED')
}

export default function TankReadingsPage() {
  const qc = useQueryClient()
  const { user } = useAuth()
  const role = normalizeRole(user?.normalizedRole || user?.role)
  const isAdmin = role === 'ADMIN'
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  const stationsQ = useQuery({
    queryKey: ['sm', 'stations'],
    queryFn: async () => (await getStationManagerStations()).data,
  })
  const [stationId, setStationId] = useState('')
  const [pageBusinessDate, setPageBusinessDate] = useState<string>('')
  const [statusFilter, setStatusFilter] = useState('')
  const [latenessFilter, setLatenessFilter] = useState('')
  const [histFrom, setHistFrom] = useState('')
  const [histTo, setHistTo] = useState('')
  const [page, setPage] = useState(1)
  const [modalOpen, setModalOpen] = useState(false)
  const [mode, setMode] = useState<Mode>('create')
  const [viewDate, setViewDate] = useState<string | undefined>()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [dateChangeOpen, setDateChangeOpen] = useState(false)
  const [pendingBusinessDate, setPendingBusinessDate] = useState<string | null>(null)
  const [auditOpen, setAuditOpen] = useState(false)
  const [auditBatchId, setAuditBatchId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Record<string, any>>({})
  const [lateReason, setLateReason] = useState('')
  const [correctionReason, setCorrectionReason] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [submittedOk, setSubmittedOk] = useState(false)
  const [errors, setErrors] = useState<Record<string, string[]>>({})

  useEffect(() => {
    if (!stationId && stationsQ.data?.length === 1) {
      setStationId(stationsQ.data[0].id)
    } else if (!stationId && stationsQ.data?.[0]?.id) {
      setStationId(stationsQ.data[0].id)
    }
  }, [stationsQ.data, stationId])

  const singleStation = (stationsQ.data?.length ?? 0) === 1

  const workspaceDate = viewDate || pageBusinessDate || undefined

  const currentQ = useQuery({
    queryKey: ['sm', 'readings', stationId, workspaceDate || 'current'],
    queryFn: async () => (await getStationManagerCurrentReadings(stationId, workspaceDate)).data,
    enabled: !!stationId && modalOpen,
  })

  const pageQ = useQuery({
    queryKey: ['sm', 'readings-page', stationId, pageBusinessDate || 'today'],
    queryFn: async () =>
      (await getStationManagerCurrentReadings(stationId, pageBusinessDate || undefined)).data,
    enabled: !!stationId,
  })

  useEffect(() => {
    if (!pageBusinessDate && pageQ.data?.todayBusinessDate) {
      setPageBusinessDate(pageQ.data.todayBusinessDate)
    } else if (!pageBusinessDate && pageQ.data?.businessDate) {
      setPageBusinessDate(pageQ.data.businessDate)
    }
  }, [pageQ.data, pageBusinessDate])

  useEffect(() => {
    setPageBusinessDate('')
    setPage(1)
  }, [stationId])

  const histQ = useQuery({
    queryKey: ['sm', 'history', stationId, statusFilter, latenessFilter, histFrom, histTo, page],
    queryFn: async () =>
      (
        await getStationManagerHistory({
          station_id: stationId || undefined,
          status: statusFilter || undefined,
          lateness: latenessFilter || undefined,
          date_from: histFrom || undefined,
          date_to: histTo || undefined,
          page,
          page_size: 15,
        })
      ).data,
    enabled: !!stationId || isAdmin,
  })

  const auditQ = useQuery({
    queryKey: ['sm', 'audit', auditBatchId],
    queryFn: async () => (await getTankReadingAudit(auditBatchId!)).data,
    enabled: !!auditBatchId && auditOpen,
  })

  useEffect(() => {
    if (!currentQ.data?.tanks) return
    const next: Record<string, any> = {}
    currentQ.data.tanks.forEach((t: any) => {
      next[t.tankId] = {
        tank_id: t.tankId,
        closing_volume_liters: t.closingVolumeLiters ?? '',
        measured_level_mm: t.measuredLevelMm ?? '',
        water_level_mm: t.waterLevelMm ?? '',
        temperature_celsius: t.temperatureCelsius ?? '',
        notes: t.notes ?? '',
      }
    })
    setDraft(next)
    setErrors({})
    if (currentQ.data?.batch?.lateReason) {
      setLateReason(currentQ.data.batch.lateReason)
    }
  }, [currentQ.data])

  const uiStatus = pageQ.data?.uiStatus || pageQ.data?.batch?.status || 'NOT_STARTED'
  const alreadySubmitted = Boolean(pageQ.data?.alreadySubmitted)
  const modalStatus = currentQ.data?.uiStatus || currentQ.data?.batch?.status || uiStatus
  const modalLocked = ['SUBMITTED', 'ACCEPTED', 'CORRECTED'].includes(modalStatus)
  const readOnly = mode === 'view' || (mode !== 'correct' && modalLocked && !isAdmin)
  const isLatePreview = Boolean(currentQ.data?.isLatePreview || currentQ.data?.batch?.isLate)
  const tz = currentQ.data?.timezoneUsed || currentQ.data?.station?.timezone || pageQ.data?.station?.timezone

  const applyBusinessDate = (next: string, scope: 'page' | 'modal') => {
    if (scope === 'page') {
      setPageBusinessDate(next)
      return
    }
    setViewDate(next)
    setDraft({})
    setLateReason('')
    setErrors({})
    setMessage(null)
  }

  const requestBusinessDateChange = (next: string, scope: 'page' | 'modal') => {
    const current = scope === 'page' ? pageBusinessDate : viewDate || currentQ.data?.businessDate
    if (!next || next === current) return
    if (scope === 'modal' && draftHasValues(draft)) {
      setPendingBusinessDate(next)
      setDateChangeOpen(true)
      return
    }
    applyBusinessDate(next, scope)
  }

  const closeModal = () => {
    setModalOpen(false)
    setConfirmOpen(false)
    setDateChangeOpen(false)
    setTimeout(() => triggerRef.current?.focus(), 0)
  }

  useEffect(() => {
    if (!modalOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeModal()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [modalOpen])

  const openCreate = () => {
    const biz = pageBusinessDate || pageQ.data?.businessDate
    setViewDate(biz)
    if (alreadySubmitted) {
      setMode('view')
    } else if (uiStatus === 'DRAFT' || uiStatus === 'REOPENED') {
      setMode('continue')
    } else {
      setMode('create')
    }
    setCorrectionReason('')
    setLateReason('')
    setSubmittedOk(false)
    setModalOpen(true)
    setMessage(null)
  }

  const openRow = (row: any, nextMode: Mode) => {
    setViewDate(row.businessDate)
    setPageBusinessDate(row.businessDate)
    setMode(nextMode)
    setCorrectionReason(row.correctionReason || '')
    setLateReason(row.lateReason || '')
    setSubmittedOk(false)
    setModalOpen(true)
    setMessage(null)
  }

  const saveMut = useMutation({
    mutationFn: async () => {
      const readings = Object.values(draft).map((r) => ({
        tank_id: r.tank_id,
        closing_volume_liters: r.closing_volume_liters === '' ? null : Number(r.closing_volume_liters),
        measured_level_mm: r.measured_level_mm === '' ? null : Number(r.measured_level_mm),
        water_level_mm: r.water_level_mm === '' ? null : Number(r.water_level_mm),
        temperature_celsius: r.temperature_celsius === '' ? null : Number(r.temperature_celsius),
        notes: r.notes || null,
      }))
      if (mode === 'correct') {
        const batchId = currentQ.data?.batch?.id
        if (!batchId) throw new Error('Missing batch')
        return (
          await correctTankReadingBatch(batchId, {
            readings,
            correction_reason: correctionReason,
            version: currentQ.data?.batch?.version,
          })
        ).data
      }
      return (
        await saveTankReadingDraft({
          station_id: stationId,
          business_date: viewDate || currentQ.data?.businessDate,
          readings,
          late_reason: lateReason.trim() || null,
        })
      ).data
    },
    onSuccess: (data) => {
      setMessage(mode === 'correct' ? 'Correction saved' : 'Draft saved')
      setErrors(data.fieldErrors || {})
      qc.invalidateQueries({ queryKey: ['sm'] })
      if (mode === 'correct') {
        closeModal()
      }
    },
    onError: (err: any) => {
      const detail = err?.response?.data?.detail
      setMessage(typeof detail === 'string' ? detail : detail?.message || 'Save failed')
      if (detail?.fieldErrors) setErrors(detail.fieldErrors)
    },
  })

  const submitMut = useMutation({
    mutationFn: async () => {
      await saveMut.mutateAsync()
      return (
        await submitTankReadings({
          station_id: stationId,
          business_date: viewDate || currentQ.data?.businessDate,
          confirm: true,
          late_reason: lateReason.trim() || null,
        })
      ).data
    },
    onSuccess: (data) => {
      setConfirmOpen(false)
      setMode('view')
      setViewDate(data?.businessDate || viewDate || currentQ.data?.businessDate)
      setSubmittedOk(true)
      setModalOpen(true)
      setMessage(data?.batch?.isLate ? 'Late submission recorded.' : 'Reading submitted successfully.')
      qc.invalidateQueries({ queryKey: ['sm'] })
    },
    onError: (err: any) => {
      const detail = err?.response?.data?.detail
      if (detail?.fieldErrors) setErrors(detail.fieldErrors)
      setMessage(typeof detail === 'string' ? detail : detail?.message || 'Submit failed')
      setConfirmOpen(false)
    },
  })

  const summary = useMemo(() => {
    if (!currentQ.data?.tanks)
      return [] as Array<{
        name: string
        product?: string
        capacity: number
        closing: number | null
        fill: string
      }>
    return currentQ.data.tanks.map((t: any) => {
      const closing = Number(draft[t.tankId]?.closing_volume_liters)
      const cap = Number(t.capacityLiters || 0)
      const fill = cap && !Number.isNaN(closing) ? ((closing / cap) * 100).toFixed(1) : '—'
      return {
        name: String(t.name || t.tankCode || 'Tank'),
        product: t.product as string | undefined,
        capacity: cap,
        closing: Number.isNaN(closing) ? null : closing,
        fill,
      }
    })
  }, [currentQ.data, draft])

  const addButtonLabel = alreadySubmitted
    ? 'View submission'
    : uiStatus === 'DRAFT' || uiStatus === 'REOPENED'
      ? 'Continue draft'
      : 'Add tank readings'

  const histItems = Array.isArray(histQ.data) ? histQ.data : histQ.data?.items || []
  const minDate = pageQ.data?.minSelectableDate
  const maxDate = pageQ.data?.maxSelectableDate || pageQ.data?.todayBusinessDate
  const pageLate = Boolean(pageQ.data?.isLatePreview || pageQ.data?.batch?.isLate)

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-6xl mx-auto">
      <div>
        <h1 className="section-title">Tank Reading</h1>
        <p className="text-slate-400 text-sm mt-1">
          Record closing stock for each tank. Previous submissions stay on this page.
        </p>
      </div>

      {message && (
        <div className="card text-sm text-sky-300" role="status">
          {message}
        </div>
      )}

      <div className="card space-y-3">
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <label className="text-sm text-slate-400">
            Station
            <select
              className="input mt-1 w-full h-11"
              value={stationId}
              onChange={(e) => {
                setStationId(e.target.value)
              }}
              disabled={stationsQ.isLoading || singleStation || (stationsQ.data?.length ?? 0) === 0}
            >
              {(stationsQ.data?.length ?? 0) === 0 ? (
                <option value="">{stationsQ.isLoading ? 'Loading…' : 'No stations assigned'}</option>
              ) : null}
              {(stationsQ.data || []).map((s: any) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.stationCode || s.station_code})
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm text-slate-400">
            Business date
            <input
              type="date"
              className="input mt-1 w-full h-11"
              value={pageBusinessDate}
              min={minDate || undefined}
              max={maxDate || undefined}
              onChange={(e) => requestBusinessDateChange(e.target.value, 'page')}
            />
            <span className="block mt-1 text-[11px] text-slate-500">
              {formatBusinessDate(pageBusinessDate || pageQ.data?.businessDate)}
              {pageQ.data?.managerBackentryDays != null && !isAdmin
                ? ` · Managers may enter up to ${pageQ.data.managerBackentryDays} days back`
                : null}
            </span>
          </label>
          <div className="text-sm pt-1 space-y-1">
            <div>
              Deadline:{' '}
              <span className="text-white">
                {pageQ.data?.deadlineLocal
                  ? `${formatBusinessDate(pageBusinessDate || pageQ.data?.businessDate)} at ${pageQ.data.deadlineLocal}`
                  : '—'}
              </span>
            </div>
            <div>
              Status:{' '}
              <span className="font-semibold text-emerald-400">
                {statusDisplay(uiStatus, pageQ.data?.batch?.isLate, pageLate && !alreadySubmitted)}
              </span>
            </div>
            {alreadySubmitted && pageQ.data?.batch?.submittedAt ? (
              <div className="text-xs text-slate-500">
                Submitted {formatDateTimeInZone(pageQ.data.batch.submittedAt, pageQ.data.timezoneUsed)}
              </div>
            ) : null}
          </div>
          <div className="flex items-end justify-end gap-2">
            {isAdmin && alreadySubmitted && pageQ.data?.batch?.id ? (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => openRow({ businessDate: pageQ.data.businessDate }, 'correct')}
              >
                Edit / Correct
              </button>
            ) : null}
            <button
              ref={triggerRef}
              type="button"
              className="btn-primary"
              disabled={!stationId}
              onClick={openCreate}
            >
              {addButtonLabel}
            </button>
          </div>
        </div>
        {alreadySubmitted && (
          <div className="text-xs text-amber-200 bg-amber-950/40 border border-amber-900 rounded px-3 py-2">
            Readings for {formatBusinessDate(pageBusinessDate || pageQ.data?.businessDate)} were already
            submitted.
            {isAdmin ? ' Use Edit / Correct to change values.' : ' An administrator must make any corrections.'}
          </div>
        )}
        {alreadySubmitted && pageQ.data ? (
          <div className="pt-2">
            <TankReadingSummary
              data={pageQ.data}
              title={`Tank reading · ${formatBusinessDate(pageQ.data.businessDate)}`}
            />
          </div>
        ) : null}
        {!stationsQ.isLoading && (stationsQ.data?.length ?? 0) === 0 && (
          <div className="text-sm text-amber-200">
            No stations assigned to your account. Ask an Admin to assign a station on Users.
          </div>
        )}
      </div>

      <div className="card space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 className="text-white font-semibold text-sm">Submission history</h2>
          <div className="flex flex-wrap gap-2">
            <label className="text-xs text-slate-400">
              From
              <input
                type="date"
                className="input mt-1 h-10"
                value={histFrom}
                onChange={(e) => {
                  setHistFrom(e.target.value)
                  setPage(1)
                }}
              />
            </label>
            <label className="text-xs text-slate-400">
              To
              <input
                type="date"
                className="input mt-1 h-10"
                value={histTo}
                onChange={(e) => {
                  setHistTo(e.target.value)
                  setPage(1)
                }}
              />
            </label>
            <label className="text-xs text-slate-400">
              Status
              <select
                className="input mt-1 h-10"
                value={statusFilter}
                onChange={(e) => {
                  setStatusFilter(e.target.value)
                  setPage(1)
                }}
              >
                <option value="">All</option>
                {['DRAFT', 'SUBMITTED', 'CORRECTED', 'REOPENED', 'ACCEPTED', 'REJECTED'].map((s) => (
                  <option key={s} value={s}>
                    {formatStatusLabel(s)}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-slate-400">
              On time / Late
              <select
                className="input mt-1 h-10"
                value={latenessFilter}
                onChange={(e) => {
                  setLatenessFilter(e.target.value)
                  setPage(1)
                }}
              >
                <option value="">All</option>
                <option value="ON_TIME">On time</option>
                <option value="LATE">Late submission</option>
              </select>
            </label>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-400 border-b border-slate-700">
                <th className="pb-2">Business date</th>
                <th className="pb-2">Station</th>
                <th className="pb-2">Submitted by</th>
                <th className="pb-2">Tanks</th>
                <th className="pb-2 text-right">Total volume</th>
                <th className="pb-2">Status</th>
                <th className="pb-2">Submitted at</th>
                <th className="pb-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {histItems.length === 0 && !histQ.isLoading ? (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-slate-500">
                    No submissions yet for this station.
                  </td>
                </tr>
              ) : null}
              {histItems.map((b: any) => (
                <tr key={b.id} className="border-b border-slate-800">
                  <td className="py-2 font-medium text-white">{formatBusinessDate(b.businessDate)}</td>
                  <td className="py-2">{b.stationName || '—'}</td>
                  <td className="py-2 text-xs">{b.submittedBy?.name || '—'}</td>
                  <td className="py-2 text-xs">{b.tankCount ?? '—'}</td>
                  <td className="py-2 text-right font-mono">
                    {b.totalClosingVolumeLiters != null
                      ? `${Number(b.totalClosingVolumeLiters).toLocaleString()} L`
                      : '—'}
                  </td>
                  <td className="py-2">
                    <span className="text-xs font-medium text-emerald-300">
                      {formatStatusLabel(b.status)}
                    </span>
                    {b.isLate ? (
                      <span className="ml-1 text-[10px] text-amber-300">Late submission</span>
                    ) : b.status === 'SUBMITTED' || b.status === 'ACCEPTED' || b.status === 'CORRECTED' ? (
                      <span className="ml-1 text-[10px] text-slate-500">On time</span>
                    ) : null}
                    {b.correctedByAdministrator ? (
                      <span className="ml-1 text-[10px] text-sky-300">Amended</span>
                    ) : null}
                  </td>
                  <td className="py-2 text-xs text-slate-400">
                    {b.submittedAt ? formatDateTimeInZone(b.submittedAt, b.timezoneUsed) : '—'}
                  </td>
                  <td className="py-2">
                    <div className="flex flex-wrap gap-1">
                      <button
                        type="button"
                        className="btn-secondary text-xs px-2 py-1"
                        onClick={() => openRow(b, 'view')}
                      >
                        View
                      </button>
                      {b.status === 'DRAFT' || b.status === 'REOPENED' ? (
                        <button
                          type="button"
                          className="btn-primary text-xs px-2 py-1"
                          onClick={() => openRow(b, 'continue')}
                        >
                          Continue
                        </button>
                      ) : null}
                      {isAdmin && ['SUBMITTED', 'ACCEPTED', 'CORRECTED'].includes(b.status) ? (
                        <button
                          type="button"
                          className="btn-secondary text-xs px-2 py-1"
                          onClick={() => openRow(b, 'correct')}
                        >
                          Correct
                        </button>
                      ) : null}
                      {isAdmin ? (
                        <button
                          type="button"
                          className="btn-secondary text-xs px-2 py-1"
                          onClick={() => {
                            setAuditBatchId(b.id)
                            setAuditOpen(true)
                          }}
                        >
                          Audit
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex justify-between text-xs text-slate-500">
          <span>{histQ.data?.total ?? histItems.length} total</span>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn-secondary text-xs"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              Prev
            </button>
            <button
              type="button"
              className="btn-secondary text-xs"
              disabled={!histQ.data?.hasMore}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        </div>
      </div>

      {modalOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/70 flex items-end sm:items-center justify-center p-0 sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="tank-reading-dialog-title"
        >
          <div className="bg-slate-950 border border-slate-800 sm:rounded-xl w-full sm:max-w-3xl max-h-[100vh] sm:max-h-[90vh] flex flex-col">
            <div className="sticky top-0 bg-slate-950 border-b border-slate-800 px-4 py-3 flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                {mode !== 'view' ? (
                  <>
                    <h2 id="tank-reading-dialog-title" className="text-white font-semibold">
                      {mode === 'correct' ? 'Correct tank readings' : 'Add tank readings'}
                    </h2>
                    <p className="text-sm text-slate-300">
                      Station: {currentQ.data?.station?.name || '—'}
                    </p>
                  </>
                ) : (
                  <h2 id="tank-reading-dialog-title" className="text-white font-semibold">
                    Tank reading summary
                  </h2>
                )}
              </div>
              <button type="button" className="btn-secondary text-xs" onClick={closeModal}>
                Close
              </button>
            </div>

            <div className="p-4 space-y-4 overflow-y-auto">
              {mode !== 'view' && (
                <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-3 space-y-3">
                  <label className="block text-sm text-slate-300">
                    Business date
                    <input
                      type="date"
                      className="input mt-1 w-full max-w-xs h-11"
                      value={viewDate || currentQ.data?.businessDate || ''}
                      min={currentQ.data?.minSelectableDate || minDate || undefined}
                      max={currentQ.data?.maxSelectableDate || maxDate || undefined}
                      disabled={mode === 'correct' || readOnly}
                      onChange={(e) => requestBusinessDateChange(e.target.value, 'modal')}
                    />
                    <span className="block mt-1 text-xs text-slate-500">
                      {formatBusinessDate(viewDate || currentQ.data?.businessDate)}
                    </span>
                  </label>
                  <div className="text-xs text-slate-400 space-y-1">
                    <div>
                      Deadline:{' '}
                      <span className="text-slate-200">
                        {formatBusinessDate(viewDate || currentQ.data?.businessDate)} at{' '}
                        {currentQ.data?.deadlineLocal || '—'}
                      </span>
                    </div>
                    <div>
                      Status:{' '}
                      <span className="text-emerald-300 font-medium">
                        {statusDisplay(modalStatus, currentQ.data?.batch?.isLate, isLatePreview && !modalLocked)}
                      </span>
                    </div>
                    {currentQ.data?.batch?.status === 'DRAFT' && currentQ.data?.batch?.lastModifiedAt ? (
                      <div>
                        Draft last saved{' '}
                        {formatDateTimeInZone(currentQ.data.batch.lastModifiedAt, tz)}
                      </div>
                    ) : null}
                    {modalLocked ? (
                      <div className="text-amber-200">
                        Readings for {formatBusinessDate(currentQ.data?.businessDate)} were submitted
                        {currentQ.data?.batch?.submittedAt
                          ? ` on ${formatDateTimeInZone(currentQ.data.batch.submittedAt, tz)}`
                          : ''}
                        .
                      </div>
                    ) : null}
                  </div>
                </div>
              )}

              {mode === 'view' ? (
                <>
                  {currentQ.isLoading ? (
                    <div className="rounded-lg border border-slate-800 bg-slate-900/50 px-4 py-8 text-center text-sm text-slate-400">
                      Loading submission…
                    </div>
                  ) : currentQ.isError ? (
                    <div className="rounded-lg border border-red-900/50 bg-red-950/40 px-4 py-6 text-sm text-red-300">
                      Could not load this tank-reading submission.
                    </div>
                  ) : currentQ.data ? (
                    <TankReadingSummary data={currentQ.data} success={submittedOk} />
                  ) : null}
                </>
              ) : null}
              {mode === 'correct' && (
                <label className="block text-xs text-slate-400">
                  Correction reason *
                  <textarea
                    className="input mt-1 w-full min-h-[72px]"
                    value={correctionReason}
                    onChange={(e) => setCorrectionReason(e.target.value)}
                    required
                  />
                </label>
              )}

              {mode !== 'view' && !readOnly && isLatePreview ? (
                <label className="block text-xs text-slate-400">
                  Reason for late entry{mode === 'correct' ? '' : ' *'}
                  <textarea
                    className="input mt-1 w-full min-h-[72px]"
                    value={lateReason}
                    maxLength={500}
                    onChange={(e) => setLateReason(e.target.value)}
                    placeholder="Explain why the reading was submitted after the deadline"
                  />
                  <span className="block mt-1 text-[11px] text-slate-500">
                    Required for final submit after the deadline. Optional when saving a draft.
                  </span>
                </label>
              ) : null}

              {mode !== 'view' && currentQ.isLoading && (
                <div className="rounded-lg border border-slate-800 bg-slate-900/50 px-4 py-8 text-center text-sm text-slate-400">
                  Loading tanks…
                </div>
              )}
              {mode !== 'view' && currentQ.isError && (
                <div className="rounded-lg border border-red-900/50 bg-red-950/40 px-4 py-6 text-sm text-red-300">
                  Could not load tank readings for this station.
                  {(currentQ.error as any)?.response?.data?.detail
                    ? ` ${String((currentQ.error as any).response.data.detail)}`
                    : ' Check that the database migration is applied, then try again.'}
                </div>
              )}
              {mode !== 'view' &&
                !currentQ.isLoading &&
                !currentQ.isError &&
                (currentQ.data?.tanks || []).length === 0 && (
                  <div className="rounded-lg border border-amber-900/40 bg-amber-950/30 px-4 py-6 text-sm text-amber-200">
                    No tanks were active on this business date.
                  </div>
                )}

              {mode !== 'view' &&
                (currentQ.data?.tanks || []).map((t: any) => {
                  const closing = Number(draft[t.tankId]?.closing_volume_liters)
                  const cap = Number(t.capacityLiters || 0)
                  const fill =
                    cap && !Number.isNaN(closing) ? `${((closing / cap) * 100).toFixed(1)}%` : '—'
                  const gap = t.previousClosingGapDays
                  const inv = t.inventory || {}
                  const expected =
                    inv.expectedClosingStockLiters != null
                      ? Number(inv.expectedClosingStockLiters)
                      : null
                  const variance =
                    !Number.isNaN(closing) && expected != null ? closing - expected : null
                  return (
                    <div key={t.tankId} className="rounded-lg border border-slate-800 p-3 space-y-3">
                      <div className="flex flex-wrap justify-between gap-2">
                        <div>
                          <div className="text-white font-semibold text-sm">
                            {t.name || t.tankCode} — {t.product || 'Fuel'}
                          </div>
                          <div className="text-[11px] text-slate-500 font-mono">{t.tankCode}</div>
                        </div>
                        <div className="text-[11px] text-slate-400 text-right">
                          Capacity {t.capacityLiters?.toLocaleString() || '—'} L
                          <div>
                            {t.previousClosingVolumeLiters != null ? (
                              <>
                                Previous closing: {Number(t.previousClosingVolumeLiters).toLocaleString()} L
                                {t.previousBusinessDate ? (
                                  <div className="text-slate-500">
                                    From {formatBusinessDate(t.previousBusinessDate)}
                                    {gap != null && gap > 1
                                      ? ` · ${gap} days before this business date`
                                      : null}
                                  </div>
                                ) : null}
                              </>
                            ) : (
                              'No previous closing reading'
                            )}
                          </div>
                          <div>Fill: {fill}</div>
                        </div>
                      </div>

                      <div
                        className="rounded-md border border-slate-800 bg-slate-950/60 p-2 text-xs space-y-1"
                        data-testid="tank-inventory-summary"
                      >
                        <div className="flex justify-between gap-3">
                          <span className="text-slate-400">Opening stock</span>
                          <span>{inv.openingMissing ? 'Missing' : fmtLiters(inv.openingStockLiters)}</span>
                        </div>
                        <div className="flex justify-between gap-3">
                          <span className="text-slate-400">Deliveries received</span>
                          <span>{fmtLiters(inv.deliveriesReceivedLiters ?? 0)}</span>
                        </div>
                        <div className="flex justify-between gap-3">
                          <span className="text-slate-400">Pump sales</span>
                          <span>{fmtLiters(inv.pumpSalesVolumeLiters ?? 0)}</span>
                        </div>
                        <div className="flex justify-between gap-3 text-slate-200">
                          <span>Expected closing stock</span>
                          <span>{expected == null ? '—' : fmtLiters(expected)}</span>
                        </div>
                        <div className="flex justify-between gap-3">
                          <span className="text-slate-400">Actual closing stock</span>
                          <span>{Number.isNaN(closing) ? '—' : fmtLiters(closing)}</span>
                        </div>
                        <div className="flex justify-between gap-3">
                          <span className="text-slate-400">Variance</span>
                          <span>{variance == null ? 'Calculated after entry' : fmtLiters(variance)}</span>
                        </div>
                        {!inv.deliveriesRecorded ? (
                          <p className="pt-1 text-amber-200/90">
                            {inv.noDeliveriesMessage ||
                              'No fuel deliveries were recorded for this tank on this business date.'}
                          </p>
                        ) : null}
                        <Link
                          className="inline-block pt-1 text-emerald-400 hover:underline"
                          to={`/fuel-deliveries?stationId=${stationId}&tankId=${t.tankId}&businessDate=${currentQ.data?.businessDate || pageBusinessDate || ''}`}
                        >
                          View deliveries for this date
                        </Link>
                      </div>

                      <Field
                        label="Closing volume (L) *"
                        hint="Litres of fuel left in this tank at close of business (actual stock)."
                        type="number"
                        disabled={readOnly}
                        value={draft[t.tankId]?.closing_volume_liters ?? ''}
                        onChange={(v) =>
                          setDraft((d) => ({
                            ...d,
                            [t.tankId]: { ...d[t.tankId], closing_volume_liters: v },
                          }))
                        }
                      />
                      <label className="text-xs text-slate-400 block">
                        Notes
                        <span className="text-slate-600 font-normal"> (optional)</span>
                        <textarea
                          className="input mt-1 w-full min-h-[56px]"
                          disabled={readOnly}
                          placeholder="Anything unusual at close of business"
                          value={draft[t.tankId]?.notes ?? ''}
                          onChange={(e) =>
                            setDraft((d) => ({
                              ...d,
                              [t.tankId]: { ...d[t.tankId], notes: e.target.value },
                            }))
                          }
                        />
                      </label>
                      {errors[t.tankId]?.length ? (
                        <div className="text-xs text-red-400">{errors[t.tankId].join(' · ')}</div>
                      ) : null}
                    </div>
                  )
                })}
            </div>

            {!readOnly && (
              <div className="sticky bottom-0 bg-slate-950 border-t border-slate-800 px-4 py-3 flex flex-wrap gap-2 justify-end">
                <button type="button" className="btn-secondary" onClick={closeModal}>
                  Cancel
                </button>
                {mode === 'correct' ? (
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={saveMut.isPending || correctionReason.trim().length < 3}
                    onClick={() => saveMut.mutate()}
                  >
                    Save correction
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={saveMut.isPending}
                      onClick={() => saveMut.mutate()}
                    >
                      Save Draft
                    </button>
                    <button
                      type="button"
                      className="btn-primary"
                      disabled={isLatePreview && lateReason.trim().length < 3}
                      onClick={() => setConfirmOpen(true)}
                    >
                      Submit All Readings
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {dateChangeOpen && pendingBusinessDate && (
        <div className="fixed inset-0 bg-black/70 z-[60] flex items-end sm:items-center justify-center p-4">
          <div className="card max-w-lg w-full space-y-3">
            <h2 className="text-white font-semibold">Change business date?</h2>
            <p className="text-sm text-slate-300">
              The values entered for {formatBusinessDate(viewDate || currentQ.data?.businessDate)} will be
              cleared when you switch to {formatBusinessDate(pendingBusinessDate)}.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setDateChangeOpen(false)
                  setPendingBusinessDate(null)
                }}
              >
                Keep current date
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => {
                  if (pendingBusinessDate) applyBusinessDate(pendingBusinessDate, 'modal')
                  setDateChangeOpen(false)
                  setPendingBusinessDate(null)
                }}
              >
                Change date
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmOpen && (
        <div className="fixed inset-0 bg-black/70 z-[60] flex items-end sm:items-center justify-center p-4">
          <div className="card max-w-lg w-full space-y-3">
            <h2 className="text-white font-semibold">Confirm tank reading</h2>
            <p className="text-sm text-slate-300">
              Submit the tank readings for {currentQ.data?.station?.name} on{' '}
              {formatBusinessDate(currentQ.data?.businessDate)}? You will not be able to edit the
              submission after it is submitted. An administrator must make any corrections.
            </p>
            {isLatePreview ? (
              <p className="text-sm text-amber-200">This will be recorded as a late submission.</p>
            ) : null}
            <ul className="text-sm space-y-2 max-h-48 overflow-auto">
              {summary.map(
                (s: {
                  name: string
                  product?: string
                  capacity: number
                  closing: number | null
                  fill: string
                }) => (
                  <li key={s.name} className="border-b border-slate-800 pb-2">
                    <div className="text-slate-200 font-medium">
                      {s.name} — {s.product}
                    </div>
                    <div className="text-slate-400 text-xs">
                      Closing: {s.closing?.toLocaleString() ?? '—'} L · Fill: {s.fill}%
                    </div>
                  </li>
                ),
              )}
            </ul>
            <div className="flex gap-2 justify-end">
              <button type="button" className="btn-secondary" onClick={() => setConfirmOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={submitMut.isPending || (isLatePreview && lateReason.trim().length < 3)}
                onClick={() => submitMut.mutate()}
              >
                Confirm submit
              </button>
            </div>
          </div>
        </div>
      )}

      {auditOpen && (
        <div className="fixed inset-0 bg-black/70 z-[60] flex items-end sm:items-center justify-center p-4">
          <div className="card max-w-2xl w-full space-y-3 max-h-[85vh] overflow-auto">
            <div className="flex justify-between gap-2">
              <h2 className="text-white font-semibold">Audit history</h2>
              <button type="button" className="btn-secondary text-xs" onClick={() => setAuditOpen(false)}>
                Close
              </button>
            </div>
            {(auditQ.data || []).length === 0 ? (
              <p className="text-sm text-slate-500">No audit events.</p>
            ) : (
              <ul className="space-y-2 text-xs">
                {(auditQ.data || []).map((ev: any) => (
                  <li key={ev.id} className="border border-slate-800 rounded p-2">
                    <div className="text-slate-200 font-medium">
                      {ev.action} · {ev.changedBy?.name || '—'}
                    </div>
                    <div className="text-slate-500">
                      {ev.changedAt ? new Date(ev.changedAt).toLocaleString() : '—'}
                      {ev.reason ? ` · ${ev.reason}` : ''}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function Field({
  label,
  hint,
  value,
  onChange,
  disabled,
  type,
}: {
  label: string
  hint?: string
  value: string | number
  onChange: (v: string) => void
  disabled?: boolean
  type?: string
}) {
  return (
    <label className="text-xs text-slate-400">
      {label}
      <input
        className="input mt-1 w-full h-11"
        type={type || 'text'}
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint ? <p className="mt-1 text-[11px] leading-snug text-slate-500">{hint}</p> : null}
    </label>
  )
}
