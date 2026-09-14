import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  fmtLiters,
  fmtNaira,
  getAlerts,
  getPumps,
  getStationPerformance,
  getStations,
} from '../api/client'
import { formatStatusLabel } from '../lib/enumPresentation'

function badgeClass(kind: 'op' | 'data', value?: string) {
  const v = (value || 'UNKNOWN').toUpperCase()
  if (kind === 'op') {
    if (v === 'OPEN') return 'bg-emerald-950 text-emerald-400 border-emerald-800'
    if (v === 'CLOSED') return 'bg-slate-800 text-slate-300 border-slate-600'
    if (v === 'OPENING' || v === 'CLOSING') return 'bg-amber-950 text-amber-400 border-amber-800'
  } else {
    if (v === 'CURRENT') return 'bg-emerald-950 text-emerald-400 border-emerald-800'
    if (v === 'DELAYED') return 'bg-amber-950 text-amber-400 border-amber-800'
    if (v === 'UNAVAILABLE' || v === 'NO_DATA') return 'bg-slate-800 text-slate-300 border-slate-600'
  }
  return 'bg-slate-800 text-slate-400 border-slate-700'
}

function dataStatusLabel(opts: {
  amount: number
  count: number
  outage: string | null
  connectivity?: string | null
}): { code: string; label: string } {
  if (opts.outage || (opts.connectivity || '').toUpperCase() === 'OFFLINE') {
    return { code: 'DELAYED', label: 'Sales data may be delayed' }
  }
  if (opts.count > 0 || opts.amount > 0) {
    return { code: 'CURRENT', label: 'Current' }
  }
  if ((opts.connectivity || '').toUpperCase() === 'UNKNOWN') {
    return { code: 'UNAVAILABLE', label: 'Data unavailable' }
  }
  return { code: 'NO_DATA', label: 'No recent sales data' }
}

export default function StationsPage() {
  const [technical, setTechnical] = useState(false)
  const stationsQ = useQuery({ queryKey: ['stations'], queryFn: async () => (await getStations()).data })
  const perfQ = useQuery({
    queryKey: ['dashboard', 'stations'],
    queryFn: async () => (await getStationPerformance()).data,
  })
  const pumpsQ = useQuery({ queryKey: ['pumps'], queryFn: async () => (await getPumps()).data })
  const alertsQ = useQuery({
    queryKey: ['alerts', 'stations-outage'],
    queryFn: async () => (await getAlerts({ status: 'OPEN' })).data,
  })

  const perfByCode = useMemo(() => {
    const map = new Map<string, { amount: number; volume: number; count: number }>()
    perfQ.data?.forEach((p) =>
      map.set(p.station_id, { amount: Number(p.amount), volume: Number(p.volume), count: p.count }),
    )
    return map
  }, [perfQ.data])

  const outageByStation = useMemo(() => {
    const map = new Map<string, string>()
    ;(alertsQ.data || []).forEach((a) => {
      if (a.alert_type === 'STATION_UNEXPECTED_OFFLINE' && a.station_id) {
        map.set(a.station_id, a.title || 'Sales data may be delayed')
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
        const physicalPumps =
          pumpsQ.data?.filter((p) => p.station_id === s.id && p.active !== false).length ?? 0
        const amount = perf?.amount ?? 0
        const volume = perf?.volume ?? 0
        const count = perf?.count ?? 0
        const outage = outageByStation.get(s.id) || null
        const data = dataStatusLabel({
          amount,
          count,
          outage,
          connectivity: s.connectivity_status,
        })
        return {
          key: s.id,
          code: s.station_code,
          mqttId: s.mqtt_station_id || s.station_code,
          name: s.name,
          operational: s.operational_status || 'UNKNOWN',
          amount,
          volume,
          count,
          pumps: physicalPumps,
          data,
          outage,
          href: `/stations/${s.id}`,
          twinHref: `/digital-twin/${encodeURIComponent(s.mqtt_station_id || s.station_code)}`,
        }
      })
    }
    return []
  }, [stationsQ.data, perfByCode, pumpsQ.data, outageByStation])

  return (
    <div className="p-6 space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="section-title">Stations</h1>
          <p className="text-slate-400 text-sm mt-1">Monitor sales and station activity</p>
        </div>
        <button
          type="button"
          className="btn-secondary btn-compact text-xs"
          aria-pressed={technical}
          onClick={() => setTechnical((v) => !v)}
        >
          {technical ? 'Hide technical details' : 'Technical details'}
        </button>
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
                <th className="pb-2">Operating status</th>
                <th className="pb-2 text-right">Sales today</th>
                <th className="pb-2 text-right">Volume today</th>
                <th className="pb-2 text-right">Transactions today</th>
                <th className="pb-2 text-right">Physical pumps</th>
                <th className="pb-2">Data status</th>
                {technical ? <th className="pb-2">Notes</th> : null}
                <th className="pb-2 text-right">Action</th>
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
                  </td>
                  <td className="py-3">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded border ${badgeClass('op', r.operational)}`}>
                      {formatStatusLabel(r.operational)}
                    </span>
                  </td>
                  <td className="py-3 text-right font-mono">{fmtNaira(r.amount)}</td>
                  <td className="py-3 text-right font-mono">{fmtLiters(r.volume)}</td>
                  <td className="py-3 text-right font-mono">{r.count}</td>
                  <td className="py-3 text-right" data-testid="station-pump-count">
                    {r.pumps}
                  </td>
                  <td className="py-3">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded border ${badgeClass('data', r.data.code)}`}>
                      {r.data.label}
                    </span>
                  </td>
                  {technical ? (
                    <td className="py-3 text-xs text-slate-500 max-w-[12rem]">
                      {r.outage ? 'Sales data may be delayed' : '—'}
                      {r.mqttId && r.mqttId !== r.code ? (
                        <div className="font-mono text-[10px] mt-1 truncate" title={r.mqttId}>
                          {r.mqttId}
                        </div>
                      ) : null}
                    </td>
                  ) : null}
                  <td className="py-3 text-right space-x-2 whitespace-nowrap">
                    <Link to={r.href} className="text-emerald-400 hover:underline text-xs font-medium">
                      Open
                    </Link>
                    <Link to={r.twinHref} className="text-sky-400 hover:underline text-xs font-medium">
                      Twin
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
