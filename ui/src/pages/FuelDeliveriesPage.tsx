import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  completeFuelDelivery,
  createFuelDelivery,
  fmtLiters,
  fmtTime,
  getFuelDeliveryStockPreview,
  getFuelDeliveryTanks,
  getStationManagerStations,
  listFuelDeliveries,
  voidFuelDelivery,
} from '../api/client'
import { useAuth } from '../context/AuthContext'
import { formatStatusLabel } from '../lib/enumPresentation'
import { normalizeRole } from '../lib/roles'

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

function localDateTimeValue(d = new Date()) {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function toUtcIso(localValue: string) {
  const dt = new Date(localValue)
  return dt.toISOString()
}

export default function FuelDeliveriesPage() {
  const qc = useQueryClient()
  const { user } = useAuth()
  const role = normalizeRole(user?.normalizedRole || user?.role)
  const canWrite = role === 'ADMIN' || role === 'STATION_MANAGER'

  const stationsQ = useQuery({
    queryKey: ['sm', 'stations'],
    queryFn: async () => (await getStationManagerStations()).data,
  })

  const [stationId, setStationId] = useState('')
  const [tankId, setTankId] = useState('')
  const [status, setStatus] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [modalOpen, setModalOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [voidId, setVoidId] = useState<string | null>(null)
  const [voidReason, setVoidReason] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [ackOverfill, setAckOverfill] = useState(false)
  const [form, setForm] = useState({
    station_id: '',
    tank_id: '',
    business_date: todayIso(),
    delivered_at: localDateTimeValue(),
    quantity_litres: '',
    supplier_name: '',
    supplier_reference: '',
    waybill_number: '',
    vehicle_registration: '',
    notes: '',
  })

  useEffect(() => {
    if (!stationId && stationsQ.data?.[0]?.id) setStationId(stationsQ.data[0].id)
  }, [stationId, stationsQ.data])

  const tanksQ = useQuery({
    queryKey: ['fuel-deliveries', 'tanks', stationId || form.station_id],
    queryFn: async () => (await getFuelDeliveryTanks(stationId || form.station_id)).data,
    enabled: Boolean(stationId || form.station_id),
  })

  const listQ = useQuery({
    queryKey: ['fuel-deliveries', stationId, tankId, status, dateFrom, dateTo, search, page],
    queryFn: async () =>
      (
        await listFuelDeliveries({
          station_id: stationId || undefined,
          tank_id: tankId || undefined,
          status: status || undefined,
          from: dateFrom || undefined,
          to: dateTo || undefined,
          search: search || undefined,
          page,
          page_size: 25,
        })
      ).data,
  })

  const selectedTank = useMemo(
    () => (tanksQ.data || []).find((t: any) => t.id === form.tank_id),
    [tanksQ.data, form.tank_id],
  )

  const qty = Number(form.quantity_litres)
  const previewQ = useQuery({
    queryKey: ['fuel-deliveries', 'preview', form.station_id, form.tank_id, form.quantity_litres],
    queryFn: async () =>
      (await getFuelDeliveryStockPreview(form.station_id, form.tank_id, qty)).data,
    enabled: Boolean(form.station_id && form.tank_id && qty > 0),
  })

  const saveMut = useMutation({
    mutationFn: async (complete: boolean) => {
      const body = {
        station_id: form.station_id,
        tank_id: form.tank_id,
        business_date: form.business_date,
        delivered_at: toUtcIso(form.delivered_at),
        quantity_litres: Number(form.quantity_litres),
        product: selectedTank?.product || undefined,
        supplier_name: form.supplier_name || undefined,
        supplier_reference: form.supplier_reference || undefined,
        waybill_number: form.waybill_number || undefined,
        vehicle_registration: form.vehicle_registration || undefined,
        notes: form.notes || undefined,
        acknowledge_overfill_warning: ackOverfill,
        complete,
      }
      return (await createFuelDelivery(body)).data
    },
    onSuccess: async (data, complete) => {
      setMessage(complete ? 'Delivery completed successfully.' : 'Draft saved.')
      setModalOpen(false)
      setConfirmOpen(false)
      setAckOverfill(false)
      await qc.invalidateQueries({ queryKey: ['fuel-deliveries'] })
      await qc.invalidateQueries({ queryKey: ['sm'] })
      await qc.invalidateQueries({ queryKey: ['twin'] })
      await qc.invalidateQueries({ queryKey: ['day-closes'] })
      if (data.warnings?.length) setMessage((m) => `${m} ${data.warnings!.join(' ')}`)
    },
    onError: (err: any) => {
      const detail = err?.response?.data?.detail
      if (detail?.code === 'OVERFILL_ACK_REQUIRED') {
        setAckOverfill(false)
        setMessage(detail.message || 'Overfill confirmation required.')
        return
      }
      setMessage(typeof detail === 'string' ? detail : 'Could not save delivery.')
    },
  })

  const voidMut = useMutation({
    mutationFn: async () => {
      if (!voidId) return
      return (await voidFuelDelivery(voidId, { reason: voidReason })).data
    },
    onSuccess: async () => {
      setVoidId(null)
      setVoidReason('')
      setMessage('Delivery voided.')
      await qc.invalidateQueries({ queryKey: ['fuel-deliveries'] })
      await qc.invalidateQueries({ queryKey: ['sm'] })
      await qc.invalidateQueries({ queryKey: ['twin'] })
    },
  })

  const openRecord = () => {
    setForm({
      station_id: stationId || stationsQ.data?.[0]?.id || '',
      tank_id: '',
      business_date: todayIso(),
      delivered_at: localDateTimeValue(),
      quantity_litres: '',
      supplier_name: '',
      supplier_reference: '',
      waybill_number: '',
      vehicle_registration: '',
      notes: '',
    })
    setAckOverfill(false)
    setMessage(null)
    setModalOpen(true)
  }

  const preview = previewQ.data
  const overfill = Boolean(preview?.possibleOverfill)

  return (
    <div className="space-y-4" data-testid="fuel-deliveries-page">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-white">Fuel Deliveries</h1>
          <p className="text-sm text-slate-400">Record fuel received into station tanks.</p>
        </div>
        {canWrite ? (
          <button type="button" className="btn-primary" onClick={openRecord} data-testid="record-delivery">
            Record Delivery
          </button>
        ) : null}
      </div>

      {message ? (
        <div className="rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200">{message}</div>
      ) : null}

      <div className="card grid gap-2 sm:grid-cols-2 lg:grid-cols-6 items-end">
        <label className="text-xs text-slate-400">
          Station
          <select className="input mt-1 w-full" value={stationId} onChange={(e) => { setStationId(e.target.value); setPage(1) }}>
            {(stationsQ.data || []).map((s: any) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-slate-400">
          Tank
          <select className="input mt-1 w-full" value={tankId} onChange={(e) => { setTankId(e.target.value); setPage(1) }}>
            <option value="">All tanks</option>
            {(tanksQ.data || []).map((t: any) => (
              <option key={t.id} value={t.id}>{t.name || t.tankCode}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-slate-400">
          From
          <input type="date" className="input mt-1 w-full" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(1) }} />
        </label>
        <label className="text-xs text-slate-400">
          To
          <input type="date" className="input mt-1 w-full" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(1) }} />
        </label>
        <label className="text-xs text-slate-400">
          Status
          <select className="input mt-1 w-full" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }}>
            <option value="">All</option>
            <option value="DRAFT">Draft</option>
            <option value="COMPLETED">Completed</option>
            <option value="VOIDED">Voided</option>
          </select>
        </label>
        <label className="text-xs text-slate-400 lg:col-span-1 sm:col-span-2">
          Search
          <input
            className="input mt-1 w-full"
            placeholder="Waybill, reference, vehicle"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1) }}
          />
        </label>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm min-w-[64rem]">
          <thead>
            <tr className="text-left text-slate-500">
              <th className="pb-2 pr-3">Business date</th>
              <th className="pb-2 pr-3">Delivery time</th>
              <th className="pb-2 pr-3">Station</th>
              <th className="pb-2 pr-3">Tank</th>
              <th className="pb-2 pr-3">Product</th>
              <th className="pb-2 pr-3">Quantity</th>
              <th className="pb-2 pr-3">Supplier</th>
              <th className="pb-2 pr-3">Waybill / reference</th>
              <th className="pb-2 pr-3">Status</th>
              <th className="pb-2 pr-3">Recorded by</th>
              <th className="pb-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(listQ.data?.items || []).map((row: any) => (
              <tr key={row.id} className="border-t border-slate-800" data-testid="fuel-delivery-row">
                <td className="py-2 pr-3 text-white">{row.businessDate}</td>
                <td className="pr-3">{fmtTime(row.deliveredAt)}</td>
                <td className="pr-3">{row.stationName || '—'}</td>
                <td className="pr-3">{row.tankName || row.tankCode || '—'}</td>
                <td className="pr-3">{row.product || '—'}</td>
                <td className="pr-3">{fmtLiters(row.quantityLitres)}</td>
                <td className="pr-3">{row.supplierName || '—'}</td>
                <td className="pr-3">{row.waybillNumber || row.supplierReference || '—'}</td>
                <td className="pr-3">{formatStatusLabel(row.status)}</td>
                <td className="pr-3">{row.createdByName || '—'}</td>
                <td className="space-x-2">
                  {canWrite && row.status === 'DRAFT' ? (
                    <button
                      type="button"
                      className="btn-secondary px-2 py-1 text-xs"
                      onClick={() =>
                        completeFuelDelivery(row.id, { version: row.version }).then(async () => {
                          setMessage('Delivery completed successfully.')
                          await qc.invalidateQueries({ queryKey: ['fuel-deliveries'] })
                          await qc.invalidateQueries({ queryKey: ['twin'] })
                          await qc.invalidateQueries({ queryKey: ['sm'] })
                        })
                      }
                    >
                      Complete
                    </button>
                  ) : null}
                  {canWrite && row.status === 'COMPLETED' ? (
                    <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => setVoidId(row.id)}>
                      Void
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!listQ.data?.items?.length ? (
          <p className="text-sm text-slate-500 py-6 text-center">No fuel deliveries match these filters.</p>
        ) : null}
        <div className="mt-3 flex items-center justify-between text-xs text-slate-400">
          <span>
            Page {listQ.data?.page || page} · {listQ.data?.total || 0} total
          </span>
          <div className="space-x-2">
            <button type="button" className="btn-secondary px-2 py-1" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Previous
            </button>
            <button
              type="button"
              className="btn-secondary px-2 py-1"
              disabled={!listQ.data?.hasMore}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        </div>
      </div>

      {modalOpen ? (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 p-3">
          <div className="w-full max-w-2xl rounded-xl border border-slate-700 bg-slate-950 p-4 space-y-3 max-h-[92vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h2 className="text-white font-semibold">Record Delivery</h2>
              <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => setModalOpen(false)}>
                Cancel
              </button>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="text-xs text-slate-400">
                Station *
                <select
                  className="input mt-1 w-full"
                  value={form.station_id}
                  onChange={(e) => setForm((f) => ({ ...f, station_id: e.target.value, tank_id: '' }))}
                >
                  {(stationsQ.data || []).map((s: any) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-slate-400">
                Tank *
                <select
                  className="input mt-1 w-full"
                  value={form.tank_id}
                  onChange={(e) => setForm((f) => ({ ...f, tank_id: e.target.value }))}
                >
                  <option value="">Select tank</option>
                  {(tanksQ.data || []).map((t: any) => (
                    <option key={t.id} value={t.id}>{t.name || t.tankCode} · {t.product || '—'}</option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-slate-400">
                Product
                <input className="input mt-1 w-full" disabled value={selectedTank?.product || ''} />
              </label>
              <label className="text-xs text-slate-400">
                Business date *
                <input
                  type="date"
                  className="input mt-1 w-full"
                  value={form.business_date}
                  onChange={(e) => setForm((f) => ({ ...f, business_date: e.target.value }))}
                />
              </label>
              <label className="text-xs text-slate-400">
                Delivery date and time *
                <input
                  type="datetime-local"
                  className="input mt-1 w-full"
                  value={form.delivered_at}
                  onChange={(e) => setForm((f) => ({ ...f, delivered_at: e.target.value }))}
                />
              </label>
              <label className="text-xs text-slate-400">
                Quantity delivered (L) *
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  className="input mt-1 w-full"
                  value={form.quantity_litres}
                  onChange={(e) => setForm((f) => ({ ...f, quantity_litres: e.target.value }))}
                />
              </label>
              <label className="text-xs text-slate-400">
                Supplier name
                <input className="input mt-1 w-full" value={form.supplier_name} onChange={(e) => setForm((f) => ({ ...f, supplier_name: e.target.value }))} />
              </label>
              <label className="text-xs text-slate-400">
                Supplier reference / waybill
                <input className="input mt-1 w-full" value={form.supplier_reference || form.waybill_number} onChange={(e) => setForm((f) => ({ ...f, supplier_reference: e.target.value, waybill_number: e.target.value }))} />
              </label>
              <label className="text-xs text-slate-400">
                Vehicle registration
                <input className="input mt-1 w-full" value={form.vehicle_registration} onChange={(e) => setForm((f) => ({ ...f, vehicle_registration: e.target.value }))} />
              </label>
              <label className="text-xs text-slate-400 sm:col-span-2">
                Notes
                <textarea className="input mt-1 w-full min-h-[56px]" value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
              </label>
            </div>

            {form.tank_id && qty > 0 ? (
              <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3 text-sm space-y-1" data-testid="stock-preview">
                <div className="flex justify-between"><span className="text-slate-400">Last recorded stock</span><span>{fmtLiters(preview?.lastRecordedStockLiters)}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Delivery</span><span>{fmtLiters(qty)}</span></div>
                <div className="flex justify-between text-white font-medium"><span>Projected stock</span><span>{fmtLiters(preview?.projectedStockLiters)}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Tank capacity</span><span>{fmtLiters(preview?.tankCapacityLiters)}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Projected fill</span><span>{preview?.projectedFillPercent != null ? `${preview.projectedFillPercent}%` : '—'}</span></div>
              </div>
            ) : null}

            {overfill ? (
              <label className="flex items-start gap-2 rounded border border-amber-800 bg-amber-950/40 px-3 py-2 text-sm text-amber-100">
                <input type="checkbox" checked={ackOverfill} onChange={(e) => setAckOverfill(e.target.checked)} />
                <span>
                  Projected stock exceeds tank capacity. Existing stock may be estimated or outdated. I confirm this delivery.
                </span>
              </label>
            ) : null}

            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className="btn-secondary" onClick={() => setModalOpen(false)}>Cancel</button>
              <button
                type="button"
                className="btn-secondary"
                disabled={!canWrite || saveMut.isPending || !form.tank_id || !(qty > 0) || (overfill && !ackOverfill)}
                onClick={() => saveMut.mutate(false)}
              >
                Save Draft
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={!canWrite || saveMut.isPending || !form.tank_id || !(qty > 0) || (overfill && !ackOverfill)}
                onClick={() => setConfirmOpen(true)}
              >
                Complete Delivery
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {confirmOpen ? (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-3">
          <div className="w-full max-w-md rounded-xl border border-slate-700 bg-slate-950 p-4 space-y-3">
            <p className="text-sm text-slate-200">
              Confirm that {fmtLiters(qty)} of {selectedTank?.product || 'fuel'} was delivered to{' '}
              {selectedTank?.name || selectedTank?.tankCode || 'the selected tank'} on {form.business_date}.
            </p>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-secondary" onClick={() => setConfirmOpen(false)}>Back</button>
              <button type="button" className="btn-primary" onClick={() => saveMut.mutate(true)}>Confirm</button>
            </div>
          </div>
        </div>
      ) : null}

      {voidId ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3">
          <div className="w-full max-w-md rounded-xl border border-slate-700 bg-slate-950 p-4 space-y-3">
            <h3 className="text-white font-semibold">Void delivery</h3>
            <label className="text-xs text-slate-400 block">
              Reason *
              <textarea className="input mt-1 w-full min-h-[80px]" value={voidReason} onChange={(e) => setVoidReason(e.target.value)} />
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-secondary" onClick={() => setVoidId(null)}>Cancel</button>
              <button
                type="button"
                className="btn-primary"
                disabled={voidReason.trim().length < 3 || voidMut.isPending}
                onClick={() => voidMut.mutate()}
              >
                Void
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <p className="text-xs text-slate-500">
        Need tank readings for this date? <Link className="text-emerald-400" to="/station-manager/tank-readings">Open Tank Reading</Link>
      </p>
    </div>
  )
}
