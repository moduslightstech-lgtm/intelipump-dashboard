import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
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
  getDashboardSummary,
  getHourlySales,
  getProductBreakdown,
  getStationPerformance,
  getTransactions,
} from '../api/client'
import ChartEmptyState from '../components/dashboard/ChartEmptyState'
import DashboardPanel from '../components/dashboard/DashboardPanel'
import ExecutiveKpiCard from '../components/dashboard/ExecutiveKpiCard'
import {
  IconAlert,
  IconBuilding,
  IconChart,
  IconCheck,
  IconCurrency,
  IconDroplet,
  IconReceipt,
  IconTicket,
  IconWifi,
  IconWifiOff,
} from '../components/dashboard/icons'
import SeverityPill from '../components/dashboard/SeverityPill'
import { productColor } from '../components/dashboard/tokens'

const tooltipStyle = {
  background: '#0f172a',
  border: '1px solid #334155',
  borderRadius: 12,
  color: '#e2e8f0',
  fontSize: 12,
}

export default function OverviewPage() {
  const summaryQ = useQuery({
    queryKey: ['dashboard', 'summary'],
    queryFn: async () => (await getDashboardSummary()).data,
  })
  const hourlyQ = useQuery({
    queryKey: ['dashboard', 'hourly'],
    queryFn: async () => (await getHourlySales()).data,
  })
  const productQ = useQuery({
    queryKey: ['dashboard', 'products'],
    queryFn: async () => (await getProductBreakdown()).data,
  })
  const stationQ = useQuery({
    queryKey: ['dashboard', 'stations'],
    queryFn: async () => (await getStationPerformance()).data,
  })
  const txQ = useQuery({
    queryKey: ['transactions', 'recent'],
    queryFn: async () => (await getTransactions({ page: 1, size: 8, sort: 'received_at,desc' })).data,
  })
  const alertsQ = useQuery({
    queryKey: ['alerts', 'open'],
    queryFn: async () => (await getAlerts('OPEN')).data,
  })

  const s = summaryQ.data
  const error = summaryQ.error || hourlyQ.error
  const stations = stationQ.data || []
  const maxStationAmount = Math.max(...stations.map((row) => Number(row.amount || 0)), 1)
  const productTotal = useMemo(
    () => (productQ.data || []).reduce((sum, row) => sum + Number(row.amount || 0), 0),
    [productQ.data],
  )
  const bestStation = stations[0]?.station_name || stations[0]?.station_id || null
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

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">Overview</h1>
          <p className="mt-1 text-sm text-slate-400">
            Today&apos;s sales ({s?.timezone || 'Africa/Lagos'}) · live updates via API events
          </p>
        </div>
        {summaryQ.isFetching && <span className="text-xs text-slate-500">Refreshing…</span>}
      </div>

      {error && (
        <div className="rounded-2xl border border-red-800/60 bg-red-950/40 p-4 text-sm text-red-300" role="alert">
          Failed to load dashboard data. Check API connectivity.
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <ExecutiveKpiCard
          label="Sales today"
          value={fmtNaira(s?.total_amount_today)}
          accent="sales"
          icon={<IconCurrency className="h-5 w-5" />}
          hint={peakHour ? `Peak hour: ${peakHour}` : undefined}
          trend={bestStation ? { label: `Best: ${bestStation}`, direction: 'up' } : null}
        />
        <ExecutiveKpiCard
          label="Volume today"
          value={fmtLiters(s?.total_volume_today)}
          accent="volume"
          icon={<IconDroplet className="h-5 w-5" />}
        />
        <ExecutiveKpiCard
          label="Transactions"
          value={String(s?.transaction_count_today ?? '—')}
          accent="transactions"
          icon={<IconReceipt className="h-5 w-5" />}
        />
        <ExecutiveKpiCard
          label="Avg ticket"
          value={fmtNaira(s?.average_transaction_amount)}
          accent="ticket"
          icon={<IconTicket className="h-5 w-5" />}
        />
        <ExecutiveKpiCard
          label="Active stations"
          value={String(s?.active_stations ?? '—')}
          accent="stations"
          icon={<IconBuilding className="h-5 w-5" />}
        />
        <ExecutiveKpiCard
          label="Online devices"
          value={String(s?.online_devices ?? '—')}
          accent="online"
          icon={<IconWifi className="h-5 w-5" />}
        />
        <ExecutiveKpiCard
          label="Offline devices"
          value={String(s?.offline_devices ?? '—')}
          accent="offline"
          icon={<IconWifiOff className="h-5 w-5" />}
        />
        <ExecutiveKpiCard
          label="Rejected MQTT today"
          value={String(s?.rejected_mqtt_messages_today ?? '—')}
          accent="rejected"
          icon={<IconAlert className="h-5 w-5" />}
          hint={`Last tx: ${fmtTime(s?.last_transaction_time)}`}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <DashboardPanel title="Hourly sales">
          <div className="h-64">
            {(hourlyQ.data?.length ?? 0) === 0 ? (
              <ChartEmptyState
                title="No sales yet today"
                description="Hourly revenue will appear as transactions arrive."
                icon={<IconChart className="h-6 w-6" />}
              />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={hourlyQ.data}>
                  <defs>
                    <linearGradient id="overviewSalesFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#10b981" stopOpacity={0.4} />
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
                    fill="url(#overviewSalesFill)"
                    dot={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </DashboardPanel>

        <DashboardPanel title="Sales by product">
          <div className="h-64">
            {(productQ.data?.length ?? 0) === 0 ? (
              <ChartEmptyState
                title="No product breakdown yet"
                description="Product mix will show once sales are recorded."
                icon={<IconDroplet className="h-6 w-6" />}
              />
            ) : (
              <div className="flex h-full flex-col gap-3 sm:flex-row sm:items-center">
                <div className="h-48 w-full sm:h-full sm:w-1/2">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={productQ.data}
                        dataKey="amount"
                        nameKey="product"
                        cx="50%"
                        cy="50%"
                        innerRadius={48}
                        outerRadius={74}
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
                        <div className="flex items-center gap-2">
                          <span
                            className="h-2.5 w-2.5 rounded-full"
                            style={{ backgroundColor: productColor(row.product) }}
                          />
                          <span className="text-sm text-slate-200">{row.product}</span>
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
        <DashboardPanel title="Sales by station" action={{ to: '/stations', label: 'View stations' }}>
          {stations.length === 0 ? (
            <ChartEmptyState
              title="No station sales yet"
              description="Station rankings will appear as sales come in."
              icon={<IconBuilding className="h-6 w-6" />}
            />
          ) : (
            <div className="space-y-3">
              {stations.slice(0, 8).map((row, idx) => {
                const width = Math.max(6, (Number(row.amount || 0) / maxStationAmount) * 100)
                return (
                  <div key={row.station_id} className="rounded-xl border border-slate-800/80 bg-slate-950/40 p-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <span
                          className={`inline-flex h-5 w-5 items-center justify-center rounded-md text-[10px] font-bold ${
                            idx === 0 ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-800 text-slate-400'
                          }`}
                        >
                          {idx + 1}
                        </span>
                        <span className="truncate text-sm font-medium text-white">
                          {row.station_name || row.station_id}
                        </span>
                      </div>
                      <div className="text-right font-mono text-sm text-emerald-300">{fmtNaira(row.amount)}</div>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-slate-800">
                      <div
                        className={`h-full rounded-full ${idx === 0 ? 'bg-emerald-400' : 'bg-sky-400/80'}`}
                        style={{ width: `${width}%` }}
                      />
                    </div>
                    <div className="mt-1.5 flex justify-between text-[11px] text-slate-500">
                      <span>{row.count} tx</span>
                      <span>{fmtLiters(row.volume)}</span>
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
              description="Operations look clear right now."
              icon={<IconCheck className="h-6 w-6" />}
            />
          ) : (
            <ul className="space-y-2">
              {alertsQ.data?.slice(0, 6).map((a) => (
                <li key={a.id} className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
                  <div className="flex items-center gap-2">
                    <SeverityPill severity={a.severity} />
                    <span className="truncate text-sm font-medium text-white">{a.title}</span>
                  </div>
                  <p className="mt-1 text-xs text-slate-400">{a.message || a.alert_type}</p>
                </li>
              ))}
            </ul>
          )}
        </DashboardPanel>
      </div>

      <DashboardPanel title="Recent transactions" action={{ to: '/transactions', label: 'View all' }}>
        {(txQ.data?.items.length ?? 0) === 0 ? (
          <ChartEmptyState title="No transactions yet" description="Completed sales will list here." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700 text-left text-slate-400">
                  <th className="pb-2 font-medium">Time</th>
                  <th className="pb-2 font-medium">Station</th>
                  <th className="pb-2 font-medium">Pump</th>
                  <th className="pb-2 font-medium">Product</th>
                  <th className="pb-2 text-right font-medium">Volume</th>
                  <th className="pb-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {txQ.data?.items.map((t) => (
                  <tr key={t.id} className="border-b border-slate-800/80 hover:bg-slate-900/40">
                    <td className="whitespace-nowrap py-2.5 text-slate-400">
                      {fmtTime(t.received_at || t.device_timestamp)}
                    </td>
                    <td className="py-2.5 text-white">{t.station_id}</td>
                    <td className="py-2.5 font-mono text-slate-300">{t.pump_id}</td>
                    <td className="py-2.5">
                      <span className="inline-flex items-center gap-1.5">
                        <span
                          className="h-2 w-2 rounded-full"
                          style={{ backgroundColor: productColor(t.product) }}
                        />
                        {t.product || '—'}
                      </span>
                    </td>
                    <td className="py-2.5 text-right font-mono text-cyan-300">{fmtLiters(t.volume_liters)}</td>
                    <td className="py-2.5 text-right font-mono text-emerald-300">{fmtNaira(t.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DashboardPanel>
    </div>
  )
}
