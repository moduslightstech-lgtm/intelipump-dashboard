import { useQuery } from '@tanstack/react-query'
import { fmtTime, getDevices, getStations } from '../api/client'

export default function DevicesPage() {
  const devicesQ = useQuery({ queryKey: ['devices'], queryFn: async () => (await getDevices()).data })
  const stationsQ = useQuery({ queryKey: ['stations'], queryFn: async () => (await getStations()).data })

  const stationName = (id: string | null) =>
    stationsQ.data?.find((s) => s.id === id)?.name || stationsQ.data?.find((s) => s.id === id)?.station_code || '—'

  return (
    <div className="p-6 space-y-4">
      <div>
        <h1 className="section-title">Devices</h1>
        <p className="text-slate-400 text-sm mt-1">Edge Raspberry Pi agents and last-seen status</p>
      </div>

      {devicesQ.isError && (
        <div className="card text-red-300 text-sm" role="alert">Failed to load devices.</div>
      )}

      {(devicesQ.data?.length ?? 0) === 0 ? (
        <div className="card text-slate-500 text-sm text-center py-16">
          No devices yet. Devices appear when the consumer upserts last-seen from MQTT payloads.
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-400 border-b border-slate-700">
                <th className="pb-2">Device</th>
                <th className="pb-2">Station</th>
                <th className="pb-2">Status</th>
                <th className="pb-2">Last seen</th>
                <th className="pb-2">Last transaction</th>
                <th className="pb-2">Agent</th>
                <th className="pb-2">MQTT client</th>
              </tr>
            </thead>
            <tbody>
              {devicesQ.data?.map((d) => (
                <tr key={d.id} className="border-b border-slate-800">
                  <td className="py-3">
                    <div className="font-mono text-emerald-300">{d.device_code}</div>
                    <div className="text-xs text-slate-500">{d.name || '—'}</div>
                  </td>
                  <td className="py-3">{stationName(d.station_id)}</td>
                  <td className="py-3">
                    <span className={d.status === 'ONLINE' ? 'badge-ok' : 'badge-warn'}>{d.status}</span>
                  </td>
                  <td className="py-3 text-slate-400">{fmtTime(d.last_seen_at)}</td>
                  <td className="py-3 text-slate-400">{fmtTime(d.last_transaction_at)}</td>
                  <td className="py-3 font-mono text-xs">{d.agent_version || '—'}</td>
                  <td className="py-3 font-mono text-xs text-slate-400">{d.mqtt_client_id || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
