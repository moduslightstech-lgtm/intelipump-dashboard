import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { getAdminStations } from '../../api/client'

export default function AdminStationsPage() {
  const stationsQ = useQuery({
    queryKey: ['admin-stations'],
    queryFn: async () => (await getAdminStations()).data,
  })

  return (
    <div className="p-6 space-y-4">
      <div>
        <h1 className="section-title">Admin · Stations</h1>
        <p className="text-slate-400 text-sm mt-1">
          Configure stations, pumps, nozzles, devices, and tank-to-pump connections for the Operational Twin.
        </p>
      </div>

      <div className="card overflow-x-auto">
        <table className="table w-full text-sm">
          <thead>
            <tr className="text-slate-400 border-b border-slate-700 text-left">
              <th className="py-2 pr-3">Name</th>
              <th className="py-2 pr-3">Code</th>
              <th className="py-2 pr-3">MQTT ID</th>
              <th className="py-2 pr-3">Status</th>
              <th className="py-2 pr-3">Pumps</th>
              <th className="py-2 pr-3">Tanks</th>
              <th className="py-2 pr-3">Connections</th>
              <th className="py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(stationsQ.data || []).map((s) => (
              <tr key={s.id} className="border-b border-slate-800 hover:bg-slate-800/40">
                <td className="py-2 pr-3 text-white font-medium">{s.name}</td>
                <td className="py-2 pr-3 font-mono text-xs">{s.station_code}</td>
                <td className="py-2 pr-3 font-mono text-xs text-slate-300">{s.mqtt_station_id || '—'}</td>
                <td className="py-2 pr-3">
                  <span className={s.status === 'ACTIVE' ? 'badge-ok' : 'badge-warn'}>{s.status}</span>
                </td>
                <td className="py-2 pr-3">
                  {s.active_pump_count ?? 0}/{s.pump_count ?? 0}
                </td>
                <td className="py-2 pr-3">{s.tank_count ?? 0}</td>
                <td className="py-2 pr-3">{s.connection_count ?? 0}</td>
                <td className="py-2">
                  <div className="flex flex-wrap gap-2">
                    <Link className="btn-secondary text-xs px-2 py-1" to={`/admin/stations/${s.id}`}>
                      Open
                    </Link>
                    <Link className="btn-secondary text-xs px-2 py-1" to={`/admin/stations/${s.id}/edit`}>
                      Edit
                    </Link>
                    <Link className="btn-secondary text-xs px-2 py-1" to={`/admin/stations/${s.id}/pumps`}>
                      Pumps
                    </Link>
                    <Link
                      className="btn-primary text-xs px-2 py-1"
                      to={`/digital-twin/${s.id}`}
                    >
                      Twin
                    </Link>
                  </div>
                </td>
              </tr>
            ))}
            {!stationsQ.isLoading && !(stationsQ.data || []).length && (
              <tr>
                <td colSpan={8} className="py-8 text-center text-slate-500">
                  No stations yet. Create one from Settings, then configure it here.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
