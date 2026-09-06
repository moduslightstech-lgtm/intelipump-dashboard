import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  fmtNaira,
  getAlerts,
  getDashboardSummary,
  getPumps,
  getStationPerformance,
  getStations,
} from '../api/client'
import { StatusDot } from '../components/edge/EdgeConnectivity'
import { formatRelativeHeartbeat, formatExactTimestamp } from '../lib/relativeTime'
import { useStationEdgeDevices } from '../hooks/useDeviceStatus'

function badgeClass(kind: 'op' | 'conn', value?: string) {
  const v = (value || 'UNKNOWN').toUpperCase()
  if (kind === 'op') {
    if (v === 'OPEN') return 'bg-emerald-950 text-emerald-400 border-emerald-800'
    if (v === 'CLOSED') return 'bg-slate-800 text-slate-300 border-slate-600'
    if (v === 'OPENING' || v === 'CLOSING') return 'bg-amber-950 text-amber-400 border-amber-800'
  } else {
    if (v === 'ONLINE') return 'bg-emerald-950 text-emerald-400 border-emerald-800'
    if (v === 'DEGRADED') return 'bg-amber-950 text-amber-400 border-amber-800'
    if (v === 'OFFLINE') return 'bg-red-950 text-red-400 border-red-800'
  }
  return 'bg-slate-800 text-slate-400 border-slate-700'
}

function expectedHoursLabel(operational?: string, opensAt?: string | null, closesAt?: string | null) {
  const op = (operational || '').toUpperCase()
  if (!opensAt && !closesAt) return '—'
  if (op === 'CLOSED' || op === 'CLOSING') {
    return opensAt ? `Opens ${opensAt}` : '—'
  }
  if (op === 'OPEN' || op === 'OPENING') {
    return closesAt ? `Closes ${closesAt}` : '—'
  }
  if (opensAt && closesAt) return `${opensAt}–${closesAt}`
  return opensAt || closesAt || '—'
}

function StationEdgeCells({ mqttStationId }: { mqttStationId: string }) {
  const q = useStationEdgeDevices(mqttStationId)
  const primary = q.primary
  return (
    <>
      <td className="py-3">
        {!q.hasMapping ? (
          <span className="text-xs text-slate-500">No edge device assigned</span>
        ) : q.isLoading && !primary ? (
          <span className="text-xs text-slate-500">Checking device status...</span>
        ) : q.notFound ? (
          <span className="text-xs text-slate-500">Edge device is not registered</span>
        ) : q.isError && !primary ? (
          <span className="text-xs text-amber-400">Device status temporarily unavailable</span>
        ) : (
          <>
            <StatusDot status={primary?.status} />
            <div className="mt-1 text-[10px] text-slate-500 font-mono">
              {primary?.deviceId || q.primaryId}
            </div>
          </>
        )}
        {q.isError && primary && (
          <div className="mt-1 text-[10px] text-amber-400">Status temporarily unavailable</div>
        )}
      </td>
      <td className="py-3 text-xs text-slate-400" title={formatExactTimestamp(primary?.lastSeen)}>
        {primary?.status === 'NEVER_CONNECTED'
          ? 'Waiting for first heartbeat'
          : formatRelativeHeartbeat(primary?.secondsSinceLastHeartbeat, primary?.lastSeen)}
      </td>
      <td className="py-3 text-xs text-slate-400" title="Pump sales are separate from Pi connectivity">
        No recent transaction
      </td>
    </>
  )
}

export default function StationsPage() {
  const stationsQ = useQuery({ queryKey: ['stations'], queryFn: async () => (await getStations()).data })
  const perfQ = useQuery({ queryKey: ['dashboard', 'stations'], queryFn: async () => (await getStationPerformance()).data })
  const pumpsQ = useQuery({ queryKey: ['pumps'], queryFn: async () => (await getPumps()).data })
  const alertsQ = useQuery({
    queryKey: ['alerts', 'stations-outage'],
    queryFn: async () => (await getAlerts({ status: 'OPEN' })).data,
  })
  const summaryQ = useQuery({ queryKey: ['dashboard', 'summary'], queryFn: async () => (await getDashboardSummary()).data })

  const perfByCode = useMemo(() => {
    const map = new Map<string, { amount: number; volume: number; count: number }>()
    perfQ.data?.forEach((p) => map.set(p.station_id, { amount: Number(p.amount), volume: Number(p.volume), count: p.count }))
    return map
  }, [perfQ.data])

  const outageByStation = useMemo(() => {
    const map = new Map<string, string>()
    ;(alertsQ.data || []).forEach((a: any) => {
      if (a.alert_type === 'STATION_UNEXPECTED_OFFLINE' && a.station_id) {
        map.set(a.station_id, a.title || 'Outage')
      }
    })
    return map
  }, [alertsQ.data])

  const rows = useMemo(() => {
    if ((stationsQ.data?.length ?? 0) > 0) {
      return stationsQ.data!.map((s) => {
        const perf =
          perfByCode.get(s.station_code) ||
          (s.mqtt_station_id ? perfByCode.get(s.mqtt_station_id) : undefined)
        return {
          key: s.id,
          code: s.station_code,
          mqttId: s.mqtt_station_id || s.station_code,
          name: s.name,
          operational: s.operational_status || 'UNKNOWN',
          connectivity: s.connectivity_status || 'UNKNOWN',
          statusSource: s.status_source || null,
          lastSeen: s.last_seen_at || s.last_heartbeat_at || null,
          expected: expectedHoursLabel(s.operational_status, s.opens_at, s.closes_at),
          outage: outageByStation.get(s.id) || null,
          amount: perf?.amount ?? 0,
          pumps: pumpsQ.data?.filter((p) => p.station_id === s.id).length ?? 0,
          href: `/stations/${s.id}`,
          twinHref: `/digital-twin/${encodeURIComponent(s.mqtt_station_id || s.station_code)}`,
        }
      })
    }
    return []
  }, [stationsQ.data, perfByCode, pumpsQ.data, outageByStation])

  return (
    <div className="p-6 space-y-4">
      <div>
        <h1 className="section-title">Stations</h1>
        <p className="text-slate-400 text-sm mt-1">
          Operational vs edge connectivity are independent · {summaryQ.data?.timezone || 'Africa/Lagos'}
        </p>
        <p className="text-[11px] text-slate-600 mt-1">
          Edge online means the Raspberry Pi is connected to the cloud. Pump activity is reported
          separately.
        </p>
      </div>

      {stationsQ.isError && (
        <div className="card text-red-300 text-sm" role="alert">
          Failed to load stations.
        </div>
      )}

      {rows.length === 0 ? (
        <div className="card text-slate-500 text-sm text-center py-16">No stations or sales data yet</div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-400 border-b border-slate-700">
                <th className="pb-2">Station</th>
                <th className="pb-2">Operational</th>
                <th className="pb-2">Edge device</th>
                <th className="pb-2">Last heartbeat</th>
                <th className="pb-2">Pump comms</th>
                <th className="pb-2">Expected</th>
                <th className="pb-2">Source</th>
                <th className="pb-2">Outage</th>
                <th className="pb-2 text-right">Sales today</th>
                <th className="pb-2 text-right">Pumps</th>
                <th className="pb-2 text-right">Twin</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-b border-slate-800 hover:bg-slate-800/40">
                  <td className="py-3">
                    <Link to={r.href} className="text-emerald-400 hover:underline font-medium">
                      {r.name}
                    </Link>
                    <div className="text-xs text-slate-500 font-mono">{r.code}</div>
                    {r.mqttId && r.mqttId !== r.code && (
                      <div className="text-[10px] text-sky-500/80 font-mono">{r.mqttId}</div>
                    )}
                  </td>
                  <td className="py-3">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded border ${badgeClass('op', r.operational)}`}>
                      {r.operational}
                    </span>
                  </td>
                  <StationEdgeCells mqttStationId={r.mqttId} />
                  <td className="py-3 text-slate-400 text-xs font-mono">{r.expected}</td>
                  <td className="py-3 text-[10px] text-slate-500 uppercase">{r.statusSource || '—'}</td>
                  <td className="py-3 text-xs">
                    {r.outage ? (
                      <span className="text-red-400">{r.outage}</span>
                    ) : (
                      <span className="text-slate-600">—</span>
                    )}
                  </td>
                  <td className="py-3 text-right font-mono">{fmtNaira(r.amount)}</td>
                  <td className="py-3 text-right">{r.pumps}</td>
                  <td className="py-3 text-right">
                    <Link to={r.twinHref} className="text-sky-400 hover:underline text-xs font-medium">
                      View Digital Twin
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
