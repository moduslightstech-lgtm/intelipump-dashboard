import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
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
  getExecutiveDashboard,
  getExecutiveStationPerformance,
  getHourlySales,
  getProductBreakdown,
  getStations,
} from '../api/client'
import ChartEmptyState from '../components/dashboard/ChartEmptyState'
import DashboardPanel from '../components/dashboard/DashboardPanel'
import ExecutiveKpiCard from '../components/dashboard/ExecutiveKpiCard'
import ExecutiveSummaryBanner from '../components/dashboard/ExecutiveSummaryBanner'
import {
  IconAlert,
  IconBuilding,
  IconChart,
  IconCheck,
  IconCurrency,
  IconDroplet,
  IconWifi,
  IconWifiOff,
} from '../components/dashboard/icons'
import SeverityPill from '../components/dashboard/SeverityPill'
import { productColor } from '../components/dashboard/tokens'
import { EdgeConnectivityNetworkPanel } from '../components/edge/EdgeConnectivity'
import { useStationLiveSales } from '../hooks/useStationLiveSales'
import { formatSaleAmount } from '../types/sales'

const LIVE_STATION = 'EnergySwitch-Ibadan-Boluwaji'

const tooltipStyle = {
  background: '#0f172a',
  border: '1px solid #334155',
  borderRadius: 12,
  color: '#e2e8f0',
  fontSize: 12,
}

export default function ExecutiveOverviewPage() {
  const dashQ = useQuery({
    queryKey: ['executive', 'dashboard'],
    queryFn: async () => (await getExecutiveDashboard()).data,
  })
  const perfQ = useQuery({
    queryKey: ['executive', 'performance'],
    queryFn: async () => (await getExecutiveStationPerformance()).data,
  })
  const hourlyQ = useQuery({
    queryKey: ['dashboard', 'hourly'],
    queryFn: async () => (await getHourlySales()).data,
  })
  const productQ = useQuery({
    queryKey: ['dashboard', 'products'],
    queryFn: async () => (await getProductBreakdown()).data,
  })
  const alertsQ = useQuery({
    queryKey: ['alerts', 'open'],
    queryFn: async () => (await getAlerts('OPEN')).data,
  })
  const stationsQ = useQuery({
    queryKey: ['stations'],
    queryFn: async () => (await getStations()).data,
  })

  const live = useStationLiveSales({ stationId: LIVE_STATION })

  const d = dashQ.data
  const stations = perfQ.data || []
  const edgeStations = useMemo(
    () =>
      (stationsQ.data || []).map((s) => ({
        id: s.id,
        name: s.name,
        mqttId: s.mqtt_station_id || s.station_code,
      })),
    [stationsQ.data],
  )
  const bestStation = stations[0]?.name || null
  const reconHealthy =
    Number(d?.reconciliationsWithVariance ?? 0) === 0 && Number(d?.missingNightlySubmissions ?? 0) === 0
  const reconLabel = reconHealthy
    ? 'Healthy'
    : `${Number(d?.reconciliationsWithVariance || 0)} variance · ${Number(d?.missingNightlySubmissions || 0)} missing`

  const productTotal = useMemo(
    () => (productQ.data || []).reduce((sum, row) => sum + Number(row.amount || 0), 0),
    [productQ.data],
  )

  const topStations = stations.slice(0, 8)
  const maxStationAmount = Math.max(...topStations.map((s: any) => Number(s.amount || 0)), 1)

  const peakHour = useMemo(() => {
    const rows = hourlyQ.data || []
    if (!rows.length) return null
    let best = rows[0]
    for (const row of rows) {
      if (Number(row.amount || 0) > Number(best.amount || 0)) best = row
    }
    if (!best?.hour || !Number(best.amount)) return null
    return new Date(best.hour).toLocaleTimeString('en-NG', { hour: 'numeric' })
  }, [hourlyQ.data])

  const edgeOnline = live.devices?.onlineCount ?? 0
  const edgeOffline = live.devices?.offlineCount ?? 0
  const piStatus = live.primaryDevice?.status || 'UNKNOWN'
  const mqttStatus = live.primaryDevice?.mqttConnectionStatus || 'UNKNOWN'

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">Executive Overview</h1>
          <p className="mt-1 text-sm text-slate-400">
            Revenue, volume, and operational health across the network
          </p>
        </div>
        {dashQ.isFetching && <span className="text-xs text-slate-500">Refreshing…</span>}
      </div>

      <ExecutiveSummaryBanner
        salesToday={live.summary?.totalAmount ?? d?.salesToday}
        salesMonth={d?.salesMonth}
        litersToday={live.summary?.totalVolumeLiters ?? d?.litersToday}
        bestStation={bestStation}
        reconHealthy={reconHealthy}
        reconLabel={reconLabel}
        criticalAlerts={d?.activeCriticalAlerts}
        businessDate={d?.businessDate}
        timezone={d?.timezone}
      />

      <div className="card space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-white">
            Live · {LIVE_STATION}
          </h2>
          <span className="text-[11px] text-slate-500">
            Edge Pi status is separate from the live sales stream
          </span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-8 gap-2">
          <MiniKpi label="Today’s sales" value={formatSaleAmount(live.summary?.totalAmount ?? null)} />
          <MiniKpi label="Liters sold" value={fmtLiters(live.summary?.totalVolumeLiters)} />
          <MiniKpi label="Transactions" value={String(live.summary?.transactionCount ?? '—')} />
          <MiniKpi
            label="Avg transaction"
            value={formatSaleAmount(live.summary?.averageTransactionAmount ?? null)}
          />
          <MiniKpi
            label="Last transaction"
            value={live.summary?.latestTransactionAt ? fmtTime(live.summary.latestTransactionAt) : '—'}
          />
          <MiniKpi label="Online edge devices" value={String(edgeOnline)} tone="ok" />
          <MiniKpi label="Offline edge devices" value={String(edgeOffline)} tone={edgeOffline ? 'bad' : undefined} />
          <MiniKpi
            label="Live stream"
            value={live.streamStatus}
            tone={live.streamStatus === 'LIVE' ? 'ok' : 'warn'}
          />
        </div>
        <div className="flex flex-wrap gap-3 text-xs text-slate-400">
          <span>
            Edge device:{' '}
            <span className="text-slate-200 font-medium">{piStatus}</span>
          </span>
          <span>
            MQTT:{' '}
            <span className="text-slate-200 font-medium">{mqttStatus}</span>
          </span>
          <span>
            Stream heartbeat:{' '}
            <span className="text-slate-200 font-medium">
              {live.lastStreamHeartbeatAt ? fmtTime(live.lastStreamHeartbeatAt) : '—'}
            </span>
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-4">
        <ExecutiveKpiCard
          label="Sales today"
          value={fmtNaira(live.summary?.totalAmount ?? d?.salesToday)}
          accent="sales"
          icon={<IconCurrency className="h-5 w-5" />}
          hint={peakHour ? `Peak hour: ${peakHour}` : 'Boluwaji live summary when available'}
          trend={bestStation ? { label: `Best: ${bestStation}`, direction: 'up' } : null}
        />
        <ExecutiveKpiCard
          label="Sales this month"
          value={fmtNaira(d?.salesMonth)}
          accent="ticket"
          icon={<IconChart className="h-5 w-5" />}
          hint="Month-to-date"
        />
        <ExecutiveKpiCard
          label="Liters today"
          value={fmtLiters(live.summary?.totalVolumeLiters ?? d?.litersToday)}
          accent="volume"
          icon={<IconDroplet className="h-5 w-5" />}
          hint="Dispensed volume"
        />
        <ExecutiveKpiCard
          label="Stations"
          value={String(d?.stationCount ?? '—')}
          accent="stations"
          icon={<IconBuilding className="h-5 w-5" />}
          hint={`${d?.stationsOpen ?? 0} open · ${d?.stationsClosed ?? 0} closed`}
        />
        <ExecutiveKpiCard
          label="Open now"
          value={String(d?.stationsOpen ?? '—')}
          accent="online"
          icon={<IconWifi className="h-5 w-5" />}
        />
        <ExecutiveKpiCard
          label="Unexpected offline"
          value={String(d?.stationsOfflineUnexpected ?? '—')}
          accent="offline"
          icon={<IconWifiOff className="h-5 w-5" />}
          hint="Needs attention"
        />
        <ExecutiveKpiCard
          label="Recons with variance"
          value={String(d?.reconciliationsWithVariance ?? '—')}
          accent="warning"
          icon={<IconAlert className="h-5 w-5" />}
          hint={`${d?.reconciliationsCompleted ?? 0} completed`}
        />
        <ExecutiveKpiCard
          label="Critical alerts"
          value={String(d?.activeCriticalAlerts ?? '—')}
          accent="critical"
          icon={<IconAlert className="h-5 w-5" />}
          hint={`${d?.missingNightlySubmissions ?? 0} missing tank submissions`}
        />
      </div>

      <EdgeConnectivityNetworkPanel stations={edgeStations} />

      <div className="grid gap-4 lg:grid-cols-2">
        <DashboardPanel title="Hourly sales">
          <div className="h-72">
            {(hourlyQ.data?.length ?? 0) === 0 ? (
              <ChartEmptyState
                title="No sales yet today"
                description="Hourly revenue will appear here as transactions arrive."
                icon={<IconChart className="h-6 w-6" />}
              />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={hourlyQ.data}>
                  <defs>
                    <linearGradient id="execSalesFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#10b981" stopOpacity={0.45} />
                      <stop offset="100%" stopColor="#10b981" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                  <XAxis
                    dataKey="hour"
                    tickFormatter={(v) =>
                      new Date(v).toLocaleTimeString('en-NG', { hour: '2-digit' })
                    }
                    stroke="#64748b"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis stroke="#64748b" fontSize={11} tickLine={false} axisLine={false} width={48} />
                  <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => fmtNaira(v)} />
                  <Area
                    type="monotone"
                    dataKey="amount"
                    stroke="#34d399"
                    strokeWidth={2.5}
                    fill="url(#execSalesFill)"
                    dot={false}
                    activeDot={{ r: 4, fill: '#10b981' }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </DashboardPanel>

        <DashboardPanel title="Sales by product">
          <div className="h-72">
            {(productQ.data?.length ?? 0) === 0 ? (
              <ChartEmptyState
                title="No product breakdown yet"
                description="Product mix will show once sales are recorded today."
                icon={<IconDroplet className="h-6 w-6" />}
              />
            ) : (
              <div className="flex h-full flex-col gap-3 sm:flex-row sm:items-center">
                <div className="h-52 w-full sm:h-full sm:w-1/2">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={productQ.data}
                        dataKey="amount"
                        nameKey="product"
                        cx="50%"
                        cy="50%"
                        innerRadius={52}
                        outerRadius={78}
                        paddingAngle={3}
                      >
                        {(productQ.data || []).map((row, i) => (
                          <Cell key={i} fill={productColor(row.product)} stroke="#0f172a" strokeWidth={2} />
                        ))}
                      </Pie>
                      <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => fmtNaira(v)} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <ul className="flex-1 space-y-2">
                  {(productQ.data || []).map((row) => {
                    const pct = productTotal > 0 ? (Number(row.amount) / productTotal) * 100 : 0
                    return (
                      <li
                        key={row.product}
                        className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <span
                            className="h-2.5 w-2.5 rounded-full"
                            style={{ backgroundColor: productColor(row.product) }}
                          />
                          <span className="truncate text-sm font-medium text-slate-200">{row.product}</span>
                        </div>
                        <div className="text-right">
                          <div className="font-mono text-xs text-white">{fmtNaira(row.amount)}</div>
                          <div className="text-[10px] text-slate-500">{pct.toFixed(1)}%</div>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </div>
            )}
          </div>
        </DashboardPanel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <DashboardPanel title="Station ranking (today)" action={{ to: '/stations', label: 'View stations' }}>
          {topStations.length === 0 ? (
            <ChartEmptyState
              title="No station sales yet"
              description="Ranked station performance will appear as sales come in."
              icon={<IconBuilding className="h-6 w-6" />}
            />
          ) : (
            <div className="space-y-3">
              {topStations.map((row: any, idx: number) => {
                const width = Math.max(6, (Number(row.amount || 0) / maxStationAmount) * 100)
                return (
                  <div key={row.stationId} className="rounded-xl border border-slate-800/80 bg-slate-950/40 p-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span
                            className={`inline-flex h-5 w-5 items-center justify-center rounded-md text-[10px] font-bold ${
                              idx === 0 ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-800 text-slate-400'
                            }`}
                          >
                            {idx + 1}
                          </span>
                          <span className="truncate text-sm font-medium text-white">{row.name}</span>
                        </div>
                        <div className="ml-7 text-[11px] text-slate-500">{row.stationCode}</div>
                      </div>
                      <div className="text-right">
                        <div className="font-mono text-sm text-emerald-300">{fmtNaira(row.amount)}</div>
                        <div className="text-[11px] text-slate-500">{fmtLiters(row.volume)}</div>
                      </div>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-slate-800">
                      <div
                        className={`h-full rounded-full ${idx === 0 ? 'bg-emerald-400' : 'bg-indigo-400/80'}`}
                        style={{ width: `${width}%` }}
                      />
                    </div>
                    <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
                      <span>
                        {row.operationalStatus} · {row.connectivityStatus}
                      </span>
                      <Link
                        to={`/digital-twin/${encodeURIComponent(row.stationId)}`}
                        className="text-sky-400 hover:underline"
                      >
                        Twin
                      </Link>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </DashboardPanel>

        <DashboardPanel title="Active alerts" action={{ to: '/alerts', label: 'View alerts' }}>
          {(alertsQ.data?.length ?? 0) === 0 ? (
            <ChartEmptyState
              title="No open alerts"
              description="Network is clear — critical issues will surface here."
              icon={<IconCheck className="h-6 w-6" />}
            />
          ) : (
            <ul className="space-y-2">
              {alertsQ.data?.slice(0, 8).map((a) => (
                <li
                  key={a.id}
                  className="rounded-xl border border-slate-800 bg-slate-950/50 p-3 transition hover:border-slate-600"
                >
                  <div className="flex items-center gap-2">
                    <SeverityPill severity={a.severity} />
                    <span className="truncate text-sm font-medium text-white">{a.title}</span>
                  </div>
                  <p className="mt-1 text-xs text-slate-400 line-clamp-2">{a.message || a.alert_type}</p>
                </li>
              ))}
            </ul>
          )}
        </DashboardPanel>
      </div>

      {/* Keep compact table for reconciliation deep-dive */}
      <DashboardPanel title="Station detail table" action={{ to: '/reconciliations', label: 'Reconciliations' }}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-700 text-left text-slate-400">
                <th className="pb-2 font-medium">Station</th>
                <th className="pb-2 font-medium">Operational</th>
                <th className="pb-2 font-medium">Connectivity</th>
                <th className="pb-2 text-right font-medium">Sales</th>
                <th className="pb-2 text-right font-medium">Volume</th>
              </tr>
            </thead>
            <tbody>
              {stations.map((r: any) => (
                <tr key={r.stationId} className="border-b border-slate-800/80 hover:bg-slate-900/50">
                  <td className="py-2.5 text-slate-200">{r.name}</td>
                  <td className="py-2.5 text-xs text-slate-400">{r.operationalStatus}</td>
                  <td className="py-2.5 text-xs text-slate-400">{r.connectivityStatus}</td>
                  <td className="py-2.5 text-right font-mono text-emerald-300">{fmtNaira(r.amount)}</td>
                  <td className="py-2.5 text-right font-mono text-cyan-300">{fmtLiters(r.volume)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </DashboardPanel>
    </div>
  )
}

function MiniKpi({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'ok' | 'warn' | 'bad'
}) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/50 px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div
        className={`text-sm font-semibold truncate ${
          tone === 'ok'
            ? 'text-emerald-400'
            : tone === 'warn'
              ? 'text-amber-300'
              : tone === 'bad'
                ? 'text-red-300'
                : 'text-white'
        }`}
      >
        {value}
      </div>
    </div>
  )
}
