import { BaseEdge, type EdgeProps } from '@xyflow/react'
import { productPipeColor } from '../../pipe/pipeTheme'

export type PipeEdgeData = {
  path: string
  product?: string | null
  role?: 'PRIMARY' | 'BACKUP' | 'INACTIVE'
  dimmed?: boolean
  highlighted?: boolean
  flowing?: boolean
  isFlowing?: boolean
  segmentType?: 'TANK_TRUNK' | 'NOZZLE_BRANCH' | 'PUMP_SUPPLY'
  nozzleId?: string
  tankId?: string
  pumpId?: string
  stationId?: string
  label?: string
}

function productFlowClass(product?: string | null): string {
  const p = String(product || '').toUpperCase()
  if (p.includes('PMS')) return 'pms'
  if (p.includes('AGO') || p.includes('DIESEL')) return 'ago'
  if (p.includes('DPK') || p.includes('KEROSENE')) return 'dpk'
  return 'fuel'
}

export default function PipeEdge({ id, data, selected }: EdgeProps) {
  const d = data as PipeEdgeData
  const isFlowing = Boolean(d.isFlowing ?? d.flowing)
  const color = productPipeColor(d.product)
  const dashed = d.role === 'BACKUP' && !isFlowing
  const muted = (d.role === 'INACTIVE' || d.dimmed) && !isFlowing
  const path = d.path
  if (!path) return null
  const productClass = productFlowClass(d.product)
  return (
    <g
      data-testid={`pipe-edge-${id}`}
      data-pipe-flowing={isFlowing ? 'true' : 'false'}
      data-pipe-segment={d.segmentType || 'NOZZLE_BRANCH'}
      data-nozzle-id={d.nozzleId || ''}
      style={{ opacity: muted ? 0.6 : 1 }}
    >
      <BaseEdge
        id={`${id}-halo`}
        path={path}
        className="fuel-pipe-halo"
        style={{
          stroke: '#020617',
          strokeWidth: selected || d.highlighted || isFlowing ? 9 : 6,
          fill: 'none',
        }}
      />
      <BaseEdge
        id={id}
        path={path}
        className="fuel-pipe-base"
        style={{
          stroke: color,
          strokeWidth: selected || d.highlighted || isFlowing ? 3.5 : 2.5,
          strokeDasharray: dashed ? '8 5' : undefined,
          fill: 'none',
        }}
      />
      {isFlowing ? (
        <g data-testid={`pipe-flow-${id}`} pointerEvents="none">
          <path
            d={path}
            fill="none"
            stroke={color}
            strokeWidth={6}
            strokeLinecap="round"
            opacity={0.22}
            className={`fuel-pipe-flow fuel-pipe-flow--${productClass}`}
          />
          <path
            d={path}
            fill="none"
            stroke={color}
            strokeWidth={2.4}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray="10 8"
            className={
              productClass === 'pms'
                ? `fuel-pipe-flow fuel-pipe-flow--pms schematic-pipe-flow schematic-pipe-flow-fuel`
                : `fuel-pipe-flow fuel-pipe-flow--${productClass} schematic-pipe-flow`
            }
          />
          {[0, 0.28, 0.56].map((begin, i) => (
            <circle key={i} r={2.6} fill={color} opacity={0.95} className="schematic-pipe-particles">
              <animateMotion
                dur="1.15s"
                repeatCount="indefinite"
                begin={`${begin}s`}
                path={path}
                rotate="auto"
                keyPoints="0;1"
                keyTimes="0;1"
                calcMode="linear"
              />
            </circle>
          ))}
        </g>
      ) : null}
    </g>
  )
}
