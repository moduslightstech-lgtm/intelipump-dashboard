import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  fmtLiters,
  fmtNaira,
  fmtTime,
  getAlerts,
  getDevices,
  getHourlySales,
  getProductBreakdown,
  getPumps,
  getStations,
  getTransactions,
} from '../api/client'
import { EdgeDeviceStatusDetailCard } from '../components/edge/EdgeConnectivity'

export default function StationDetailPage() {
  const { stationId = '' } = useParams()
  const stationsQ = useQuery({ queryKey: ['stations'], queryFn: async () => (await getStations()).data })
  const station = stationsQ.data?.find((s) => s.id === stationId || s.station_code === stationId)
  const code = station?.station_code || decodeURIComponent(stationId)
  const mqttStationId = station?.mqtt_station_id || code

  const txQ = useQuery({
    queryKey: ['transactions', 'station', code],
    queryFn: async () =>
      (await getTransactions({ page: 1, size: 20, station_id: code, sort: 'received_at,desc' })).data,
    enabled: !!code,
  })
  const hourlyQ = useQuery({ queryKey: ['dashboard', 'hourly'], queryFn: async () => (await getHourlySales()).data })
  const productQ = useQuery({ queryKey: ['dashboard', 'products'], queryFn: async () => (await getProductBreakdown()).data })
  const devicesQ = useQuery({ queryKey: ['devices'], queryFn: async () => (await getDevices()).data })
  const pumpsQ = useQuery({ queryKey: ['pumps'], queryFn: async () => (await getPumps()).data })
  const alertsQ = useQuery({ queryKey: ['alerts', 'open'], queryFn: async () => (await getAlerts('OPEN')).data })

  const devices = devicesQ.data?.filter((d) => d.station_id === station?.id || d.device_code.includes(code)) || []
  const pumps = pumpsQ.data?.filter((p) => p.station_id === station?.id) || []

  return (
    <div className="p-6 space-y-4">
      <div>
        <Link to="/stations" className="text-xs text-emerald-400 hover:underline">
          ← Stations
        </Link>
        <h1 className="section-title mt-2">{station?.name || code}</h1>
        <p className="text-slate-400 text-sm mt-1">
          {station?.city || station?.address || 'Station detail'} · {station?.timezone || 'Africa/Lagos'}
        </p>
      </div>

      <EdgeDeviceStatusDetailCard stationId={mqttStationId} />

      <div className="grid lg:grid-cols-2 gap-4">
        <div className="card">
          <h2 className="text-white font-semibold mb-3">Recent transactions</h2>
          {(txQ.data?.items.length ?? 0) === 0 ? (
            <p className="text-slate-500 text-sm py-8 text-center">No transactions</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-slate-400 text-left border-b border-slate-700">
                  <th className="pb-2">Time</th>
                  <th className="pb-2">Pump</th>
                  <th className="pb-2 text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {txQ.data?.items.map((t) => (
                  <tr key={t.id} className="border-b border-slate-800">
                    <td className="py-2 text-slate-400">{fmtTime(t.received_at)}</td>
                    <td className="py-2 font-mono">{t.pump_id}</td>
                    <td className="py-2 text-right font-mono">{fmtNaira(t.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card">
          <h2 className="text-white font-semibold mb-3">Hourly sales (network)</h2>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={hourlyQ.data || []}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="hour" hide />
                <YAxis stroke="#94a3b8" fontSize={11} />
                <Tooltip
                  contentStyle={{ background: '#1e293b', border: '1px solid #334155' }}
                  formatter={(v: number) => fmtNaira(v)}
                />
                <Bar dataKey="amount" fill="#3b82f6" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        <div className="card">
          <h2 className="text-white font-semibold mb-3">Product breakdown</h2>
          <ul className="space-y-2 text-sm">
            {(productQ.data || []).map((p) => (
              <li key={p.product} className="flex justify-between">
                <span>{p.product}</span>
                <span className="font-mono text-slate-300">
                  {fmtLiters(p.volume)} · {fmtNaira(p.amount)}
                </span>
              </li>
            ))}
            {(productQ.data?.length ?? 0) === 0 && <li className="text-slate-500">No data</li>}
          </ul>
        </div>
        <div className="card">
          <h2 className="text-white font-semibold mb-3">Devices</h2>
          <ul className="space-y-2 text-sm">
            {devices.map((d) => (
              <li key={d.id} className="flex justify-between gap-2">
                <span className="font-mono text-emerald-300">{d.device_code}</span>
                <span className="text-slate-400">{d.status}</span>
              </li>
            ))}
            {devices.length === 0 && <li className="text-slate-500">No devices registered</li>}
          </ul>
        </div>
        <div className="card">
          <h2 className="text-white font-semibold mb-3">Pumps & alerts</h2>
          <p className="text-sm text-slate-300 mb-2">{pumps.length} pumps</p>
          <ul className="space-y-2 text-sm">
            {(alertsQ.data || []).slice(0, 5).map((a) => (
              <li key={a.id} className="text-slate-300">
                {a.title}
              </li>
            ))}
            {(alertsQ.data?.length ?? 0) === 0 && <li className="text-slate-500">No open alerts</li>}
          </ul>
        </div>
      </div>
    </div>
  )
}
