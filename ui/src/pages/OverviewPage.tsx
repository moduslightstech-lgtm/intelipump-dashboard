import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
    LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
    ResponsiveContainer, Legend
} from 'recharts'
import { getDashboardOverview, getStations } from '../api/client'

interface OverviewData {
    totalStations: number
    stationsReportingToday: number
    totalLitersToday: number
    totalRevenueToday: number
    totalVariance7Days: number
    openAlerts: number
    topStationsByVariance: Array<{ stationId: string; totalVariance: number }>
    revenueTrend7Days: Array<{ date: string; revenue: number }>
}

interface Station { id: string; name: string }

const fmt = (n: number) =>
    n >= 1_000_000 ? `₦${(n / 1_000_000).toFixed(2)}M`
        : n >= 1_000 ? `₦${(n / 1_000).toFixed(1)}K`
            : `₦${n.toFixed(0)}`

const StatusBadge = ({ status }: { status: string }) => {
    const cls = { OK: 'badge-ok', WARN: 'badge-warn', CRITICAL: 'badge-critical' }[status] ?? 'badge-info'
    return <span className={cls}>{status}</span>
}

export default function OverviewPage() {
    const navigate = useNavigate()
    const [data, setData] = useState<OverviewData | null>(null)
    const [stations, setStations] = useState<Station[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState('')

    useEffect(() => {
        Promise.all([getDashboardOverview(), getStations()])
            .then(([ov, st]) => {
                setData(ov.data)
                setStations(st.data)
            })
            .catch(() => setError('Failed to load dashboard data. Ensure the API is running and seed data is loaded.'))
            .finally(() => setLoading(false))
    }, [])

    const stationName = (id: string) => stations.find(s => s.id === id)?.name ?? id.slice(0, 8)

    if (loading) return <div className="flex items-center justify-center h-full text-slate-400">Loading…</div>
    if (error) return (
        <div className="p-8">
            <div className="card border-red-900/40 bg-red-900/10">
                <p className="text-red-400 text-sm">{error}</p>
            </div>
        </div>
    )

    const d = data!
    const coveragePct = d.totalStations > 0 ? Math.round((d.stationsReportingToday / d.totalStations) * 100) : 0
    const varianceColor = d.totalVariance7Days < 0 ? 'text-red-400' : d.totalVariance7Days > 0 ? 'text-amber-400' : 'text-green-400'

    const chartData = d.revenueTrend7Days.map(r => ({
        date: new Date(r.date).toLocaleDateString('en', { weekday: 'short', day: 'numeric' }),
        revenue: Number(r.revenue),
    }))

    return (
        <div className="p-6 space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-white">Executive Overview</h1>
                    <p className="text-slate-400 text-sm mt-0.5">Real-time fuel retail intelligence across all stations</p>
                </div>
                <div className="text-right">
                    <div className="text-xs text-slate-400">Last updated</div>
                    <div className="text-sm text-white">{new Date().toLocaleTimeString()}</div>
                </div>
            </div>

            {/* KPI cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="stat-card">
                    <div className="label-text">Liters Today</div>
                    <div className="value-text text-blue-400">{Number(d.totalLitersToday).toLocaleString('en', { maximumFractionDigits: 0 })}L</div>
                    <div className="text-xs text-slate-500">All stations combined</div>
                </div>
                <div className="stat-card">
                    <div className="label-text">Revenue Today</div>
                    <div className="value-text text-green-400">{fmt(Number(d.totalRevenueToday))}</div>
                    <div className="text-xs text-slate-500">Expected (dispense)</div>
                </div>
                <div className="stat-card">
                    <div className="label-text">7-Day Variance</div>
                    <div className={`value-text ${varianceColor}`}>{fmt(Math.abs(Number(d.totalVariance7Days)))}</div>
                    <div className="text-xs text-slate-500">{Number(d.totalVariance7Days) < 0 ? 'Deficit' : 'Surplus'}</div>
                </div>
                <div className="stat-card">
                    <div className="label-text">Open Alerts</div>
                    <div className={`value-text ${d.openAlerts > 0 ? 'text-red-400' : 'text-green-400'}`}>{d.openAlerts}</div>
                    <button onClick={() => navigate('/alerts')} className="text-xs text-blue-400 hover:underline text-left">View alerts →</button>
                </div>
            </div>

            {/* Coverage + Revenue trend */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                {/* Coverage */}
                <div className="card">
                    <h2 className="font-semibold text-white mb-4">Station Coverage Today</h2>
                    <div className="flex items-center justify-center">
                        <div className="relative w-32 h-32">
                            <svg viewBox="0 0 36 36" className="w-32 h-32 -rotate-90">
                                <circle cx="18" cy="18" r="15.9" fill="none" stroke="#1e293b" strokeWidth="3.5" />
                                <circle cx="18" cy="18" r="15.9" fill="none" stroke="#3b5bdb" strokeWidth="3.5"
                                    strokeDasharray={`${coveragePct} ${100 - coveragePct}`}
                                    strokeLinecap="round" className="ring-fill" />
                            </svg>
                            <div className="absolute inset-0 flex flex-col items-center justify-center">
                                <span className="text-2xl font-bold text-white">{coveragePct}%</span>
                                <span className="text-xs text-slate-400">{d.stationsReportingToday}/{d.totalStations}</span>
                            </div>
                        </div>
                    </div>
                    <div className="mt-4 space-y-2">
                        {stations.map(s => (
                            <div key={s.id} className="flex items-center justify-between text-sm">
                                <span className="text-slate-300 truncate">{s.name}</span>
                                <button onClick={() => navigate(`/stations/${s.id}/twin`)}
                                    className="text-xs text-blue-400 hover:underline">Twin →</button>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Revenue trend */}
                <div className="card lg:col-span-2">
                    <h2 className="font-semibold text-white mb-4">Revenue Trend — Last 7 Days</h2>
                    <ResponsiveContainer width="100%" height={200}>
                        <LineChart data={chartData}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                            <XAxis dataKey="date" tick={{ fill: '#94a3b8', fontSize: 11 }} />
                            <YAxis tick={{ fill: '#94a3b8', fontSize: 11 }}
                                tickFormatter={v => `₦${(v / 1000).toFixed(0)}K`} />
                            <Tooltip
                                contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, color: '#e2e8f0' }}
                                formatter={(v: number) => [fmt(v), 'Expected Revenue']} />
                            <Line type="monotone" dataKey="revenue" stroke="#3b5bdb" strokeWidth={2.5}
                                dot={{ fill: '#3b5bdb', strokeWidth: 0, r: 3 }} activeDot={{ r: 5 }} />
                        </LineChart>
                    </ResponsiveContainer>
                </div>
            </div>

            {/* Top variance stations */}
            <div className="card">
                <h2 className="font-semibold text-white mb-4">Top Stations by Variance (7-Day)</h2>
                {d.topStationsByVariance.length === 0 ? (
                    <p className="text-slate-400 text-sm">No variance data yet — run reconciliation first.</p>
                ) : (
                    <table className="w-full">
                        <thead>
                            <tr className="border-b border-slate-700">
                                <th className="table-header text-left">Station</th>
                                <th className="table-header text-right">Total Variance (abs)</th>
                                <th className="table-header text-right">Action</th>
                            </tr>
                        </thead>
                        <tbody>
                            {d.topStationsByVariance.map((row, i) => (
                                <tr key={i} className="border-b border-slate-700/50 hover:bg-slate-700/20 transition-colors">
                                    <td className="table-cell">{stationName(row.stationId)}</td>
                                    <td className="table-cell text-right">
                                        <span className={Number(row.totalVariance) > 50000 ? 'text-red-400 font-semibold' : 'text-amber-400'}>
                                            {fmt(Number(row.totalVariance))}
                                        </span>
                                    </td>
                                    <td className="table-cell text-right">
                                        <button onClick={() => navigate(`/stations/${row.stationId}/reconciliation`)}
                                            className="text-xs text-blue-400 hover:underline">Drilldown →</button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    )
}
