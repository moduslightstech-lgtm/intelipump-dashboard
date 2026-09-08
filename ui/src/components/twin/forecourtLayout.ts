import type { TwinLiveState } from '../../api/client'
import { pumpStatusColor } from '../../lib/pumpIdentity'
import {
  buildForecourtNodes as buildSchematicNodes,
  groupPumpsIntoIslands,
  nodesHaveNoOverlap,
} from './schematic/autoLayout'
import { buildConnectionGraph } from './schematic/connectionGraph'
import {
  buildForecourtPipes as buildSchematicPipes,
  buildManifoldPath as schematicManifold,
  pipePath as routePipePath,
  productStroke,
} from './schematic/orthogonalRouting'
import type { SchematicNode } from './schematic/types'

export type ForecourtNode = SchematicNode

export type ForecourtPipe = {
  id: string
  tankId: string
  pumpId: string
  product?: string | null
  lineLabel?: string | null
  source: string
  d: string
  midX: number
  midY: number
  connection: Record<string, any>
}

export function buildForecourtNodes(state?: TwinLiveState, viewportWidth = 1440): ForecourtNode[] {
  return buildSchematicNodes(state, viewportWidth)
}

export function buildForecourtPipes(
  nodes: ForecourtNode[],
  connections: Record<string, any>[] | undefined,
): ForecourtPipe[] {
  const { edges } = buildConnectionGraph(nodes, connections)
  return buildSchematicPipes(nodes, edges)
}

export function buildManifoldPath(nodes: ForecourtNode[]): string | null {
  return schematicManifold(nodes)
}

export function pipePath(
  tank: { x: number; y: number; w: number; h: number },
  pump: { x: number; y: number; w: number; h: number },
  manifoldY?: number,
): { d: string; midX: number; midY: number } {
  return routePipePath(tank, pump, manifoldY)
}

export { productStroke }

export function getConnections(state?: TwinLiveState): Record<string, any>[] {
  return (state?.connections || state?.tankPumpConnections || []) as Record<string, any>[]
}

export function pumpsHaveNoOverlap(nodes: ForecourtNode[]): boolean {
  return nodesHaveNoOverlap(nodes)
}

export function computePumpGridLayout(pumps: Record<string, any>[], _bounds?: unknown) {
  const nodes = buildSchematicNodes({
    layout: { mode: 'AUTO', items: [] },
    pumps,
    tanks: [],
  })
  return nodes
    .filter((n) => n.kind === 'PUMP')
    .map((n) => ({
      pump: pumps.find((p) => String(p.id) === n.id) || n.raw,
      x: n.x,
      y: n.y,
      w: n.w,
      h: n.h,
    }))
}

export function groupPumpsIntoRows<T>(items: T[], size = 2): T[][] {
  const rows: T[][] = []
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size))
  return rows
}

export { pumpStatusColor, groupPumpsIntoIslands }
