import { memo, useMemo } from 'react'
import type { ForecourtNode } from '../forecourtLayout'
import { isSchematicPipeFlowing } from '../schematic/pipeFlow'
import { pipeSegmentsForRender } from '../schematic/orthogonalRouting'
import { buildManifoldRoutes } from './pipeRouting'
import type { ActiveDispensingState, PipeRoute, PipeStatus } from './pipeTypes'
import PipeConnection from './PipeConnection'
import ActivePipeFlow from './ActivePipeFlow'

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
  branches: PipeRoute[],
): PipeStatus {
  if (stationClosed) return 'IDLE'
  if (isSchematicPipeFlowing(route, undefined, activeByPump, { branches })) return 'ACTIVE'
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
  const { routes: branchRoutes, trunks } = useMemo(
    () => buildManifoldRoutes(nodes, connections),
    [nodes, connections],
  )
  const routes = useMemo(
    () => pipeSegmentsForRender(branchRoutes, trunks),
    [branchRoutes, trunks],
  )

  const inactive = routes.filter((r) => routeStatus(r, activeByPump, stationClosed, branchRoutes) !== 'ACTIVE')
  const active = routes.filter((r) => routeStatus(r, activeByPump, stationClosed, branchRoutes) === 'ACTIVE')

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

      {inactive.map((route) => (
        <PipeConnection
          key={route.id}
          route={route}
          status={routeStatus(route, activeByPump, stationClosed, branchRoutes)}
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
