import { FormEvent, useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useOutletContext } from 'react-router-dom'
import {
  createAdminStationDevice,
  getAdminStationDevices,
  getAdminStationPumps,
  setAdminStationPrice,
  type Station,
  updateAdminDevice,
  updateAdminStation,
} from '../../api/client'
import { StatusDot } from '../../components/edge/EdgeConnectivity'
import { useStationEdgeDevices } from '../../hooks/useDeviceStatus'
import {
  deriveOperationalStatus,
  mapEdgeToConnectivityStatus,
} from '../../lib/stationSchedule'

type Ctx = { stationId: string; station?: Station; refreshStation: () => void }

const DAYS = [
  { v: 0, label: 'Mon' },
  { v: 1, label: 'Tue' },
  { v: 2, label: 'Wed' },
  { v: 3, label: 'Thu' },
  { v: 4, label: 'Fri' },
  { v: 5, label: 'Sat' },
  { v: 6, label: 'Sun' },
]

const PRICE_TARGET_ALL_PMS = '__all_pms__'

function useMinuteTick() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30_000)
    return () => window.clearInterval(id)
  }, [])
  return now
}

export default function AdminStationEditPage() {
  const { stationId, station, refreshStation } = useOutletContext<Ctx>()
  const qc = useQueryClient()
  const now = useMinuteTick()
  const devicesQ = useQuery({
    queryKey: ['admin-station-devices', stationId],
    queryFn: async () => (await getAdminStationDevices(stationId)).data,
    enabled: Boolean(stationId),
  })
  const pumpsQ = useQuery({
    queryKey: ['admin-station-pumps', stationId],
    queryFn: async () => (await getAdminStationPumps(stationId, false)).data,
    enabled: Boolean(stationId),
  })

  const [form, setForm] = useState({
    name: '',
    station_code: '',
    mqtt_station_id: '',
    address: '',
    city: '',
    state: '',
    country: '',
    timezone: 'Africa/Lagos',
    status: 'ACTIVE',
    opens_at: '',
    closes_at: '',
    operating_days: [] as number[],
  })
  const [msg, setMsg] = useState('')
  const [deviceForm, setDeviceForm] = useState({
    device_code: '',
    name: '',
    mqtt_client_id: '',
    external_device_id: '',
  })
  const [priceRaw, setPriceRaw] = useState('1400')
  const [priceTarget, setPriceTarget] = useState(PRICE_TARGET_ALL_PMS)
  const [priceMsg, setPriceMsg] = useState('')

  const activePumps = useMemo(() => {
    const rows = (pumpsQ.data || []).filter((p) => p.active !== false)
    return [...rows].sort((a, b) => {
      const ao = Number(a.display_order ?? a.pump_number ?? 999)
      const bo = Number(b.display_order ?? b.pump_number ?? 999)
      if (ao !== bo) return ao - bo
      return String(a.mqtt_pump_id || a.pump_code || '').localeCompare(
        String(b.mqtt_pump_id || b.pump_code || ''),
      )
    })
  }, [pumpsQ.data])

  const selectedPump = useMemo(() => {
    if (priceTarget === PRICE_TARGET_ALL_PMS) return undefined
    return activePumps.find((p) => (p.mqtt_pump_id || p.pump_code) === priceTarget)
  }, [activePumps, priceTarget])

  useEffect(() => {
    if (priceTarget === PRICE_TARGET_ALL_PMS) {
      if (station?.commanded_unit_price_raw != null) {
        setPriceRaw(String(station.commanded_unit_price_raw))
      }
      return
    }
    if (selectedPump?.commanded_unit_price_raw != null) {
      setPriceRaw(String(selectedPump.commanded_unit_price_raw))
      return
    }
    const product = String(selectedPump?.product || 'PMS').toUpperCase()
    if (product === 'AGO') {
      setPriceRaw('1875')
      return
    }
    if (station?.commanded_unit_price_raw != null) {
      setPriceRaw(String(station.commanded_unit_price_raw))
      return
    }
    setPriceRaw('1400')
  }, [
    station?.commanded_unit_price_raw,
    priceTarget,
    selectedPump?.commanded_unit_price_raw,
    selectedPump?.product,
  ])

  const stationKey =
    form.mqtt_station_id || station?.mqtt_station_id || station?.station_code || station?.name
  const edgeQ = useStationEdgeDevices(stationKey)

  const liveOperational = useMemo(
    () =>
      deriveOperationalStatus(
        {
          opensAt: form.opens_at,
          closesAt: form.closes_at,
          operatingDays: form.operating_days,
          timezone: form.timezone,
        },
        now,
      ),
    [form.opens_at, form.closes_at, form.operating_days, form.timezone, now],
  )

  const liveConnectivity = useMemo(() => {
    if (!edgeQ.hasMapping) return 'UNKNOWN' as const
    if (edgeQ.isError && !edgeQ.stationAvailability && !edgeQ.primary) return 'UNKNOWN' as const
    return mapEdgeToConnectivityStatus(edgeQ.stationAvailability || edgeQ.primary?.status)
  }, [edgeQ.hasMapping, edgeQ.isError, edgeQ.stationAvailability, edgeQ.primary])

  useEffect(() => {
    if (!station) return
    setForm({
      name: station.name || '',
      station_code: station.station_code || '',
      mqtt_station_id: station.mqtt_station_id || '',
      address: station.address || '',
      city: station.city || '',
      state: station.state || '',
      country: station.country || '',
      timezone: station.timezone || 'Africa/Lagos',
      status: station.status || 'ACTIVE',
      opens_at: station.opens_at || '',
      closes_at: station.closes_at || '',
      operating_days: station.operating_days || [],
    })
  }, [station])

  const saveMut = useMutation({
    mutationFn: async () =>
      (
        await updateAdminStation(stationId, {
          ...form,
          operational_status: liveOperational,
          connectivity_status: liveConnectivity,
          opens_at: form.opens_at || null,
          closes_at: form.closes_at || null,
        })
      ).data,
    onSuccess: () => {
      setMsg('Station saved')
      refreshStation()
      qc.invalidateQueries({ queryKey: ['admin-stations'] })
      qc.invalidateQueries({ queryKey: ['admin-station', stationId] })
      qc.invalidateQueries({ queryKey: ['twin'] })
    },
    onError: () => setMsg('Failed to save station'),
  })

  const addDeviceMut = useMutation({
    mutationFn: async () =>
      (
        await createAdminStationDevice(stationId, {
          device_code: deviceForm.device_code,
          name: deviceForm.name || deviceForm.device_code,
          mqtt_client_id: deviceForm.mqtt_client_id || undefined,
          external_device_id: deviceForm.external_device_id || undefined,
          status: 'ACTIVE',
          active: true,
        })
      ).data,
    onSuccess: () => {
      setDeviceForm({ device_code: '', name: '', mqtt_client_id: '', external_device_id: '' })
      setMsg('Device added')
      devicesQ.refetch()
      refreshStation()
    },
    onError: () => setMsg('Failed to add device'),
  })

  const setPriceMut = useMutation({
    mutationFn: async () => {
      const n = Number.parseInt(priceRaw, 10)
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error('invalid_price')
      }
      const body: { unit_price_raw: number; pump_id?: string } = { unit_price_raw: n }
      if (priceTarget !== PRICE_TARGET_ALL_PMS) {
        body.pump_id = priceTarget
      }
      return (await setAdminStationPrice(stationId, body)).data
    },
    onSuccess: (data) => {
      const pumps = data.pumpIds?.length ? data.pumpIds.join(', ') : data.pumpId
      setPriceMsg(
        `Queued ₦${data.unitPriceRaw}/L → ${data.stationId} [${pumps}]`,
      )
      setMsg(data.detail)
      refreshStation()
      qc.invalidateQueries({ queryKey: ['admin-station', stationId] })
      qc.invalidateQueries({ queryKey: ['admin-station-pumps', stationId] })
      void pumpsQ.refetch()
    },
    onError: (err: unknown) => {
      const detail =
        err && typeof err === 'object' && 'response' in err
          ? String((err as { response?: { data?: { detail?: string } } }).response?.data?.detail || '')
          : ''
      setPriceMsg(detail || 'Failed to publish price command')
      setMsg(detail || 'Failed to publish price command')
    },
  })

  const onSave = (e: FormEvent) => {
    e.preventDefault()
    saveMut.mutate()
  }

  const toggleDay = (day: number) => {
    setForm((f) => ({
      ...f,
      operating_days: f.operating_days.includes(day)
        ? f.operating_days.filter((d) => d !== day)
        : [...f.operating_days, day].sort(),
    }))
  }

  return (
    <div className="space-y-6">
      {msg && <div className="card text-emerald-300 text-sm">{msg}</div>}

      <form className="card space-y-4 max-w-4xl" onSubmit={onSave}>
        <h2 className="text-white font-semibold">General</h2>
        <div className="grid sm:grid-cols-2 gap-3">
          <label className="space-y-1">
            <span className="label-text">Station name</span>
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          </label>
          <label className="space-y-1">
            <span className="label-text">Station code</span>
            <input
              className="input font-mono"
              value={form.station_code}
              onChange={(e) => setForm({ ...form, station_code: e.target.value })}
              required
            />
          </label>
          <label className="space-y-1 sm:col-span-2">
            <span className="label-text">MQTT station identifier</span>
            <input
              className="input font-mono"
              value={form.mqtt_station_id}
              onChange={(e) => setForm({ ...form, mqtt_station_id: e.target.value })}
              placeholder="InteliPump-US-Lab"
            />
          </label>
          <label className="space-y-1 sm:col-span-2">
            <span className="label-text">Address</span>
            <input className="input" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
          </label>
          <label className="space-y-1">
            <span className="label-text">City</span>
            <input className="input" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
          </label>
          <label className="space-y-1">
            <span className="label-text">State</span>
            <input className="input" value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} />
          </label>
          <label className="space-y-1">
            <span className="label-text">Country</span>
            <input className="input" value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} />
          </label>
          <label className="space-y-1">
            <span className="label-text">Timezone</span>
            <input className="input" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} />
          </label>
          <label className="space-y-1">
            <span className="label-text">Active / inactive</span>
            <select className="input" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
              <option value="ACTIVE">ACTIVE</option>
              <option value="INACTIVE">INACTIVE</option>
            </select>
          </label>
          <div className="space-y-1">
            <span className="label-text">Operating status</span>
            <div
              className="input flex items-center justify-between gap-2"
              data-testid="live-operating-status"
            >
              <span
                className={`inline-flex items-center gap-1.5 text-sm font-medium ${
                  liveOperational === 'OPEN' ? 'text-emerald-400' : 'text-slate-300'
                }`}
              >
                <span
                  className={`h-2 w-2 rounded-full ${
                    liveOperational === 'OPEN' ? 'bg-emerald-400' : 'bg-slate-500'
                  }`}
                  aria-hidden
                />
                {liveOperational}
              </span>
              <span className="text-[11px] text-slate-500">
                From opening / closing hours (Nigeria time)
              </span>
            </div>
          </div>
          <div className="space-y-1">
            <span className="label-text">Connectivity status</span>
            <div
              className="input flex flex-col justify-center gap-1 min-h-[42px]"
              data-testid="live-connectivity-status"
            >
              {!edgeQ.hasMapping ? (
                <span className="text-sm text-slate-500">No edge device mapped for this MQTT station id</span>
              ) : edgeQ.isLoading && !edgeQ.stationAvailability && !edgeQ.primary ? (
                <span className="text-sm text-slate-500">Checking Pi heartbeat…</span>
              ) : edgeQ.isError && !edgeQ.stationAvailability && !edgeQ.primary ? (
                <span className="text-sm text-slate-500">Status unavailable</span>
              ) : (
                <div className="flex items-center justify-between gap-2">
                  <StatusDot status={edgeQ.stationAvailability || edgeQ.primary?.status} />
                  <span className="text-[11px] text-slate-500">
                    {edgeQ.totalCount > 1
                      ? `${edgeQ.onlineCount} of ${edgeQ.totalCount} Pis online`
                      : 'Live from Raspberry Pi'}
                  </span>
                </div>
              )}
            </div>
          </div>
          <label className="space-y-1">
            <span className="label-text">Opening time</span>
            <input
              className="input"
              type="time"
              value={form.opens_at}
              onChange={(e) => setForm({ ...form, opens_at: e.target.value })}
            />
          </label>
          <label className="space-y-1">
            <span className="label-text">Closing time</span>
            <input
              className="input"
              type="time"
              value={form.closes_at}
              onChange={(e) => setForm({ ...form, closes_at: e.target.value })}
            />
          </label>
        </div>
        <div>
          <span className="label-text">Operating days</span>
          <div className="flex flex-wrap gap-2 mt-2">
            {DAYS.map((d) => (
              <button
                key={d.v}
                type="button"
                className={`px-3 py-1.5 rounded-lg text-sm border ${
                  form.operating_days.includes(d.v)
                    ? 'border-emerald-600 bg-emerald-900/40 text-emerald-200'
                    : 'border-slate-700 text-slate-400'
                }`}
                onClick={() => toggleDay(d.v)}
              >
                {d.label}
              </button>
            ))}
          </div>
        </div>
        <button className="btn-primary" type="submit" disabled={saveMut.isPending}>
          Save station
        </button>
      </form>

      <section className="card space-y-4 max-w-4xl">
        <h2 className="text-white font-semibold">Unit price</h2>
        <p className="text-sm text-slate-400">
          <strong className="font-semibold text-slate-300">All PMS pumps</strong> sends one
          price to every active PMS Pi and skips AGO. Pick a single pump to set that Pi only
          (AGO e.g. Pump 8 for diesel). Controllers queue CD5 while busy or awaiting hang-up
          after a sale; status moves requested → pending → confirmed (or failed). Use raw
          integers (1400 PMS / 1875 AGO).
        </p>
        {priceTarget === PRICE_TARGET_ALL_PMS && station?.commanded_unit_price_raw != null && (
          <p className="text-sm text-slate-300/90">
            Last requested PMS station price: ₦{station.commanded_unit_price_raw}/L
            {station.commanded_unit_price_at
              ? ` at ${new Date(station.commanded_unit_price_at).toLocaleString()}`
              : ''}
            {' '}(per-pump confirm status below)
          </p>
        )}
        {priceTarget !== PRICE_TARGET_ALL_PMS && selectedPump?.commanded_unit_price_raw != null && (
          <p className="text-sm text-slate-300/90">
            Last requested for this pump: ₦{selectedPump.commanded_unit_price_raw}/L
            {selectedPump.commanded_unit_price_at
              ? ` at ${new Date(selectedPump.commanded_unit_price_at).toLocaleString()}`
              : ''}
            {selectedPump.price_command_status
              ? ` · ${selectedPump.price_command_status}`
              : ''}
          </p>
        )}
        {activePumps.some((p) => p.price_command_status) && (
          <ul className="text-sm space-y-1 text-slate-300">
            {activePumps
              .filter((p) => p.price_command_status)
              .map((p) => {
                const id = String(p.mqtt_pump_id || p.pump_code || '')
                const status = String(p.price_command_status || '').toUpperCase()
                const tone =
                  status === 'CONFIRMED'
                    ? 'text-emerald-300'
                    : status === 'FAILED'
                      ? 'text-rose-300'
                      : status === 'PENDING' || status === 'REQUESTED'
                        ? 'text-amber-200'
                        : 'text-slate-300'
                return (
                  <li key={id} className={tone}>
                    {p.name || id}: {status}
                    {p.commanded_unit_price_raw != null
                      ? ` · ₦${p.commanded_unit_price_raw}/L`
                      : ''}
                    {p.price_command_detail ? ` · ${p.price_command_detail}` : ''}
                  </li>
                )
              })}
          </ul>
        )}
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            setPriceMut.mutate()
          }}
        >
          <label className="space-y-1">
            <span className="label-text">Target</span>
            <select
              className="input min-w-[220px]"
              value={priceTarget}
              onChange={(e) => {
                setPriceTarget(e.target.value)
              }}
            >
              <option value={PRICE_TARGET_ALL_PMS}>All PMS pumps (exclude AGO)</option>
              {activePumps.map((p) => {
                const id = String(p.mqtt_pump_id || p.pump_code || '')
                const label = p.name || `Pump ${p.pump_number ?? id}`
                const product = String(p.product || 'PMS').toUpperCase()
                return (
                  <option key={id} value={id}>
                    {label} · {product === 'AGO' ? 'AGO' : 'PMS only'} ({id})
                  </option>
                )
              })}
            </select>
          </label>
          <label className="space-y-1">
            <span className="label-text">Unit price (raw)</span>
            <input
              className="input font-mono w-40"
              inputMode="numeric"
              value={priceRaw}
              onChange={(e) => setPriceRaw(e.target.value)}
              required
            />
          </label>
          <button className="btn-primary" type="submit" disabled={setPriceMut.isPending}>
            {setPriceMut.isPending
              ? 'Sending…'
              : priceTarget === PRICE_TARGET_ALL_PMS
                ? 'Set PMS price'
                : 'Set pump price'}
          </button>
        </form>
        {priceMsg && <p className="text-sm text-slate-300">{priceMsg}</p>}
      </section>

      <section className="card space-y-4">
        <h2 className="text-white font-semibold">Devices</h2>
        <form
          className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            addDeviceMut.mutate()
          }}
        >
          <input
            className="input font-mono"
            placeholder="Device code"
            value={deviceForm.device_code}
            onChange={(e) => setDeviceForm({ ...deviceForm, device_code: e.target.value })}
            required
          />
          <input
            className="input"
            placeholder="Name"
            value={deviceForm.name}
            onChange={(e) => setDeviceForm({ ...deviceForm, name: e.target.value })}
          />
          <input
            className="input font-mono"
            placeholder="MQTT client ID"
            value={deviceForm.mqtt_client_id}
            onChange={(e) => setDeviceForm({ ...deviceForm, mqtt_client_id: e.target.value })}
          />
          <input
            className="input font-mono"
            placeholder="External device ID"
            value={deviceForm.external_device_id}
            onChange={(e) => setDeviceForm({ ...deviceForm, external_device_id: e.target.value })}
          />
          <button className="btn-primary sm:col-span-2 lg:col-span-4" type="submit">
            Add device
          </button>
        </form>

        <div className="overflow-x-auto">
          <table className="table w-full text-sm">
            <thead>
              <tr className="text-slate-400 border-b border-slate-700 text-left">
                <th className="py-2 pr-3">Name</th>
                <th className="py-2 pr-3">Code</th>
                <th className="py-2 pr-3">MQTT client</th>
                <th className="py-2 pr-3">External ID</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(devicesQ.data || []).map((d) => (
                <tr key={d.id} className="border-b border-slate-800">
                  <td className="py-2 pr-3">{d.name || '—'}</td>
                  <td className="py-2 pr-3 font-mono text-xs">{d.device_code}</td>
                  <td className="py-2 pr-3 font-mono text-xs">{d.mqtt_client_id || '—'}</td>
                  <td className="py-2 pr-3 font-mono text-xs">{d.external_device_id || '—'}</td>
                  <td className="py-2 pr-3">
                    <span className={d.active === false ? 'badge-warn' : 'badge-ok'}>
                      {d.active === false ? 'INACTIVE' : d.status}
                    </span>
                  </td>
                  <td className="py-2">
                    <button
                      type="button"
                      className="btn-secondary text-xs px-2 py-1"
                      onClick={async () => {
                        await updateAdminDevice(d.id, { active: d.active === false })
                        devicesQ.refetch()
                      }}
                    >
                      {d.active === false ? 'Reactivate' : 'Deactivate'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
