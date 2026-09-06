import { useEffect, useState } from 'react'
import { getStations, getStationPumps } from '../api/client'

interface PumpRow {
    id: string
    pumpId: string
    label: string
    status: string
    lastSeenAt?: string
    todayTransactionCount: number
    todayVolumeLiters: number
    todayRevenue: number
    stationName: string
    stationId: string
    lastTransaction?: {
        transactionId: string
        volumeLiters: number
        amount: number
        product: string
        timestamp: string
    }
}

interface Station {
    id: string
    name: string
}

export default function PumpsPage() {
    const [pumps, setPumps] = useState<PumpRow[]>([])
    const [stations, setStations] = useState<Station[]>([])
    const [loading, setLoading] = useState(true)
    const [filterStation, setFilterStation] = useState('')
    const [filterStatus, setFilterStatus] = useState('')
    const [error, setError] = useState('')

    const loadData = () => {
        getStations()
            .then(async (res) => {
                const stationList: Station[] = res.data
                setStations(stationList)

                // Fetch pumps for all stations
                const allPumps: PumpRow[] = []
                for (const st of stationList) {
                    try {
                        const pumpsRes = await getStationPumps(st.id)
                        const pumpData = pumpsRes.data.map((p: any) => ({
                            ...p,
                            stationName: st.name,
                            stationId: st.id
                        }))
                        allPumps.push(...pumpData)
                    } catch (err) {
                        console.error(`Failed to fetch pumps for station ${st.name}`, err)
                    }
                }
                setPumps(allPumps)
            })
            .catch((err) => {
                console.error("Failed to load pumps directory data", err)
                setError('Failed to query pump statuses. Verify backend connections.')
            })
            .finally(() => setLoading(false))
    }

    useEffect(() => {
        loadData()
        const interval = setInterval(loadData, 10000)
        return () => clearInterval(interval)
    }, [])

    const fmtNaira = (val: number) => {
        return new Intl.NumberFormat('en-NG', {
            style: 'currency',
            currency: 'NGN',
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        }).format(val);
    }

    const filteredPumps = pumps.filter(p => {
        const matchesStation = filterStation === '' || p.stationId === filterStation
        const matchesStatus = filterStatus === '' || p.status === filterStatus
        return matchesStation && matchesStatus
    })

    if (loading) return <div className="p-6 text-slate-400">Loading pump monitor...</div>
    if (error) return (
        <div className="p-6">
            <div className="card bg-red-950/20 text-red-400 p-4 border border-red-500/20 rounded-xl">
                {error}
            </div>
        </div>
    )

    return (
        <div className="p-6 space-y-6 bg-slate-950 min-h-screen text-slate-100">
            {/* Header */}
            <div>
                <h1 className="text-2xl font-bold text-white tracking-tight">Dispenser Operations</h1>
                <p className="text-slate-400 text-sm">Real-time status monitoring and daily performance across all pumps</p>
            </div>

            {/* Filter Ribbons */}
            <div className="flex gap-4 flex-wrap bg-slate-900 p-4 rounded-xl border border-slate-800">
                <div className="flex flex-col gap-1.5">
                    <span className="text-[10px] text-slate-500 uppercase font-bold tracking-wider">Station Filter</span>
                    <select 
                        className="input w-52 bg-slate-950 border-slate-800" 
                        value={filterStation} 
                        onChange={e => setFilterStation(e.target.value)}
                    >
                        <option value="">All Stations</option>
                        {stations.map(st => (
                            <option key={st.id} value={st.id}>{st.name}</option>
                        ))}
                    </select>
                </div>

                <div className="flex flex-col gap-1.5">
                    <span className="text-[10px] text-slate-500 uppercase font-bold tracking-wider">Status Filter</span>
                    <select 
                        className="input w-40 bg-slate-950 border-slate-800" 
                        value={filterStatus} 
                        onChange={e => setFilterStatus(e.target.value)}
                    >
                        <option value="">All Statuses</option>
                        <option value="ONLINE">ONLINE</option>
                        <option value="OFFLINE">OFFLINE</option>
                        <option value="IDLE">IDLE</option>
                        <option value="DISPENSING">DISPENSING</option>
                        <option value="ERROR">ERROR</option>
                        <option value="UNKNOWN">UNKNOWN</option>
                    </select>
                </div>
            </div>

            {/* Pumps Table */}
            <div className="card p-5 bg-slate-900 border-slate-800">
                {filteredPumps.length === 0 ? (
                    <div className="text-center py-8 text-slate-500 text-sm">
                        No dispensers match these criteria.
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm">
                            <thead>
                                <tr className="border-b border-slate-800 text-slate-400">
                                    <th className="pb-3 font-semibold">Station</th>
                                    <th className="pb-3 font-semibold">Pump</th>
                                    <th className="pb-3 font-semibold">Status</th>
                                    <th className="pb-3 font-semibold">Last Seen</th>
                                    <th className="pb-3 font-semibold text-right">Transactions</th>
                                    <th className="pb-3 font-semibold text-right">Liters Today</th>
                                    <th className="pb-3 font-semibold text-right">Revenue Today</th>
                                    <th className="pb-3 font-semibold text-right">Last Transaction</th>
                                </tr>
                            </thead>
                            <tbody>
                                {filteredPumps.map(p => (
                                    <tr key={p.id} className="border-b border-slate-800/50 hover:bg-slate-800/20 transition-colors">
                                        <td className="py-4 font-semibold text-slate-300">{p.stationName}</td>
                                        <td className="py-4 text-white font-bold">{p.label} <span className="text-xs text-slate-500 font-mono">({p.pumpId})</span></td>
                                        <td className="py-4">
                                            <span className={`px-2 py-0.5 text-xs font-semibold rounded-full border ${
                                                p.status === 'DISPENSING' ? 'bg-blue-900/30 text-blue-400 border-blue-500/20 animate-pulse' :
                                                p.status === 'IDLE' || p.status === 'ONLINE' ? 'bg-green-900/30 text-green-400 border-green-500/20' :
                                                'bg-slate-900 text-slate-400 border-slate-800'
                                            }`}>
                                                {p.status}
                                            </span>
                                        </td>
                                        <td className="py-4 text-slate-400">
                                            {p.lastSeenAt ? new Date(p.lastSeenAt).toLocaleTimeString() : 'Never'}
                                        </td>
                                        <td className="py-4 text-right text-blue-400 font-bold">{p.todayTransactionCount}</td>
                                        <td className="py-4 text-right font-mono text-slate-300">{p.todayVolumeLiters.toFixed(2)} L</td>
                                        <td className="py-4 text-right font-mono text-green-400 font-semibold">{fmtNaira(p.todayRevenue)}</td>
                                        <td className="py-4 text-right text-xs">
                                            {p.lastTransaction ? (
                                                <div className="flex flex-col items-end">
                                                    <span className="font-mono text-slate-300">{p.lastTransaction.volumeLiters} L / {p.lastTransaction.product}</span>
                                                    <span className="text-slate-500 font-mono text-[10px]">{new Date(p.lastTransaction.timestamp).toLocaleTimeString()}</span>
                                                </div>
                                            ) : (
                                                <span className="text-slate-600">None</span>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    )
}
