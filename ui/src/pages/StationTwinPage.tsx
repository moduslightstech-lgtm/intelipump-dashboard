import { useEffect, useState, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { useAuth } from '../context/AuthContext'
import { getStationOverview, getStationPumps } from '../api/client'
import BabylonStationTwin from '../components/BabylonStationTwin'
import { SimState } from '../types/simulation'

interface TransactionItem {
    transactionId: string
    volumeLiters: number
    amount: number
    product: string
    timestamp: string
    pumpId: string
    nozzleId: string
    status: string
}

interface PumpState {
    id: string // UUID
    pumpId: string // External ID
    label: string
    status: string
    lastSeenAt?: string
    todayTransactionCount: number
    todayVolumeLiters: number
    todayRevenue: number
}

interface TankState {
    id: string
    label: string
    capacity: number
    measuredLiters: number | null // null if no physical probe
    estimatedLiters: number // Capacity - dispensed
    percent: number
}

const STATE_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
    ONLINE: { bg: 'bg-green-900/30', text: 'text-green-400', dot: 'bg-green-400' },
    OFFLINE: { bg: 'bg-red-900/30', text: 'text-red-400', dot: 'bg-red-400' },
    DEGRADED: { bg: 'bg-amber-900/30', text: 'text-amber-400', dot: 'bg-amber-400' },
}

export default function StationTwinPage() {
    const { stationId } = useParams<{ stationId: string }>()
    const navigate = useNavigate()
    const { user } = useAuth()
    const tenantId = user?.tenantId

    const [stationName, setStationName] = useState('')
    const [stationExternalId, setStationExternalId] = useState('')
    const [stationStatus, setStationStatus] = useState('ONLINE')
    const [stationLastSeen, setStationLastSeen] = useState<string | null>(null)
    const [activeAlertsCount, setActiveAlertsCount] = useState(0)

    const [todayTransactions, setTodayTransactions] = useState(0)
    const [todayVolume, setTodayVolume] = useState(0)
    const [todayRevenue, setTodayRevenue] = useState(0)
    const [avgSale, setAvgSale] = useState(0)
    const [avgVol, setAvgVol] = useState(0)

    const [pumps, setPumps] = useState<PumpState[]>([])
    const [tank, setTank] = useState<TankState>({
        id: 'T1',
        label: 'PMS Tank 1',
        capacity: 33000,
        measuredLiters: null,
        estimatedLiters: 33000,
        percent: 100
    })

    const [recentTx, setRecentTx] = useState<TransactionItem[]>([])
    const [loading, setLoading] = useState(true)
    const [connected, setConnected] = useState(false)
    const [reconnecting, setReconnecting] = useState(false)
    const [activePumpId, setActivePumpId] = useState<string | null>(null)

    const esRef = useRef<EventSource | null>(null)

    // Map external pump ID to Babylon visualizer pump IDs ("pump_1" or "pump_2")
    const mapPumpIdToSimId = (extId: string) => {
        if (extId.toLowerCase().includes('pump-02') || extId.includes('2')) return 'pump_2';
        return 'pump_1';
    }

    const loadSnapshot = async () => {
        if (!stationId) return
        try {
            const [ovRes, pumpsRes] = await Promise.all([
                getStationOverview(stationId),
                getStationPumps(stationId)
            ])

            const ov = ovRes.data
            setStationName(ov.name)
            setStationExternalId(ov.stationId)
            setStationStatus(ov.status)
            setStationLastSeen(ov.lastSeenAt)
            setTodayTransactions(ov.todayTransactionCount)
            setTodayVolume(ov.todayVolumeLiters)
            setTodayRevenue(ov.todayRevenue)
            setAvgSale(ov.averageTransactionAmount)
            setAvgVol(ov.averageLitersPerTransaction)
            setActiveAlertsCount(ov.activeAlertsCount)
            setRecentTx(ov.recentTransactions || [])

            const pumpList: PumpState[] = pumpsRes.data
            setPumps(pumpList)

            // Compute tank state: capacity defaults to 33000 L, estimated starts at 33000 minus total volume dispensed
            const dispensed = pumpList.reduce((acc, p) => acc + p.todayVolumeLiters, 0)
            setTank(prev => ({
                ...prev,
                estimatedLiters: Math.max(0, 33000 - dispensed),
                percent: Math.max(0, ((33000 - dispensed) / 33000) * 100)
            }))

            setLoading(false)
            setReconnecting(false)
        } catch (err) {
            console.error("Failed to load station snapshot", err)
            setLoading(false)
        }
    }

    const connectSSE = () => {
        if (!stationId) return
        if (esRef.current) {
            esRef.current.close()
        }

        const baseUrl = (import.meta as any).env?.VITE_API_BASE_URL || 'http://localhost:8080'
        const sseUrl = `${baseUrl}/api/stations/${stationId}/stream?tenantId=${tenantId}`
        
        console.log("Connecting to SSE stream:", sseUrl)
        const es = new EventSource(sseUrl)
        esRef.current = es

        es.onopen = () => {
            console.log("SSE Stream Connected")
            setConnected(true)
            setReconnecting(false)
            // Reload snapshot in case we missed events while offline
            loadSnapshot()
        }

        es.onerror = () => {
            console.warn("SSE Stream Disconnected. Retrying in 5 seconds...")
            setConnected(false)
            setReconnecting(true)
            es.close()
            setTimeout(connectSSE, 5000)
        }

        // Listen for new transactions
        es.addEventListener('transaction-completed', (e: any) => {
            try {
                const txData: TransactionItem = JSON.parse(e.data)
                console.log("SSE: transaction-completed received", txData)

                // Highlight pump briefly
                const simPumpId = mapPumpIdToSimId(txData.pumpId)
                setActivePumpId(simPumpId === 'pump_2' ? '2' : '1')
                setTimeout(() => setActivePumpId(null), 5000)

                // Prepend transaction to recent list
                setRecentTx(prev => [txData, ...prev.slice(0, 9)])

                // Update counters
                setTodayTransactions(prev => prev + 1)
                setTodayVolume(prev => prev + txData.volumeLiters)
                setTodayRevenue(prev => prev + txData.amount)

                // Update specific pump data in state
                setPumps(prev => prev.map(p => {
                    if (p.pumpId === txData.pumpId) {
                        return {
                            ...p,
                            todayTransactionCount: p.todayTransactionCount + 1,
                            todayVolumeLiters: p.todayVolumeLiters + txData.volumeLiters,
                            todayRevenue: p.todayRevenue + txData.amount
                        }
                    }
                    return p
                }))

                // Deplete estimated tank balance
                setTank(prev => {
                    const newEst = Math.max(0, prev.estimatedLiters - txData.volumeLiters)
                    return {
                        ...prev,
                        estimatedLiters: newEst,
                        percent: (newEst / prev.capacity) * 100
                    }
                })

                setStationLastSeen(new Date().toISOString())
            } catch (err) {
                console.error("Error handling transaction sse event", err)
            }
        })

        // Listen for pump status transitions
        es.addEventListener('pump-status', (e: any) => {
            try {
                const statusData = JSON.parse(e.data)
                console.log("SSE: pump-status received", statusData)
                
                setPumps(prev => prev.map(p => {
                    if (p.pumpId === statusData.pumpId) {
                        return {
                            ...p,
                            status: statusData.status
                        }
                    }
                    return p
                }))
            } catch (err) {
                console.error("Error handling pump status sse event", err)
            }
        })

        // Listen for tank probe readings
        es.addEventListener('tank-reading', (e: any) => {
            try {
                const readingData = JSON.parse(e.data)
                console.log("SSE: tank-reading received", readingData)
                setTank(prev => ({
                    ...prev,
                    measuredLiters: readingData.reportedLiters,
                    percent: (readingData.reportedLiters / prev.capacity) * 100
                }))
            } catch (err) {
                console.error("Error handling tank reading sse event", err)
            }
        })

        // Listen for heartbeats
        es.addEventListener('station-heartbeat', (e: any) => {
            try {
                const hb = JSON.parse(e.data)
                console.log("SSE: station-heartbeat received", hb)
                setStationStatus(hb.status)
                setStationLastSeen(hb.timestamp || new Date().toISOString())
            } catch (err) {
                console.error("Error handling heartbeat sse event", err)
            }
        })

        // Listen for new alerts
        es.addEventListener('alert-created', (e: any) => {
            try {
                console.log("SSE: alert-created received", e.data)
                setActiveAlertsCount(prev => prev + 1)
            } catch (err) {
                console.error("Error handling alert sse event", err)
            }
        })
    }

    useEffect(() => {
        if (!stationId) return
        setLoading(true)
        loadSnapshot().then(() => connectSSE())

        return () => {
            if (esRef.current) {
                esRef.current.close()
            }
        }
    }, [stationId, tenantId])

    const fmtNaira = (val: number) => {
        return new Intl.NumberFormat('en-NG', {
            style: 'currency',
            currency: 'NGN',
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        }).format(val);
    }

    if (loading) return <div className="p-6 text-slate-400">Connecting to station stream...</div>

    const stateStyle = STATE_COLORS[stationStatus] || STATE_COLORS.ONLINE

    // Build SimState payload for BabylonJS 3D visualizer
    const simPayload: SimState = {
        tank: {
            id: 'pms',
            label: tank.label,
            capacity: tank.capacity,
            currentLiters: tank.measuredLiters !== null ? tank.measuredLiters : tank.estimatedLiters,
            percent: tank.percent,
            startLiters: tank.capacity
        },
        pumps: [
            {
                id: 'pump_1',
                label: pumps.find(p => mapPumpIdToSimId(p.pumpId) === 'pump_1')?.label || 'Pump 1',
                transactions: pumps.find(p => mapPumpIdToSimId(p.pumpId) === 'pump_1')?.todayTransactionCount || 0,
                totalLiters: pumps.find(p => mapPumpIdToSimId(p.pumpId) === 'pump_1')?.todayVolumeLiters || 0,
                status: (pumps.find(p => mapPumpIdToSimId(p.pumpId) === 'pump_1')?.status === 'DISPENSING' ? 'DISPENSING' : 'IDLE') as 'IDLE' | 'DISPENSING',
                currentDispenseRate: 0
            },
            {
                id: 'pump_2',
                label: pumps.find(p => mapPumpIdToSimId(p.pumpId) === 'pump_2')?.label || 'Pump 2',
                transactions: pumps.find(p => mapPumpIdToSimId(p.pumpId) === 'pump_2')?.todayTransactionCount || 0,
                totalLiters: pumps.find(p => mapPumpIdToSimId(p.pumpId) === 'pump_2')?.todayVolumeLiters || 0,
                status: (pumps.find(p => mapPumpIdToSimId(p.pumpId) === 'pump_2')?.status === 'DISPENSING' ? 'DISPENSING' : 'IDLE') as 'IDLE' | 'DISPENSING',
                currentDispenseRate: 0
            }
        ]
    }

    const pumpChartData = simPayload.pumps.map((p) => ({
        name: p.label, liters: Number(p.totalLiters), txns: p.transactions
    }))

    return (
        <div className="p-6 space-y-6 bg-slate-950 min-h-screen text-slate-100">
            {/* Header */}
            <div className="flex items-start justify-between flex-wrap gap-3 border-b border-slate-900 pb-4">
                <div>
                    <div className="flex items-center gap-3 mb-2 flex-wrap">
                        <div className={`flex items-center gap-1.5 text-xs px-2.5 py-0.5 rounded-full font-bold border ${connected ? 'bg-green-950 text-green-400 border-green-500/20' : 'bg-red-950 text-red-400 border-red-500/20 animate-pulse'}`}>
                            <div className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-green-400' : 'bg-red-400'}`} />
                            {connected ? 'Live Stream Connected' : reconnecting ? 'Reconnecting...' : 'Delayed'}
                        </div>
                        <div className={`flex items-center gap-1.5 text-xs px-2.5 py-0.5 rounded-full font-bold border ${stateStyle.bg} ${stateStyle.text} border-slate-800`}>
                            <div className={`w-1.5 h-1.5 rounded-full ${stateStyle.dot}`} />
                            {stationStatus}
                        </div>
                    </div>
                    <h1 className="text-2xl font-bold text-white tracking-tight">{stationName}</h1>
                    <p className="text-slate-500 text-xs">External ID: <span className="font-mono text-slate-400 font-semibold">{stationExternalId}</span> • Last telemetry received: {stationLastSeen ? new Date(stationLastSeen).toLocaleTimeString() : 'Never'}</p>
                </div>
                <div className="flex gap-2">
                    <button onClick={() => navigate(`/stations/${stationId}/reconciliation`)} className="btn-secondary">
                        Reconciliation Reports
                    </button>
                </div>
            </div>

            {/* KPI Cards */}
            <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
                <div className="card p-4 bg-slate-900 border-slate-800">
                    <div className="text-xs text-slate-400 font-medium">Transactions Today</div>
                    <div className="text-2xl font-bold text-blue-400 mt-2">{todayTransactions}</div>
                </div>
                <div className="card p-4 bg-slate-900 border-slate-800">
                    <div className="text-xs text-slate-400 font-medium">Liters Today</div>
                    <div className="text-2xl font-bold text-indigo-400 mt-2">{todayVolume.toFixed(2)} L</div>
                </div>
                <div className="card p-4 bg-slate-900 border-slate-800">
                    <div className="text-xs text-slate-400 font-medium">Revenue Today</div>
                    <div className="text-2xl font-bold text-green-400 mt-2 truncate" title={fmtNaira(todayRevenue)}>{fmtNaira(todayRevenue)}</div>
                </div>
                <div className="card p-4 bg-slate-900 border-slate-800">
                    <div className="text-xs text-slate-400 font-medium">Average Sale</div>
                    <div className="text-2xl font-bold text-slate-200 mt-2 truncate" title={fmtNaira(avgSale)}>{fmtNaira(avgSale)}</div>
                </div>
                <div className="card p-4 bg-slate-900 border-slate-800">
                    <div className="text-xs text-slate-400 font-medium">Pumps Online</div>
                    <div className="text-2xl font-bold text-slate-200 mt-2">{pumps.filter(p => p.status !== 'OFFLINE').length} / {pumps.length}</div>
                </div>
                <div className="card p-4 bg-slate-900 border-slate-800">
                    <div className="text-xs text-slate-400 font-medium">Open Alerts</div>
                    <div className={`text-2xl font-bold mt-2 ${activeAlertsCount > 0 ? 'text-red-400' : 'text-green-400'}`}>{activeAlertsCount}</div>
                </div>
            </div>

            {/* 3D Digital Twin Visualizer */}
            <div className="mb-6">
                <BabylonStationTwin 
                    tenantId={tenantId} 
                    stationId={stationId} 
                    sim={simPayload}
                    onDispenseStateChange={(pumpId, active) => {
                        if (active) setActivePumpId(pumpId);
                        else setActivePumpId(null);
                    }}
                />
            </div>

            {/* Tank Section */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="card p-5 bg-slate-900 border-slate-800 space-y-4">
                    <div className="flex items-center justify-between">
                        <div>
                            <h3 className="font-bold text-lg text-white">Measured Tank Level</h3>
                            <span className="text-xs text-slate-500">Physical ATG Probe Telemetry</span>
                        </div>
                        <span className={`px-2 py-0.5 text-xs font-semibold rounded-full ${tank.measuredLiters !== null ? 'bg-green-950 text-green-400 border border-green-500/20' : 'bg-slate-950 text-slate-500'}`}>
                            {tank.measuredLiters !== null ? 'ATG Probe Online' : 'No ATG Probe'}
                        </span>
                    </div>

                    {tank.measuredLiters !== null ? (
                        <div className="space-y-4">
                            <div className="space-y-1.5">
                                <div className="flex justify-between text-xs">
                                    <span className="text-slate-400">Probe Level</span>
                                    <span className="text-white font-semibold">{tank.percent.toFixed(1)}%</span>
                                </div>
                                <div className="h-3 bg-slate-950 rounded-full overflow-hidden border border-slate-800">
                                    <div className="h-full rounded-full transition-all duration-500 bg-green-500"
                                        style={{ width: `${Math.min(tank.percent, 100)}%` }} />
                                </div>
                            </div>
                            <div className="p-3 bg-slate-950/60 border border-slate-800/80 rounded-lg text-center">
                                <span className="text-[10px] text-slate-500 uppercase font-bold tracking-wider block">Reported Liters</span>
                                <span className="text-xl font-bold font-mono text-white">{tank.measuredLiters.toLocaleString()} L</span>
                            </div>
                        </div>
                    ) : (
                        <div className="p-8 bg-slate-950/40 border border-slate-850 rounded-lg text-center text-sm text-slate-500 font-medium">
                            Tank probe not connected
                        </div>
                    )}
                </div>

                <div className="card p-5 bg-slate-900 border-slate-800 space-y-4">
                    <div>
                        <h3 className="font-bold text-lg text-white">Estimated Tank Balance</h3>
                        <span className="text-xs text-slate-500">Calculated from dispenser transaction depletion</span>
                    </div>
                    <div className="space-y-4">
                        <div className="space-y-1.5">
                            <div className="flex justify-between text-xs">
                                <span className="text-slate-400">Depletion Percentage</span>
                                <span className="text-white font-semibold">{((tank.estimatedLiters / tank.capacity) * 100).toFixed(1)}%</span>
                            </div>
                            <div className="h-3 bg-slate-950 rounded-full overflow-hidden border border-slate-800">
                                <div className="h-full rounded-full transition-all duration-500 bg-indigo-500"
                                    style={{ width: `${Math.min((tank.estimatedLiters / tank.capacity) * 100, 100)}%` }} />
                            </div>
                        </div>
                        <div className="p-3 bg-slate-950/60 border border-slate-800/80 rounded-lg text-center">
                            <span className="text-[10px] text-slate-500 uppercase font-bold tracking-wider block">Estimated balance</span>
                            <span className="text-xl font-bold font-mono text-indigo-400">{tank.estimatedLiters.toLocaleString(undefined, { maximumFractionDigits: 2 })} L</span>
                        </div>
                    </div>
                </div>
            </div>

            {/* Pumps Activity Grid & Live Feed */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div className="card p-5 bg-slate-900 border-slate-800 lg:col-span-2 space-y-4">
                    <h3 className="text-lg font-bold text-white">Dispenser Telemetry</h3>
                    <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm">
                            <thead>
                                <tr className="border-b border-slate-800 text-slate-400">
                                    <th className="pb-2">Pump</th>
                                    <th className="pb-2">Status</th>
                                    <th className="pb-2">Last Seen</th>
                                    <th className="pb-2 text-right">Transactions</th>
                                    <th className="pb-2 text-right">Volume</th>
                                    <th className="pb-2 text-right">Revenue</th>
                                </tr>
                            </thead>
                            <tbody>
                                {pumps.map(p => (
                                    <tr key={p.id} 
                                        className={`border-b border-slate-800/40 transition-colors ${activePumpId === (mapPumpIdToSimId(p.pumpId) === 'pump_1' ? '1' : '2') ? 'bg-blue-900/20 border-l-2 border-l-blue-500' : 'hover:bg-slate-800/20'}`}
                                    >
                                        <td className="py-3 font-semibold text-slate-300">{p.label} <span className="text-xs text-slate-500 font-mono">({p.pumpId})</span></td>
                                        <td className="py-3">
                                            <span className={`px-2 py-0.5 text-xs font-semibold rounded-full border ${
                                                p.status === 'DISPENSING' ? 'bg-blue-900/30 text-blue-400 border-blue-500/20 animate-pulse' :
                                                p.status === 'IDLE' || p.status === 'ONLINE' ? 'bg-green-900/30 text-green-400 border-green-500/20' :
                                                'bg-slate-950 text-slate-500 border-slate-800'
                                            }`}>
                                                {p.status}
                                            </span>
                                        </td>
                                        <td className="py-3 text-slate-400">
                                            {p.lastSeenAt ? new Date(p.lastSeenAt).toLocaleTimeString() : 'Never'}
                                        </td>
                                        <td className="py-3 text-right text-blue-400 font-bold">{p.todayTransactionCount}</td>
                                        <td className="py-3 text-right font-mono text-slate-300">{p.todayVolumeLiters.toFixed(2)} L</td>
                                        <td className="py-3 text-right font-mono text-green-400 font-semibold">{fmtNaira(p.todayRevenue)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>

                <div className="card p-5 bg-slate-900 border-slate-800 space-y-4">
                    <h3 className="text-lg font-bold text-white flex items-center justify-between">
                        Live Transactions
                        <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                    </h3>
                    <div className="space-y-3 h-[240px] overflow-y-auto pr-1">
                        {recentTx.length === 0 ? (
                            <div className="text-center py-16 text-slate-500 text-sm">Waiting for transactions...</div>
                        ) : (
                            recentTx.map(tx => (
                                <div key={tx.transactionId} className="p-3 bg-slate-950/60 border border-slate-850/80 rounded-lg flex items-center justify-between hover:border-slate-700 transition-colors animate-fadeIn">
                                    <div className="min-w-0">
                                        <span className="font-mono text-xs text-white block truncate font-bold">{tx.transactionId}</span>
                                        <span className="text-[10px] text-slate-500 font-mono block mt-0.5">{tx.pumpId} • {tx.product} • {new Date(tx.timestamp).toLocaleTimeString()}</span>
                                    </div>
                                    <div className="text-right flex-shrink-0">
                                        <span className="font-mono text-green-400 text-sm font-semibold block">{fmtNaira(tx.amount)}</span>
                                        <span className="text-slate-400 font-mono text-xs block">{tx.volumeLiters.toFixed(2)} L</span>
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </div>
            </div>
        </div>
    )
}
