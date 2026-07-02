import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
    BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
    ResponsiveContainer, Cell
} from 'recharts'
import { getReconciliation, createAdjustment, getStations } from '../api/client'

interface ReconResult {
    id: string; windowFrom: string; windowTo: string; granularity: string
    expectedRevenue: number; totalReceived: number; variance: number; variancePercent: number
    receivedCash: number; receivedPos: number; receivedTransfer: number
    pumpLiters: number; status: string; computedAt: string
}
interface Transaction { id: string; eventTime: string; data: { liters?: number; unitPrice?: number; totalAmount?: number; nozzleId?: string } }
interface Payment { id: string; paymentType: string; amount: number; eventTime: string; reference: string }

const fmt = (n: number) => `₦${Number(n).toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const StatusBadge = ({ s }: { s: string }) => (
    <span className={s === 'OK' ? 'badge-ok' : s === 'WARN' ? 'badge-warn' : 'badge-critical'}>{s}</span>
)

export default function ReconciliationPage() {
    const { stationId } = useParams<{ stationId: string }>()
    const navigate = useNavigate()
    const [results, setResults] = useState<ReconResult[]>([])
    const [transactions, setTransactions] = useState<Transaction[]>([])
    const [payments, setPayments] = useState<Payment[]>([])
    const [loading, setLoading] = useState(true)
    const [stationName, setStationName] = useState('')
    const [showAdj, setShowAdj] = useState(false)
    const [adjForm, setAdjForm] = useState({ reason: '', windowFrom: '', windowTo: '', amountAdjustment: '' })
    const [adjStatus, setAdjStatus] = useState('')

    useEffect(() => {
        if (!stationId) return
        Promise.all([getReconciliation(stationId), getStations()])
            .then(([r, s]) => {
                setResults(r.data.results || [])
                setTransactions(r.data.transactions || [])
                setPayments(r.data.payments || [])
                const st = s.data.find((x: any) => x.id === stationId)
                setStationName(st?.name ?? 'Station')
            })
            .finally(() => setLoading(false))
    }, [stationId])

    const submitAdj = async () => {
        if (!adjForm.reason || !adjForm.windowFrom || !adjForm.windowTo) {
            setAdjStatus('Please fill in all required fields'); return
        }
        try {
            await createAdjustment(stationId!, {
                reason: adjForm.reason,
                windowFrom: new Date(adjForm.windowFrom).toISOString(),
                windowTo: new Date(adjForm.windowTo).toISOString(),
                amountAdjustment: Number(adjForm.amountAdjustment) || 0,
            })
            setAdjStatus('✓ Adjustment saved. Reconciliation re-computed.')
            setShowAdj(false)
            const r = await getReconciliation(stationId!)
            setResults(r.data.results || [])
        } catch { setAdjStatus('Failed to save adjustment') }
    }

    const chartData = results.slice().reverse().map(r => ({
        date: new Date(r.windowFrom).toLocaleDateString('en', { weekday: 'short', day: 'numeric' }),
        expected: Number(r.expectedRevenue),
        received: Number(r.totalReceived),
        variance: Math.abs(Number(r.variance)),
        status: r.status,
    }))

    const barColor = (status: string) => status === 'OK' ? '#22c55e' : status === 'WARN' ? '#f59e0b' : '#ef4444'

    if (loading) return <div className="flex items-center justify-center h-full text-slate-400">Loading reconciliation…</div>

    return (
        <div className="p-6 space-y-6">
            <div className="flex items-start justify-between flex-wrap gap-3">
                <div>
                    <h1 className="text-2xl font-bold text-white">Reconciliation</h1>
                    <p className="text-slate-400 text-sm">{stationName} — last 7 days</p>
                </div>
                <div className="flex gap-2">
                    <button onClick={() => navigate(`/stations/${stationId}/twin`)} className="btn-secondary">← Twin</button>
                    <button onClick={() => setShowAdj(!showAdj)} className="btn-primary">+ Adjustment</button>
                </div>
            </div>

            {/* Adjustment form */}
            {showAdj && (
                <div className="card border-blue-700/50 bg-blue-900/10">
                    <h3 className="font-semibold text-white mb-4">Add Manual Adjustment</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="md:col-span-2">
                            <label className="label-text block mb-1">Reason *</label>
                            <input className="input" placeholder="e.g., POS terminal batch delay confirmed by bank" value={adjForm.reason}
                                onChange={e => setAdjForm(f => ({ ...f, reason: e.target.value }))} />
                        </div>
                        <div>
                            <label className="label-text block mb-1">Window From *</label>
                            <input className="input" type="datetime-local" value={adjForm.windowFrom}
                                onChange={e => setAdjForm(f => ({ ...f, windowFrom: e.target.value }))} />
                        </div>
                        <div>
                            <label className="label-text block mb-1">Window To *</label>
                            <input className="input" type="datetime-local" value={adjForm.windowTo}
                                onChange={e => setAdjForm(f => ({ ...f, windowTo: e.target.value }))} />
                        </div>
                        <div>
                            <label className="label-text block mb-1">Amount Adjustment (₦)</label>
                            <input className="input" type="number" placeholder="e.g., 25000" value={adjForm.amountAdjustment}
                                onChange={e => setAdjForm(f => ({ ...f, amountAdjustment: e.target.value }))} />
                        </div>
                    </div>
                    <div className="flex gap-2 mt-4">
                        <button onClick={submitAdj} className="btn-primary">Save Adjustment</button>
                        <button onClick={() => setShowAdj(false)} className="btn-secondary">Cancel</button>
                    </div>
                    {adjStatus && <p className={`text-sm mt-2 ${adjStatus.startsWith('✓') ? 'text-green-400' : 'text-red-400'}`}>{adjStatus}</p>}
                </div>
            )}

            {/* Chart */}
            <div className="card">
                <h2 className="section-title mb-4">Expected vs Received — 7 Days</h2>
                <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={chartData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                        <XAxis dataKey="date" tick={{ fill: '#94a3b8', fontSize: 11 }} />
                        <YAxis tick={{ fill: '#94a3b8', fontSize: 11 }} tickFormatter={v => `₦${(v / 1000).toFixed(0)}K`} />
                        <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8 }}
                            formatter={(v: number, n: string) => [`₦${Number(v).toLocaleString()}`, n]} />
                        <Bar dataKey="expected" fill="#475569" radius={[2, 2, 0, 0]} name="Expected" />
                        <Bar dataKey="received" radius={[2, 2, 0, 0]} name="Received">
                            {chartData.map((d, i) => <Cell key={i} fill={barColor(d.status)} />)}
                        </Bar>
                    </BarChart>
                </ResponsiveContainer>
            </div>

            {/* Results table */}
            <div className="card">
                <h2 className="section-title mb-4">Daily Results</h2>
                {results.length === 0 ? (
                    <p className="text-slate-400 text-sm">No reconciliation results yet. Run reconciliation from the sidebar.</p>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-slate-700">
                                    <th className="table-header">Date</th>
                                    <th className="table-header text-right">Expected</th>
                                    <th className="table-header text-right">Cash</th>
                                    <th className="table-header text-right">POS</th>
                                    <th className="table-header text-right">Transfer</th>
                                    <th className="table-header text-right">Variance</th>
                                    <th className="table-header text-right">Var%</th>
                                    <th className="table-header text-center">Status</th>
                                </tr>
                            </thead>
                            <tbody>
                                {results.map(r => {
                                    const varN = Number(r.variance)
                                    const varColor = varN >= 0 ? 'text-green-400' : 'text-red-400'
                                    return (
                                        <tr key={r.id} className="border-b border-slate-700/50 hover:bg-slate-700/20">
                                            <td className="table-cell">{new Date(r.windowFrom).toLocaleDateString()}</td>
                                            <td className="table-cell text-right font-medium">{fmt(r.expectedRevenue)}</td>
                                            <td className="table-cell text-right text-slate-300">{fmt(r.receivedCash)}</td>
                                            <td className="table-cell text-right text-slate-300">{fmt(r.receivedPos)}</td>
                                            <td className="table-cell text-right text-slate-300">{fmt(r.receivedTransfer)}</td>
                                            <td className={`table-cell text-right font-semibold ${varColor}`}>{fmt(varN)}</td>
                                            <td className={`table-cell text-right text-xs ${varColor}`}>{Number(r.variancePercent).toFixed(2)}%</td>
                                            <td className="table-cell text-center"><StatusBadge s={r.status} /></td>
                                        </tr>
                                    )
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* Evidence */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="card">
                    <h2 className="font-semibold text-white mb-3">Recent Transactions ({transactions.length})</h2>
                    <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                        {transactions.slice(0, 50).map(t => (
                            <div key={t.id} className="flex items-center justify-between bg-slate-700/30 rounded-lg px-3 py-2">
                                <div>
                                    <div className="text-xs text-slate-400">{new Date(t.eventTime).toLocaleString()}</div>
                                    <div className="text-sm">{Number(t.data.liters ?? 0).toFixed(1)}L @ ₦{t.data.unitPrice}</div>
                                </div>
                                <div className="text-sm font-semibold text-green-400">
                                    ₦{Number(t.data.totalAmount ?? 0).toLocaleString()}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                <div className="card">
                    <h2 className="font-semibold text-white mb-3">Payment Events ({payments.length})</h2>
                    <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                        {payments.slice(0, 50).map(p => (
                            <div key={p.id} className="flex items-center justify-between bg-slate-700/30 rounded-lg px-3 py-2">
                                <div>
                                    <div className="text-xs text-slate-400">{new Date(p.eventTime).toLocaleString()}</div>
                                    <span className={`text-xs px-2 py-0.5 rounded-full font-semibold
                    ${p.paymentType === 'CASH' ? 'bg-green-900/50 text-green-400'
                                            : p.paymentType === 'POS' ? 'bg-blue-900/50 text-blue-400'
                                                : 'bg-purple-900/50 text-purple-400'}`}>
                                        {p.paymentType}
                                    </span>
                                </div>
                                <div className="text-sm font-semibold">₦{Number(p.amount).toLocaleString()}</div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    )
}
