import { FormEvent, useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useOutletContext, useSearchParams } from 'react-router-dom'
import {
  createAdminTankConnection,
  deleteAdminTankConnection,
  getAdminStationPumps,
  getAdminTankConnections,
  getTanks,
  type Station,
  updateAdminTankConnection,
} from '../../api/client'

type Ctx = { stationId: string; station?: Station; refreshStation: () => void }

export default function AdminStationConnectionsPage() {
  const { stationId, refreshStation } = useOutletContext<Ctx>()
  const [search] = useSearchParams()
  const qc = useQueryClient()
  const [msg, setMsg] = useState('')
  const [form, setForm] = useState({
    tank_id: '',
    pump_id: '',
    product: '',
    is_primary: true,
    active: true,
    display_order: '',
  })

  const connectionsQ = useQuery({
    queryKey: ['admin-tank-connections', stationId],
    queryFn: async () => (await getAdminTankConnections(stationId)).data,
  })
  const tanksQ = useQuery({
    queryKey: ['admin-station-tanks', stationId],
    queryFn: async () => (await getTanks(stationId)).data,
  })
  const pumpsQ = useQuery({
    queryKey: ['admin-station-pumps', stationId],
    queryFn: async () => (await getAdminStationPumps(stationId, true)).data,
  })

  useEffect(() => {
    const pumpId = search.get('pumpId')
    if (pumpId) setForm((f) => ({ ...f, pump_id: pumpId }))
  }, [search])

  const selectedTank = useMemo(
    () => (tanksQ.data || []).find((t: any) => t.id === form.tank_id),
    [tanksQ.data, form.tank_id],
  )

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['admin-tank-connections', stationId] })
    qc.invalidateQueries({ queryKey: ['admin-station', stationId] })
    qc.invalidateQueries({ queryKey: ['twin'] })
    refreshStation()
  }

  const createMut = useMutation({
    mutationFn: async () => {
      if (!form.tank_id || !form.pump_id) {
        throw new Error('Incomplete')
      }
      if (form.active && (!form.tank_id || !form.pump_id)) {
        throw new Error('Incomplete active connection')
      }
      return (
        await createAdminTankConnection(stationId, {
          tank_id: form.tank_id,
          pump_id: form.pump_id,
          product: form.product || selectedTank?.product || null,
          is_primary: form.is_primary,
          active: form.active,
          display_order: form.display_order ? Number(form.display_order) : undefined,
        })
      ).data
    },
    onSuccess: () => {
      setMsg('Connection saved')
      setForm({
        tank_id: '',
        pump_id: '',
        product: '',
        is_primary: true,
        active: true,
        display_order: '',
      })
      invalidate()
    },
    onError: () => setMsg('Failed to save connection — ensure tank and pump are set'),
  })

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (form.active && (!form.tank_id || !form.pump_id)) {
      setMsg('Cannot save an incomplete active connection')
      return
    }
    createMut.mutate()
  }

  return (
    <div className="space-y-4">
      {msg && <div className="card text-emerald-300 text-sm">{msg}</div>}

      <form className="card grid sm:grid-cols-2 gap-3 max-w-3xl" onSubmit={onSubmit}>
        <h2 className="sm:col-span-2 text-white font-semibold">Tank connections</h2>
        <p className="sm:col-span-2 text-slate-400 text-sm">
          Maps source tanks to pumps. The Operational Twin uses these routes for pipe drawing.
        </p>
        <label className="space-y-1">
          <span className="label-text">Source tank</span>
          <select
            className="input"
            value={form.tank_id}
            onChange={(e) => setForm({ ...form, tank_id: e.target.value })}
            required={form.active}
          >
            <option value="">Select tank…</option>
            {(tanksQ.data || []).map((t: any) => (
              <option key={t.id} value={t.id}>
                {t.tankCode || t.tank_code} · {t.product || '—'}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="label-text">Destination pump</span>
          <select
            className="input"
            value={form.pump_id}
            onChange={(e) => setForm({ ...form, pump_id: e.target.value })}
            required={form.active}
          >
            <option value="">Select pump…</option>
            {(pumpsQ.data || [])
              .filter((p) => p.active !== false)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name || p.pump_code} · {p.mqtt_pump_id || p.pump_code}
                </option>
              ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="label-text">Product</span>
          <input
            className="input"
            value={form.product}
            onChange={(e) => setForm({ ...form, product: e.target.value })}
            placeholder={selectedTank?.product || 'PMS'}
          />
        </label>
        <label className="space-y-1">
          <span className="label-text">Display order</span>
          <input
            className="input"
            type="number"
            value={form.display_order}
            onChange={(e) => setForm({ ...form, display_order: e.target.value })}
          />
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={form.is_primary}
            onChange={(e) => setForm({ ...form, is_primary: e.target.checked })}
          />
          <span className="label-text">Primary connection</span>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={form.active}
            onChange={(e) => setForm({ ...form, active: e.target.checked })}
          />
          <span className="label-text">Active</span>
        </label>
        <button className="btn-primary sm:col-span-2" type="submit">
          Save connection
        </button>
      </form>

      <div className="card overflow-x-auto">
        <table className="table w-full text-sm">
          <thead>
            <tr className="text-slate-400 border-b border-slate-700 text-left">
              <th className="py-2 pr-3">Tank</th>
              <th className="py-2 pr-3">Pump</th>
              <th className="py-2 pr-3">Product</th>
              <th className="py-2 pr-3">Primary</th>
              <th className="py-2 pr-3">Active</th>
              <th className="py-2 pr-3">Order</th>
              <th className="py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(connectionsQ.data || []).map((c) => (
              <tr key={c.id} className="border-b border-slate-800">
                <td className="py-2 pr-3">{c.tank_code || c.tank_id}</td>
                <td className="py-2 pr-3">{c.pump_name || c.pump_code || c.pump_id}</td>
                <td className="py-2 pr-3">{c.product || '—'}</td>
                <td className="py-2 pr-3">{c.is_primary ? 'Yes' : '—'}</td>
                <td className="py-2 pr-3">{c.active ? 'Yes' : 'No'}</td>
                <td className="py-2 pr-3">{c.display_order}</td>
                <td className="py-2">
                  <div className="flex flex-wrap gap-1">
                    <button
                      type="button"
                      className="btn-secondary text-xs px-2 py-1"
                      onClick={async () => {
                        await updateAdminTankConnection(c.id, {
                          is_primary: !c.is_primary,
                          active: c.active,
                        })
                        invalidate()
                      }}
                    >
                      {c.is_primary ? 'Unset primary' : 'Make primary'}
                    </button>
                    <button
                      type="button"
                      className="btn-secondary text-xs px-2 py-1"
                      onClick={async () => {
                        await updateAdminTankConnection(c.id, { active: !c.active })
                        invalidate()
                      }}
                    >
                      {c.active ? 'Deactivate' : 'Activate'}
                    </button>
                    <button
                      type="button"
                      className="btn-secondary text-xs px-2 py-1 text-rose-300"
                      onClick={async () => {
                        await deleteAdminTankConnection(c.id)
                        invalidate()
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {!connectionsQ.isLoading && !(connectionsQ.data || []).length && (
              <tr>
                <td colSpan={7} className="py-6 text-center text-slate-500">
                  No connections yet. Map each pump to a source tank.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
