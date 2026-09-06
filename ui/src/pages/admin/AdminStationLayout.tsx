import { NavLink, Outlet, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { getAdminStation } from '../../api/client'

const TABS = [
  { to: '', label: 'Overview', end: true },
  { to: 'edit', label: 'Edit' },
  { to: 'pumps', label: 'Pumps' },
  { to: 'tanks', label: 'Tanks' },
  { to: 'connections', label: 'Connections' },
]

export default function AdminStationLayout() {
  const { stationId = '' } = useParams()
  const stationQ = useQuery({
    queryKey: ['admin-station', stationId],
    queryFn: async () => (await getAdminStation(stationId)).data,
    enabled: Boolean(stationId),
  })
  const station = stationQ.data

  return (
    <div className="p-6 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs text-slate-500 uppercase tracking-wider font-semibold">Admin</p>
          <h1 className="section-title">{station?.name || 'Station'}</h1>
          <p className="text-slate-400 text-sm mt-1">
            {station?.station_code}
            {station?.mqtt_station_id ? ` · MQTT ${station.mqtt_station_id}` : ''}
          </p>
        </div>
        <NavLink to="/admin/stations" className="btn-secondary text-sm">
          All stations
        </NavLink>
      </div>

      <nav className="flex flex-wrap gap-1 border-b border-slate-800 pb-2">
        {TABS.map((tab) => (
          <NavLink
            key={tab.label}
            to={tab.to ? `/admin/stations/${stationId}/${tab.to}` : `/admin/stations/${stationId}`}
            end={tab.end}
            className={({ isActive }) =>
              `px-3 py-1.5 rounded-lg text-sm ${
                isActive ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
              }`
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>

      <Outlet context={{ stationId, station, refreshStation: () => stationQ.refetch() }} />
    </div>
  )
}
