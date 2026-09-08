import type { TwinLiveState } from '../../../api/client'
import {
  DEFAULT_METRICS,
  ISLAND_GAP_X,
  ISLAND_GAP_Y,
  ISLAND_PAD_X,
  ISLAND_PAD_Y,
  LANE_GAP,
  MARKER_H,
  MARKER_W,
  MAX_CANVAS_H,
  MIN_CANVAS_H,
  MIN_CANVAS_W,
  MIN_NODE_GAP,
  MARGIN,
  OFFICE_CLEARANCE,
  OFFICE_H,
  OFFICE_W,
  PIPE_BAND_BASE,
  PUMP_HORIZONTAL_GAP,
  PUMP_NODE_WIDTH,
  PUMP_VERTICAL_GAP,
  TANK_BAND_Y,
  TANK_GAP,
  type LayoutMetrics,
  islandSize,
} from './constants'
import { aggregatePhysicalPumpStatus, nozzlesForPhysicalPump } from './physicalPump'
import { assertNoNodeOverlap, rectsOverlap, snapToGrid } from './geometry'
import type { LayoutPersist, LayoutPersistItem, SchematicNode } from './types'

export type IslandGroup = {
  islandId: string
  islandNumber: number | null
  pumps: Record<string, any>[]
  physicalPump?: Record<string, any>
}

export function sortPumpsForLayout(pumps: Record<string, any>[]): Record<string, any>[] {
  return [...pumps].sort((a, b) => {
    const ao = Number(a.displayOrder ?? a.display_order ?? a.pumpNumber ?? a.pump_number ?? 9999)
    const bo = Number(b.displayOrder ?? b.display_order ?? b.pumpNumber ?? b.pump_number ?? 9999)
    if (ao !== bo) return ao - bo
    const an = Number(a.pumpNumber ?? a.pump_number)
    const bn = Number(b.pumpNumber ?? b.pump_number)
    if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an - bn
    const ac = String(a.name || a.mqttPumpId || a.pumpCode || a.id || '')
    const bc = String(b.name || b.mqttPumpId || b.pumpCode || b.id || '')
    return ac.localeCompare(bc)
  })
}

export function groupPumpsIntoIslands(pumps: Record<string, any>[]): IslandGroup[] {
  const sorted = sortPumpsForLayout(pumps.filter((p) => !String(p.id || '').startsWith('ledger:')))
  return sorted.map((pump, idx) => {
    const nozzles = nozzlesForPhysicalPump(pump)
    return {
      islandId: `shell-${pump.id}`,
      islandNumber: idx + 1,
      physicalPump: pump,
      pumps: nozzles,
    }
  })
}

export function pumpShellSize(nozzleCount: number, metrics: LayoutMetrics = DEFAULT_METRICS) {
  const n = Math.max(1, nozzleCount)
  const cols = Math.min(2, n)
  const rows = Math.ceil(n / cols)
  return {
    w: ISLAND_PAD_X * 2 + cols * metrics.pumpW + Math.max(0, cols - 1) * PUMP_HORIZONTAL_GAP,
    h: ISLAND_PAD_Y + rows * metrics.pumpH + Math.max(0, rows - 1) * 28 + 16,
  }
}

export function schematicViewportHeight(opts: {
  physicalPumpCount: number
  canvasHeight: number
  viewportHeight?: number
}): number {
  const n = Math.max(1, opts.physicalPumpCount)
  const minH = n <= 2 ? 580 : n <= 6 ? 640 : 720
  const vh = opts.viewportHeight ?? (typeof window === 'undefined' ? 900 : window.innerHeight)
  const maxFromPage = Math.max(minH, Math.round(vh * 0.62))
  const topology = Math.max(minH, opts.canvasHeight + 12)
  return Math.min(Math.max(minH, topology), Math.min(maxFromPage, MAX_CANVAS_H))
}

export function islandColumnCount(viewportWidth: number): number {
  if (viewportWidth < 768) return 1
  if (viewportWidth < 1280) return 2
  return 3
}

export function pipeBandHeight(tankCount: number): number {
  return PIPE_BAND_BASE + Math.max(0, tankCount - 1) * LANE_GAP
}

function catalogPumps(state?: TwinLiveState) {
  return (state?.pumps || []).filter((p) => !String(p.id || '').startsWith('ledger:'))
}

function stationLabel(state?: TwinLiveState): string {
  const s = state?.station
  if (!s) return 'Station'
  const name = s.name || 'Station'
  const code = s.stationCode || s.station_code || ''
  return code ? `${name} (${code})` : name
}

export type LayoutOptions = {
  viewportWidth?: number
  drawerWidth?: number
  metrics?: LayoutMetrics
}

export function buildAutoForecourtLayout(
  state?: TwinLiveState,
  viewportWidthOrOpts: number | LayoutOptions = 1440,
): { nodes: SchematicNode[]; canvasWidth: number; canvasHeight: number } {
  const opts: LayoutOptions =
    typeof viewportWidthOrOpts === 'number'
      ? { viewportWidth: viewportWidthOrOpts }
      : viewportWidthOrOpts
  const viewportWidth = opts.viewportWidth ?? 1440
  const metrics = opts.metrics || DEFAULT_METRICS
  const drawerWidth = opts.drawerWidth ?? 0
  const usableW = Math.max(520, viewportWidth - drawerWidth)

  const tanks = state?.tanks || []
  const pumps = catalogPumps(state)
  const islands = groupPumpsIntoIslands(pumps)
  const cols = islandColumnCount(viewportWidth)
  const rows = Math.max(1, Math.ceil(Math.max(islands.length, 1) / cols))
  const band = pipeBandHeight(tanks.length)
  const sizes = islands.map((g) => pumpShellSize(g.pumps.length, metrics))
  const isle = sizes.length
    ? { w: Math.max(...sizes.map((s) => s.w)), h: Math.max(...sizes.map((s) => s.h)) }
    : islandSize(metrics)

  const tankRowW =
    tanks.length > 0 ? tanks.length * metrics.tankW + (tanks.length - 1) * TANK_GAP : metrics.tankW
  const islandRowW =
    Math.min(Math.max(islands.length, 1), cols) * isle.w +
    Math.max(0, Math.min(Math.max(islands.length, 1), cols) - 1) * ISLAND_GAP_X
  const coreW = Math.max(tankRowW, islandRowW)
  const canvasWidth = Math.max(
    MIN_CANVAS_W,
    Math.min(Math.max(usableW, 640), Math.ceil(coreW + OFFICE_W + OFFICE_CLEARANCE + MARGIN * 2)),
    Math.ceil(coreW + MARGIN * 2 + 24),
  )

  const pumpTop = TANK_BAND_Y + metrics.tankH + band
  const islandsBlockH = rows * isle.h + Math.max(0, rows - 1) * ISLAND_GAP_Y
  const canvasHeight = Math.min(
    MAX_CANVAS_H,
    Math.max(MIN_CANVAS_H, pumpTop + islandsBlockH + MARKER_H + 40),
  )

  const groupLeft = MARGIN + Math.max(0, (canvasWidth - MARGIN * 2 - OFFICE_W - OFFICE_CLEARANCE - coreW) / 2)
  const nodes: SchematicNode[] = []

  nodes.push({
    id: 'station-title',
    kind: 'LABEL',
    x: MARGIN,
    y: 12,
    w: 480,
    h: 22,
    label: stationLabel(state),
    status: 'STATIC',
    raw: { role: 'station_title' },
  })

  nodes.push({
    id: 'forecourt',
    kind: 'FORECOURT',
    x: MARGIN,
    y: 40,
    w: canvasWidth - MARGIN * 2,
    h: canvasHeight - 56,
    label: 'Forecourt',
    status: 'STATIC',
    raw: { role: 'boundary' },
  })

  nodes.push({
    id: 'office',
    kind: 'OFFICE',
    x: canvasWidth - MARGIN - OFFICE_W,
    y: TANK_BAND_Y,
    w: OFFICE_W,
    h: OFFICE_H,
    label: 'Control room',
    status: 'STATIC',
    raw: {},
  })

  nodes.push({
    id: 'entrance',
    kind: 'ENTRANCE',
    x: MARGIN + 8,
    y: canvasHeight - MARKER_H - 12,
    w: MARKER_W,
    h: MARKER_H,
    label: 'ENTRANCE',
    status: 'STATIC',
    raw: {},
  })

  nodes.push({
    id: 'exit',
    kind: 'EXIT',
    x: canvasWidth - MARGIN - MARKER_W - 8,
    y: canvasHeight - MARKER_H - 12,
    w: MARKER_W,
    h: MARKER_H,
    label: 'EXIT',
    status: 'STATIC',
    raw: {},
  })

  const tankTotal = tanks.length * metrics.tankW + Math.max(0, tanks.length - 1) * TANK_GAP
  const tankStart = snapToGrid(groupLeft + Math.max(0, (coreW - tankTotal) / 2))
  tanks.forEach((tank, i) => {
    nodes.push({
      id: String(tank.id),
      kind: 'TANK',
      x: tankStart + i * (metrics.tankW + TANK_GAP),
      y: TANK_BAND_Y,
      w: metrics.tankW,
      h: metrics.tankH,
      label: String(tank.name || tank.tankCode || tank.id),
      status: String(tank.inferredStatus || tank.status || 'UNKNOWN'),
      product: tank.product as string | undefined,
      assetId: String(tank.id),
      raw: tank,
    })
  })

  islands.forEach((island, idx) => {
    const col = idx % cols
    const row = Math.floor(idx / cols)
    const countInRow = Math.min(cols, islands.length - row * cols)
    const rowW = countInRow * isle.w + (countInRow - 1) * ISLAND_GAP_X
    const rowLeft = snapToGrid(groupLeft + Math.max(0, (coreW - rowW) / 2))
    const shell = sizes[idx] || isle
    const ix = rowLeft + col * (isle.w + ISLAND_GAP_X)
    const iy = snapToGrid(pumpTop) + row * (isle.h + ISLAND_GAP_Y)
    const physical = island.physicalPump || island.pumps[0]
    const pumpName = String(physical?.name || `Pump ${idx + 1}`)
    const nozzleStatuses = island.pumps.map((p) => String(p.inferredStatus || p.status || 'UNKNOWN'))

    nodes.push({
      id: island.islandId,
      kind: 'ISLAND',
      x: ix,
      y: iy,
      w: shell.w,
      h: shell.h,
      label: pumpName,
      status: aggregatePhysicalPumpStatus(nozzleStatuses),
      assetId: String(physical?.id || island.islandId),
      raw: {
        ...physical,
        islandNumber: island.islandNumber,
        pumpIds: island.pumps.map((p) => String(p.id)),
        nozzleCount: island.pumps.length,
        assetRole: 'PHYSICAL_PUMP',
      },
    })

    const innerCols = Math.min(2, Math.max(1, island.pumps.length))
    island.pumps.forEach((pump, pi) => {
      const icol = pi % innerCols
      const irow = Math.floor(pi / innerCols)
      nodes.push({
        id: String(pump.id),
        kind: 'PUMP',
        x: ix + ISLAND_PAD_X + icol * (metrics.pumpW + PUMP_HORIZONTAL_GAP),
        y: iy + ISLAND_PAD_Y + irow * (metrics.pumpH + 28),
        w: metrics.pumpW,
        h: metrics.pumpH,
        label: String(pump.name || `Nozzle ${pi + 1}`),
        status: String(pump.inferredStatus || pump.status || 'UNKNOWN'),
        product: pump.product as string | undefined,
        parentId: island.islandId,
        islandId: island.islandId,
        assetId: String(pump.id),
        raw: { ...pump, assetRole: 'NOZZLE', parentPumpId: String(physical?.id || '') },
      })
    })
  })

  return { nodes, canvasWidth, canvasHeight }
}

function parseSavedItems(state?: TwinLiveState, metrics: LayoutMetrics = DEFAULT_METRICS): SchematicNode[] {
  const tanks = state?.tanks || []
  const pumps = catalogPumps(state)
  const isle = islandSize(metrics)
  const nodes: SchematicNode[] = []
  for (const item of state?.layout?.items || []) {
    const assetType = String(item.assetType || item.asset_type || '').toUpperCase()
    if (assetType === 'DEVICE') continue
    const assetId = String(item.assetId || item.asset_id || item.id || '')
    const x = Number(item.x ?? item.x_position ?? 0)
    const y = Number(item.y ?? item.y_position ?? 0)
    const w = Number(item.width ?? 40)
    const h = Number(item.height ?? 40)
    const cfg = (item.configuration || item.configuration_json || {}) as Record<string, any>
    if (assetType === 'TANK') {
      const tank = tanks.find((t) => t.id === assetId || t.tankCode === assetId) || { id: assetId }
      nodes.push({
        id: String(tank.id || assetId),
        kind: 'TANK',
        x,
        y,
        w: Math.max(w, metrics.tankW),
        h: Math.max(h, metrics.tankH),
        label: String(tank.name || tank.tankCode || item.label || assetId),
        status: String(tank.inferredStatus || tank.status || 'UNKNOWN'),
        product: tank.product as string | undefined,
        assetId: String(tank.id || assetId),
        raw: tank as Record<string, any>,
      })
    } else if (assetType === 'PUMP') {
      const pump = pumps.find((p) => p.id === assetId || p.pumpCode === assetId) || { id: assetId }
      nodes.push({
        id: String(pump.id || assetId),
        kind: 'PUMP',
        x,
        y,
        w: PUMP_NODE_WIDTH,
        h: Math.max(h, metrics.pumpH),
        label: String(pump.name || pump.mqttPumpId || pump.pumpCode || item.label || assetId),
        status: String(pump.inferredStatus || pump.status || 'UNKNOWN'),
        product: pump.product as string | undefined,
        islandId: cfg.islandId ? String(cfg.islandId) : undefined,
        parentId: cfg.islandId ? String(cfg.islandId) : undefined,
        assetId: String(pump.id || assetId),
        raw: {
          ...pump,
          assetRole: 'NOZZLE',
          parentPumpId: String(cfg.physicalPumpId || cfg.islandId || pump.id || assetId),
        },
      })
    } else if (assetType === 'NOZZLE') {
      const pump = pumps.find((p) =>
        (p.nozzles || []).some((n: any) => n.id === assetId || n.nozzleCode === assetId),
      )
      const nozzle =
        (pump?.nozzles || []).find((n: any) => n.id === assetId || n.nozzleCode === assetId) || {
          id: assetId,
        }
      nodes.push({
        id: String(nozzle.id || assetId),
        kind: 'PUMP',
        x,
        y,
        w: PUMP_NODE_WIDTH,
        h: Math.max(h, metrics.pumpH),
        label: String(nozzle.name || item.label || `Nozzle`),
        status: String(nozzle.inferredStatus || nozzle.status || 'UNKNOWN'),
        product: nozzle.product as string | undefined,
        islandId: cfg.islandId || cfg.physicalPumpId ? String(cfg.islandId || cfg.physicalPumpId) : undefined,
        parentId: cfg.islandId || cfg.physicalPumpId ? String(cfg.islandId || cfg.physicalPumpId) : undefined,
        assetId: String(nozzle.id || assetId),
        raw: { ...nozzle, assetRole: 'NOZZLE' },
      })
    } else if (assetType === 'ISLAND') {
      const rawLabel = String(item.label || 'Pump')
      const label = /^island\s+/i.test(rawLabel) ? rawLabel.replace(/^island/i, 'Pump') : rawLabel
      nodes.push({
        id: assetId || String(item.id || item.label),
        kind: 'ISLAND',
        x,
        y,
        w: Math.max(w, isle.w),
        h: Math.max(h, isle.h),
        label,
        status: 'STATIC',
        raw: { ...cfg, assetRole: 'PHYSICAL_PUMP' },
      })
    } else if (assetType) {
      nodes.push({
        id: assetId || String(item.label || assetType),
        kind: assetType as SchematicNode['kind'],
        x,
        y,
        w,
        h,
        label: String(item.label || assetType),
        status: 'STATIC',
        raw: item as Record<string, any>,
      })
    }
  }
  return nodes
}

function nudgeOffEquipment(node: SchematicNode, others: SchematicNode[]): SchematicNode {
  const placed = { ...node }
  const blockers = others.filter((n) => ['TANK', 'PUMP', 'OFFICE', 'ISLAND'].includes(n.kind))
  for (let i = 0; i < 32; i++) {
    const hit = blockers.find((b) => rectsOverlap(placed, b, MIN_NODE_GAP))
    if (!hit) break
    placed.x = hit.x + hit.w + Math.max(MIN_NODE_GAP, PUMP_HORIZONTAL_GAP)
    if (i % 6 === 5) {
      placed.x = node.x
      placed.y = hit.y + hit.h + ISLAND_GAP_Y
    }
  }
  return placed
}

function attachMissingEquipment(
  existing: SchematicNode[],
  state: TwinLiveState | undefined,
  opts: LayoutOptions,
): SchematicNode[] {
  const auto = buildAutoForecourtLayout(state, opts).nodes
  const extras = auto.filter((n) => {
    if (n.kind !== 'TANK' && n.kind !== 'PUMP') return false
    if (existing.some((e) => e.id === n.id)) return false
    if (n.kind === 'PUMP') {
      const parent = String(n.raw?.parentPumpId || '')
      const covered = existing.some(
        (e) =>
          e.kind === 'PUMP' &&
          (e.id === parent ||
            String(e.raw?.parentPumpId || '') === parent ||
            e.assetId === parent ||
            e.id === String(n.assetId || '')),
      )
      if (covered) return false
    }
    return true
  })
  if (!extras.length) return existing
  const next = [...existing]
  for (const extra of extras) {
    const placed = extra.kind === 'PUMP' || extra.kind === 'TANK' ? nudgeOffEquipment(extra, next) : extra
    if (extra.kind === 'PUMP' && extra.parentId && !next.some((n) => n.id === extra.parentId)) {
      const island = auto.find((n) => n.id === extra.parentId)
      if (island) {
        next.push({
          ...island,
          x: island.x + (placed.x - extra.x),
          y: island.y + (placed.y - extra.y),
        })
      }
    }
    next.push(placed)
  }
  return next
}

export function buildForecourtNodes(
  state?: TwinLiveState,
  viewportWidthOrOpts: number | LayoutOptions = 1440,
): SchematicNode[] {
  const opts: LayoutOptions =
    typeof viewportWidthOrOpts === 'number'
      ? { viewportWidth: viewportWidthOrOpts }
      : viewportWidthOrOpts
  const metrics = opts.metrics || DEFAULT_METRICS
  const mode = String(state?.layout?.mode || 'AUTO').toUpperCase()
  if (mode !== 'CUSTOM' || !state?.layout?.items?.length) {
    return buildAutoForecourtLayout(state, opts).nodes
  }
  let merged = parseSavedItems(state, metrics)
  merged = attachMissingEquipment(merged, state, opts)
  const hasDecor = merged.some((n) => n.kind === 'OFFICE' || n.kind === 'ENTRANCE')
  if (!hasDecor) {
    const auto = buildAutoForecourtLayout(state, opts).nodes
    merged = [...auto.filter((n) => !['TANK', 'PUMP', 'ISLAND'].includes(n.kind)), ...merged]
  }
  return merged
}

export function autoArrangeNodes(
  state?: TwinLiveState,
  viewportWidthOrOpts: number | LayoutOptions = 1440,
): SchematicNode[] {
  return buildForecourtNodes(
    { ...state, layout: { ...(state?.layout || {}), mode: 'AUTO', items: [] } },
    viewportWidthOrOpts,
  )
}

export function topologyKey(state?: TwinLiveState): string {
  const tanks = (state?.tanks || []).map((t) => t.id).join(',')
  const pumps = catalogPumps(state)
    .map((p) => `${p.id}:${p.islandNumber ?? p.island_number ?? ''}`)
    .join(',')
  const conns = (state?.connections || state?.tankPumpConnections || [])
    .map((c: any) => `${c.id}:${c.tankId}:${c.pumpId}:${c.active}:${c.isPrimary}`)
    .join(',')
  return `${state?.layout?.mode || 'AUTO'}|${tanks}|${pumps}|${conns}`
}

export function canvasSizeFromNodes(nodes: SchematicNode[]): { width: number; height: number } {
  const content = nodes.filter((n) => n.kind !== 'FORECOURT')
  if (!content.length) return { width: MIN_CANVAS_W, height: MIN_CANVAS_H }
  const width = Math.max(
    MIN_CANVAS_W,
    Math.ceil(Math.max(...content.map((n) => n.x + n.w)) + MARGIN),
  )
  const height = Math.min(
    MAX_CANVAS_H,
    Math.max(MIN_CANVAS_H, Math.ceil(Math.max(...content.map((n) => n.y + n.h)) + MARGIN)),
  )
  return { width, height }
}

export function layoutItemsFromNodes(nodes: SchematicNode[]): LayoutPersistItem[] {
  return nodes
    .filter((n) => n.kind !== 'FORECOURT' && n.kind !== 'LABEL')
    .map((n, idx) => ({
      asset_type: n.kind,
      asset_id: n.kind === 'TANK' || n.kind === 'PUMP' ? n.id : n.assetId || n.id,
      label: n.label,
      x_position: n.x,
      y_position: n.y,
      width: n.w,
      height: n.h,
      rotation: 0,
      z_index: idx,
      configuration_json:
        n.kind === 'PUMP'
          ? { islandId: n.islandId || n.parentId || null, product: n.product || null }
          : n.kind === 'ISLAND'
            ? { pumpIds: n.raw?.pumpIds || [] }
            : null,
    }))
}

export function toLayoutPersist(nodes: SchematicNode[], name = 'Custom'): LayoutPersist {
  const { width, height } = canvasSizeFromNodes(nodes)
  return {
    name,
    canvas_width: width,
    canvas_height: height,
    items: layoutItemsFromNodes(nodes),
  }
}

export function equipmentBoxes(nodes: SchematicNode[]) {
  return nodes.filter((n) => ['TANK', 'PUMP', 'OFFICE', 'ENTRANCE', 'EXIT'].includes(n.kind))
}

export function metricsFromMeasured(
  measured: Array<{ type?: string; width?: number | null; height?: number | null }>,
  base: LayoutMetrics = DEFAULT_METRICS,
): LayoutMetrics {
  const next = { ...base }
  for (const n of measured) {
    const w = Number(n.width)
    const h = Number(n.height)
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) continue
    if (n.type === 'pump') {
      next.pumpW = Math.max(next.pumpW, Math.ceil(w))
      next.pumpH = Math.max(next.pumpH, Math.ceil(h))
    }
    if (n.type === 'tank') {
      next.tankW = Math.max(next.tankW, Math.ceil(w))
      next.tankH = Math.max(next.tankH, Math.ceil(h))
    }
  }
  return next
}

export function metricsGrew(prev: LayoutMetrics, next: LayoutMetrics, slop = 1): boolean {
  return (
    next.pumpW > prev.pumpW + slop ||
    next.pumpH > prev.pumpH + slop ||
    next.tankW > prev.tankW + slop ||
    next.tankH > prev.tankH + slop
  )
}

export function nodesHaveNoOverlap(nodes: SchematicNode[]): boolean {
  return assertNoNodeOverlap(equipmentBoxes(nodes), 4)
}

export function horizontalGap(a: { x: number; w: number }, b: { x: number; w: number }): number {
  if (a.x > b.x) return horizontalGap(b, a)
  return b.x - (a.x + a.w)
}

export function verticalGap(a: { y: number; h: number }, b: { y: number; h: number }): number {
  if (a.y > b.y) return verticalGap(b, a)
  return b.y - (a.y + a.h)
}

function rectsVerticallyOverlap(a: SchematicNode, b: SchematicNode) {
  return a.y < b.y + b.h && b.y < a.y + a.h
}
function rectsHorizontallyOverlap(a: SchematicNode, b: SchematicNode) {
  return a.x < b.x + b.w && b.x < a.x + a.w
}

/** True when pump cards intersect or sit closer than the required gaps. */
export function pumpCardsConflict(
  nodes: SchematicNode[],
  minHorizontal = PUMP_HORIZONTAL_GAP,
  minVertical = PUMP_VERTICAL_GAP,
): boolean {
  const pumps = nodes.filter((n) => n.kind === 'PUMP')
  for (let i = 0; i < pumps.length; i++) {
    for (let j = i + 1; j < pumps.length; j++) {
      const a = pumps[i]
      const b = pumps[j]
      if (rectsOverlap(a, b, 0)) return true
      if (rectsVerticallyOverlap(a, b) && horizontalGap(a, b) < minHorizontal) return true
      if (rectsHorizontallyOverlap(a, b) && verticalGap(a, b) < minVertical) return true
    }
  }
  return false
}

export function detectOverlappingEquipment(nodes: SchematicNode[]): boolean {
  return !nodesHaveNoOverlap(nodes) || pumpCardsConflict(nodes)
}

export function minGap(a: SchematicNode, b: SchematicNode): number {
  const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w))
  const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h))
  if (dx === 0 && dy === 0) return 0
  if (rectsVerticallyOverlap(a, b)) return dx
  if (rectsHorizontallyOverlap(a, b)) return dy
  return Math.hypot(dx, dy)
}

export function pumpsInSameIsland(a: SchematicNode, b: SchematicNode) {
  return Boolean((a.parentId || a.islandId) && (a.parentId || a.islandId) === (b.parentId || b.islandId))
}

export function islandInteriorFitsPumps(island: SchematicNode, pumps: SchematicNode[]): boolean {
  const kids = pumps.filter((p) => p.parentId === island.id || p.islandId === island.id)
  if (!kids.length) return true
  if (pumpCardsConflict(kids)) return false
  return kids.every(
    (p) =>
      p.x >= island.x &&
      p.y >= island.y &&
      p.x + p.w <= island.x + island.w &&
      p.y + p.h <= island.y + island.h,
  )
}

export { MIN_NODE_GAP }
export const TITLE_Y = 16
