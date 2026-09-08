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
  humanizeEnum,
  stationLabel,
} from '../api/client'
import { EdgeDeviceStatusDetailCard } from '../components/edge/EdgeConnectivity'
import ChartEmptyState from '../components/dashboard/ChartEmptyState'

export default function StationDetailPage() {
  const { stationId = '' } = useParams()
  const stationsQ = useQuery({ queryKey: ['stations'], queryFn: async () => (await getStations()).data })
  const station = stationsQ.data?.find((s) => s.id === stationId || s.station_code === stationId)
  const code = station?.station_code || decodeURIComponent(stationId)
  const mqttStationId = station?.mqtt_station_id || code
  const lookupKey = station?.mqtt_station_id || station?.id || code
  const tz = station?.timezone || 'Africa/Lagos'

  const txQ = useQuery({
    queryKey: ['transactions', 'station', lookupKey],
    queryFn: async () =>
      (await getTransactions({ page: 1, size: 20, station_id: lookupKey, sort: 'received_at,desc' })).data,
    enabled: !!lookupKey,
  })
  const hourlyQ = useQuery({
    queryKey: ['dashboard', 'hourly', lookupKey],
    queryFn: async () => (await getHourlySales(lookupKey)).data,
    enabled: !!lookupKey,
  })
  const productQ = useQuery({
    queryKey: ['dashboard', 'products', lookupKey],
    queryFn: async () => (await getProductBreakdown(lookupKey)).data,
  })
  const devicesQ = useQuery({ queryKey: ['devices'], queryFn: async () => (await getDevices()).data })
  const pumpsQ = useQuery({ queryKey: ['pumps'], queryFn: async () => (await getPumps()).data })
  const alertsQ = useQuery({ queryKey: ['alerts', 'open'], queryFn: async () => (await getAlerts('OPEN')).data })

  const devices = devicesQ.data?.filter((d) => d.station_id === station?.id || d.device_code.includes(code)) || []
  const pumps = pumpsQ.data?.filter((p) => p.station_id === station?.id) || []
  const hourly = (hourlyQ.data || []).filter((row) => Number(row.count || 0) > 0)

  return (
    <div className="p-6 space-y-4 max-w-7xl">
      <div>
        <Link to="/stations" className="text-xs text-emerald-400 hover:underline">
          ← Stations
        </Link>
        <h1 className="section-title mt-2">{stationLabel(station) || code}</h1>
        <p className="text-slate-400 text-sm mt-1">
          {station?.city || station?.address || 'Station detail'} · {tz}
        </p>
      </div>

      <EdgeDeviceStatusDetailCard stationId={mqttStationId} />

      <div className="grid lg:grid-cols-2 gap-4">
        <div className="card">
          <h2 className="text-white font-semibold mb-3">Recent transactions</h2>
          {txQ.isLoading ? (
            <p className="text-slate-500 text-sm py-8 text-center">Loading…</p>
          ) : (txQ.data?.items.length ?? 0) === 0 ? (
            <p className="text-slate-500 text-sm py-8 text-center">No transactions for this station yet.</p>
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
                    <td className="py-2 text-slate-400">{fmtTime(t.received_at, tz)}</td>
                    <td className="py-2 font-mono">{t.pump_id}</td>
                    <td className="py-2 text-right font-mono">{fmtNaira(t.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card">
          <h2 className="text-white font-semibold mb-3">Hourly sales today ({tz})</h2>
          <div className="h-56">
            {hourly.length === 0 ? (
              <ChartEmptyState title="No sales yet today" description="Hourly revenue appears after transactions arrive." />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={hourly}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                  <XAxis
                    dataKey="hour"
                    stroke="#94a3b8"
                    fontSize={11}
                    tickFormatter={(v) =>
                      new Date(v).toLocaleTimeString('en-US', { hour: 'numeric', timeZone: tz })
                    }
                  />
                  <YAxis stroke="#94a3b8" fontSize={11} tickFormatter={(v) => fmtNaira(v)} width={72} />
                  <Tooltip
                    contentStyle={{ background: '#1e293b', border: '1px solid #334155' }}
                    formatter={(v: number) => fmtNaira(v)}
                    labelFormatter={(v) => fmtTime(String(v), tz)}
                  />
                  <Bar dataKey="amount" fill="#3b82f6" name="Amount (NGN)" />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        <div className="card">
          <h2 className="text-white font-semibold mb-3">Product breakdown (today)</h2>
          <ul className="space-y-2 text-sm">
            {(productQ.data || []).map((p) => (
              <li key={p.product} className="flex justify-between">
                <span>{p.product === 'UNKNOWN' ? 'Not mapped' : p.product}</span>
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
                <span className="text-slate-400" title={d.status_reason || undefined}>
                  {humanizeEnum(d.status)}
                </span>
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
