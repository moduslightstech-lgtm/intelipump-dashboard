import { useEffect, useRef } from 'react'

interface TankState {
    label: string
    capacityLiters: number
    reportedLiters: number
    expectedLiters: number
    deltaLiters: number
    fillPercent: number
}

interface PumpState {
    label: string
    active: boolean
    transactionCount: number
    totalLiters: number
}

interface Props {
    tankStates: Record<string, TankState>
    pumpStates: Record<string, PumpState>
    /** pumpId currently dispensing (for animation) */
    activePumpId: string | null
}

/**
 * SVG schematic: Tanks → pipes → Pump dispensers
 * Shows animated flow pulse when activePumpId is set
 */
export default function StationFlowDiagram({ tankStates, pumpStates, activePumpId }: Props) {
    const tanks = Object.entries(tankStates).slice(0, 2)
    const pumps = Object.entries(pumpStates).slice(0, 4)

    // Cylinder fill color based on level
    const fillColor = (pct: number) =>
        pct < 20 ? '#ef4444' : pct < 40 ? '#f59e0b' : '#22c55e'

    const tankX = [80, 260]  // x centers of 2 tanks
    const pumpX = [40, 140, 240, 340]  // x centers of 4 pumps
    const TANK_Y = 40
    const PIPE_Y = 155
    const PUMP_Y = 185

    return (
        <div className="card">
            <h2 className="font-semibold text-white mb-4 flex items-center gap-2">
                <span className="w-2 h-2 bg-blue-400 rounded-full animate-pulse inline-block" />
                Station Flow Diagram
            </h2>
            <svg
                viewBox="0 0 420 280"
                className="w-full"
                style={{ maxHeight: 280, fontFamily: 'Inter, sans-serif' }}
            >
                {/* ─── Tank cylinders ─── */}
                {tanks.map(([tankId, tank], ti) => {
                    const cx = tankX[ti] ?? 80 + ti * 180
                    const fillH = Math.min(80, Math.max(4, (tank.fillPercent / 100) * 80))
                    const color = fillColor(tank.fillPercent)

                    return (
                        <g key={tankId}>
                            {/* Tank body */}
                            <rect x={cx - 40} y={TANK_Y} width={80} height={100}
                                rx={6} fill="#1e293b" stroke="#334155" strokeWidth={1.5} />
                            {/* Fill level */}
                            <rect
                                x={cx - 39} y={TANK_Y + (100 - fillH)} width={78} height={fillH}
                                rx={4} fill={color} opacity={0.7}
                            />
                            {/* Top ellipse */}
                            <ellipse cx={cx} cy={TANK_Y} rx={40} ry={8} fill="#1e293b" stroke="#334155" strokeWidth={1.5} />
                            {/* Bottom ellipse */}
                            <ellipse cx={cx} cy={TANK_Y + 100} rx={40} ry={8} fill="#1e293b" stroke="#334155" strokeWidth={1.5} />

                            {/* Percent label */}
                            <text x={cx} y={TANK_Y + 54} textAnchor="middle"
                                fill="white" fontSize={14} fontWeight="bold">
                                {tank.fillPercent.toFixed(0)}%
                            </text>
                            <text x={cx} y={TANK_Y + 68} textAnchor="middle"
                                fill="#94a3b8" fontSize={9}>
                                {(tank.reportedLiters / 1000).toFixed(1)}kL reported
                            </text>

                            {/* Tank label */}
                            <text x={cx} y={TANK_Y - 14} textAnchor="middle"
                                fill="#e2e8f0" fontSize={10} fontWeight="600">
                                {tank.label.length > 16 ? tank.label.slice(0, 16) + '…' : tank.label}
                            </text>

                            {/* Pipe drop from tank bottom */}
                            <line x1={cx} y1={TANK_Y + 108} x2={cx} y2={PIPE_Y}
                                stroke="#334155" strokeWidth={3} />
                        </g>
                    )
                })}

                {/* ─── Horizontal manifold pipe ─── */}
                <line x1={30} y1={PIPE_Y} x2={390} y2={PIPE_Y}
                    stroke="#334155" strokeWidth={3} />

                {/* ─── Pump dispensers ─── */}
                {pumps.map(([pumpId, pump], pi) => {
                    const cx = pumpX[pi] ?? 40 + pi * 100
                    const isActive = pumpId === activePumpId
                    // Determine which tank feeds this pump (simple: even→tank0, odd→tank1)
                    const feedTankX = pi % 2 === 0 ? (tankX[0] ?? 80) : (tankX[1] ?? 260)

                    return (
                        <g key={pumpId}>
                            {/* Pipe down from manifold to pump */}
                            <line x1={cx} y1={PIPE_Y} x2={cx} y2={PUMP_Y}
                                stroke={isActive ? '#3b5bdb' : '#334155'} strokeWidth={isActive ? 4 : 2}
                            />

                            {/* Flow pulse animation on pipe when active */}
                            {isActive && (
                                <line x1={cx} y1={PIPE_Y} x2={cx} y2={PUMP_Y}
                                    stroke="#60a5fa" strokeWidth={3} strokeDasharray="4 6" opacity={0.8}>
                                    <animate
                                        attributeName="stroke-dashoffset"
                                        from="0" to="20"
                                        dur="0.4s" repeatCount="indefinite" />
                                </line>
                            )}

                            {/* Horizontal pipe from manifold toward feed tank */}
                            {isActive && (
                                <line
                                    x1={feedTankX} y1={PIPE_Y} x2={cx} y2={PIPE_Y}
                                    stroke="#3b5bdb" strokeWidth={3} strokeDasharray="4 6" opacity={0.6}
                                >
                                    <animate
                                        attributeName="stroke-dashoffset"
                                        from="0" to="-20"
                                        dur="0.4s" repeatCount="indefinite" />
                                </line>
                            )}

                            {/* Pump body */}
                            <rect x={cx - 18} y={PUMP_Y} width={36} height={50}
                                rx={4}
                                fill={isActive ? '#1e3a5f' : '#1e293b'}
                                stroke={isActive ? '#3b5bdb' : '#334155'}
                                strokeWidth={isActive ? 2 : 1.5}
                            />

                            {/* Pump nozzle */}
                            <rect x={cx + 8} y={PUMP_Y + 20} width={14} height={6}
                                rx={2} fill={isActive ? '#3b5bdb' : '#475569'} />
                            <path d={`M ${cx + 22} ${PUMP_Y + 22} q 8 0 4 10`}
                                stroke={isActive ? '#3b5bdb' : '#475569'} strokeWidth={2.5}
                                fill="none" strokeLinecap="round" />

                            {/* Screen / display on pump */}
                            <rect x={cx - 14} y={PUMP_Y + 8} width={28} height={18}
                                rx={2} fill={isActive ? '#0f172a' : '#0f172a'} stroke="#334155" strokeWidth={1} />
                            <text x={cx} y={PUMP_Y + 20} textAnchor="middle"
                                fill={isActive ? '#60a5fa' : '#475569'} fontSize={7} fontWeight="600">
                                {pump.totalLiters.toFixed(0)}L
                            </text>

                            {/* Active dot */}
                            {isActive && (
                                <circle cx={cx + 12} cy={PUMP_Y + 6} r={4} fill="#22c55e">
                                    <animate attributeName="opacity"
                                        values="1;0.3;1" dur="0.8s" repeatCount="indefinite" />
                                </circle>
                            )}

                            {/* Pump label */}
                            <text x={cx} y={PUMP_Y + 60} textAnchor="middle"
                                fill={isActive ? '#93c5fd' : '#94a3b8'} fontSize={9} fontWeight={isActive ? '600' : '400'}>
                                {pump.label}
                            </text>

                            {/* Transaction badge */}
                            <text x={cx} y={PUMP_Y + 70} textAnchor="middle"
                                fill="#64748b" fontSize={8}>
                                {pump.transactionCount} tx
                            </text>
                        </g>
                    )
                })}
            </svg>
        </div>
    )
}
