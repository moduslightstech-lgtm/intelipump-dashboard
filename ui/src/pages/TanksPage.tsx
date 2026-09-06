import { FormEvent, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createTank, getStations, getTanks, updateTank } from '../api/client'

type TankRow = {
  id: string
  stationId?: string | null
  tankCode?: string
  name?: string | null
  product?: string | null
  capacityLiters?: number | null
  status?: string
  currentMeasurementSource?: string
}

const emptyForm = {
  station_id: '',
  tank_code: '',
  name: '',
  product: 'PMS',
  capacity_liters: '45000',
  status: 'ACTIVE',
  current_measurement_source: 'MANUAL',
}

export default function TanksPage() {
  const qc = useQueryClient()
  const tanksQ = useQuery({ queryKey: ['tanks'], queryFn: async () => (await getTanks()).data as TankRow[] })
  const stationsQ = useQuery({ queryKey: ['stations'], queryFn: async () => (await getStations()).data })
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(emptyForm)
  const [msg, setMsg] = useState('')

  const openCreate = () => {
    setEditingId(null)
    setForm(emptyForm)
    setShowForm(true)
    setMsg('')
  }

  const openEdit = (t: TankRow) => {
    setEditingId(t.id)
    setForm({
      station_id: t.stationId || '',
      tank_code: t.tankCode || '',
      name: t.name || '',
      product: t.product || 'PMS',
      capacity_liters: t.capacityLiters != null ? String(t.capacityLiters) : '',
      status: t.status || 'ACTIVE',
      current_measurement_source: t.currentMeasurementSource || 'MANUAL',
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
          station_id: form.station_id,
          tank_code: form.tank_code,
          name: form.name || form.tank_code,
          product: form.product,
          capacity_liters: form.capacity_liters ? Number(form.capacity_liters) : null,
          status: form.status,
          current_measurement_source: form.current_measurement_source,
        })
      ).data
    },
    onSuccess: () => {
      setMsg(editingId ? 'Tank updated' : 'Tank created')
      setShowForm(false)
      setEditingId(null)
      setForm(emptyForm)
      qc.invalidateQueries({ queryKey: ['tanks'] })
      qc.invalidateQueries({ queryKey: ['twin'] })
    },
    onError: () => setMsg('Failed to save tank'),
  })

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    saveMut.mutate()
  }

  const stationName = (id?: string | null) =>
    (stationsQ.data || []).find((s) => s.id === id)?.name || id || '—'

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="section-title">Tanks</h1>
          <p className="text-slate-400 text-sm mt-1">Admin catalog for product tanks used by the Operational Twin.</p>
        </div>
        <button type="button" className="btn-primary text-sm" onClick={openCreate}>
          Add tank
        </button>
      </div>

      {msg && <div className="card text-emerald-300 text-sm">{msg}</div>}

      {showForm && (
        <form className="card grid sm:grid-cols-2 gap-3 max-w-3xl" onSubmit={onSubmit}>
          <h2 className="sm:col-span-2 text-white font-semibold">{editingId ? 'Edit tank' : 'Add tank'}</h2>
          {!editingId && (
            <label className="space-y-1 sm:col-span-2">
              <span className="label-text">Station</span>
              <select
                className="input"
                value={form.station_id}
                onChange={(e) => setForm({ ...form, station_id: e.target.value })}
                required
              >
                <option value="">Station…</option>
                {(stationsQ.data || []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          )}
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
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label className="space-y-1">
            <span className="label-text">Product</span>
            <select className="input" value={form.product} onChange={(e) => setForm({ ...form, product: e.target.value })}>
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
              value={form.capacity_liters}
              onChange={(e) => setForm({ ...form, capacity_liters: e.target.value })}
            />
          </label>
          <label className="space-y-1">
            <span className="label-text">Status</span>
            <select className="input" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
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
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-slate-400 border-b border-slate-700">
              <th className="pb-2 pr-3">Station</th>
              <th className="pb-2 pr-3">Code</th>
              <th className="pb-2 pr-3">Name</th>
              <th className="pb-2 pr-3">Product</th>
              <th className="pb-2 pr-3">Capacity</th>
              <th className="pb-2 pr-3">Source</th>
              <th className="pb-2 pr-3">Status</th>
              <th className="pb-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(tanksQ.data || []).map((t) => (
              <tr key={t.id} className="border-b border-slate-800 hover:bg-slate-800/40">
                <td className="py-2 pr-3">{stationName(t.stationId)}</td>
                <td className="py-2 pr-3 font-mono text-xs">{t.tankCode}</td>
                <td className="py-2 pr-3">{t.name || '—'}</td>
                <td className="py-2 pr-3">{t.product || '—'}</td>
                <td className="py-2 pr-3">
                  {t.capacityLiters != null ? Number(t.capacityLiters).toLocaleString() : '—'}
                </td>
                <td className="py-2 pr-3 text-xs">{t.currentMeasurementSource || '—'}</td>
                <td className="py-2 pr-3">{t.status || '—'}</td>
                <td className="py-2">
                  <div className="flex flex-wrap gap-1">
                    <button type="button" className="btn-secondary text-xs px-2 py-1" onClick={() => openEdit(t)}>
                      Edit
                    </button>
                    <button
                      type="button"
                      className="btn-secondary text-xs px-2 py-1"
                      onClick={async () => {
                        const next = t.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE'
                        await updateTank(t.id, { status: next })
                        qc.invalidateQueries({ queryKey: ['tanks'] })
                        qc.invalidateQueries({ queryKey: ['twin'] })
                      }}
                    >
                      {t.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
