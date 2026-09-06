import { memo } from 'react'
import { PIPE_THEME, productPipeColor } from './pipeTheme'
import type { PipeRoute, PipeStatus } from './pipeTypes'

type Props = {
  route: PipeRoute
  status?: PipeStatus
  selected?: boolean
  onClick?: () => void
}

function strokeFor(status: PipeStatus, product?: string) {
  if (status === 'ACTIVE') return PIPE_THEME.active.stroke
  if (status === 'WARNING') return PIPE_THEME.warning.stroke
  if (status === 'FAULT') return PIPE_THEME.fault.stroke
  // inactive but product-tinted slightly
  return productPipeColor(product)
}

function PipeConnection({ route, status = 'IDLE', selected, onClick }: Props) {
  const active = status === 'ACTIVE'
  const stroke = strokeFor(status, route.product)
  const width = active
    ? PIPE_THEME.active.strokeWidth
    : status === 'WARNING' || status === 'FAULT'
      ? PIPE_THEME.warning.strokeWidth
      : PIPE_THEME.inactive.strokeWidth

  return (
    <g
      data-testid={`pipe-${route.id}`}
      data-pipe-status={status}
      onClick={(e) => {
        e.stopPropagation()
        onClick?.()
      }}
      style={{ cursor: onClick ? 'pointer' : undefined }}
    >
      {/* underlay for hit area / depth */}
      <path
        d={route.path}
        fill="none"
        stroke="#0f172a"
        strokeWidth={width + 6}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.55}
      />
      <path
        d={route.path}
        fill="none"
        stroke={stroke}
        strokeWidth={width}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={active ? PIPE_THEME.active.opacity : PIPE_THEME.inactive.opacity}
        strokeDasharray={status === 'WARNING' ? '6 4' : undefined}
      />
      {selected && (
        <path
          d={route.path}
          fill="none"
          stroke="#38bdf8"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeDasharray="4 3"
          opacity={0.9}
        />
      )}
    </g>
  )
}

export default memo(PipeConnection)
