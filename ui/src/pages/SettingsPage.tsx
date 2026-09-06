import { FormEvent, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createDevice,
  createPump,
  createStation,
  getDevices,
  getPumps,
  getStations,
} from '../api/client'

export default function SettingsPage() {
  const qc = useQueryClient()
  const stationsQ = useQuery({ queryKey: ['stations'], queryFn: async () => (await getStations()).data })
  const devicesQ = useQuery({ queryKey: ['devices'], queryFn: async () => (await getDevices()).data })
  const pumpsQ = useQuery({ queryKey: ['pumps'], queryFn: async () => (await getPumps()).data })

  const [stationCode, setStationCode] = useState('')
  const [stationName, setStationName] = useState('')
  const [mqttStationId, setMqttStationId] = useState('')
  const [deviceCode, setDeviceCode] = useState('')
  const [deviceStationId, setDeviceStationId] = useState('')
  const [pumpCode, setPumpCode] = useState('')
  const [mqttPumpId, setMqttPumpId] = useState('')
  const [pumpStationId, setPumpStationId] = useState('')
  const [message, setMessage] = useState('')

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['stations'] })
    qc.invalidateQueries({ queryKey: ['devices'] })
    qc.invalidateQueries({ queryKey: ['pumps'] })
  }

  const addStation = useMutation({
    mutationFn: () =>
      createStation({
        station_code: stationCode,
        name: stationName,
        mqtt_station_id: mqttStationId || undefined,
      }),
    onSuccess: () => {
      setStationCode('')
      setStationName('')
      setMqttStationId('')
      setMessage('Station created')
      invalidate()
    },
    onError: () => setMessage('Failed to create station'),
  })

  const addDevice = useMutation({
    mutationFn: () =>
      createDevice({
        device_code: deviceCode,
        station_id: deviceStationId || undefined,
        name: deviceCode,
      }),
    onSuccess: () => {
      setDeviceCode('')
      setMessage('Device created')
      invalidate()
    },
    onError: () => setMessage('Failed to create device'),
  })

  const addPump = useMutation({
    mutationFn: () =>
      createPump({
        pump_code: pumpCode,
        mqtt_pump_id: mqttPumpId || pumpCode,
        station_id: pumpStationId || undefined,
      }),
    onSuccess: () => {
      setPumpCode('')
      setMqttPumpId('')
      setMessage('Pump created')
      invalidate()
    },
    onError: () => setMessage('Failed to create pump'),
  })

  const onStation = (e: FormEvent) => {
    e.preventDefault()
    addStation.mutate()
  }
  const onDevice = (e: FormEvent) => {
    e.preventDefault()
    addDevice.mutate()
  }
  const onPump = (e: FormEvent) => {
    e.preventDefault()
    addPump.mutate()
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="section-title">Settings</h1>
        <p className="text-slate-400 text-sm mt-1">Manage stations, devices, and pumps</p>
      </div>

      {message && <div className="card text-sm text-emerald-300">{message}</div>}

      <div className="grid lg:grid-cols-3 gap-4">
        <form className="card space-y-3" onSubmit={onStation}>
          <h2 className="text-white font-semibold">Add station</h2>
          <input className="input" placeholder="Station code (dashboard)" value={stationCode} onChange={(e) => setStationCode(e.target.value)} required />
          <input className="input" placeholder="MQTT stationId (from Pi)" value={mqttStationId} onChange={(e) => setMqttStationId(e.target.value)} />
          <input className="input" placeholder="Name" value={stationName} onChange={(e) => setStationName(e.target.value)} required />
          <button type="submit" className="btn-primary w-full">Create station</button>
          <p className="text-xs text-slate-500">
            MQTT stationId may differ from station code (e.g. InteliPump-US-Lab vs US-LAB-001).
          </p>
          <ul className="text-xs text-slate-400 space-y-1 max-h-32 overflow-auto">
            {stationsQ.data?.map((s) => (
              <li key={s.id}>
                <span className="text-slate-200">{s.name}</span> · {s.station_code}
                {s.mqtt_station_id && (
                  <span className="text-sky-400 font-mono"> → {s.mqtt_station_id}</span>
                )}
              </li>
            ))}
          </ul>
        </form>

        <form className="card space-y-3" onSubmit={onDevice}>
          <h2 className="text-white font-semibold">Add device</h2>
          <input className="input" placeholder="Device code" value={deviceCode} onChange={(e) => setDeviceCode(e.target.value)} required />
          <select className="input" value={deviceStationId} onChange={(e) => setDeviceStationId(e.target.value)}>
            <option value="">No station link</option>
            {stationsQ.data?.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          <button type="submit" className="btn-primary w-full">Create device</button>
          <p className="text-xs text-slate-500">{devicesQ.data?.length ?? 0} devices</p>
        </form>

        <form className="card space-y-3" onSubmit={onPump}>
          <h2 className="text-white font-semibold">Add pump</h2>
          <input className="input" placeholder="Pump code / MQTT pumpId (e.g. PUMP-05/06)" value={pumpCode} onChange={(e) => setPumpCode(e.target.value)} required />
          <input className="input" placeholder="MQTT pumpId override (optional)" value={mqttPumpId} onChange={(e) => setMqttPumpId(e.target.value)} />
          <select className="input" value={pumpStationId} onChange={(e) => setPumpStationId(e.target.value)}>
            <option value="">No station link</option>
            {stationsQ.data?.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          <button type="submit" className="btn-primary w-full">Create pump</button>
          <p className="text-xs text-slate-500">Slashes in pumpId are allowed and required when the Pi sends them.</p>
          <ul className="text-xs text-slate-400 space-y-1 max-h-32 overflow-auto">
            {pumpsQ.data?.map((p) => (
              <li key={p.id} className="font-mono">
                {p.mqtt_pump_id || p.pump_code}
              </li>
            ))}
          </ul>
        </form>
      </div>

      <div className="card text-sm text-slate-400">
        User management uses <code className="text-slate-200">scripts/create_admin_user.sh</code> on the server for now.
        MQTT credentials never appear in this dashboard.
      </div>
    </div>
  )
}
