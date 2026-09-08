import { memo, useMemo } from 'react'
import type { ForecourtNode } from '../forecourtLayout'
import { buildManifoldRoutes } from './pipeRouting'
import { PIPE_THEME, productPipeColor } from './pipeTheme'
import type { ActiveDispensingState, PipeRoute, PipeStatus } from './pipeTypes'
import PipeConnection from './PipeConnection'
import ActivePipeFlow from './ActivePipeFlow'
import { pumpMatchesId } from '../../../lib/pumpIdentity'

type Props = {
  nodes: ForecourtNode[]
  connections: Record<string, any>[]
  activeByPump?: Record<string, ActiveDispensingState>
  selectedPipeId?: string | null
  stationClosed?: boolean
  onSelectPipe?: (route: PipeRoute) => void
}

function routeStatus(
  route: PipeRoute,
  activeByPump: Record<string, ActiveDispensingState>,
  stationClosed: boolean,
): PipeStatus {
  if (stationClosed) return 'IDLE'
  for (const s of Object.values(activeByPump)) {
    if (s.phase !== 'DISPENSING') continue
    const match =
      route.pumpId === s.pumpId ||
      pumpMatchesId(
        {
          id: route.pumpId,
          mqttPumpId: (route.connection as any)?.mqttPumpId,
          pumpCode: (route.connection as any)?.pumpCode,
        },
        s.pumpId,
      ) ||
      (s.connectionId && route.id === s.connectionId)
    if (match && s.phase === 'DISPENSING') return 'ACTIVE'
  }
  return route.status
}

function PipeLayer({
  nodes,
  connections,
  activeByPump = {},
  selectedPipeId = null,
  stationClosed = false,
  onSelectPipe,
}: Props) {
  const { routes, trunks } = useMemo(
    () => buildManifoldRoutes(nodes, connections),
    [nodes, connections],
  )

  const inactive = routes.filter((r) => routeStatus(r, activeByPump, stationClosed) !== 'ACTIVE')
  const active = routes.filter((r) => routeStatus(r, activeByPump, stationClosed) === 'ACTIVE')

  return (
    <g data-testid="pipe-layer">
      <style>{`
        .pipe-flow-dash {
          animation: pipe-dash 0.65s linear infinite;
        }
        @keyframes pipe-dash {
          to { stroke-dashoffset: -18; }
        }
      `}</style>

      {/* trunk rails per tank/product */}
      {trunks.map((t) => (
        <path
          key={`trunk-${t.tankId}`}
          d={t.path}
          fill="none"
          stroke={productPipeColor(t.product)}
          strokeWidth={PIPE_THEME.trunk.strokeWidth}
          strokeLinecap="round"
          opacity={0.35}
          data-testid={`manifold-trunk-${t.tankId}`}
        />
      ))}

      {/* Layer: inactive pipes */}
      {inactive.map((route) => (
        <PipeConnection
          key={route.id}
          route={route}
          status={routeStatus(route, activeByPump, stationClosed)}
          selected={selectedPipeId === route.id}
          onClick={() => onSelectPipe?.(route)}
        />
      ))}

      {/* Layer: active pipes + flow */}
      {active.map((route) => (
        <g key={`active-${route.id}`}>
          <PipeConnection
            route={route}
            status="ACTIVE"
            selected={selectedPipeId === route.id}
            onClick={() => onSelectPipe?.(route)}
          />
          {!stationClosed && <ActivePipeFlow route={route} />}
        </g>
      ))}
    </g>
  )
}

export default memo(PipeLayer)
export type { PipeRoute }
