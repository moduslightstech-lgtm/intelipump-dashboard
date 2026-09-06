import { pumpMatchesId } from '../../../lib/pumpIdentity'
import type { ForecourtNode } from '../forecourtLayout'
import { computePipeManifoldY } from '../pumpGridLayout'
import type { LayoutNodeBox, PipeRoute, Point, Rect } from './pipeTypes'

const MANIFOLD_STEP = 18
const DROP_STUB = 14
const BRANCH_STUB = 10
const CORNER_R = 6
const MIN_BRANCH_GAP = 14

export function getTankOutletAnchor(
  tank: LayoutNodeBox,
  index = 0,
  total = 1,
): Point {
  // Spread outlets when many connections share a tank
  const span = Math.min(tank.w * 0.6, Math.max(0, total - 1) * 14)
  const start = tank.x + tank.w / 2 - span / 2
  const x = total <= 1 ? tank.x + tank.w / 2 : start + index * (span / Math.max(total - 1, 1))
  return { x, y: tank.y + tank.h }
}

export function getPumpInletAnchor(pump: LayoutNodeBox): Point {
  return { x: pump.x + pump.w / 2, y: pump.y }
}

/** Orthogonal path with small rounded bends (Q) at manifold corners. */
export function buildOrthogonalPipePath(
  source: Point,
  target: Point,
  manifoldY: number,
): { path: string; mid: Point } {
  const y1 = source.y + DROP_STUB
  const rail = manifoldY
  const y2 = target.y - BRANCH_STUB
  const r = Math.min(CORNER_R, Math.abs(target.x - source.x) / 2, Math.abs(rail - y1) / 2)

  // Vertical drop → horizontal trunk → vertical branch into pump
  let path: string
  if (Math.abs(target.x - source.x) < 2) {
    path = `M ${source.x} ${source.y} L ${source.x} ${target.y}`
  } else {
    const dir = target.x > source.x ? 1 : -1
    path = [
      `M ${source.x} ${source.y}`,
      `L ${source.x} ${rail - r}`,
      `Q ${source.x} ${rail} ${source.x + dir * r} ${rail}`,
      `L ${target.x - dir * r} ${rail}`,
      `Q ${target.x} ${rail} ${target.x} ${rail + r}`,
      `L ${target.x} ${y2}`,
      `L ${target.x} ${target.y}`,
    ].join(' ')
  }
  return { path, mid: { x: (source.x + target.x) / 2, y: rail } }
}

function nodeRect(n: LayoutNodeBox): Rect {
  return { x: n.x, y: n.y, width: n.w, height: n.h }
}

function inflate(r: Rect, pad: number): Rect {
  return {
    x: r.x - pad,
    y: r.y - pad,
    width: r.width + pad * 2,
    height: r.height + pad * 2,
  }
}

/** Collect obstacle rectangles (control room, entrance, exit, tanks, pumps). */
export function collectObstacles(nodes: ForecourtNode[]): Rect[] {
  return nodes
    .filter((n) =>
      ['OFFICE', 'ENTRANCE', 'EXIT', 'TANK', 'PUMP'].includes(n.kind),
    )
    .map((n) => inflate(nodeRect(n), n.kind === 'OFFICE' ? 12 : 4))
}

/**
 * Shift a branch X slightly if it would pass through a reserved obstacle
 * (simple lateral nudge — not a full graph router).
 */
export function nudgeBranchX(
  x: number,
  manifoldY: number,
  pumpTopY: number,
  obstacles: Rect[],
  usedXs: number[],
): number {
  let nx = x
  for (let attempt = 0; attempt < 8; attempt++) {
    const hits = obstacles.some(
      (o) =>
        nx >= o.x &&
        nx <= o.x + o.width &&
        manifoldY < o.y + o.height &&
        pumpTopY > o.y,
    )
    const overlap = usedXs.some((ux) => Math.abs(ux - nx) < MIN_BRANCH_GAP)
    if (!hits && !overlap) break
    nx += attempt % 2 === 0 ? 12 + attempt * 2 : -(12 + attempt * 2)
  }
  return nx
}

function pickConnectionForPump(
  connections: Record<string, any>[],
  pump: ForecourtNode,
): { conn: Record<string, any>; fallback: boolean } | null {
  const matches = connections.filter(
    (c) =>
      c.pumpId === pump.id ||
      pumpMatchesId(
        { id: pump.id, pumpCode: pump.raw?.pumpCode, mqttPumpId: pump.raw?.mqttPumpId },
        c.mqttPumpId || c.pumpCode,
      ),
  )
  if (!matches.length) return null
  const primary = matches.find((c) => c.isPrimary)
  if (primary) return { conn: primary, fallback: false }
  const active = matches.find((c) => c.active !== false)
  if (active && matches.length === 1) return { conn: active, fallback: false }
  // display order then tank id
  const sorted = [...matches].sort((a, b) => {
    const ao = Number(a.displayOrder ?? a.display_order ?? 0)
    const bo = Number(b.displayOrder ?? b.display_order ?? 0)
    if (ao !== bo) return ao - bo
    return String(a.tankId).localeCompare(String(b.tankId))
  })
  return { conn: sorted[0], fallback: matches.length > 1 }
}

/**
 * Build trunk-and-branch routes grouped by source tank.
 * Each tank gets its own manifold Y to avoid product-line overlap.
 */
export function buildManifoldRoutes(
  nodes: ForecourtNode[],
  connections: Record<string, any>[],
): { routes: PipeRoute[]; trunks: { tankId: string; product: string; y: number; path: string }[] } {
  const tanks = nodes.filter((n) => n.kind === 'TANK')
  const pumps = nodes.filter((n) => n.kind === 'PUMP')
  if (!tanks.length || !pumps.length || !connections.length) {
    return { routes: [], trunks: [] }
  }

  const tankBottom = Math.max(...tanks.map((t) => t.y + t.h))
  const pumpTop = Math.min(...pumps.map((p) => p.y))
  const obstacles = collectObstacles(nodes)

  // Group pumps under their resolved tank
  type Group = {
    tank: ForecourtNode
    product: string
    members: { pump: ForecourtNode; conn: Record<string, any>; fallback: boolean }[]
  }
  const groups = new Map<string, Group>()

  for (const pump of pumps) {
    const picked = pickConnectionForPump(connections, pump)
    if (!picked) continue
    const tank =
      tanks.find((t) => t.id === String(picked.conn.tankId)) ||
      tanks.find((t) => t.raw?.tankCode === picked.conn.tankCode)
    if (!tank) continue
    if (picked.fallback && import.meta.env.DEV) {
      console.warn(
        `[pipeRouting] ambiguous mapping for pump ${pump.raw?.mqttPumpId || pump.id}; using tank ${tank.id}`,
      )
    }
    const key = tank.id
    const g = groups.get(key) || {
      tank,
      product: String(picked.conn.product || tank.product || 'UNKNOWN'),
      members: [],
    }
    g.members.push({ pump, conn: picked.conn, fallback: picked.fallback })
    groups.set(key, g)
  }

  // Assign manifold Y per tank group (stable order by tank id)
  const ordered = [...groups.values()].sort((a, b) => a.tank.id.localeCompare(b.tank.id))
  const trunks: { tankId: string; product: string; y: number; path: string }[] = []
  const routes: PipeRoute[] = []
  const usedBranchXs: number[] = []

  ordered.forEach((group, gi) => {
    const manifoldY = computePipeManifoldY(tankBottom, pumpTop, gi, MANIFOLD_STEP)
    const members = [...group.members].sort(
      (a, b) => a.pump.x + a.pump.w / 2 - (b.pump.x + b.pump.w / 2),
    )
    const outletTotal = members.length
    const xs: number[] = []

    members.forEach((m, mi) => {
      const source = getTankOutletAnchor(group.tank, mi, outletTotal)
      let target = getPumpInletAnchor(m.pump)
      const nudgedX = nudgeBranchX(
        target.x,
        manifoldY,
        m.pump.y,
        obstacles.filter((o) => {
          return !(
            (Math.abs(o.x - m.pump.x) < 1 && Math.abs(o.y - m.pump.y) < 1) ||
            (Math.abs(o.x - group.tank.x) < 1 && Math.abs(o.y - group.tank.y) < 1)
          )
        }),
        usedBranchXs,
      )
      if (nudgedX !== target.x) {
        target = { x: nudgedX, y: target.y }
      }
      usedBranchXs.push(target.x)
      xs.push(source.x, target.x)

      const { path } = buildOrthogonalPipePath(source, target, manifoldY)
      routes.push({
        id: String(m.conn.id || `${group.tank.id}:${m.pump.id}`),
        tankId: group.tank.id,
        pumpId: m.pump.id,
        product: group.product,
        path,
        source,
        target,
        manifoldY,
        status: 'IDLE',
        connection: m.conn,
        lineLabel: m.conn.lineLabel as string | undefined,
        mappingSource: m.fallback ? 'FALLBACK' : String(m.conn.source || 'CONFIGURED'),
      })
    })

    if (xs.length) {
      const xMin = Math.min(...xs)
      const xMax = Math.max(...xs)
      trunks.push({
        tankId: group.tank.id,
        product: group.product,
        y: manifoldY,
        path: `M ${xMin} ${manifoldY} L ${xMax} ${manifoldY}`,
      })
    }
  })

  return { routes, trunks }
}

/** @deprecated prefer buildManifoldRoutes — kept for tests */
export function pipePath(
  tank: LayoutNodeBox,
  pump: LayoutNodeBox,
  manifoldY?: number,
): { d: string; midX: number; midY: number } {
  const source = getTankOutletAnchor(tank)
  const target = getPumpInletAnchor(pump)
  const rail = manifoldY ?? source.y + 40
  const { path, mid } = buildOrthogonalPipePath(source, target, rail)
  return { d: path, midX: mid.x, midY: mid.y }
}
