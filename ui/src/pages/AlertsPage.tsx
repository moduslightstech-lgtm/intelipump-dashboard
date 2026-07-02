import { useEffect, useState } from 'react'
import { getAlerts, getAlertSummary, acknowledgeAlert, resolveAlert, getStations } from '../api/client'

interface AlertItem {
    id: string; alertType: string; severity: string; status: string
    title: string; details: Record<string, unknown>; triggeredAt: string
    stationId: string; acknowledgedAt?: string; resolvedAt?: string
}

const SeverityBadge = ({ s }: { s: string }) => (
    <span className={s === 'CRITICAL' ? 'badge-critical' : s === 'WARN' ? 'badge-warn' : 'badge-info'}>{s}</span>
)
const StatusBadge = ({ s }: { s: string }) => (
    <span className={s === 'OPEN' ? 'badge-open' : s === 'ACKNOWLEDGED' ? 'badge-warn' : 'badge-ok'}>{s}</span>
)
const TypeBadge = ({ t }: { t: string }) => (
    <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${t === 'VARIANCE' ? 'bg-red-900/30 text-red-300' : t === 'DATA_GAP' ? 'bg-yellow-900/30 text-yellow-300' : 'bg-slate-700 text-slate-300'}`}>{t}</span>
)

export default function AlertsPage() {
    const [alerts, setAlerts] = useState<AlertItem[]>([])
    const [summary, setSummary] = useState<any>(null)
    const [stations, setStations] = useState<{ id: string; name: string }[]>([])
    const [filter, setFilter] = useState({ status: '', type: '' })
    const [loading, setLoading] = useState(true)

    const load = () => {
        Promise.all([
            getAlerts(filter.status || undefined, filter.type || undefined),
            getAlertSummary(),
            getStations(),
        ]).then(([a, s, st]) => {
            setAlerts(a.data); setSummary(s.data); setStations(st.data)
        }).finally(() => setLoading(false))
    }

    useEffect(() => { setLoading(true); load() }, [filter])

    const stationName = (id: string) => stations.find(s => s.id === id)?.name ?? id.slice(0, 8)

    const doAck = async (id: string) => {
        await acknowledgeAlert(id); load()
    }
    const doResolve = async (id: string) => {
        await resolveAlert(id); load()
    }

    if (loading) return <div className="flex items-center justify-center h-full text-slate-400">Loading alerts…</div>

    return (
        <div className="p-6 space-y-6">
            {/* Header */}
            <div>
                <h1 className="text-2xl font-bold text-white">Alerts</h1>
                <p className="text-slate-400 text-sm">Variance and data gap exceptions requiring attention</p>
            </div>

            {/* Summary ribbon */}
            {summary && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <div className="card py-3">
                        <div className="label-text">Open</div>
                        <div className={`text-2xl font-bold ${summary.open > 0 ? 'text-red-400' : 'text-green-400'}`}>{summary.open}</div>
                    </div>
                    <div className="card py-3">
                        <div className="label-text">Acknowledged</div>
                        <div className="text-2xl font-bold text-amber-400">{summary.acknowledged}</div>
                    </div>
                    <div className="card py-3">
                        <div className="label-text">Variance Alerts</div>
                        <div className="text-2xl font-bold text-red-400">{summary.byType?.VARIANCE ?? 0}</div>
                    </div>
                    <div className="card py-3">
                        <div className="label-text">Data Gap Alerts</div>
                        <div className="text-2xl font-bold text-amber-400">{summary.byType?.DATA_GAP ?? 0}</div>
                    </div>
                </div>
            )}

            {/* Filters */}
            <div className="flex gap-3 flex-wrap">
                <select className="input w-40" value={filter.status} onChange={e => setFilter(f => ({ ...f, status: e.target.value }))}>
                    <option value="">All Statuses</option>
                    <option value="OPEN">Open</option>
                    <option value="ACKNOWLEDGED">Acknowledged</option>
                    <option value="RESOLVED">Resolved</option>
                </select>
                <select className="input w-40" value={filter.type} onChange={e => setFilter(f => ({ ...f, type: e.target.value }))}>
                    <option value="">All Types</option>
                    <option value="VARIANCE">Variance</option>
                    <option value="DATA_GAP">Data Gap</option>
                </select>
                <button onClick={load} className="btn-secondary">Refresh</button>
            </div>

            {/* Alert list */}
            <div className="space-y-3">
                {alerts.length === 0 && (
                    <div className="card text-center py-12">
                        <div className="text-4xl mb-3">✅</div>
                        <p className="text-white font-semibold">No alerts match this filter</p>
                        <p className="text-slate-400 text-sm mt-1">All clear — or try a different filter.</p>
                    </div>
                )}
                {alerts.map(alert => (
                    <div key={alert.id} className={`card transition-all ${alert.status === 'OPEN' && alert.severity === 'CRITICAL' ? 'border-red-700/60 bg-red-900/5' : alert.status === 'OPEN' ? 'border-amber-700/40 bg-amber-900/5' : ''}`}>
                        <div className="flex items-start justify-between gap-4">
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap mb-1">
                                    <TypeBadge t={alert.alertType} />
                                    <SeverityBadge s={alert.severity} />
                                    <StatusBadge s={alert.status} />
                                </div>
                                <h3 className="font-semibold text-white mt-2">{alert.title}</h3>
                                <div className="text-xs text-slate-400 mt-1 flex flex-wrap gap-3">
                                    <span>Station: <span className="text-slate-300">{stationName(alert.stationId)}</span></span>
                                    <span>Triggered: <span className="text-slate-300">{new Date(alert.triggeredAt).toLocaleString()}</span></span>
                                    {alert.acknowledgedAt && <span>Acked: <span className="text-slate-300">{new Date(alert.acknowledgedAt).toLocaleString()}</span></span>}
                                </div>
                                {/* Details */}
                                <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-2">
                                    {Object.entries(alert.details).slice(0, 6).map(([k, v]) => (
                                        <div key={k} className="bg-slate-700/30 rounded-lg px-2 py-1.5">
                                            <div className="text-xs text-slate-400 capitalize">{k.replace(/([A-Z])/g, ' $1').trim()}</div>
                                            <div className="text-xs text-slate-200 font-medium truncate">
                                                {typeof v === 'number' ? `₦${Number(v).toLocaleString()}` : String(v)}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                            {/* Actions */}
                            <div className="flex flex-col gap-2 flex-shrink-0">
                                {alert.status === 'OPEN' && (
                                    <button onClick={() => doAck(alert.id)} className="btn-secondary text-xs py-1.5 px-3">Acknowledge</button>
                                )}
                                {alert.status !== 'RESOLVED' && (
                                    <button onClick={() => doResolve(alert.id)} className="btn-secondary text-xs py-1.5 px-3 text-green-400">Resolve</button>
                                )}
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    )
}
