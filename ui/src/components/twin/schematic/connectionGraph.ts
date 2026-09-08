import { pumpMatchesId } from '../../../lib/pumpIdentity'
import type { TwinLiveState } from '../../../api/client'
import type { ConnectionWarning, SchematicNode, ValidatedConnection } from './types'

export function getConnections(state?: TwinLiveState): Record<string, any>[] {
  return (state?.connections || state?.tankPumpConnections || []) as Record<string, any>[]
}

function matchPump(pumps: SchematicNode[], conn: Record<string, any>): SchematicNode | undefined {
  const nozzleId = conn.nozzleId ? String(conn.nozzleId) : ''
  if (nozzleId) {
    const byNozzle = pumps.find((p) => p.id === nozzleId || p.raw?.id === nozzleId)
    if (byNozzle) return byNozzle
  }
  const physicalId = String(conn.physicalPumpId || conn.pumpId || '')
  const matches = pumps.filter(
    (p) =>
      p.id === String(conn.pumpId) ||
      String(p.raw?.parentPumpId || '') === physicalId ||
      pumpMatchesId(
        { id: p.id, pumpCode: p.raw?.pumpCode, mqttPumpId: p.raw?.mqttPumpId || p.raw?.sourceIdentifier },
        conn.mqttPumpId || conn.pumpCode || conn.sourceIdentifier || conn.pumpId,
      ),
  )
  if (matches.length === 1) return matches[0]
  if (nozzleId) return matches.find((p) => p.id === nozzleId)
  return matches[0]
}

function matchTank(tanks: SchematicNode[], conn: Record<string, any>): SchematicNode | undefined {
  return tanks.find(
    (t) => t.id === String(conn.tankId) || t.raw?.tankCode === conn.tankCode,
  )
}

export function buildConnectionGraph(
  nodes: SchematicNode[],
  connections: Record<string, any>[] | undefined,
  opts?: { includeInactive?: boolean },
): { edges: ValidatedConnection[]; warnings: ConnectionWarning[] } {
  const tanks = nodes.filter((n) => n.kind === 'TANK' && !n.raw?.archived && !n.raw?.deletedAt)
  const pumps = nodes.filter((n) => n.kind === 'PUMP')
  const warnings: ConnectionWarning[] = []
  const edges: ValidatedConnection[] = []
  const includeInactive = opts?.includeInactive === true

  for (const raw of connections || []) {
    const active = raw.active !== false && String(raw.status || 'ACTIVE').toUpperCase() !== 'INACTIVE'
    if (!active && !includeInactive) {
      warnings.push({
        code: 'INACTIVE_CONNECTION',
        message: 'Inactive connection excluded from operational routing.',
        connectionId: raw.id ? String(raw.id) : undefined,
        pumpId: raw.pumpId ? String(raw.pumpId) : undefined,
        tankId: raw.tankId ? String(raw.tankId) : undefined,
      })
      continue
    }
    const tank = matchTank(tanks, raw)
    const pump = matchPump(pumps, raw)
    if (!tank || !pump) {
      warnings.push({
        code: 'MISSING_REF',
        message: `Connection ${raw.id || ''} references a missing tank or pump.`,
        connectionId: raw.id ? String(raw.id) : undefined,
        tankId: raw.tankId ? String(raw.tankId) : undefined,
        pumpId: raw.pumpId ? String(raw.pumpId) : undefined,
      })
      continue
    }
    const isPrimary = raw.isPrimary === true || raw.is_primary === true
    edges.push({
      id: String(raw.id || `${tank.id}:${pump.id}:${isPrimary ? 'P' : 'B'}`),
      tankId: tank.id,
      pumpId: pump.id,
      tankName: String(tank.label || tank.raw?.name || tank.raw?.tankCode || tank.id),
      pumpName: String(
        raw.lineLabel ||
          (pump.raw?.parentPumpName
            ? `${pump.raw.parentPumpName} · ${pump.label}`
            : pump.label || pump.raw?.name || pump.raw?.pumpCode || pump.id),
      ),
      product: (raw.product || tank.product || pump.product) as string | undefined,
      isPrimary,
      active,
      role: !active ? 'INACTIVE' : isPrimary ? 'PRIMARY' : 'BACKUP',
      lineLabel: raw.lineLabel || raw.line_label || null,
      source: String(raw.source || 'CONFIGURED'),
      raw: {
        ...raw,
        physicalPumpId: raw.physicalPumpId || pump.raw?.parentPumpId || raw.pumpId,
        nozzleId: raw.nozzleId || pump.id,
      },
    })
  }

  const byPump = new Map<string, ValidatedConnection[]>()
  for (const e of edges) {
    byPump.set(e.pumpId, [...(byPump.get(e.pumpId) || []), e])
  }
  for (const [pumpId, list] of byPump) {
    const primaries = list.filter((e) => e.role === 'PRIMARY')
    if (primaries.length > 1) {
      const products = new Map<string, ValidatedConnection[]>()
      for (const p of primaries) {
        const key = String(p.product || '')
        products.set(key, [...(products.get(key) || []), p])
      }
      for (const [product, group] of products) {
        if (group.length > 1) {
          warnings.push({
            code: 'DUAL_PRIMARY',
            message: `Pump has multiple primary tanks${product ? ` for ${product}` : ''}.`,
            pumpId,
          })
        }
      }
    }
  }

  for (const pump of pumps) {
    if (!byPump.has(pump.id)) {
      warnings.push({
        code: 'UNCONNECTED_PUMP',
        message: `${pump.label} is unconnected.`,
        pumpId: pump.id,
      })
    }
    const product = String(pump.product || pump.raw?.product || '').trim()
    if (!product) {
      warnings.push({
        code: 'PRODUCT_NOT_MAPPED',
        message: `${pump.label} has no product mapping.`,
        pumpId: pump.id,
      })
    }
  }

  return { edges, warnings }
}

export function relatedEquipment(
  edges: ValidatedConnection[],
  selection: {
    tankId?: string | null
    pumpId?: string | null
    physicalPumpId?: string | null
    pipeId?: string | null
  },
) {
  const tanks = new Set<string>()
  const pumps = new Set<string>()
  const pipes = new Set<string>()
  if (selection.tankId) {
    tanks.add(selection.tankId)
    for (const e of edges) {
      if (e.tankId === selection.tankId) {
        pumps.add(e.pumpId)
        const phys = String(e.raw?.physicalPumpId || '')
        if (phys) pumps.add(phys)
        pipes.add(e.id)
      }
    }
  } else if (selection.physicalPumpId) {
    for (const e of edges) {
      const phys = String(e.raw?.physicalPumpId || '')
      if (phys === selection.physicalPumpId || e.pumpId === selection.physicalPumpId) {
        pumps.add(e.pumpId)
        if (phys) pumps.add(phys)
        tanks.add(e.tankId)
        pipes.add(e.id)
      }
    }
  } else if (selection.pumpId) {
    pumps.add(selection.pumpId)
    for (const e of edges) {
      const phys = String(e.raw?.physicalPumpId || '')
      if (
        e.pumpId === selection.pumpId ||
        String(e.raw?.nozzleId || '') === selection.pumpId ||
        phys === selection.pumpId
      ) {
        tanks.add(e.tankId)
        pipes.add(e.id)
        pumps.add(e.pumpId)
        if (phys) pumps.add(phys)
      }
    }
  } else if (selection.pipeId) {
    const e = edges.find((x) => x.id === selection.pipeId)
    if (e) {
      tanks.add(e.tankId)
      pumps.add(e.pumpId)
      pipes.add(e.id)
    }
  }
  return { tanks, pumps, pipes, active: tanks.size + pumps.size + pipes.size > 0 }
}
