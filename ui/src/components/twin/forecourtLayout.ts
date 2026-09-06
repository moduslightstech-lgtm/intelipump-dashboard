import type { TwinLiveState } from '../../api/client'
import { pumpStatusColor } from '../../lib/pumpIdentity'
import { buildManifoldRoutes, pipePath as routePipePath } from './pipe/pipeRouting'
import { productPipeColor } from './pipe/pipeTheme'
import {
  assertNoPumpOverlaps,
  computePipeManifoldY,
  computePumpGridLayout,
  computePumpZoneTop,
  findNextFreePumpSlots,
  groupPumpsIntoRows,
  PUMP_CARD_H,
  PUMP_CARD_W,
  sortPumpsForLayout,
} from './pumpGridLayout'

export type ForecourtNode = {
  id: string
  kind: 'TANK' | 'PUMP' | 'OFFICE' | 'ENTRANCE' | 'EXIT' | 'LABEL' | 'FORECOURT'
  x: number
  y: number
  w: number
  h: number
  label: string
  status: string
  product?: string | null
  raw: Record<string, any>
}

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

const DEFAULT_W = 1200
const DEFAULT_H = 700
const MARGIN = 40
const TANK_BAND_Y = 70
const TANK_H = 70

function pumpBounds(canvasW: number, canvasH: number, tankBottom: number) {
  const top = computePumpZoneTop(tankBottom)
  const left = MARGIN + 90
  const right = canvasW - MARGIN - 100
  const bottom = canvasH - 80
  return {
    left,
    top,
    width: Math.max(200, right - left),
    height: Math.max(120, bottom - top),
  }
}

function tankNodesAuto(tanks: Record<string, any>[], canvasW: number): ForecourtNode[] {
  const usable = canvasW - 2 * MARGIN - 160
  const gap = 16
  const n = Math.max(tanks.length, 1)
  const tw = Math.max(100, Math.min(220, (usable - gap * (n - 1)) / n))
  const total = tanks.length * tw + gap * Math.max(0, tanks.length - 1)
  const startX = MARGIN + Math.max(0, (usable - total) / 2)
  return tanks.map((tank, i) => ({
    kind: 'TANK' as const,
    id: String(tank.id),
    x: startX + i * (tw + gap),
    y: TANK_BAND_Y,
    w: tw,
    h: TANK_H,
    label: String(tank.name || tank.tankCode || tank.id),
    status: String(tank.inferredStatus || tank.status || 'UNKNOWN'),
    product: tank.product as string | undefined,
    raw: tank,
  }))
}

function pumpNodesFromGrid(
  pumps: Record<string, any>[],
  bounds: ReturnType<typeof pumpBounds>,
): ForecourtNode[] {
  return computePumpGridLayout(pumps, bounds).map(({ pump, x, y, w, h }) => ({
    kind: 'PUMP' as const,
    id: String(pump.id),
    x,
    y,
    w,
    h,
    label: String(pump.mqttPumpId || pump.pumpCode || pump.id),
    status: String(pump.inferredStatus || pump.status || 'UNKNOWN'),
    product: pump.product as string | undefined,
    raw: pump,
  }))
}

function staticDecor(canvasW: number, canvasH: number, stationLabel?: string): ForecourtNode[] {
  return [
    {
      kind: 'LABEL',
      id: 'station-title',
      x: MARGIN,
      y: 18,
      w: 480,
      h: 28,
      label: stationLabel || 'Station',
      status: 'STATIC',
      raw: { role: 'station_title' },
    },
    {
      kind: 'FORECOURT',
      id: 'forecourt',
      x: MARGIN,
      y: 55,
      w: canvasW - 2 * MARGIN,
      h: canvasH - 95,
      label: 'Forecourt',
      status: 'STATIC',
      raw: { role: 'boundary' },
    },
    {
      kind: 'ENTRANCE',
      id: 'entrance',
      x: MARGIN + 8,
      y: canvasH / 2 - 20,
      w: 70,
      h: 28,
      label: 'ENTRANCE',
      status: 'STATIC',
      raw: {},
    },
    {
      kind: 'EXIT',
      id: 'exit',
      x: canvasW - MARGIN - 78,
      y: canvasH / 2 - 20,
      w: 70,
      h: 28,
      label: 'EXIT',
      status: 'STATIC',
      raw: {},
    },
    {
      kind: 'OFFICE',
      id: 'office',
      x: canvasW - MARGIN - 140,
      y: TANK_BAND_Y,
      w: 140,
      h: 70,
      label: 'Control room',
      status: 'STATIC',
      raw: {},
    },
  ]
}

function placeMissingPumpsCustom(
  existing: ForecourtNode[],
  pumps: Record<string, any>[],
  canvasW: number,
  canvasH: number,
): ForecourtNode[] {
  const placedIds = new Set(existing.filter((n) => n.kind === 'PUMP').map((n) => n.id))
  const missing = sortPumpsForLayout(pumps.filter((p) => !placedIds.has(String(p.id))))
  if (!missing.length) return existing

  const tanks = existing.filter((n) => n.kind === 'TANK')
  const tankBottom = tanks.length
    ? Math.max(...tanks.map((t) => t.y + t.h))
    : TANK_BAND_Y + TANK_H
  const bounds = pumpBounds(canvasW, canvasH, tankBottom)
  const occupied = existing
    .filter((n) => n.kind === 'PUMP')
    .map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h }))
  const slots = findNextFreePumpSlots(missing.length, occupied, bounds)

  const extras: ForecourtNode[] = missing.map((pump, i) => {
    const slot = slots[i]
    return {
      kind: 'PUMP' as const,
      id: String(pump.id),
      x: slot.x,
      y: slot.y,
      w: slot.w,
      h: slot.h,
      label: String(pump.mqttPumpId || pump.pumpCode || pump.id),
      status: String(pump.inferredStatus || pump.status || 'UNKNOWN'),
      product: pump.product as string | undefined,
      raw: pump,
    }
  })

  if (import.meta.env.DEV) {
    console.warn(
      `[forecourt] CUSTOM layout missing ${missing.length} pump(s); staged in free grid slots`,
    )
  }
  return [...existing, ...extras]
}

function placeMissingTanksCustom(
  existing: ForecourtNode[],
  tanks: Record<string, any>[],
  canvasW: number,
): ForecourtNode[] {
  const placedIds = new Set(existing.filter((n) => n.kind === 'TANK').map((n) => n.id))
  const missing = tanks.filter((t) => !placedIds.has(String(t.id)))
  if (!missing.length) return existing
  const auto = tankNodesAuto(missing, canvasW)
  return [...existing, ...auto]
}

function parseLayoutItems(
  state: TwinLiveState | undefined,
  tanks: Record<string, any>[],
  pumps: Record<string, any>[],
): ForecourtNode[] {
  const nodes: ForecourtNode[] = []
  for (const item of state?.layout?.items || []) {
    const assetType = String(item.assetType || item.asset_type || '').toUpperCase()
    if (assetType === 'NOZZLE' || assetType === 'DEVICE') continue
    const assetId = String(item.assetId || item.asset_id || item.id || '')
    const x = Number(item.x ?? item.x_position ?? 0)
    const y = Number(item.y ?? item.y_position ?? 0)
    const w = Number(item.width ?? 40)
    const h = Number(item.height ?? 40)
    const label = String(item.label || assetId)

    if (assetType === 'TANK') {
      const tank =
        tanks.find((t) => t.id === assetId || t.tankCode === assetId) || { id: assetId }
      nodes.push({
        kind: 'TANK',
        id: String(tank.id || assetId),
        x,
        y,
        w: Math.max(w, 110),
        h: Math.max(h, TANK_H),
        label: String(tank.name || tank.tankCode || label),
        status: String(tank.inferredStatus || tank.status || 'UNKNOWN'),
        product: tank.product as string | undefined,
        raw: tank as Record<string, any>,
      })
    } else if (assetType === 'PUMP') {
      const pump =
        pumps.find((p) => p.id === assetId || p.pumpCode === assetId) || { id: assetId }
      nodes.push({
        kind: 'PUMP',
        id: String(pump.id || assetId),
        x,
        y,
        w: Math.max(w, PUMP_CARD_W),
        h: Math.max(h, PUMP_CARD_H),
        label: String(pump.mqttPumpId || pump.pumpCode || label),
        status: String(pump.inferredStatus || pump.status || 'UNKNOWN'),
        product: pump.product as string | undefined,
        raw: pump as Record<string, any>,
      })
    } else if (assetType) {
      nodes.push({
        kind: assetType as ForecourtNode['kind'],
        id: assetId || label,
        x,
        y,
        w,
        h,
        label,
        status: 'STATIC',
        raw: item as Record<string, any>,
      })
    }
  }
  return nodes
}

/**
 * Build forecourt nodes.
 * AUTO: always recompute tank + pump grids (ignores stale pump coords).
 * CUSTOM: preserve saved positions; stage missing pumps in free grid slots.
 */
export function buildForecourtNodes(state?: TwinLiveState): ForecourtNode[] {
  const tanks = state?.tanks || []
  const pumps = (state?.pumps || []).filter((p) => !String(p.id || '').startsWith('ledger:'))
  const canvasW = Number(state?.layout?.canvasWidth || DEFAULT_W)
  const canvasH = Number(state?.layout?.canvasHeight || DEFAULT_H)
  const mode = String(state?.layout?.mode || 'AUTO').toUpperCase()

  if (mode === 'AUTO' || !state?.layout?.items?.length) {
    const stationLabel = state?.station
      ? `${(state.station as any).name || ''} (${(state.station as any).stationCode || (state.station as any).station_code || ''})`.trim()
      : 'Station'
    const tankNodes = tankNodesAuto(tanks, canvasW)
    const tankBottom = tankNodes.length
      ? Math.max(...tankNodes.map((t) => t.y + t.h))
      : TANK_BAND_Y + TANK_H
    const bounds = pumpBounds(canvasW, canvasH, tankBottom)
    const pumpNodes = pumpNodesFromGrid(pumps, bounds)
    const fromLayout = parseLayoutItems(state, tanks, pumps).filter(
      (n) => !['TANK', 'PUMP'].includes(n.kind),
    )
    const baseDecor = fromLayout.length ? fromLayout : staticDecor(canvasW, canvasH, stationLabel)
    return [...baseDecor, ...tankNodes, ...pumpNodes]
  }

  // CUSTOM
  let merged = parseLayoutItems(state, tanks, pumps)
  merged = placeMissingTanksCustom(merged, tanks, canvasW)
  merged = placeMissingPumpsCustom(merged, pumps, canvasW, canvasH)
  return merged
}

export function buildForecourtPipes(
  nodes: ForecourtNode[],
  connections: Record<string, any>[] | undefined,
): ForecourtPipe[] {
  if (!connections?.length) return []
  const { routes } = buildManifoldRoutes(nodes, connections)
  return routes.map((r) => ({
    id: r.id,
    tankId: r.tankId,
    pumpId: r.pumpId,
    product: r.product,
    lineLabel: r.lineLabel,
    source: r.mappingSource,
    d: r.path,
    midX: (r.source.x + r.target.x) / 2,
    midY: r.manifoldY,
    connection: r.connection as Record<string, any>,
  }))
}

/** Shared manifold rail path under tanks (visual trunk). */
export function buildManifoldPath(nodes: ForecourtNode[]): string | null {
  const tanks = nodes.filter((n) => n.kind === 'TANK')
  const pumps = nodes.filter((n) => n.kind === 'PUMP')
  if (!tanks.length || !pumps.length) return null
  const tankBottom = Math.max(...tanks.map((t) => t.y + t.h))
  const pumpTop = Math.min(...pumps.map((p) => p.y))
  const y = computePipeManifoldY(tankBottom, pumpTop, 0)
  const xs = [...tanks.map((t) => t.x + t.w / 2), ...pumps.map((p) => p.x + p.w / 2)]
  return `M ${Math.min(...xs)} ${y} L ${Math.max(...xs)} ${y}`
}

export function pipePath(
  tank: { x: number; y: number; w: number; h: number },
  pump: { x: number; y: number; w: number; h: number },
  manifoldY?: number,
): { d: string; midX: number; midY: number } {
  return routePipePath(tank, pump, manifoldY)
}

export function productStroke(product?: string | null): string {
  return productPipeColor(product)
}

export function getConnections(state?: TwinLiveState): Record<string, any>[] {
  return (state?.connections || state?.tankPumpConnections || []) as Record<string, any>[]
}

/** Test helper: pump cards must not overlap after layout. */
export function pumpsHaveNoOverlap(nodes: ForecourtNode[]): boolean {
  return assertNoPumpOverlaps(
    nodes.filter((n) => n.kind === 'PUMP').map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h })),
  )
}

export { pumpStatusColor, computePumpGridLayout, groupPumpsIntoRows }
