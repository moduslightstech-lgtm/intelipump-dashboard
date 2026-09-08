import { FormEvent, Fragment, useMemo, useState } from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createAdminNozzle,
  createAdminStationPump,
  deactivateAdminNozzle,
  deactivateAdminPump,
  deleteAdminPump,
  duplicateAdminPump,
  getAdminPumpNozzles,
  getAdminStationDevices,
  getAdminStationPumps,
  getAdminTankConnections,
  reactivateAdminPump,
  type Pump,
  type Station,
  updateAdminNozzle,
  updateAdminPump,
} from '../../api/client'

type Ctx = { stationId: string; station?: Station; refreshStation: () => void }

const emptyPumpForm = {
  name: '',
  pump_code: '',
  mqtt_pump_id: '',
  pump_number: '',
  display_order: '',
  island_number: '',
  manufacturer: '',
  model: '',
  protocol: '',
  device_id: '',
  status: 'ACTIVE',
  active: true,
  product: 'PMS',
  nozzle_count: '2',
  notes: '',
}

export default function AdminStationPumpsPage() {
  const { stationId, refreshStation } = useOutletContext<Ctx>()
  const qc = useQueryClient()
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Pump | null>(null)
  const [form, setForm] = useState(emptyPumpForm)
  const [msg, setMsg] = useState('')
  const [expandedPumpId, setExpandedPumpId] = useState<string | null>(null)
  const [promptConnectPumpId, setPromptConnectPumpId] = useState<string | null>(null)

  const pumpsQ = useQuery({
    queryKey: ['admin-station-pumps', stationId],
    queryFn: async () => (await getAdminStationPumps(stationId, true)).data,
  })
  const devicesQ = useQuery({
    queryKey: ['admin-station-devices', stationId],
    queryFn: async () => (await getAdminStationDevices(stationId)).data,
  })
  const connectionsQ = useQuery({
    queryKey: ['admin-tank-connections', stationId],
    queryFn: async () => (await getAdminTankConnections(stationId)).data,
  })

  const connectedPumpIds = useMemo(
    () => new Set((connectionsQ.data || []).filter((c) => c.active).map((c) => c.pump_id)),
    [connectionsQ.data],
  )

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['admin-station-pumps', stationId] })
    qc.invalidateQueries({ queryKey: ['admin-station', stationId] })
    qc.invalidateQueries({ queryKey: ['twin'] })
    refreshStation()
  }

  const openCreate = () => {
    setEditing(null)
    setForm(emptyPumpForm)
    setShowForm(true)
  }

  const openEdit = (p: Pump) => {
    setEditing(p)
    setForm({
      name: p.name || '',
      pump_code: p.pump_code || '',
      mqtt_pump_id: p.mqtt_pump_id || '',
      pump_number: p.pump_number != null ? String(p.pump_number) : '',
      display_order: p.display_order != null ? String(p.display_order) : '',
      island_number: p.island_number != null ? String(p.island_number) : '',
      manufacturer: p.manufacturer || '',
      model: p.model || '',
      protocol: p.protocol || '',
      device_id: p.device_id || '',
      status: p.status || 'ACTIVE',
      active: p.active !== false,
      product: p.product || 'PMS',
      nozzle_count: String(p.nozzle_count || 0),
      notes: p.notes || '',
    })
    setShowForm(true)
  }

  const saveMut = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {
        name: form.name || form.pump_code,
        pump_code: form.pump_code,
        mqtt_pump_id: form.mqtt_pump_id || form.pump_code,
        pump_number: form.pump_number ? Number(form.pump_number) : null,
        display_order: form.display_order ? Number(form.display_order) : undefined,
        island_number: form.island_number ? Number(form.island_number) : null,
        manufacturer: form.manufacturer || null,
        model: form.model || null,
        protocol: form.protocol || null,
        device_id: form.device_id || null,
        status: form.status,
        active: form.active,
        notes: form.notes || null,
      }
      if (editing) {
        return (await updateAdminPump(editing.id, payload)).data
      }
      payload.product = form.product
      payload.nozzle_count = form.nozzle_count ? Number(form.nozzle_count) : 0
      return (await createAdminStationPump(stationId, payload)).data
    },
    onSuccess: (pump) => {
      setShowForm(false)
      setEditing(null)
      setMsg(editing ? 'Pump updated' : 'Pump created')
      invalidate()
      if (!editing && pump?.id && !connectedPumpIds.has(pump.id)) {
        setPromptConnectPumpId(pump.id)
      }
    },
    onError: (err: any) => {
      const detail = err?.response?.data?.detail
      setMsg(
        typeof detail === 'string'
          ? detail
          : 'Failed to save pump — check unique MQTT id / nozzle codes per station',
      )
    },
  })

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    saveMut.mutate()
  }

  return (
    <div className="space-y-4">
      {msg && <div className="card text-emerald-300 text-sm">{msg}</div>}

      {promptConnectPumpId && (
        <div className="card border border-amber-700/50 bg-amber-950/30 space-y-2">
          <p className="text-amber-200 text-sm">
            Pump created. Assign a source tank so the Operational Twin can draw its pipe.
          </p>
          <div className="flex gap-2">
            <Link
              className="btn-primary text-sm"
              to={`/admin/stations/${stationId}/connections?pumpId=${promptConnectPumpId}`}
            >
              Configure tank connection
            </Link>
            <button type="button" className="btn-secondary text-sm" onClick={() => setPromptConnectPumpId(null)}>
              Later
            </button>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <h2 className="text-white font-semibold">Physical pumps</h2>
        <button type="button" className="btn-primary text-sm" onClick={openCreate}>
          Add pump
        </button>
      </div>

      {showForm && (
        <form className="card grid sm:grid-cols-2 gap-3" onSubmit={onSubmit}>
          <h3 className="sm:col-span-2 text-white font-medium">{editing ? 'Edit pump' : 'Add pump'}</h3>
          <label className="space-y-1">
            <span className="label-text">Pump name</span>
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label className="space-y-1">
            <span className="label-text">Pump code</span>
            <input
              className="input font-mono"
              value={form.pump_code}
              onChange={(e) => setForm({ ...form, pump_code: e.target.value })}
              required
            />
          </label>
          <label className="space-y-1 sm:col-span-2">
            <span className="label-text">Physical pump MQTT ID (matches sale.pumpId)</span>
            <input
              className="input font-mono"
              value={form.mqtt_pump_id}
              onChange={(e) => setForm({ ...form, mqtt_pump_id: e.target.value })}
              placeholder="PUMP-05-06 or PUMP-05/06"
            />
            <span className="text-[11px] text-slate-500">
              Must match backend <code className="text-slate-400">transaction.pumpId</code> for the
              complete dispenser. Nozzle/channel IDs belong on nested nozzles, not this field.
            </span>
          </label>
          <label className="space-y-1">
            <span className="label-text">Pump number</span>
            <input
              className="input"
              type="number"
              value={form.pump_number}
              onChange={(e) => setForm({ ...form, pump_number: e.target.value })}
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
          <label className="space-y-1">
            <span className="label-text">Island / group</span>
            <input
              className="input"
              type="number"
              value={form.island_number}
              onChange={(e) => setForm({ ...form, island_number: e.target.value })}
            />
          </label>
          <label className="space-y-1">
            <span className="label-text">Assigned device</span>
            <select
              className="input"
              value={form.device_id}
              onChange={(e) => setForm({ ...form, device_id: e.target.value })}
            >
              <option value="">None</option>
              {(devicesQ.data || []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name || d.device_code}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="label-text">Manufacturer</span>
            <input
              className="input"
              value={form.manufacturer}
              onChange={(e) => setForm({ ...form, manufacturer: e.target.value })}
            />
          </label>
          <label className="space-y-1">
            <span className="label-text">Model</span>
            <input className="input" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
          </label>
          <label className="space-y-1">
            <span className="label-text">Protocol</span>
            <input
              className="input"
              value={form.protocol}
              onChange={(e) => setForm({ ...form, protocol: e.target.value })}
            />
          </label>
          <label className="space-y-1">
            <span className="label-text">Operational status</span>
            <select className="input" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
              {['ACTIVE', 'IDLE', 'UNKNOWN', 'INACTIVE', 'FAULT'].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 flex items-end gap-2">
            <input
              type="checkbox"
              checked={form.active}
              onChange={(e) => setForm({ ...form, active: e.target.checked })}
            />
            <span className="label-text">Active</span>
          </label>
          {!editing && (
            <>
              <label className="space-y-1">
                <span className="label-text">Product assignment</span>
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
                <span className="label-text">Number of nozzles</span>
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={8}
                  value={form.nozzle_count}
                  onChange={(e) => setForm({ ...form, nozzle_count: e.target.value })}
                />
              </label>
            </>
          )}
          <label className="space-y-1 sm:col-span-2">
            <span className="label-text">Notes</span>
            <textarea
              className="input min-h-[72px]"
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />
          </label>
          <div className="sm:col-span-2 flex gap-2">
            <button className="btn-primary" type="submit" disabled={saveMut.isPending}>
              {editing ? 'Save changes' : 'Create pump'}
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setShowForm(false)
                setEditing(null)
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
              <th className="py-2 pr-2">Order</th>
              <th className="py-2 pr-2">Name</th>
              <th className="py-2 pr-2">Code</th>
              <th className="py-2 pr-2">MQTT ID</th>
              <th className="py-2 pr-2">#</th>
              <th className="py-2 pr-2">Island</th>
              <th className="py-2 pr-2">Product</th>
              <th className="py-2 pr-2">Nozzles</th>
              <th className="py-2 pr-2">Device</th>
              <th className="py-2 pr-2">Status</th>
              <th className="py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(pumpsQ.data || []).map((p) => (
              <Fragment key={p.id}>
                <tr className="border-b border-slate-800 hover:bg-slate-800/40">
                  <td className="py-2 pr-2">{p.display_order ?? 0}</td>
                  <td className="py-2 pr-2 text-white">{p.name || p.pump_code}</td>
                  <td className="py-2 pr-2 font-mono text-xs">{p.pump_code}</td>
                  <td className="py-2 pr-2 font-mono text-xs text-emerald-300">{p.mqtt_pump_id || '—'}</td>
                  <td className="py-2 pr-2">{p.pump_number ?? '—'}</td>
                  <td className="py-2 pr-2">{p.island_number ?? '—'}</td>
                  <td className="py-2 pr-2">{p.product || '—'}</td>
                  <td className="py-2 pr-2">{p.nozzle_count ?? 0}</td>
                  <td className="py-2 pr-2 text-xs">{p.device_name || p.device_code || '—'}</td>
                  <td className="py-2 pr-2">
                    <span className={p.active === false ? 'badge-warn' : 'badge-ok'}>
                      {p.active === false ? 'INACTIVE' : p.status}
                    </span>
                  </td>
                  <td className="py-2">
                    <div className="flex flex-wrap gap-1">
                      <button type="button" className="btn-secondary text-xs px-2 py-1" onClick={() => openEdit(p)}>
                        Edit
                      </button>
                      <button
                        type="button"
                        className="btn-secondary text-xs px-2 py-1"
                        onClick={() => setExpandedPumpId(expandedPumpId === p.id ? null : p.id)}
                      >
                        Nozzles
                      </button>
                      <button
                        type="button"
                        className="btn-secondary text-xs px-2 py-1"
                        onClick={async () => {
                          await duplicateAdminPump(p.id)
                          invalidate()
                          setMsg('Pump duplicated')
                        }}
                      >
                        Duplicate
                      </button>
                      {p.active === false ? (
                        <button
                          type="button"
                          className="btn-secondary text-xs px-2 py-1"
                          onClick={async () => {
                            await reactivateAdminPump(p.id)
                            invalidate()
                          }}
                        >
                          Reactivate
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn-secondary text-xs px-2 py-1"
                          onClick={async () => {
                            await deactivateAdminPump(p.id)
                            invalidate()
                          }}
                        >
                          Deactivate
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn-secondary text-xs px-2 py-1 text-rose-300"
                        onClick={async () => {
                          if (
                            !window.confirm(
                              p.can_hard_delete === false
                                ? 'This pump has transactions and will be soft-deactivated. Continue?'
                                : 'Delete this pump permanently?',
                            )
                          ) {
                            return
                          }
                          const res = await deleteAdminPump(p.id)
                          setMsg(res.data.softDeleted ? res.data.reason || 'Soft-deleted' : 'Pump deleted')
                          invalidate()
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
                {expandedPumpId === p.id && (
                  <tr className="bg-slate-950/50">
                    <td colSpan={11} className="p-3">
                      <NozzleEditor pumpId={p.id} stationId={stationId} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function NozzleEditor({ pumpId, stationId }: { pumpId: string; stationId: string }) {
  const qc = useQueryClient()
  const nozzlesQ = useQuery({
    queryKey: ['admin-nozzles', pumpId],
    queryFn: async () => (await getAdminPumpNozzles(pumpId, true)).data,
  })
  const [form, setForm] = useState({
    nozzle_code: '',
    name: '',
    mqtt_nozzle_id: '',
    source_identifier: '',
    side_id: '',
    nozzle_number: '',
    product: 'PMS',
    display_order: '',
  })

  return (
    <div className="space-y-3">
      <div className="text-slate-300 text-sm font-medium">Nozzles</div>
      <form
        className="grid sm:grid-cols-5 gap-2"
        onSubmit={async (e) => {
          e.preventDefault()
          await createAdminNozzle(pumpId, {
            nozzle_code: form.nozzle_code,
            name: form.name || undefined,
            mqtt_nozzle_id: form.mqtt_nozzle_id || form.nozzle_code,
            source_identifier: form.source_identifier || undefined,
            side_id: form.side_id || undefined,
            nozzle_number: form.nozzle_number ? Number(form.nozzle_number) : null,
            product: form.product,
            display_order: form.display_order ? Number(form.display_order) : undefined,
            status: 'ACTIVE',
            active: true,
          })
          setForm({
            nozzle_code: '',
            name: '',
            mqtt_nozzle_id: '',
            source_identifier: '',
            side_id: '',
            nozzle_number: '',
            product: 'PMS',
            display_order: '',
          })
          qc.invalidateQueries({ queryKey: ['admin-nozzles', pumpId] })
          qc.invalidateQueries({ queryKey: ['admin-station-pumps', stationId] })
          qc.invalidateQueries({ queryKey: ['twin'] })
        }}
      >
        <input
          className="input font-mono text-xs"
          placeholder="NOZZLE-05"
          value={form.nozzle_code}
          onChange={(e) => setForm({ ...form, nozzle_code: e.target.value })}
          required
        />
        <input
          className="input text-xs"
          placeholder="Nozzle 1"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        <input
          className="input font-mono text-xs"
          placeholder="Source channel (e.g. pump-2)"
          value={form.source_identifier}
          onChange={(e) => setForm({ ...form, source_identifier: e.target.value })}
        />
        <input
          className="input font-mono text-xs"
          placeholder="MQTT nozzle id"
          value={form.mqtt_nozzle_id}
          onChange={(e) => setForm({ ...form, mqtt_nozzle_id: e.target.value })}
        />
        <input
          className="input text-xs"
          type="number"
          placeholder="#"
          value={form.nozzle_number}
          onChange={(e) => setForm({ ...form, nozzle_number: e.target.value })}
        />
        <select className="input text-xs" value={form.product} onChange={(e) => setForm({ ...form, product: e.target.value })}>
          {['PMS', 'AGO', 'DPK'].map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <button className="btn-primary text-xs" type="submit">
          Add nozzle
        </button>
      </form>
      <table className="table w-full text-xs">
        <thead>
          <tr className="text-slate-500 text-left">
            <th className="py-1">Order</th>
            <th className="py-1">Code</th>
            <th className="py-1">MQTT</th>
            <th className="py-1">#</th>
            <th className="py-1">Product</th>
            <th className="py-1">Status</th>
            <th className="py-1">Actions</th>
          </tr>
        </thead>
        <tbody>
          {(nozzlesQ.data || []).map((n) => (
            <tr key={n.id} className="border-t border-slate-800">
              <td className="py-1">{n.display_order ?? 0}</td>
              <td className="py-1 font-mono">{n.nozzle_code}</td>
              <td className="py-1 font-mono">{n.mqtt_nozzle_id || '—'}</td>
              <td className="py-1">{n.nozzle_number ?? '—'}</td>
              <td className="py-1">
                <select
                  className="input text-xs py-1"
                  value={n.product || ''}
                  onChange={async (e) => {
                    await updateAdminNozzle(n.id, { product: e.target.value })
                    nozzlesQ.refetch()
                  }}
                >
                  {['PMS', 'AGO', 'DPK', ''].map((p) => (
                    <option key={p || 'none'} value={p}>
                      {p || '—'}
                    </option>
                  ))}
                </select>
              </td>
              <td className="py-1">{n.active === false ? 'INACTIVE' : n.status}</td>
              <td className="py-1">
                {n.active !== false && (
                  <button
                    type="button"
                    className="btn-secondary text-xs px-2 py-0.5"
                    onClick={async () => {
                      await deactivateAdminNozzle(n.id)
                      nozzlesQ.refetch()
                    }}
                  >
                    Deactivate
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
