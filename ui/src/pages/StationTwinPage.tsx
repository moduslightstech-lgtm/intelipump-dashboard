import { useEffect, useState, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { useAuth } from '../context/AuthContext'
import { getStations } from '../api/client'
import BabylonStationTwin from '../components/BabylonStationTwin'
import { SimState } from '../types/simulation'

interface TankState {
    label: string; productId: string; capacityLiters: number
    reportedLiters: number; expectedLiters: number
    deltaLiters: number; deltaPercent: number; fillPercent: number
}
interface PumpState {
    label: string; active: boolean; transactionCount: number; totalLiters: number
    nozzleCount: number; lastNozzleId?: string
}
interface TwinData {
    stationId: string; stationName: string; snapshotTime: string
    state: string
    tankStates: Record<string, TankState>
    pumpStates: Record<string, PumpState>
    lastDispenseAt?: string; lastTankReadingAt?: string; lastPaymentAt?: string
}

const STATE_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
    ONLINE: { bg: 'bg-green-900/30', text: 'text-green-400', dot: 'bg-green-400' },
    DEGRADED: { bg: 'bg-amber-900/30', text: 'text-amber-400', dot: 'bg-amber-400' },
    DATA_GAP: { bg: 'bg-slate-700/50', text: 'text-slate-400', dot: 'bg-slate-400' },
    RECONCILING: { bg: 'bg-blue-900/30', text: 'text-blue-400', dot: 'bg-blue-400' },
    ALERTING: { bg: 'bg-red-900/30', text: 'text-red-400', dot: 'bg-red-400' },
}

const fresh = (t?: string, isStaleWarning: boolean = false) => {
    if (!t) return { label: 'Never', cls: 'text-slate-500', stale: true }
    const secs = Math.floor((Date.now() - new Date(t).getTime()) / 1000)
    if (secs < 30 && isStaleWarning) return { label: 'Just now', cls: 'text-green-400', stale: false }
    if (secs >= 30 && isStaleWarning) return { label: `${secs}s ago`, cls: 'text-amber-400', stale: true }
    
    // Normal format
    const mins = Math.floor(secs / 60)
    if (mins < 2) return { label: 'Just now', cls: 'text-green-400', stale: false }
    if (mins < 60) return { label: `${mins}m ago`, cls: 'text-green-400', stale: false }
    return { label: `${Math.floor(mins / 60)}h ago`, cls: 'text-red-400', stale: true }
}

export default function StationTwinPage() {
    const { stationId } = useParams<{ stationId: string }>()
    const navigate = useNavigate()
    const { user } = useAuth()
    const tenantId = user?.tenantId
    const [twin, setTwin] = useState<TwinData | null>(null)
    const [loading, setLoading] = useState(true)
    const [connected, setConnected] = useState(false)
    const [activePumpId, setActivePumpId] = useState<string | null>(null)
    const [stationName, setStationName] = useState('')
    
    // --- Simulation State ---
    const [sim, setSim] = useState<SimState>({
        tank: { 
            id: 'pms', 
            label: 'Tank 1 (PMS)', 
            capacity: 33000, 
            currentLiters: 28450.5, 
            percent: 86.2,
            startLiters: 28450.5
        },
        pumps: [
            { id: 'pump_1', label: 'Pump 1', transactions: 14, totalLiters: 1240.2, status: 'IDLE', currentDispenseRate: 0 },
            { id: 'pump_2', label: 'Pump 2', transactions: 9, totalLiters: 850.8, status: 'IDLE', currentDispenseRate: 0 }
        ]
    });

    const esRef = useRef<EventSource | null>(null)

    // --- Simulation Loop ---
    useEffect(() => {
        const interval = setInterval(() => {
            setSim(prev => {
                const newSim = { ...prev };
                const dispensingPump = newSim.pumps.find(p => p.status === 'DISPENSING');

                if (dispensingPump) {
                    // Update current dispense
                    const dispenseAmount = 0.5 + Math.random() * 0.5; // Liters per tick
                    dispensingPump.totalLiters += dispenseAmount;
                    newSim.tank.currentLiters -= dispenseAmount;
                    newSim.tank.percent = (newSim.tank.currentLiters / newSim.tank.capacity) * 100;

                    // Randomly stop dispensing
                    if (Math.random() > 0.95) {
                        console.log(`Simulation: ${dispensingPump.label} finished dispensing.`);
                        dispensingPump.status = 'IDLE';
                        dispensingPump.transactions += 1;
                        setActivePumpId(null);
                    }
                } else {
                    // Randomly start dispensing on a pump
                    if (Math.random() > 0.90) {
                        const pumpIndex = Math.floor(Math.random() * newSim.pumps.length);
                        const selectedPump = newSim.pumps[pumpIndex];
                        console.log(`Simulation: ${selectedPump.label} started dispensing...`);
                        selectedPump.status = 'DISPENSING';
                        setActivePumpId(selectedPump.id === 'pump_1' ? '1' : '2'); // Mapping to Babylon IDs
                    }
                }
                return { ...newSim };
            });
        }, 1000);

        return () => clearInterval(interval);
    }, []);

    useEffect(() => {
        if (!stationId) return

        // Load station name
        getStations().then(r => {
            const st = r.data.find((s: any) => s.id === stationId)
            if (st) setStationName(st.name)
        })

        setLoading(false); // Skip SSE loading for local simulation
        setConnected(true);
    }, [stationId, tenantId])

    if (loading) return (
        <div className="flex items-center justify-center h-full">
            <div className="text-center space-y-3">
                <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto" />
                <p className="text-slate-400 text-sm">Connecting to live twin…</p>
            </div>
        </div>
    )


    const stateStyle = STATE_COLORS.ONLINE

    const pumpChartData = sim.pumps.map((p) => ({
        name: p.label, liters: Number(p.totalLiters), txns: p.transactions
    }))

    return (
        <div className="p-6 space-y-5">
            {/* Header */}
            <div className="flex items-start justify-between flex-wrap gap-3">
                <div>
                    <div className="flex items-center gap-3 mb-1 flex-wrap">
                        <div className={`flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full ${connected ? 'bg-green-900/30 text-green-400' : 'bg-slate-700 text-slate-400'}`}>
                            <div className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-green-400 animate-pulse' : 'bg-slate-500'}`} />
                            {connected ? 'Live' : 'Reconnecting…'}
                        </div>
                        <div className={`flex items-center gap-1.5 text-xs px-2.5 py-0.5 rounded-full font-semibold ${stateStyle.bg} ${stateStyle.text}`}>
                            <div className={`w-1.5 h-1.5 rounded-full ${stateStyle.dot}`} />
                            ONLINE
                        </div>
                    </div>
                    <h1 className="text-2xl font-bold text-white">{stationName || 'Fuel Station'}</h1>
                    <p className="text-slate-400 text-sm">Digital Twin — live SSE feed</p>
                </div>
                <button onClick={() => navigate(`/stations/${stationId}/reconciliation`)} className="btn-primary">
                    Reconciliation →
                </button>
            </div>

            {/* Data freshness */}
            <div className="grid grid-cols-3 gap-3">
                {[['Last Dispense', 'Just now'], ['Tank Reading', 'Live'], ['Payment', 'Pending']].map(([label, val]) => {
                    return (
                        <div key={label} className="card py-3">
                            <div className="label-text">{label}</div>
                            <div className={`text-sm font-semibold text-green-400`}>{val}</div>
                        </div>
                    )
                })}
            </div>

            {/* 3D Digital Twin */}
            <div className="mb-6">
                <BabylonStationTwin 
                    tenantId={tenantId} 
                    stationId={stationId} 
                    sim={sim}
                    onDispenseStateChange={(pumpId, active) => {
                        if (active) setActivePumpId(pumpId);
                        else setActivePumpId(null);
                    }}
                />
            </div>

            {/* Tank cards */}
            <div>
                <h2 className="section-title mb-3">Tank Inventory — PMS</h2>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="card space-y-4">
                        <div className="flex items-center justify-between">
                            <div>
                                <div className="flex items-center gap-2">
                                    <h3 className="font-semibold text-white">{sim.tank.label}</h3>
                                    <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-green-900/40 text-green-400 border border-green-500/30 uppercase tracking-wider animate-pulse">
                                        Live Updating
                                    </span>
                                </div>
                                <p className="text-xs text-slate-400">Cap: {Number(sim.tank.capacity).toLocaleString()}L</p>
                            </div>
                            <div className="text-right">
                                <div className={`font-semibold text-sm text-green-400`}>
                                    {(sim.tank.currentLiters - sim.tank.startLiters).toFixed(2)}L
                                </div>
                                <div className="text-xs text-slate-400">Since Start</div>
                            </div>
                        </div>
                        <div className="space-y-1.5">
                            <div className="flex justify-between text-xs">
                                <span className="text-slate-400">Fill Level</span>
                                <span className="text-white font-semibold">{Number(sim.tank.percent).toFixed(1)}%</span>
                            </div>
                            <div className="h-2.5 bg-slate-700 rounded-full overflow-hidden">
                                <div className="h-full rounded-full transition-all duration-500"
                                    style={{ width: `${Math.min(sim.tank.percent, 100)}%`, background: '#22c55e' }} />
                            </div>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                            <div className="bg-slate-700/50 rounded-lg p-2.5 border border-blue-500/20">
                                <div className="text-xs text-slate-400 mb-0.5">Reported (Current)</div>
                                <div className="text-lg font-bold text-white">{Number(sim.tank.currentLiters).toLocaleString(undefined, { maximumFractionDigits: 2 })}L</div>
                            </div>
                            <div className="bg-slate-700/50 rounded-lg p-2.5 border border-slate-600">
                                <div className="text-xs text-slate-400 mb-0.5">Expected (Start - Dispensed)</div>
                                <div className="text-lg font-bold text-slate-300">
                                    {(sim.tank.startLiters - sim.pumps.reduce((acc, p) => acc + (p.totalLiters - (p.id === 'pump_1' ? 1240.2 : 850.8)), 0)).toLocaleString(undefined, { maximumFractionDigits: 2 })}L
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Pump section */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="card">
                    <h2 className="section-title mb-3">Pump Activity — Today</h2>
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-slate-700">
                                <th className="table-header text-left">Pump</th>
                                <th className="table-header text-right">Transactions</th>
                                <th className="table-header text-right">Liters</th>
                            </tr>
                        </thead>
                        <tbody>
                            {sim.pumps.map((p) => (
                                <tr key={p.id}
                                    className={`border-b border-slate-700/50 transition-colors ${activePumpId === (p.id === 'pump_1' ? '1' : '2') ? 'bg-blue-900/40 border-l-2 border-l-blue-500' : 'hover:bg-slate-700/20'}`}>
                                    <td className="table-cell font-medium flex items-center gap-2">
                                        {p.label}
                                        {p.status === 'DISPENSING' && (
                                            <span className="flex h-2 w-2 relative">
                                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                                                <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
                                            </span>
                                        )}
                                    </td>
                                    <td className="table-cell text-right text-blue-400 font-semibold">{p.transactions}</td>
                                    <td className="table-cell text-right font-mono">{Number(p.totalLiters).toFixed(2)}L</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>

                <div className="card">
                    <h2 className="section-title mb-3">Volume by Pump</h2>
                    <ResponsiveContainer width="100%" height={200}>
                        <BarChart data={pumpChartData}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                            <XAxis dataKey="name" tick={{ fill: '#94a3b8', fontSize: 11 }} />
                            <YAxis tick={{ fill: '#94a3b8', fontSize: 11 }} />
                            <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8 }} />
                            <Bar dataKey="liters" fill="#3b5bdb" radius={[4, 4, 0, 0]} name="Liters" />
                        </BarChart>
                    </ResponsiveContainer>
                </div>
            </div>
        </div>
    )
}
