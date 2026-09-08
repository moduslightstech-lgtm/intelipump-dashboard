import { buildConnectionGraph } from '../schematic/connectionGraph'
import {
  buildManifoldRoutes as routeValidated,
  buildOrthogonalPipePath,
  collectObstacles,
  getPumpInletAnchor,
  getTankOutletAnchor,
  nudgeBranchX,
  pipePath,
} from '../schematic/orthogonalRouting'
import type { SchematicNode } from '../schematic/types'
import { computePipeManifoldY } from '../pumpGridLayout'
import type { ForecourtNode } from '../forecourtLayout'

export {
  buildOrthogonalPipePath,
  collectObstacles,
  getPumpInletAnchor,
  getTankOutletAnchor,
  nudgeBranchX,
  pipePath,
}

export function buildManifoldRoutes(
  nodes: ForecourtNode[] | SchematicNode[],
  connections: Record<string, any>[],
) {
  const { edges } = buildConnectionGraph(nodes as SchematicNode[], connections)
  return routeValidated(nodes as SchematicNode[], edges)
}

export { computePipeManifoldY }
