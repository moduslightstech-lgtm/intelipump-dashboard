import { NavLink, Outlet, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { getAdminStation, humanizeEnum } from '../../api/client'
import { StatusDot } from '../../components/edge/EdgeConnectivity'
import { useStationEdgeDevices } from '../../hooks/useDeviceStatus'
import { deriveOperationalStatus, mapEdgeToConnectivityStatus } from '../../lib/stationSchedule'

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
  const stationKey = station?.mqtt_station_id || station?.station_code || station?.name
  const edgeQ = useStationEdgeDevices(stationKey)
  const liveOp = deriveOperationalStatus(
    {
      opensAt: station?.opens_at,
      closesAt: station?.closes_at,
      operatingDays: station?.operating_days,
      timezone: station?.timezone,
    },
    new Date(),
  )
  const liveConn = edgeQ.hasMapping ? mapEdgeToConnectivityStatus(edgeQ.primary?.status) : 'UNKNOWN'

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-7xl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs text-slate-500 uppercase tracking-wider font-semibold">Admin</p>
          <h1 className="section-title">{station?.name || 'Station'}</h1>
          <p className="text-slate-400 text-sm mt-1">
            {station?.station_code}
            {station?.mqtt_station_id && station.mqtt_station_id !== station.station_code ? (
              <span className="text-slate-500" title={`MQTT ${station.mqtt_station_id}`}>
                {' '}
                · MQTT id in details
              </span>
            ) : null}
          </p>
        </div>
        <NavLink to="/admin/stations" className="btn-secondary text-sm">
          Back to stations
        </NavLink>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className={`rounded-full border px-2 py-1 ${station?.status === 'ACTIVE' ? 'border-emerald-800 text-emerald-300' : 'border-slate-600 text-slate-300'}`}>
          Catalog {humanizeEnum(station?.status)}
        </span>
        <span className="rounded-full border border-slate-700 px-2 py-1 text-slate-200">
          Operating {humanizeEnum(liveOp)}
        </span>
        <span className="inline-flex items-center gap-1 rounded-full border border-slate-700 px-2 py-1">
          <StatusDot status={liveConn} />
          <span className="sr-only">Gateway</span>
          Gateway {humanizeEnum(liveConn)}
        </span>
        <span className="text-slate-400">Pumps {station?.active_pump_count ?? '—'}</span>
        <span className="text-slate-400">Tanks {station?.tank_count ?? '—'}</span>
        <span className="text-slate-400">Connections {station?.connection_count ?? '—'}</span>
        <span className="text-slate-400">Devices {station?.device_count ?? '—'}</span>
      </div>

      <nav className="flex flex-wrap gap-1 border-b border-slate-800 pb-2">
        {TABS.map((tab) => (
          <NavLink
            key={tab.label}
            to={tab.to ? `/admin/stations/${stationId}/${tab.to}` : `/admin/stations/${stationId}`}
            end={tab.end}
            className={({ isActive }) =>
              `px-3 py-1.5 rounded-lg text-sm focus-visible:ring-2 focus-visible:ring-emerald-500 ${
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
