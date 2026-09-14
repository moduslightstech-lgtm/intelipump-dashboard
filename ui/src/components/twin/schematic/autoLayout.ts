import type { TwinLiveState } from '../../../api/client'
import {
  DEFAULT_METRICS,
  DECORATIVE_LAYOUT_IDS,
  DECORATIVE_LAYOUT_KINDS,
  DECORATIVE_LAYOUT_LABELS,
  DISPENSER_HEIGHT,
  HOSE_OVERHANG,
  ISLAND_GAP_X,
  ISLAND_GAP_Y,
  LANE_GAP,
  LAYOUT_SCHEMA_VERSION,
  LCD_EXTRA_ROW_H,
  MAX_CANVAS_H,
  MIN_CANVAS_H,
  MIN_CANVAS_W,
  MIN_NODE_GAP,
  MARGIN,
  PIPE_BAND_BASE,
  PIPE_PORT_SIZE,
  physicalPumpIdAliases,
  PUMP_HORIZONTAL_GAP,
  PUMP_VERTICAL_GAP,
  TANK_BAND_Y,
  TANK_GAP,
  type LayoutMetrics,
  islandSize,
} from './constants'
import { aggregatePhysicalPumpStatus, friendlyNozzleName, nozzlesForPhysicalPump } from './physicalPump'
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
    w: HOSE_OVERHANG * 2 + metrics.pumpW,
    h: metrics.pumpH + Math.max(0, rows - 1) * LCD_EXTRA_ROW_H,
  }
}

export function nozzlePortBox(
  island: { x: number; y: number; w: number; h: number },
  index: number,
  count: number,
): { x: number; y: number; w: number; h: number } {
  const n = Math.max(1, count)
  const cols = Math.min(2, n)
  const col = index % cols
  const row = Math.floor(index / cols)
  const cabinetX = island.x + HOSE_OVERHANG
  const cabinetW = Math.max(PIPE_PORT_SIZE, island.w - HOSE_OVERHANG * 2)
  const slot = cabinetW / cols
  return {
    x: cabinetX + col * slot + slot / 2 - PIPE_PORT_SIZE / 2,
    y: island.y + 8 + row * LCD_EXTRA_ROW_H,
    w: PIPE_PORT_SIZE,
    h: PIPE_PORT_SIZE,
  }
}

export function isDecorativeLayoutKind(kind?: string | null): boolean {
  const k = String(kind || '').trim().toUpperCase()
  return (DECORATIVE_LAYOUT_KINDS as readonly string[]).includes(k)
}

export function isDecorativeLayoutNode(
  node: { kind?: string; id?: string; label?: string; assetId?: string } | null | undefined,
): boolean {
  if (!node) return false
  if (isDecorativeLayoutKind(node.kind)) return true
  const ids = [node.id, node.assetId].map((v) => String(v || '').trim().toLowerCase())
  if (ids.some((id) => DECORATIVE_LAYOUT_IDS.has(id))) return true
  const label = String(node.label || '').trim().toLowerCase()
  return Boolean(label) && DECORATIVE_LAYOUT_LABELS.has(label)
}

export function stripDecorativeLayoutNodes<T extends { kind?: string; id?: string; label?: string; assetId?: string }>(
  nodes: T[],
): T[] {
  return nodes.filter((n) => !isDecorativeLayoutNode(n))
}

export function schematicViewportHeight(opts: {
  physicalPumpCount: number
  canvasHeight: number
  viewportHeight?: number
}): number {
  const n = Math.max(1, opts.physicalPumpCount)
  const minH = n <= 2 ? 640 : n <= 6 ? 720 : 780
  const vh = opts.viewportHeight ?? (typeof window === 'undefined' ? 900 : window.innerHeight)
  // Fill most of the viewport now that tank/pump list widgets are gone.
  const maxFromPage = Math.max(minH, Math.round(vh * 0.78))
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

function catalogNozzleEntries(pumps: Record<string, any>[]) {
  return pumps.flatMap((pump) =>
    nozzlesForPhysicalPump(pump).map((nozzle, index) => ({ pump, nozzle, index })),
  )
}

function savedItemConfig(item: Record<string, any>): Record<string, any> {
  return (item.configuration || item.configuration_json || {}) as Record<string, any>
}

function resolveSavedPumpNozzle(
  assetId: string,
  item: Record<string, any>,
  pumps: Record<string, any>[],
  claimed: Set<string>,
): { nozzle: Record<string, any>; pump: Record<string, any>; index: number } | null {
  const entries = catalogNozzleEntries(pumps)
  const unused = () => entries.filter((e) => !claimed.has(String(e.nozzle.id)))
  const hit = unused().find(
    (e) =>
      e.nozzle.id === assetId ||
      e.nozzle.nozzleCode === assetId ||
      e.nozzle.sourceIdentifier === assetId ||
      e.nozzle.mqttNozzleId === assetId ||
      e.nozzle.mqttPumpId === assetId,
  )
  if (hit) return hit

  const parent = pumps.find(
    (p) => p.id === assetId || p.pumpCode === assetId || p.mqttPumpId === assetId,
  )
  if (parent) {
    const nested = unused().filter((e) => e.pump.id === parent.id)
    if (nested[0]) return nested[0]
  }

  const cfg = savedItemConfig(item)
  const islandId = String(cfg.islandId || cfg.physicalPumpId || '')
  if (islandId) {
    const onIsland = unused().find(
      (e) => `shell-${e.pump.id}` === islandId || String(e.pump.id) === islandId,
    )
    if (onIsland) return onIsland
  }

  const label = String(item.label || '').trim()
  if (label) {
    const bySource = unused().find((e) => {
      if (e.nozzle.sourceIdentifier === label || e.nozzle.mqttPumpId === label) return true
      if (/^pump[\s_-]*2$/i.test(label) && /2$/.test(String(e.nozzle.sourceIdentifier || e.nozzle.nozzleCode || ''))) {
        return true
      }
      return false
    })
    if (bySource) return bySource
  }

  if (pumps.length === 1) {
    const only = unused()[0]
    if (only) return only
  }
  return null
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
    Math.min(Math.max(usableW, 640), Math.ceil(coreW + MARGIN * 2 + 48)),
    Math.ceil(coreW + MARGIN * 2 + 24),
  )

  const pumpTop = TANK_BAND_Y + metrics.tankH + band
  const islandsBlockH = rows * isle.h + Math.max(0, rows - 1) * ISLAND_GAP_Y
  const contentHeight = pumpTop + islandsBlockH + 48
  const canvasHeight = Math.min(MAX_CANVAS_H, Math.max(MIN_CANVAS_H, contentHeight))

  const groupLeft = MARGIN + Math.max(0, (canvasWidth - MARGIN * 2 - coreW) / 2)
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

    island.pumps.forEach((pump, pi) => {
      const port = nozzlePortBox({ x: ix, y: iy, w: shell.w, h: shell.h }, pi, island.pumps.length)
      nodes.push({
        id: String(pump.id),
        kind: 'PUMP',
        x: port.x,
        y: port.y,
        w: port.w,
        h: port.h,
        label: friendlyNozzleName(pump, pi),
        status: String(pump.inferredStatus || pump.status || 'UNKNOWN'),
        product: pump.product as string | undefined,
        parentId: island.islandId,
        islandId: island.islandId,
        assetId: String(pump.id),
        raw: { ...pump, assetRole: 'NOZZLE', parentPumpId: String(physical?.id || ''), parentPumpName: pumpName },
      })
    })
  })

  return { nodes: stripDecorativeLayoutNodes(nodes), canvasWidth, canvasHeight }
}

function parseSavedItems(state?: TwinLiveState, metrics: LayoutMetrics = DEFAULT_METRICS): SchematicNode[] {
  const tanks = state?.tanks || []
  const pumps = catalogPumps(state)
  const claimedNozzles = new Set<string>()
  const isle = islandSize(metrics)
  const nodes: SchematicNode[] = []
  for (const item of state?.layout?.items || []) {
    const assetType = String(item.assetType || item.asset_type || '').toUpperCase()
    if (assetType === 'DEVICE') continue
    if (isDecorativeLayoutKind(assetType)) continue
    const assetId = String(item.assetId || item.asset_id || item.id || '')
    if (isDecorativeLayoutNode({ kind: assetType, id: assetId, label: String(item.label || '') })) continue
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
      const resolved = resolveSavedPumpNozzle(assetId, item as Record<string, any>, pumps, claimedNozzles)
      if (!resolved) continue
      claimedNozzles.add(String(resolved.nozzle.id))
      const { nozzle, pump, index } = resolved
      const parentId = String(cfg.islandId || `shell-${pump.id}`)
      const islandBox = nodes.find((n) => n.id === parentId && n.kind === 'ISLAND')
      const siblings = (islandBox?.raw?.pumpIds as string[] | undefined)?.length || 2
      const port = islandBox
        ? nozzlePortBox(islandBox, index, Math.max(siblings, index + 1))
        : { x, y, w: PIPE_PORT_SIZE, h: PIPE_PORT_SIZE }
      nodes.push({
        id: String(nozzle.id),
        kind: 'PUMP',
        x: port.x,
        y: port.y,
        w: port.w,
        h: port.h,
        label: friendlyNozzleName(nozzle, index),
        status: String(nozzle.inferredStatus || nozzle.status || pump.inferredStatus || 'UNKNOWN'),
        product: (nozzle.product || pump.product) as string | undefined,
        islandId: parentId,
        parentId,
        assetId: String(nozzle.id),
        raw: {
          ...nozzle,
          assetRole: 'NOZZLE',
          parentPumpId: String(pump.id),
          parentPumpName: String(pump.name || pump.pumpCode || 'Pump'),
        },
      })
    } else if (assetType === 'NOZZLE') {
      const resolved = resolveSavedPumpNozzle(assetId, item as Record<string, any>, pumps, claimedNozzles)
      if (!resolved) continue
      claimedNozzles.add(String(resolved.nozzle.id))
      const { nozzle, pump, index } = resolved
      const parentId = String(cfg.islandId || cfg.physicalPumpId || `shell-${pump.id}`)
      const islandBox = nodes.find((n) => n.id === parentId && n.kind === 'ISLAND')
      const port = islandBox
        ? nozzlePortBox(islandBox, index, Math.max(2, index + 1))
        : { x, y, w: PIPE_PORT_SIZE, h: PIPE_PORT_SIZE }
      nodes.push({
        id: String(nozzle.id),
        kind: 'PUMP',
        x: port.x,
        y: port.y,
        w: port.w,
        h: port.h,
        label: friendlyNozzleName(nozzle, index),
        status: String(nozzle.inferredStatus || nozzle.status || 'UNKNOWN'),
        product: (nozzle.product || pump.product) as string | undefined,
        islandId: parentId,
        parentId,
        assetId: String(nozzle.id),
        raw: {
          ...nozzle,
          assetRole: 'NOZZLE',
          parentPumpId: String(pump.id),
          parentPumpName: String(pump.name || pump.pumpCode || 'Pump'),
        },
      })
    } else if (assetType === 'ISLAND') {
      const rawLabel = String(item.label || 'Pump')
      const label = /^island\s+/i.test(rawLabel) ? rawLabel.replace(/^island/i, 'Pump') : rawLabel
      nodes.push({
        id: assetId || String(item.id || item.label),
        kind: 'ISLAND',
        x,
        y,
        w: isle.w,
        h: isle.h,
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
  return snapNozzlePorts(nodes)
}

type SavedPoint = { x: number; y: number; kind: string; id: string; cfg: Record<string, any> }

function savedItemPoint(item: Record<string, any>): SavedPoint | null {
  const kind = String(item.assetType || item.asset_type || '').toUpperCase()
  if (!kind || kind === 'DEVICE' || kind === 'FORECOURT' || kind === 'LABEL' || kind === 'PUMP' || kind === 'NOZZLE') {
    return null
  }
  if (isDecorativeLayoutKind(kind)) return null
  const id = String(item.assetId || item.asset_id || item.id || '')
  if (!id || isDecorativeLayoutNode({ kind, id, label: String(item.label || '') })) return null
  return {
    id,
    kind,
    x: Number(item.x ?? item.x_position ?? 0),
    y: Number(item.y ?? item.y_position ?? 0),
    cfg: (item.configuration || item.configuration_json || {}) as Record<string, any>,
  }
}

export function applySavedLayoutPositions(
  canonical: SchematicNode[],
  state?: TwinLiveState,
): SchematicNode[] {
  const points = (state?.layout?.items || [])
    .map((item) => savedItemPoint(item as Record<string, any>))
    .filter((p): p is SavedPoint => Boolean(p))
  const byKey = new Map<string, SavedPoint>()
  for (const point of points) {
    byKey.set(`${point.kind}:${point.id}`, point)
    byKey.set(point.id, point)
    const phys = String(point.cfg.physicalPumpId || '')
    if (phys) byKey.set(`ISLAND:${phys}`, point)
  }
  const stationId = String(state?.station?.mqttStationId || state?.station?.stationCode || state?.station?.id || '')
  const savedIslands = points.filter((p) => p.kind === 'ISLAND')
  const usedIslands = new Set<string>()
  const physicalCount = catalogPumps(state).length

  return canonical.map((node) => {
    if (node.kind === 'PUMP') return node
    const keys = [node.id, node.assetId || '', `${node.kind}:${node.id}`, `${node.kind}:${node.assetId || ''}`]
    if (node.kind === 'ISLAND') {
      keys.push(...physicalPumpIdAliases(String(node.assetId || node.raw?.id || ''), stationId))
      keys.push(`ISLAND:${node.assetId || ''}`, `ISLAND:${node.id}`)
      const isleNum = node.raw?.islandNumber
      if (isleNum != null && isleNum !== '') {
        keys.push(`island-${isleNum}`, `ISLAND:island-${isleNum}`)
      }
    }
    for (const key of keys.filter(Boolean)) {
      const hit = byKey.get(key)
      if (!hit) continue
      if (hit.kind === 'ISLAND') usedIslands.add(hit.id)
      return { ...node, x: hit.x, y: hit.y }
    }
    if (node.kind === 'ISLAND' && physicalCount === 1 && savedIslands.length === 1 && !usedIslands.has(savedIslands[0].id)) {
      usedIslands.add(savedIslands[0].id)
      return { ...node, x: savedIslands[0].x, y: savedIslands[0].y }
    }
    return node
  })
}

export function dedupePhysicalPumpNodes(nodes: SchematicNode[]): SchematicNode[] {
  const islands = nodes.filter((n) => n.kind === 'ISLAND')
  const keep = new Map<string, SchematicNode>()
  const drop = new Set<string>()
  for (const isle of islands) {
    const key = String(isle.assetId || isle.raw?.id || isle.id)
    const prev = keep.get(key)
    if (!prev) {
      keep.set(key, isle)
      continue
    }
    const preferCurrent = isle.id.startsWith('shell-') || Number(isle.raw?.nozzleCount || 0) > 0
    const winner = preferCurrent ? isle : prev
    const loser = winner === isle ? prev : isle
    drop.add(loser.id)
    keep.set(key, winner)
  }
  if (!drop.size) return nodes
  return nodes.filter((n) => !drop.has(n.id) && !(n.kind === 'PUMP' && drop.has(String(n.parentId || n.islandId || ''))))
}

function snapNozzlePorts(nodes: SchematicNode[]): SchematicNode[] {
  const islands = nodes.filter((n) => n.kind === 'ISLAND')
  const kids = nodes.filter((n) => n.kind === 'PUMP' && (n.parentId || n.islandId))
  return nodes.map((n) => {
    if (n.kind !== 'PUMP' || !(n.parentId || n.islandId)) return n
    const island = islands.find((i) => i.id === n.parentId || i.id === n.islandId)
    if (!island) return n
    const siblings = kids.filter((p) => p.parentId === island.id || p.islandId === island.id)
    const index = Math.max(0, siblings.findIndex((p) => p.id === n.id))
    return { ...n, ...nozzlePortBox(island, index, Math.max(siblings.length, 1)) }
  })
}

function nudgeOffEquipment(node: SchematicNode, others: SchematicNode[]): SchematicNode {
  const placed = { ...node }
  const blockers = others.filter((n) => n.kind === 'TANK' || n.kind === 'ISLAND')
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
    if (existing.some((e) => e.id === n.id || e.assetId === n.id)) return false
    if (n.kind === 'PUMP') {
      const nozzleId = String(n.id)
      const parent = String(n.raw?.parentPumpId || '')
      const synthetic = nozzleId.endsWith('::nozzle')
      const covered = existing.some((e) => {
        if (e.kind !== 'PUMP') return false
        if (e.id === nozzleId || e.assetId === nozzleId) return true
        return synthetic && (e.id === parent || e.assetId === parent)
      })
      if (covered) return false
    }
    return true
  })
  if (!extras.length) return existing
  const next = [...existing]
  for (const extra of extras) {
    let placed = extra
    if (extra.kind === 'PUMP' && extra.parentId) {
      const savedIsland = next.find((n) => n.id === extra.parentId)
      const autoIsland = auto.find((n) => n.id === extra.parentId)
      if (savedIsland && autoIsland) {
        placed = {
          ...extra,
          x: savedIsland.x + (extra.x - autoIsland.x),
          y: savedIsland.y + (extra.y - autoIsland.y),
        }
      } else {
        placed = nudgeOffEquipment(extra, next.filter((n) => n.id !== extra.parentId))
      }
    } else if (extra.kind === 'TANK' || extra.kind === 'PUMP') {
      placed = nudgeOffEquipment(extra, next)
    }
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
    return stripDecorativeLayoutNodes(buildAutoForecourtLayout(state, opts).nodes)
  }
  const canonical = buildAutoForecourtLayout(state, opts).nodes
  return stripDecorativeLayoutNodes(
    snapNozzlePorts(dedupePhysicalPumpNodes(applySavedLayoutPositions(canonical, state))),
  )
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
  const content = equipmentBoxes(stripDecorativeLayoutNodes(nodes))
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
  return stripDecorativeLayoutNodes(nodes)
    .filter((n) => n.kind !== 'FORECOURT' && n.kind !== 'LABEL' && !(n.kind === 'PUMP' && n.parentId))
    .map((n, idx) => ({
      asset_type: n.kind,
      asset_id: n.kind === 'TANK' || n.kind === 'PUMP' || n.kind === 'ISLAND' ? n.id : n.assetId || n.id,
      label: n.label,
      x_position: n.x,
      y_position: n.y,
      width: n.w,
      height: n.h,
      rotation: 0,
      z_index: idx,
      configuration_json:
        n.kind === 'PUMP'
          ? {
              islandId: n.islandId || n.parentId || null,
              physicalPumpId: n.raw?.parentPumpId || null,
              product: n.product || null,
            }
          : n.kind === 'ISLAND'
            ? {
                pumpIds: n.raw?.pumpIds || [],
                physicalPumpId: n.assetId || n.raw?.id || null,
                role: 'PHYSICAL_PUMP',
              }
            : null,
    }))
}

export function toLayoutPersist(nodes: SchematicNode[], name = 'Custom'): LayoutPersist {
  const { width, height } = canvasSizeFromNodes(nodes)
  return {
    name,
    layout_version: LAYOUT_SCHEMA_VERSION,
    canvas_width: width,
    canvas_height: height,
    items: layoutItemsFromNodes(nodes),
  }
}

export function equipmentBoxes(nodes: SchematicNode[]) {
  return nodes.filter((n) => n.kind === 'TANK' || n.kind === 'ISLAND')
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
    if (n.type === 'island' || n.type === 'dispenser') {
      next.pumpW = Math.max(next.pumpW, Math.ceil(w - HOSE_OVERHANG * 2))
      const contentH = Math.ceil(h)
      // Hoses hang outside the cabinet and must not reintroduce empty card height.
      if (contentH >= DISPENSER_HEIGHT + LCD_EXTRA_ROW_H - 20) {
        next.pumpH = Math.max(
          next.pumpH,
          Math.min(contentH, DISPENSER_HEIGHT + LCD_EXTRA_ROW_H * 2),
        )
      }
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
  const pumps = nodes.filter((n) => n.kind === 'ISLAND')
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
