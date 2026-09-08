import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
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
  getExecutiveOverview,
  type ExecutiveOverview,
} from '../api/client'
import ChartEmptyState from '../components/dashboard/ChartEmptyState'
import DashboardPanel from '../components/dashboard/DashboardPanel'
import ExecutiveKpiCard from '../components/dashboard/ExecutiveKpiCard'
import {
  IconBuilding,
  IconChart,
  IconDroplet,
  IconReceipt,
  IconTicket,
} from '../components/dashboard/icons'
import { productColor } from '../components/dashboard/tokens'
import {
  COMPARISON_OPTIONS,
  PERIOD_OPTIONS,
  formatPct,
  num,
  overviewSearchParams,
  parseOverviewFilters,
  relativeTime,
  trendFromPct,
} from '../lib/executiveOverview'
import { useAuth } from '../context/AuthContext'
import { normalizeRole } from '../lib/roles'

const tooltipStyle = {
  background: '#0f172a',
  border: '1px solid #334155',
  borderRadius: 12,
  color: '#e2e8f0',
  fontSize: 12,
}

function severityClass(severity: string) {
  if (severity === 'critical') return 'bg-red-500/15 text-red-300'
  if (severity === 'attention') return 'bg-amber-500/15 text-amber-200'
  return 'bg-slate-700/70 text-slate-300'
}

function severityLabel(severity: string) {
  if (severity === 'critical') return 'Critical'
  if (severity === 'attention') return 'Needs attention'
  return 'Monitor'
}

export default function OverviewPage() {
  const { user } = useAuth()
  const role = normalizeRole(user?.normalizedRole || user?.role)
  const canSeeRecon = role !== 'STATION_MANAGER'
  const [searchParams, setSearchParams] = useSearchParams()
  const filters = useMemo(() => parseOverviewFilters(searchParams), [searchParams])
  const [metric, setMetric] = useState<'revenue' | 'volume'>('revenue')
  const [mixMode, setMixMode] = useState<'revenue' | 'volume'>('revenue')

  const queryParams = useMemo(() => {
    const params: Record<string, string | undefined> = {
      period: filters.period,
      comparison: filters.comparison,
      station_id: filters.station || undefined,
      product: filters.product && filters.product !== 'all' ? filters.product : undefined,
      sort: filters.sort,
      start: filters.period === 'custom' ? filters.start || undefined : undefined,
      end: filters.period === 'custom' ? filters.end || undefined : undefined,
    }
    return params
  }, [filters])

  const overviewQ = useQuery({
    queryKey: ['dashboard', 'executive-overview', queryParams],
    queryFn: async () => (await getExecutiveOverview(queryParams)).data,
  })

  const data = overviewQ.data
  const setFilter = (patch: Partial<typeof filters>) => {
    const next = { ...filters, ...patch }
    setSearchParams(overviewSearchParams(next), { replace: true })
  }

  const series = useMemo(
    () =>
      (data?.series || []).map((row) => ({
        ...row,
        current: metric === 'revenue' ? num(row.current_amount) || 0 : num(row.current_volume) || 0,
        previous: metric === 'revenue' ? num(row.previous_amount) : num(row.previous_volume),
      })),
    [data?.series, metric],
  )
  const maxStation = Math.max(...(data?.stations || []).map((s) => num(s.amount) || 0), 1)
  const topStations = (data?.stations || []).slice(0, 6).map((row) => ({
    ...row,
    amount: num(row.amount) || 0,
  }))
  const products = (data?.products || []).map((row) => ({
    ...row,
    amount: num(row.amount) || 0,
    volume: num(row.volume) || 0,
  }))
  const empty = Boolean(data?.activity.empty_period)
  const subtitleScope = `${data?.period.label || filters.period} · ${data?.period.station_name || 'All stations'}`

  return (
    <div className="space-y-8 p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">Executive Overview</h1>
          <p className="mt-1 text-sm text-slate-400">Sales performance across your stations</p>
        </div>
        <div className="text-right">
          <p className="text-sm text-slate-200" title={data?.period.timezone_note}>
            {subtitleScope}
          </p>
          <p className="text-xs text-slate-500">{relativeTime(data?.generated_at)}</p>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-slate-800 bg-slate-900/50 px-4 py-3">
        <FilterSelect
          label="Date period"
          value={filters.period}
          onChange={(period) => setFilter({ period, start: period === 'custom' ? filters.start : '', end: period === 'custom' ? filters.end : '' })}
          options={PERIOD_OPTIONS.map((o) => ({ id: o.id, name: o.label }))}
        />
        {filters.period === 'custom' && (
          <>
            <label className="text-xs text-slate-400">
              From
              <input
                type="date"
                className="input mt-1 block py-1.5 text-sm"
                value={filters.start}
                onChange={(e) => setFilter({ start: e.target.value })}
              />
            </label>
            <label className="text-xs text-slate-400">
              To
              <input
                type="date"
                className="input mt-1 block py-1.5 text-sm"
                value={filters.end}
                onChange={(e) => setFilter({ end: e.target.value })}
              />
            </label>
          </>
        )}
        <FilterSelect
          label="Comparison"
          value={filters.comparison}
          onChange={(comparison) => setFilter({ comparison })}
          options={COMPARISON_OPTIONS.map((o) => ({ id: o.id, name: o.label }))}
        />
        <FilterSelect
          label="Station"
          value={filters.station}
          onChange={(station) => setFilter({ station })}
          options={[{ id: '', name: 'All stations' }, ...(data?.filters.stations || [])]}
        />
        <FilterSelect
          label="Product"
          value={filters.product || 'all'}
          onChange={(product) => setFilter({ product: product === 'all' ? '' : product })}
          options={data?.filters.products || [{ id: 'all', name: 'All products' }]}
        />
        <button
          type="button"
          className="btn-secondary ml-auto py-1.5 text-sm"
          onClick={() => overviewQ.refetch()}
        >
          Refresh
        </button>
      </div>

      {overviewQ.error && (
        <div className="rounded-2xl border border-red-800/60 bg-red-950/40 p-4 text-sm text-red-300" role="alert">
          Failed to load dashboard data.
        </div>
      )}

      <KpiStrip data={data} canSeeRecon={canSeeRecon} />

      {data?.insights?.length ? (
        <ul className="grid gap-2 md:grid-cols-3">
          {data.insights.map((line) => (
            <li key={line} className="rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-3 text-sm text-slate-200">
              {line}
            </li>
          ))}
        </ul>
      ) : null}

      <DashboardPanel title="Sales trend">
        {empty || series.length === 0 ? (
          <ChartEmptyState
            compact
            title={data?.activity.empty_title || 'No sales recorded for this period'}
            description={data?.activity.empty_detail || 'Try another date range or check a different station.'}
            actions={
              <>
                <button type="button" className="btn-secondary py-1 text-xs" onClick={() => setFilter({ period: 'last_7_days' })}>
                  View previous sales
                </button>
                <Link to="/stations" className="btn-secondary py-1 text-xs">
                  Review stations
                </Link>
              </>
            }
          />
        ) : (
          <div>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex gap-1 rounded-lg bg-slate-950 p-1">
                <Toggle active={metric === 'revenue'} onClick={() => setMetric('revenue')}>
                  Revenue
                </Toggle>
                <Toggle active={metric === 'volume'} onClick={() => setMetric('volume')}>
                  Volume
                </Toggle>
              </div>
              <p className="text-xs text-slate-500" title={data?.period.timezone_note}>
                {data?.annotations.peak_label ? `Peak: ${data.annotations.peak_label}` : null}
                {data?.annotations.change_label ? ` · ${data.annotations.change_label}` : null}
              </p>
            </div>
            <div className="h-72 min-h-[18rem] w-full min-w-0">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={series}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                  <XAxis dataKey="label" stroke="#64748b" fontSize={11} tickLine={false} axisLine={false} />
                  <YAxis
                    stroke="#64748b"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    width={64}
                    tickFormatter={(v) => (metric === 'revenue' ? fmtNaira(v) : fmtLiters(v))}
                  />
                  <Tooltip
                    contentStyle={tooltipStyle}
                    formatter={(value: number, name: string) => [
                      metric === 'revenue' ? fmtNaira(value) : fmtLiters(value),
                      name === 'current' ? 'Selected period' : 'Comparison',
                    ]}
                  />
                  <Legend formatter={(v) => (v === 'current' ? 'Selected period' : 'Comparison')} />
                  <Line type="monotone" dataKey="current" stroke="#34d399" strokeWidth={2.5} dot={false} />
                  {filters.comparison !== 'none' && (
                    <Line
                      type="monotone"
                      dataKey="previous"
                      stroke="#64748b"
                      strokeWidth={2}
                      strokeDasharray="4 4"
                      dot={false}
                    />
                  )}
                </LineChart>
              </ResponsiveContainer>
            </div>
            <details className="mt-3">
              <summary className="cursor-pointer text-xs text-slate-500">View data table</summary>
              <table className="mt-2 w-full text-xs text-slate-300">
                <thead>
                  <tr className="text-left text-slate-500">
                    <th className="py-1">Period</th>
                    <th className="py-1 text-right">Selected</th>
                    <th className="py-1 text-right">Comparison</th>
                  </tr>
                </thead>
                <tbody>
                  {series.map((row) => (
                    <tr key={row.bucket} className="border-t border-slate-800">
                      <td className="py-1">{row.label}</td>
                      <td className="py-1 text-right font-mono">
                        {metric === 'revenue' ? fmtNaira(row.current) : fmtLiters(row.current)}
                      </td>
                      <td className="py-1 text-right font-mono">
                        {row.previous == null
                          ? '—'
                          : metric === 'revenue'
                            ? fmtNaira(row.previous)
                            : fmtLiters(row.previous)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </div>
        )}
      </DashboardPanel>

      <div className="grid gap-6 lg:grid-cols-2">
        <DashboardPanel title="Product mix">
          {products.length === 0 ? (
            <ChartEmptyState
              compact
              title={data?.activity.empty_title || 'No sales recorded for this period'}
              description="Product mix will appear when sales are recorded."
            />
          ) : (
            <div>
              <div className="mb-3 flex gap-1 rounded-lg bg-slate-950 p-1 w-fit">
                <Toggle active={mixMode === 'revenue'} onClick={() => setMixMode('revenue')}>
                  Revenue share
                </Toggle>
                <Toggle active={mixMode === 'volume'} onClick={() => setMixMode('volume')}>
                  Volume share
                </Toggle>
              </div>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <div className="h-44 w-full sm:w-2/5">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={products}
                        dataKey={mixMode === 'revenue' ? 'amount' : 'volume'}
                        nameKey="product"
                        cx="50%"
                        cy="50%"
                        innerRadius={42}
                        outerRadius={68}
                        paddingAngle={3}
                      >
                        {products.map((row) => (
                          <Cell key={row.product} fill={productColor(row.product)} stroke="#0f172a" strokeWidth={2} />
                        ))}
                      </Pie>
                      <Tooltip
                        contentStyle={tooltipStyle}
                        formatter={(v: number, _n, item) => [
                          mixMode === 'revenue' ? fmtNaira(v) : fmtLiters(v),
                          (item?.payload as { product?: string })?.product,
                        ]}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <ul className="flex-1 space-y-2">
                  {products.map((row) => (
                    <li key={row.product} className="rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: productColor(row.product) }} />
                          <span className="truncate text-sm text-slate-200">{row.product}</span>
                        </div>
                        <span className="font-mono text-xs text-white">
                          {mixMode === 'revenue' ? fmtNaira(num(row.amount)) : fmtLiters(num(row.volume))}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-slate-500">
                        <span>
                          {(mixMode === 'revenue' ? num(row.share_amount) : num(row.share_volume))?.toFixed(1)}%
                        </span>
                        <span>{row.count} sales</span>
                        {row.avg_price_per_litre != null && (
                          <span>{fmtNaira(num(row.avg_price_per_litre))}/L</span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
              {data?.unmapped && (
                <div className="mt-3 rounded-xl border border-amber-900/60 bg-amber-950/20 px-3 py-2 text-xs text-amber-100">
                  <div className="font-medium">Unmapped sales</div>
                  <p className="mt-1 text-amber-200/80">
                    {fmtNaira(num(data.unmapped.amount))} · {fmtLiters(num(data.unmapped.volume))} · {data.unmapped.count}{' '}
                    sales
                  </p>
                  <Link to={data.unmapped.review_href} className="mt-1 inline-block text-amber-300 hover:underline">
                    Review product mappings
                  </Link>
                </div>
              )}
            </div>
          )}
        </DashboardPanel>

        <DashboardPanel
          title="Needs attention"
          action={canSeeRecon ? { to: '/alerts', label: 'Technical alerts' } : undefined}
        >
          {(data?.exceptions.length ?? 0) === 0 ? (
            <ChartEmptyState compact title="Nothing needs attention" description="No business issues for this period." />
          ) : (
            <ul className="space-y-2">
              {data?.exceptions.map((item) => (
                <li key={item.id} className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
                  <div className="flex items-center gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${severityClass(item.severity)}`}>
                      {severityLabel(item.severity)}
                    </span>
                    <span className="truncate text-sm font-medium text-white">{item.title}</span>
                  </div>
                  {item.station_name && <p className="mt-1 text-xs text-slate-400">{item.station_name}</p>}
                  {item.impact && <p className="mt-1 text-xs text-slate-400">{item.impact}</p>}
                  <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
                    <span>{fmtTime(item.occurred_at)}</span>
                    <Link to={item.href} className="text-emerald-400 hover:underline">
                      {item.action}
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </DashboardPanel>
      </div>

      <DashboardPanel title="Station performance" action={{ to: '/stations', label: 'View all stations' }}>
        {(data?.stations.length ?? 0) === 0 ? (
          <ChartEmptyState
            compact
            title={data?.activity.empty_title || 'No sales recorded for this period'}
            description="Try another date range or check a different station."
          />
        ) : (
          <div className="space-y-4">
            {topStations.some((s) => (num(s.amount) || 0) > 0) && (
              <div className="h-40">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={topStations} layout="vertical" margin={{ left: 8, right: 12 }}>
                    <XAxis type="number" hide />
                    <YAxis type="category" dataKey="station_name" width={120} stroke="#94a3b8" fontSize={11} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => fmtNaira(v)} />
                    <Bar dataKey="amount" fill="#34d399" radius={[0, 6, 6, 0]} maxBarSize={16} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
            <div className="flex flex-wrap gap-2 text-xs">
              {['sales', 'volume', 'transactions', 'growth', 'variance'].map((key) => (
                <button
                  key={key}
                  type="button"
                  className={`rounded-full px-2.5 py-1 ${filters.sort === key ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-800 text-slate-400'}`}
                  onClick={() => setFilter({ sort: key })}
                >
                  {key === 'sales' ? 'Sales' : key[0].toUpperCase() + key.slice(1)}
                </button>
              ))}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[52rem] text-sm">
                <thead>
                  <tr className="border-b border-slate-700 text-left text-slate-400">
                    <th className="pb-2 font-medium">Rank</th>
                    <th className="pb-2 font-medium">Station</th>
                    <th className="pb-2 text-right font-medium">Sales</th>
                    <th className="pb-2 text-right font-medium">Volume</th>
                    <th className="pb-2 text-right font-medium">Transactions</th>
                    <th className="pb-2 text-right font-medium">Average sale</th>
                    <th className="pb-2 text-right font-medium">Change</th>
                    {canSeeRecon && <th className="pb-2 text-right font-medium">Variance</th>}
                    <th className="pb-2 font-medium">Last sale</th>
                    <th className="pb-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.stations.map((row) => {
                    const change = formatPct(row.delta_pct)
                    const { favorable } = trendFromPct(row.delta_pct)
                    return (
                      <tr key={row.station_id} className="border-b border-slate-800/80 hover:bg-slate-900/40">
                        <td className="py-2.5 text-slate-500">{row.rank}</td>
                        <td className="py-2.5">
                          <Link to={`/stations/${row.station_id}`} className="text-white hover:underline">
                            {row.station_name}
                          </Link>
                        </td>
                        <td className="py-2.5 text-right font-mono text-emerald-300">{fmtNaira(num(row.amount))}</td>
                        <td className="py-2.5 text-right font-mono text-slate-200">{fmtLiters(num(row.volume))}</td>
                        <td className="py-2.5 text-right font-mono">{row.count}</td>
                        <td className="py-2.5 text-right font-mono">{fmtNaira(num(row.average_sale))}</td>
                        <td className={`py-2.5 text-right text-xs ${favorable == null ? 'text-slate-500' : favorable ? 'text-emerald-300' : 'text-red-300'}`}>
                          {change ? `${(num(row.delta_pct) || 0) > 0 ? '+' : ''}${change}` : '—'}
                        </td>
                        {canSeeRecon && (
                          <td className="py-2.5 text-right text-xs text-slate-300">
                            {row.variance_status === 'AWAITING' || row.variance_amount == null
                              ? 'Awaiting'
                              : `${row.variance_status === 'SHORT' ? 'Short' : row.variance_status === 'OVER' ? 'Over' : 'Balanced'} ${fmtNaira(num(row.variance_amount))}`}
                          </td>
                        )}
                        <td className="py-2.5 text-xs text-slate-400">{fmtTime(row.last_sale_at)}</td>
                        <td className="py-2.5 text-xs text-slate-300">{row.business_status}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <p className="sr-only">
              Leading station bar uses {fmtNaira(maxStation)} as the top of the sales scale.
            </p>
          </div>
        )}
      </DashboardPanel>

      {canSeeRecon && data?.reconciliation && (
        <DashboardPanel title="Reconciliation summary" action={{ to: '/reconciliations', label: 'Open reconciliation' }}>
          <div className="grid gap-3 sm:grid-cols-4">
            <MiniStat label="Status" value={data.reconciliation.label} />
            <MiniStat
              label="Reported collections"
              value={data.reconciliation.reported == null ? 'Awaiting reported sales' : fmtNaira(num(data.reconciliation.reported))}
            />
            <MiniStat label="Recorded pump sales" value={fmtNaira(num(data.reconciliation.pump_sales))} />
            <MiniStat
              label="Variance"
              value={
                data.reconciliation.variance == null
                  ? 'Awaiting reported sales'
                  : `${fmtNaira(num(data.reconciliation.variance))}${
                      data.reconciliation.variance_pct != null ? ` (${formatPct(data.reconciliation.variance_pct)})` : ''
                    }`
              }
            />
          </div>
          <p className="mt-3 text-xs text-slate-500">
            {data.reconciliation.awaiting_count} awaiting submission · {data.reconciliation.shortage_count} short ·{' '}
            {data.reconciliation.overage_count} over
          </p>
        </DashboardPanel>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
        <p title={data?.period.timezone_note}>
          {data?.activity.last_sale_at
            ? `Last sale received ${fmtTime(data.activity.last_sale_at)} · ${fmtNaira(num(data.activity.sales_last_hour_amount))} in the last hour · ${data.activity.stations_recording_sales} stations currently recording sales`
            : data?.activity.empty_detail || 'No sales in the selected period'}
        </p>
        <p>{relativeTime(data?.generated_at)}</p>
      </div>
    </div>
  )
}

function KpiStrip({ data, canSeeRecon }: { data?: ExecutiveOverview; canSeeRecon: boolean }) {
  const k = data?.kpis
  const sixth = canSeeRecon
    ? {
        label: 'Sales variance',
        value:
          !k || k.variance.status === 'AWAITING' || k.variance.amount == null
            ? 'Awaiting reported sales'
            : fmtNaira(num(k.variance.amount)),
        hint: k?.variance.label,
        trend:
          k && k.variance.amount != null && k.variance.status !== 'AWAITING'
            ? {
                label: `${k.variance.label}${k.variance.pct != null ? ` · ${formatPct(k.variance.pct)}` : ''}`,
                direction:
                  k.variance.status === 'BALANCED' ? ('flat' as const) : ('down' as const),
              }
            : { label: k?.variance.label || 'Awaiting reported sales', direction: 'flat' as const },
      }
    : {
        label: 'Stations reporting sales',
        value: k ? `${k.stations_reporting.current} of ${k.variance.stations_total || k.stations_reporting.current}` : '—',
        hint: 'Stations with completed sales',
        trend: null,
      }
  return (
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-3 2xl:grid-cols-6">
      <ExecutiveKpiCard
        label="Total sales"
        value={fmtNaira(num(k?.revenue.current))}
        accent="neutral"
        trend={
          k
            ? {
                label: `${formatPct(k.revenue.delta_pct) || 'No comparison'}${
                  k.revenue.delta != null ? ` · ${fmtNaira(num(k.revenue.delta))}` : ''
                }`,
                direction: trendFromPct(k.revenue.delta_pct).direction,
              }
            : null
        }
      />
      <ExecutiveKpiCard
        label="Volume sold"
        value={fmtLiters(num(k?.volume.current))}
        accent="neutral"
        icon={<IconDroplet className="h-5 w-5" />}
        trend={
          k
            ? {
                label: `${formatPct(k.volume.delta_pct) || 'No comparison'}${
                  k.volume.delta != null ? ` · ${fmtLiters(num(k.volume.delta))}` : ''
                }`,
                direction: trendFromPct(k.volume.delta_pct).direction,
              }
            : null
        }
      />
      <ExecutiveKpiCard
        label="Transactions"
        value={String(k?.transactions.current ?? '—')}
        accent="neutral"
        icon={<IconReceipt className="h-5 w-5" />}
        trend={
          k
            ? {
                label: formatPct(k.transactions.delta_pct) || 'No comparison',
                direction: trendFromPct(k.transactions.delta_pct).direction,
              }
            : null
        }
      />
      <ExecutiveKpiCard
        label="Average sale"
        value={fmtNaira(num(k?.average_sale.current))}
        accent="neutral"
        icon={<IconTicket className="h-5 w-5" />}
        hint="Per completed sale"
        trend={
          k
            ? {
                label: formatPct(k.average_sale.delta_pct) || 'No comparison',
                direction: trendFromPct(k.average_sale.delta_pct).direction,
              }
            : null
        }
      />
      <ExecutiveKpiCard
        label="Sales performance"
        value={k?.performance_label || '—'}
        accent="neutral"
        icon={<IconChart className="h-5 w-5" />}
        trend={
          k
            ? {
                label: k.performance_label,
                direction: trendFromPct(k.performance_pct).direction,
              }
            : null
        }
      />
      <ExecutiveKpiCard
        label={sixth.label}
        value={sixth.value}
        accent="neutral"
        icon={<IconBuilding className="h-5 w-5" />}
        hint={sixth.hint}
        trend={sixth.trend}
      />
    </div>
  )
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: Array<{ id: string; name: string }>
}) {
  return (
    <label className="text-xs text-slate-400">
      {label}
      <select className="input mt-1 block min-w-[9.5rem] py-1.5 text-sm" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((opt) => (
          <option key={opt.id || 'all'} value={opt.id}>
            {opt.name}
          </option>
        ))}
      </select>
    </label>
  )
}

function Toggle({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-2.5 py-1 text-xs ${active ? 'bg-slate-800 text-white' : 'text-slate-400'}`}
    >
      {children}
    </button>
  )
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-sm font-medium text-white">{value}</div>
    </div>
  )
}
