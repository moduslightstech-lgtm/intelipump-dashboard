import { productPipeColor } from '../pipe/pipeTheme'
import type { PipeRoute, Point } from '../pipe/pipeTypes'
import { LANE_GAP, PIPE_CLEARANCE, TANK_FOOTER_H, TANK_OUTLET_Y } from './constants'
import { inflate, pathToPoints, segmentHitsRect, type Rect } from './geometry'
import type { SchematicNode, ValidatedConnection } from './types'

const DROP_STUB = PIPE_CLEARANCE
const BRANCH_STUB = 14
const CORNER_R = 10
const MIN_BRANCH_GAP = 16

/** Vertical offset from tank top to the visible vessel outlet. */
export function tankOutletOffset(height: number): number {
  return Math.min(TANK_OUTLET_Y, Math.max(8, height - TANK_FOOTER_H))
}

export function getTankOutletAnchor(
  tank: { x: number; y: number; w: number; h: number },
  index = 0,
  total = 1,
): Point {
  const span = Math.min(tank.w * 0.4, Math.max(0, total - 1) * 14)
  const start = tank.x + tank.w / 2 - span / 2
  const x = total <= 1 ? tank.x + tank.w / 2 : start + index * (span / Math.max(total - 1, 1))
  return { x, y: tank.y + tankOutletOffset(tank.h) }
}

export function getPumpInletAnchor(pump: { x: number; y: number; w: number; h: number }): Point {
  return { x: pump.x + pump.w / 2, y: pump.y }
}

export function buildOrthogonalPipePath(
  source: Point,
  target: Point,
  manifoldY: number,
  viaX?: number,
  localRailY?: number,
): { path: string; mid: Point } {
  const points: Point[] = [{ x: source.x, y: source.y }, { x: source.x, y: manifoldY }]
  if (viaX != null && localRailY != null) {
    points.push({ x: viaX, y: manifoldY }, { x: viaX, y: localRailY }, { x: target.x, y: localRailY })
  } else {
    points.push({ x: target.x, y: manifoldY })
  }
  points.push({ x: target.x, y: target.y })
  return { path: polylineOrthogonal(points), mid: { x: (source.x + target.x) / 2, y: manifoldY } }
}

function polylineOrthogonal(points: Point[]): string {
  if (points.length < 2) return ''
  const parts = [`M ${points[0].x} ${points[0].y}`]
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]
    const cur = points[i]
    const next = points[i + 1]
    if (!next) {
      parts.push(`L ${cur.x} ${cur.y}`)
      break
    }
    const incomingH = Math.abs(cur.y - prev.y) < 1
    const outgoingH = Math.abs(next.y - cur.y) < 1
    const turns = incomingH !== outgoingH
    if (!turns) {
      parts.push(`L ${cur.x} ${cur.y}`)
      continue
    }
    const r = Math.min(
      CORNER_R,
      Math.hypot(cur.x - prev.x, cur.y - prev.y) / 2,
      Math.hypot(next.x - cur.x, next.y - cur.y) / 2,
    )
    const ix = incomingH ? cur.x - Math.sign(cur.x - prev.x || 1) * r : cur.x
    const iy = incomingH ? cur.y : cur.y - Math.sign(cur.y - prev.y || 1) * r
    const ox = outgoingH ? cur.x + Math.sign(next.x - cur.x || 1) * r : cur.x
    const oy = outgoingH ? cur.y : cur.y + Math.sign(next.y - cur.y || 1) * r
    parts.push(`L ${ix} ${iy}`, `Q ${cur.x} ${cur.y} ${ox} ${oy}`)
  }
  return parts.join(' ')
}

function firstRowIslandCorridors(nodes: SchematicNode[]): number[] {
  const islands = nodes.filter((n) => n.kind === 'ISLAND')
  if (!islands.length) return []
  const minY = Math.min(...islands.map((i) => i.y))
  const row = islands.filter((i) => i.y <= minY + 12).sort((a, b) => a.x - b.x)
  const xs: number[] = [row[0].x - 14]
  for (let i = 0; i < row.length - 1; i++) {
    xs.push((row[i].x + row[i].w + row[i + 1].x) / 2)
  }
  xs.push(row[row.length - 1].x + row[row.length - 1].w + 14)
  return xs
}

function nearest(value: number, candidates: number[]): number {
  if (!candidates.length) return value
  return candidates.reduce((best, x) => (Math.abs(x - value) < Math.abs(best - value) ? x : best), candidates[0])
}

function nodeRect(n: { x: number; y: number; w: number; h: number }): Rect {
  return { x: n.x, y: n.y, w: n.w, h: n.h }
}

export function collectObstacles(nodes: SchematicNode[]): Rect[] {
  return nodes
    .filter((n) => ['OFFICE', 'ENTRANCE', 'EXIT', 'TANK', 'PUMP'].includes(n.kind))
    .map((n) => inflate(nodeRect(n), n.kind === 'OFFICE' ? 10 : 4))
}

export function nudgeBranchX(
  x: number,
  manifoldY: number,
  pumpTopY: number,
  obstacles: Rect[],
  usedXs: number[],
): number {
  let nx = x
  for (let attempt = 0; attempt < 10; attempt++) {
    const hits = obstacles.some(
      (o) => nx >= o.x && nx <= o.x + o.w && manifoldY < o.y + o.h && pumpTopY > o.y,
    )
    const overlap = usedXs.some((ux) => Math.abs(ux - nx) < MIN_BRANCH_GAP)
    if (!hits && !overlap) break
    nx += attempt % 2 === 0 ? 14 + attempt * 2 : -(14 + attempt * 2)
  }
  return nx
}

export function computePipeManifoldY(
  tankBottom: number,
  pumpTop: number,
  laneIndex: number,
  step = LANE_GAP,
): number {
  const span = Math.max(step * 2, pumpTop - tankBottom - 8)
  const base = tankBottom + DROP_STUB + 12
  const y = base + laneIndex * step
  const maxY = pumpTop - BRANCH_STUB - 8
  return Math.min(y, Math.max(base, maxY - (laneIndex > 0 ? 4 : 0)))
}

export function buildManifoldRoutes(
  nodes: SchematicNode[],
  connections: ValidatedConnection[],
): { routes: PipeRoute[]; trunks: { tankId: string; product: string; y: number; path: string }[] } {
  const tanks = nodes.filter((n) => n.kind === 'TANK')
  const pumps = nodes.filter((n) => n.kind === 'PUMP')
  if (!tanks.length || !pumps.length || !connections.length) {
    return { routes: [], trunks: [] }
  }

  const tankBottom = Math.max(...tanks.map((t) => t.y + t.h))
  const pumpTop = Math.min(...pumps.map((p) => p.y))
  const obstacles = collectObstacles(nodes)
  const tankById = new Map(tanks.map((t) => [t.id, t]))
  const pumpById = new Map(pumps.map((p) => [p.id, p]))

  type Group = {
    tank: SchematicNode
    product: string
    members: { pump: SchematicNode; conn: ValidatedConnection }[]
  }
  const groups = new Map<string, Group>()
  for (const conn of connections) {
    if (conn.role === 'INACTIVE') continue
    const tank = tankById.get(conn.tankId)
    const pump = pumpById.get(conn.pumpId)
    if (!tank || !pump) continue
    const g = groups.get(tank.id) || {
      tank,
      product: String(conn.product || tank.product || 'UNKNOWN'),
      members: [],
    }
    g.members.push({ pump, conn })
    groups.set(tank.id, g)
  }

  const ordered = [...groups.values()].sort((a, b) => a.tank.x - b.tank.x || a.tank.id.localeCompare(b.tank.id))
  const trunks: { tankId: string; product: string; y: number; path: string }[] = []
  const routes: PipeRoute[] = []
  const usedBranchXs: number[] = []
  const firstPumpY = Math.min(...pumps.map((p) => p.y))
  const corridors = firstRowIslandCorridors(nodes)

  ordered.forEach((group, gi) => {
    const manifoldY = computePipeManifoldY(tankBottom, pumpTop, gi)
    const members = [...group.members].sort(
      (a, b) => a.pump.x + a.pump.w / 2 - (b.pump.x + b.pump.w / 2),
    )
    const outletTotal = members.length
    const xs: number[] = []

    members.forEach((m, mi) => {
      const source = getTankOutletAnchor(group.tank, mi, outletTotal)
      let target = getPumpInletAnchor(m.pump)
      const ignored = obstacles.filter((o) => {
        const tankHit =
          Math.abs(o.x - group.tank.x + 4) < 8 && Math.abs(o.y - group.tank.y + 4) < 8
        const pumpHit = Math.abs(o.x - m.pump.x + 4) < 8 && Math.abs(o.y - m.pump.y + 4) < 8
        return tankHit || pumpHit
      })
      const others = obstacles.filter((o) => !ignored.includes(o))
      const nudgedX = nudgeBranchX(target.x, manifoldY, m.pump.y, others, usedBranchXs)
      if (nudgedX !== target.x) target = { x: nudgedX, y: target.y }
      usedBranchXs.push(target.x)
      xs.push(source.x, target.x)

      const lowerRow = m.pump.y > firstPumpY + 24
      const viaX = lowerRow ? nearest(target.x, corridors) : undefined
      const localRailY = lowerRow ? m.pump.y - 18 : undefined
      const { path } = buildOrthogonalPipePath(source, target, manifoldY, viaX, localRailY)
      routes.push({
        id: m.conn.id,
        tankId: group.tank.id,
        pumpId: m.pump.id,
        product: group.product,
        path,
        source,
        target,
        manifoldY,
        status: 'IDLE',
        connection: m.conn.raw,
        lineLabel: m.conn.lineLabel,
        mappingSource: m.conn.role,
      })
    })

    if (xs.length) {
      trunks.push({
        tankId: group.tank.id,
        product: group.product,
        y: manifoldY,
        path: `M ${Math.min(...xs)} ${manifoldY} L ${Math.max(...xs)} ${manifoldY}`,
      })
    }
  })

  return { routes, trunks }
}

export function routeHitsUnrelated(
  route: PipeRoute,
  nodes: SchematicNode[],
): boolean {
  const tanks = nodes.filter((n) => n.kind === 'TANK')
  const pumps = nodes.filter((n) => n.kind === 'PUMP')
  const bandTop = tanks.length ? Math.max(...tanks.map((t) => t.y + t.h)) + 2 : 0
  const bandBottom = pumps.length ? Math.min(...pumps.map((p) => p.y)) - 2 : 0
  const interiors = nodes
    .filter((n) => ['OFFICE', 'ENTRANCE', 'EXIT', 'TANK', 'PUMP'].includes(n.kind))
    .filter((n) => n.id !== route.tankId && n.id !== route.pumpId)
    .map((n) => ({ x: n.x + 8, y: n.y + 8, w: Math.max(4, n.w - 16), h: Math.max(4, n.h - 16) }))
  const pts = pathToPoints(route.path)
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    const horizontal = Math.abs(a.y - b.y) < 1.5
    const inBand = horizontal && a.y > bandTop && a.y < bandBottom
    if (inBand) continue
    if (interiors.some((r) => segmentHitsRect(a.x, a.y, b.x, b.y, r))) return true
  }
  return false
}

export function pipePath(
  tank: { x: number; y: number; w: number; h: number },
  pump: { x: number; y: number; w: number; h: number },
  manifoldY?: number,
): { d: string; midX: number; midY: number } {
  const source = getTankOutletAnchor(tank)
  const target = getPumpInletAnchor(pump)
  const rail = manifoldY ?? source.y + 40
  const { path, mid } = buildOrthogonalPipePath(source, target, rail)
  return { d: path, midX: mid.x, midY: mid.y }
}

export function productStroke(product?: string | null): string {
  return productPipeColor(product)
}

export function buildForecourtPipes(
  nodes: SchematicNode[],
  connections: ValidatedConnection[],
) {
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

export function buildManifoldPath(nodes: SchematicNode[]): string | null {
  const tanks = nodes.filter((n) => n.kind === 'TANK')
  const pumps = nodes.filter((n) => n.kind === 'PUMP')
  if (!tanks.length || !pumps.length) return null
  const tankBottom = Math.max(...tanks.map((t) => t.y + t.h))
  const pumpTop = Math.min(...pumps.map((p) => p.y))
  const y = computePipeManifoldY(tankBottom, pumpTop, 0)
  const xs = [...tanks.map((t) => t.x + t.w / 2), ...pumps.map((p) => p.x + p.w / 2)]
  return `M ${Math.min(...xs)} ${y} L ${Math.max(...xs)} ${y}`
}
