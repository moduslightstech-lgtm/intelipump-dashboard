import { FormEvent, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useOutletContext } from 'react-router-dom'
import { createTank, fmtLiters, getTanks, humanizeEnum, type Station, updateTank } from '../../api/client'
import { useAuth } from '../../context/AuthContext'
import { isAdmin } from '../../lib/roles'
import DeleteTankModal from '../../components/admin/DeleteTankModal'

type Ctx = { stationId: string; station?: Station; refreshStation: () => void }

type TankRow = {
  id: string
  tankCode?: string
  tank_code?: string
  name?: string | null
  product?: string | null
  capacityLiters?: number | null
  capacity_liters?: number | null
  status?: string
  currentMeasurementSource?: string
  current_measurement_source?: string
}

const emptyForm = {
  tank_code: '',
  name: '',
  product: 'PMS',
  capacity_liters: '45000',
  status: 'ACTIVE',
  current_measurement_source: 'MANUAL',
}

function normalizeTank(t: TankRow) {
  return {
    id: t.id,
    tankCode: t.tankCode || t.tank_code || '',
    name: t.name || '',
    product: t.product || 'PMS',
    capacityLiters: t.capacityLiters ?? t.capacity_liters ?? null,
    status: t.status || 'ACTIVE',
    measurementSource: t.currentMeasurementSource || t.current_measurement_source || 'MANUAL',
  }
}

export default function AdminStationTanksPage() {
  const { stationId, station, refreshStation } = useOutletContext<Ctx>()
  const { user } = useAuth()
  const admin = isAdmin(user?.normalizedRole || user?.role)
  const qc = useQueryClient()
  const tanksQ = useQuery({
    queryKey: ['admin-station-tanks', stationId],
    queryFn: async () => (await getTanks(stationId)).data as TankRow[],
  })
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(emptyForm)
  const [msg, setMsg] = useState('')
  const [deleteTank, setDeleteTank] = useState<ReturnType<typeof normalizeTank> | null>(null)

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['admin-station-tanks', stationId] })
    qc.invalidateQueries({ queryKey: ['admin-station', stationId] })
    qc.invalidateQueries({ queryKey: ['tanks'] })
    qc.invalidateQueries({ queryKey: ['twin'] })
    refreshStation()
  }

  const openCreate = () => {
    setEditingId(null)
    setForm(emptyForm)
    setShowForm(true)
    setMsg('')
  }

  const openEdit = (raw: TankRow) => {
    const t = normalizeTank(raw)
    setEditingId(t.id)
    setForm({
      tank_code: t.tankCode,
      name: t.name,
      product: t.product || 'PMS',
      capacity_liters: t.capacityLiters != null ? String(t.capacityLiters) : '',
      status: t.status || 'ACTIVE',
      current_measurement_source: t.measurementSource || 'MANUAL',
    })
    setShowForm(true)
    setMsg('')
  }

  const saveMut = useMutation({
    mutationFn: async () => {
      if (editingId) {
        return (
          await updateTank(editingId, {
            tank_code: form.tank_code,
            name: form.name || form.tank_code,
            product: form.product,
            capacity_liters: form.capacity_liters ? Number(form.capacity_liters) : null,
            status: form.status,
            current_measurement_source: form.current_measurement_source,
          })
        ).data
      }
      return (
        await createTank({
          station_id: stationId,
          tank_code: form.tank_code,
          name: form.name || form.tank_code,
          product: form.product,
          capacity_liters: form.capacity_liters ? Number(form.capacity_liters) : null,
          status: form.status || 'ACTIVE',
          current_measurement_source: form.current_measurement_source || 'MANUAL',
        })
      ).data
    },
    onSuccess: () => {
      setMsg(editingId ? 'Tank updated' : 'Tank created')
      setShowForm(false)
      setEditingId(null)
      setForm(emptyForm)
      invalidate()
    },
    onError: () => setMsg(editingId ? 'Failed to update tank' : 'Failed to create tank'),
  })

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    saveMut.mutate()
  }

  const tanks = (tanksQ.data || []).map(normalizeTank)

  return (
    <div className="space-y-4">
      {msg && <div className="card text-emerald-300 text-sm">{msg}</div>}

      <div className="flex items-center justify-between gap-3">
        <h2 className="text-white font-semibold">Tanks</h2>
        <button type="button" className="btn-primary text-sm" onClick={openCreate}>
          Add tank
        </button>
      </div>

      {showForm && (
        <form className="card grid sm:grid-cols-2 gap-3 max-w-3xl" onSubmit={onSubmit}>
          <h3 className="sm:col-span-2 text-white font-medium">{editingId ? 'Edit tank' : 'Add tank'}</h3>
          <label className="space-y-1">
            <span className="label-text">Tank code</span>
            <input
              className="input font-mono"
              value={form.tank_code}
              onChange={(e) => setForm({ ...form, tank_code: e.target.value })}
              required
            />
          </label>
          <label className="space-y-1">
            <span className="label-text">Name</span>
            <input
              className="input"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label className="space-y-1">
            <span className="label-text">Product</span>
            <select
              className="input"
              value={form.product}
              onChange={(e) => setForm({ ...form, product: e.target.value })}
            >
              {['PMS', 'AGO', 'DPK'].map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="label-text">Capacity (L)</span>
            <input
              className="input"
              type="number"
              min={0}
              step="1"
              value={form.capacity_liters}
              onChange={(e) => setForm({ ...form, capacity_liters: e.target.value })}
            />
          </label>
          <label className="space-y-1">
            <span className="label-text">Status</span>
            <select
              className="input"
              value={form.status}
              onChange={(e) => setForm({ ...form, status: e.target.value })}
            >
              {['ACTIVE', 'INACTIVE', 'MAINTENANCE', 'UNKNOWN'].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="label-text">Measurement source</span>
            <select
              className="input"
              value={form.current_measurement_source}
              onChange={(e) => setForm({ ...form, current_measurement_source: e.target.value })}
            >
              {['MANUAL', 'AUTOMATED'].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <div className="sm:col-span-2 flex gap-2">
            <button className="btn-primary" type="submit" disabled={saveMut.isPending}>
              {editingId ? 'Save changes' : 'Create tank'}
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setShowForm(false)
                setEditingId(null)
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="card overflow-x-auto">
        <table className="table w-full text-sm">
          <thead>
            <tr className="text-slate-400 border-b border-slate-700 text-left">
              <th className="py-2 pr-3">Code</th>
              <th className="py-2 pr-3">Name</th>
              <th className="py-2 pr-3">Product</th>
              <th className="py-2 pr-3">Capacity</th>
              <th className="py-2 pr-3">Source</th>
              <th className="py-2 pr-3">Status</th>
              <th className="py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {tanks.map((t) => (
              <tr key={t.id} className="border-b border-slate-800 hover:bg-slate-800/40">
                <td className="py-2 pr-3 font-mono text-xs">{t.tankCode}</td>
                <td className="py-2 pr-3">{t.name || '—'}</td>
                <td className="py-2 pr-3">{t.product || '—'}</td>
                <td className="py-2 pr-3">
                  {t.capacityLiters != null ? fmtLiters(t.capacityLiters) : '—'}
                </td>
                <td className="py-2 pr-3 text-xs">{humanizeEnum(t.measurementSource)}</td>
                <td className="py-2 pr-3">
                  <span className={t.status === 'ACTIVE' ? 'badge-ok' : 'badge-warn'}>
                    {humanizeEnum(t.status)}
                  </span>
                </td>
                <td className="py-2">
                  <div className="flex flex-wrap gap-1">
                    <button type="button" className="btn-secondary text-xs px-2 py-1" onClick={() => openEdit({
                      id: t.id,
                      tankCode: t.tankCode,
                      name: t.name,
                      product: t.product,
                      capacityLiters: t.capacityLiters,
                      status: t.status,
                      currentMeasurementSource: t.measurementSource,
                    })}>
                      Edit
                    </button>
                    <button
                      type="button"
                      className="btn-secondary text-xs px-2 py-1"
                      onClick={async () => {
                        const next = t.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE'
                        await updateTank(t.id, { status: next })
                        setMsg(next === 'ACTIVE' ? 'Tank activated' : 'Tank deactivated')
                        invalidate()
                      }}
                    >
                      {t.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
                    </button>
                    {admin && (
                      <button
                        type="button"
                        className="btn-secondary text-xs px-2 py-1 text-rose-300"
                        onClick={() => setDeleteTank(t)}
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {!tanksQ.isLoading && !tanks.length && (
              <tr>
                <td colSpan={7} className="py-8 text-center text-slate-500">
                  No tanks for this station yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <DeleteTankModal
        open={Boolean(deleteTank)}
        stationId={stationId}
        stationName={station?.name}
        tank={deleteTank}
        onClose={() => setDeleteTank(null)}
        onDeleted={(result) => {
          setDeleteTank(null)
          setMsg(
            result.archived
              ? `Tank ${result.tankCode} archived. Historical records were kept.`
              : `Tank ${result.tankCode} deleted.`,
          )
          invalidate()
        }}
      />
    </div>
  )
}
