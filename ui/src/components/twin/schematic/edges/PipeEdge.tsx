import { BaseEdge, type EdgeProps } from '@xyflow/react'
import { productPipeColor } from '../../pipe/pipeTheme'

export type PipeEdgeData = {
  path: string
  product?: string | null
  role?: 'PRIMARY' | 'BACKUP' | 'INACTIVE'
  dimmed?: boolean
  highlighted?: boolean
  flowing?: boolean
  label?: string
}

export default function PipeEdge({ id, data, selected }: EdgeProps) {
  const d = data as PipeEdgeData
  const color = productPipeColor(d.product)
  const dashed = d.role === 'BACKUP' && !d.flowing
  const muted = (d.role === 'INACTIVE' || d.dimmed) && !d.flowing
  const path = d.path
  if (!path) return null
  return (
    <g data-testid={`pipe-edge-${id}`} data-pipe-flowing={d.flowing ? 'true' : 'false'} style={{ opacity: muted ? 0.6 : 1 }}>
      <BaseEdge
        id={`${id}-halo`}
        path={path}
        style={{
          stroke: '#020617',
          strokeWidth: selected || d.highlighted || d.flowing ? 9 : 6,
          fill: 'none',
        }}
      />
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke: color,
          strokeWidth: selected || d.highlighted || d.flowing ? 3.5 : 2.5,
          strokeDasharray: dashed ? '8 5' : undefined,
          fill: 'none',
        }}
      />
      {d.flowing ? (
        <g data-testid={`pipe-flow-${id}`} pointerEvents="none">
          <path
            d={path}
            fill="none"
            stroke={color}
            strokeWidth={6}
            strokeLinecap="round"
            opacity={0.22}
          />
          <path
            d={path}
            fill="none"
            stroke={color}
            strokeWidth={2.4}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray="10 8"
            className="schematic-pipe-flow"
          />
          {[0, 0.28, 0.56].map((begin, i) => (
            <circle key={i} r={2.6} fill={color} opacity={0.95}>
              <animateMotion
                dur="1.15s"
                repeatCount="indefinite"
                begin={`${begin}s`}
                path={path}
                rotate="auto"
              />
            </circle>
          ))}
        </g>
      ) : null}
    </g>
  )
}
