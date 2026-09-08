import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  correctTankReadingBatch,
  getStationManagerCurrentReadings,
  getStationManagerHistory,
  getStationManagerStations,
  getTankReadingAudit,
  saveTankReadingDraft,
  submitTankReadings,
} from '../../api/client'
import { useAuth } from '../../context/AuthContext'
import { normalizeRole } from '../../lib/roles'
import TankReadingSummary from '../../components/tank-readings/TankReadingSummary'

type Mode = 'create' | 'continue' | 'view' | 'correct'

export default function TankReadingsPage() {
  const qc = useQueryClient()
  const { user } = useAuth()
  const role = normalizeRole(user?.normalizedRole || user?.role)
  const isAdmin = role === 'ADMIN'

  const stationsQ = useQuery({
    queryKey: ['sm', 'stations'],
    queryFn: async () => (await getStationManagerStations()).data,
  })
  const [stationId, setStationId] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [page, setPage] = useState(1)
  const [modalOpen, setModalOpen] = useState(false)
  const [mode, setMode] = useState<Mode>('create')
  const [viewDate, setViewDate] = useState<string | undefined>()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [auditOpen, setAuditOpen] = useState(false)
  const [auditBatchId, setAuditBatchId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Record<string, any>>({})
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

  const currentQ = useQuery({
    queryKey: ['sm', 'readings', stationId, viewDate || 'current'],
    queryFn: async () => (await getStationManagerCurrentReadings(stationId, viewDate)).data,
    enabled: !!stationId && modalOpen,
  })

  const todayQ = useQuery({
    queryKey: ['sm', 'readings-today', stationId],
    queryFn: async () => (await getStationManagerCurrentReadings(stationId)).data,
    enabled: !!stationId,
  })

  const histQ = useQuery({
    queryKey: ['sm', 'history', stationId, statusFilter, page],
    queryFn: async () =>
      (
        await getStationManagerHistory({
          station_id: stationId || undefined,
          status: statusFilter || undefined,
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
  }, [currentQ.data])

  const uiStatus = todayQ.data?.uiStatus || todayQ.data?.batch?.status || 'NOT_STARTED'
  const managerLocked = ['SUBMITTED', 'ACCEPTED', 'CORRECTED'].includes(uiStatus)
  const readOnly = mode === 'view' || (mode !== 'correct' && managerLocked && !isAdmin)

  const openCreate = () => {
    setViewDate(undefined)
    setMode(uiStatus === 'DRAFT' || uiStatus === 'REOPENED' ? 'continue' : 'create')
    setCorrectionReason('')
    setSubmittedOk(false)
    setModalOpen(true)
    setMessage(null)
  }

  const openRow = (row: any, nextMode: Mode) => {
    setViewDate(row.businessDate)
    setMode(nextMode)
    setCorrectionReason(row.correctionReason || '')
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
        })
      ).data
    },
    onSuccess: (data) => {
      setMessage(mode === 'correct' ? 'Correction saved' : 'Draft saved')
      setErrors(data.fieldErrors || {})
      qc.invalidateQueries({ queryKey: ['sm'] })
      if (mode === 'correct') {
        setModalOpen(false)
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
        })
      ).data
    },
    onSuccess: (data) => {
      setConfirmOpen(false)
      setMode('view')
      setViewDate(data?.businessDate || viewDate || currentQ.data?.businessDate)
      setSubmittedOk(true)
      setModalOpen(true)
      setMessage(data?.batch?.isLate ? 'Submitted (late).' : 'Reading submitted successfully.')
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
    if (!currentQ.data?.tanks) return [] as Array<{
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

  const addButtonLabel =
    uiStatus === 'DRAFT' || uiStatus === 'REOPENED' ? 'Continue Draft' : 'Add New Entry'
  const addDisabled = managerLocked && !isAdmin

  const histItems = Array.isArray(histQ.data)
    ? histQ.data
    : histQ.data?.items || []

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
              className="input mt-1 w-full"
              value={stationId}
              onChange={(e) => {
                setStationId(e.target.value)
                setPage(1)
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
          <div className="text-sm pt-6 space-y-1">
            <div>
              Business date:{' '}
              <span className="font-mono text-white">{todayQ.data?.businessDate || '—'}</span>
            </div>
            <div>
              Deadline: <span className="font-mono text-white">{todayQ.data?.deadlineLocal || '—'}</span>
            </div>
          </div>
          <div className="text-sm pt-6">
            Status:{' '}
            <span className="font-semibold text-emerald-400">{uiStatus}</span>
            {todayQ.data?.batch?.isLate ? (
              <span className="ml-2 text-amber-300 text-xs">LATE</span>
            ) : null}
            {managerLocked && todayQ.data?.batch?.submittedAt ? (
              <div className="text-xs text-slate-500 mt-1">
                Submitted {new Date(todayQ.data.batch.submittedAt).toLocaleString()}
              </div>
            ) : null}
          </div>
          <div className="flex items-end justify-end gap-2">
            {isAdmin && managerLocked && todayQ.data?.batch?.id ? (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => openRow({ businessDate: todayQ.data.businessDate }, 'correct')}
              >
                Edit / Correct
              </button>
            ) : null}
            <button
              type="button"
              className="btn-primary"
              disabled={!stationId || addDisabled}
              onClick={openCreate}
              title={
                addDisabled
                  ? "Today's reading has already been submitted."
                  : undefined
              }
            >
              {addButtonLabel}
            </button>
          </div>
        </div>
        {addDisabled && (
          <div className="text-xs text-amber-200 bg-amber-950/40 border border-amber-900 rounded px-3 py-2">
            Today&apos;s reading has already been submitted.
            {isAdmin ? ' Use Edit / Correct to change values.' : ' An administrator must make any corrections.'}
          </div>
        )}
        {managerLocked && todayQ.data ? (
          <div className="pt-2">
            <TankReadingSummary data={todayQ.data} title="Today's Tank Reading" />
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
          <h2 className="text-white font-semibold text-sm">Previous submissions</h2>
          <label className="text-xs text-slate-400">
            Status
            <select
              className="input mt-1"
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value)
                setPage(1)
              }}
            >
              <option value="">All</option>
              {['DRAFT', 'SUBMITTED', 'CORRECTED', 'REOPENED', 'ACCEPTED', 'REJECTED'].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-400 border-b border-slate-700">
                <th className="pb-2">Business Date</th>
                <th className="pb-2">Station</th>
                <th className="pb-2">Submitted By</th>
                <th className="pb-2 text-right">Total Volume</th>
                <th className="pb-2">Status</th>
                <th className="pb-2">Submitted At</th>
                <th className="pb-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {histItems.length === 0 && !histQ.isLoading ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-slate-500">
                    No submissions yet for this station.
                  </td>
                </tr>
              ) : null}
              {histItems.map((b: any) => (
                <tr key={b.id} className="border-b border-slate-800">
                  <td className="py-2 font-mono">{b.businessDate}</td>
                  <td className="py-2">{b.stationName || '—'}</td>
                  <td className="py-2 text-xs">{b.submittedBy?.name || '—'}</td>
                  <td className="py-2 text-right font-mono">
                    {b.totalClosingVolumeLiters != null
                      ? `${Number(b.totalClosingVolumeLiters).toLocaleString()} L`
                      : '—'}
                  </td>
                  <td className="py-2">
                    <span className="text-xs font-medium text-emerald-300">{b.status}</span>
                    {b.isLate ? <span className="ml-1 text-[10px] text-amber-300">LATE</span> : null}
                  </td>
                  <td className="py-2 text-xs text-slate-400">
                    {b.submittedAt ? new Date(b.submittedAt).toLocaleString() : '—'}
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
        <div className="fixed inset-0 z-50 bg-black/70 flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-slate-950 border border-slate-800 sm:rounded-xl w-full sm:max-w-3xl max-h-[100vh] sm:max-h-[90vh] overflow-auto">
            <div className="sticky top-0 bg-slate-950 border-b border-slate-800 px-4 py-3 flex items-start justify-between gap-3">
              <div>
                {mode !== 'view' ? (
                  <>
                    <h2 className="text-white font-semibold">
                      {mode === 'correct' ? 'Correct Tank Reading' : 'Add Tank Reading'}
                    </h2>
                    <p className="text-xs text-slate-400 mt-1">
                      {currentQ.data?.station?.name || 'Station'} · {currentQ.data?.businessDate || '—'} ·
                      Deadline {currentQ.data?.deadlineLocal || '—'} ·{' '}
                      {currentQ.data?.uiStatus || currentQ.data?.batch?.status || '—'}
                    </p>
                  </>
                ) : (
                  <h2 className="text-white font-semibold">Tank Reading Summary</h2>
                )}
              </div>
              <button type="button" className="btn-secondary text-xs" onClick={() => setModalOpen(false)}>
                Close
              </button>
            </div>

            <div className="p-4 space-y-4">
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
              {mode !== 'view' && !currentQ.isLoading && !currentQ.isError && (currentQ.data?.tanks || []).length === 0 && (
                <div className="rounded-lg border border-amber-900/40 bg-amber-950/30 px-4 py-6 text-sm text-amber-200">
                  No active tanks are configured for this station. Add tanks in Admin before entering
                  tank readings.
                </div>
              )}

              {mode !== 'view' && (currentQ.data?.tanks || []).map((t: any) => {
                const closing = Number(draft[t.tankId]?.closing_volume_liters)
                const cap = Number(t.capacityLiters || 0)
                const fill =
                  cap && !Number.isNaN(closing) ? `${((closing / cap) * 100).toFixed(1)}%` : '—'
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
                        <div>Prev close: {t.previousClosingVolumeLiters?.toLocaleString() ?? '—'} L</div>
                        <div>Fill: {fill}</div>
                      </div>
                    </div>
                    <Field
                      label="Closing volume (L) *"
                      hint="Litres of fuel left in this tank at close of business."
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
                <button type="button" className="btn-secondary" onClick={() => setModalOpen(false)}>
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
                    <button type="button" className="btn-primary" onClick={() => setConfirmOpen(true)}>
                      Submit All Readings
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {confirmOpen && (
        <div className="fixed inset-0 bg-black/70 z-[60] flex items-end sm:items-center justify-center p-4">
          <div className="card max-w-lg w-full space-y-3">
            <h2 className="text-white font-semibold">Confirm tank reading</h2>
            <p className="text-sm text-slate-300">
              Submit the tank readings for {currentQ.data?.station?.name} on{' '}
              {currentQ.data?.businessDate}? You will not be able to edit the submission after it is
              submitted. An administrator must make any corrections.
            </p>
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
              ))}
            </ul>
            <div className="flex gap-2 justify-end">
              <button type="button" className="btn-secondary" onClick={() => setConfirmOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={submitMut.isPending}
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
        className="input mt-1 w-full"
        type={type || 'text'}
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint ? <p className="mt-1 text-[11px] leading-snug text-slate-500">{hint}</p> : null}
    </label>
  )
}
