import { memo, useMemo } from 'react'
export interface TankData {
    tankId: string
    reportedLiters: number
    expectedLiters: number
    capacityLiters: number
}

export interface PumpData {
    pumpId: string
    txCountToday: number
    litersToday: number
    status: 'ACTIVE' | 'IDLE' | 'OFFLINE'
}

interface Props {
    activePipeIds: string[]
    activePumpIds: string[]
    tanks: TankData[]
    pumps: PumpData[]
}

const CONSTANTS = {
    TANKS: [
        { id: 'T1', x: 260, y: 210, w: 300, h: 70, label: 'Tank 1 (PMS)' },
        { id: 'T2', x: 260, y: 295, w: 300, h: 70, label: 'Tank 2 (AGO)' }
    ],
    PUMPS: [
        { id: 'P1', x: 90, y: 400, w: 55, h: 60 },
        { id: 'P2', x: 170, y: 400, w: 55, h: 60 },
        { id: 'P3', x: 780, y: 120, w: 55, h: 60 },
        { id: 'P4', x: 860, y: 120, w: 55, h: 60 }
    ],
    PIPES: [
        { id: 'pipe-T1-P1-N1', d: 'M 260 245 L 200 245 L 90 430' },
        { id: 'pipe-T1-P2-N2', d: 'M 260 245 L 200 245 L 170 430' },
        { id: 'pipe-T1-P3-N5', d: 'M 260 245 L 200 245 L 600 245 L 600 160 L 780 150' },
        { id: 'pipe-T1-P4-N6', d: 'M 260 245 L 200 245 L 600 245 L 600 160 L 860 150' },
        { id: 'pipe-T2-P1-N3', d: 'M 260 330 L 200 330 L 90 430' },
        { id: 'pipe-T2-P2-N4', d: 'M 260 330 L 200 330 L 170 430' },
        { id: 'pipe-T2-P3-N7', d: 'M 260 330 L 200 330 L 600 330 L 600 160 L 780 150' },
        { id: 'pipe-T2-P4-N8', d: 'M 260 330 L 200 330 L 600 330 L 600 160 L 860 150' }
    ]
}

export default function StationFlowTwinSvg({
    activePipeIds,
    activePumpIds,
    tanks,
    pumps
}: Props) {
    // Map provided data by ID
    const tankMap = useMemo(() => Object.fromEntries(tanks.map(t => [t.tankId, t])), [tanks])
    const pumpMap = useMemo(() => Object.fromEntries(pumps.map(p => [p.pumpId, p])), [pumps])

    const activePipeSet = new Set(activePipeIds)
    const activePumpSet = new Set(activePumpIds)

    return (
        <div className="card w-full overflow-hidden">
            <h2 className="section-title mb-4">Station Live Flow Diagram</h2>
            <svg
                viewBox="0 0 1000 520"
                style={{ width: '100%', height: 'auto', background: '#0f172a', borderRadius: '12px' }}
            >
                <defs>
                    <style>{`
            .pipe-base {
              fill: none;
              stroke: #334155;
              stroke-width: 4;
              stroke-linecap: round;
              stroke-linejoin: round;
            }
            .pipe-flow {
              fill: none;
              stroke: #3b82f6;
              stroke-width: 4;
              stroke-linecap: round;
              stroke-linejoin: round;
              opacity: 0; 
              transition: opacity 0.2s ease;
            }
            .pipe-flow.pulse {
              opacity: 1;
              stroke-dasharray: 12 8;
              animation: flowAnim 0.6s linear infinite;
            }
            @keyframes flowAnim {
              from { stroke-dashoffset: 0; }
              to { stroke-dashoffset: -20; }
            }
          `}</style>

                    <filter id="pumpGlow">
                        <feGaussianBlur stdDeviation="4" result="coloredBlur" />
                        <feMerge>
                            <feMergeNode in="coloredBlur" />
                            <feMergeNode in="SourceGraphic" />
                        </feMerge>
                    </filter>
                </defs>

                {/* ─── Base Pipes ─── */}
                <g id="base-pipes">
                    {CONSTANTS.PIPES.map(pipe => (
                        <path key={`base-${pipe.id}`} d={pipe.d} className="pipe-base" />
                    ))}
                </g>

                {/* ─── Animated Flow Pipes ─── */}
                <g id="flow-pipes">
                    {CONSTANTS.PIPES.map(pipe => {
                        const isPulsing = activePipeSet.has(pipe.id)
                        return (
                            <path
                                key={`flow-${pipe.id}`}
                                id={pipe.id}
                                d={pipe.d}
                                className={`pipe-flow ${isPulsing ? 'pulse' : ''}`}
                                stroke={pipe.id.includes('T2') ? '#eab308' : '#3b82f6'}
                            />
                        )
                    })}
                </g>

                {/* ─── Tanks ─── */}
                <g id="tanks">
                    {CONSTANTS.TANKS.map(tank => {
                        const data = tankMap[tank.id]
                        const capacity = data?.capacityLiters || 20000
                        const fillPct = data ? Math.max(0, Math.min(1, data.reportedLiters / capacity)) : 0.75

                        return (
                            <g key={`tank-${tank.id}`} id={`tank-${tank.id}`}>
                                {/* Tank Body Base */}
                                <rect x={tank.x} y={tank.y} width={tank.w} height={tank.h} rx={6} fill="#1e293b" stroke="#475569" strokeWidth={2} />

                                {/* Fill Progress */}
                                <clipPath id={`clip-${tank.id}`}>
                                    <rect x={tank.x} y={tank.y} width={tank.w} height={tank.h} rx={6} />
                                </clipPath>
                                <rect
                                    x={tank.x} y={tank.y}
                                    width={tank.w * fillPct} height={tank.h}
                                    fill={tank.id === 'T1' ? '#1d4ed8' : '#a16207'}
                                    opacity={0.5}
                                    clipPath={`url(#clip-${tank.id})`}
                                />

                                {/* Tank Label */}
                                <text x={tank.x + 15} y={tank.y + 25} fill="white" fontSize={14} fontWeight="bold" fontFamily="Inter, sans-serif">
                                    {tank.label}
                                </text>

                                {/* Tank Stats */}
                                {data && (
                                    <text x={tank.x + 15} y={tank.y + 50} fill="#94a3b8" fontSize={12} fontFamily="Inter, sans-serif">
                                        Reported: {Math.round(data.reportedLiters)} L
                                        (Expected: {Math.round(data.expectedLiters)} L)
                                    </text>
                                )}
                            </g>
                        )
                    })}
                </g>

                {/* ─── Pumps ─── */}
                <g id="pumps">
                    {CONSTANTS.PUMPS.map(pump => {
                        const data = pumpMap[pump.id]
                        const isActive = activePumpSet.has(pump.id)

                        // Check overall status
                        let statusColor = '#64748b' // IDLE (default)
                        if (data?.status === 'ACTIVE') statusColor = '#22c55e'
                        if (data?.status === 'OFFLINE') statusColor = '#ef4444'

                        return (
                            <g key={`pump-${pump.id}`} id={`pump-${pump.id}`}>
                                {/* Glow ring if pulsing */}
                                {isActive && (
                                    <rect
                                        x={pump.x - 4} y={pump.y - 4} width={pump.w + 8} height={pump.h + 8} rx={6}
                                        fill="none" stroke="#60a5fa" strokeWidth={3}
                                        filter="url(#pumpGlow)"
                                    />
                                )}

                                {/* Pump Body */}
                                <rect
                                    x={pump.x} y={pump.y} width={pump.w} height={pump.h} rx={4}
                                    fill={isActive ? '#1e3a5f' : '#1e293b'}
                                    stroke={isActive ? '#3b82f6' : '#475569'}
                                    strokeWidth={2}
                                />

                                {/* Pump Label & Status dot */}
                                <circle cx={pump.x + 12} cy={pump.y + 12} r={4} fill={statusColor} />
                                <text x={pump.x + pump.w / 2} y={pump.y + 16} textAnchor="middle" fill="white" fontSize={12} fontWeight="bold" fontFamily="Inter, sans-serif">
                                    {pump.id}
                                </text>

                                {/* Liters Display Screen */}
                                <rect x={pump.x + 8} y={pump.y + 24} width={pump.w - 16} height={16} rx={2} fill="#020617" />
                                <text x={pump.x + pump.w / 2} y={pump.y + 36} textAnchor="middle" fill="#38bdf8" fontSize={10} fontFamily="Inter, monospace">
                                    {data ? `${Math.round(data.litersToday)}L` : '0L'}
                                </text>

                                {/* TxCount */}
                                <text x={pump.x + pump.w / 2} y={pump.y + 52} textAnchor="middle" fill="#94a3b8" fontSize={9} fontFamily="Inter, sans-serif">
                                    {data?.txCountToday || 0} tx
                                </text>
                            </g>
                        )
                    })}
                </g>
            </svg>
        </div>
    )
}
