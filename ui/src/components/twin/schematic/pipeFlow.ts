import type { ActiveDispensingState, PipeRoute } from '../pipe/pipeTypes'
import { pumpMatchesId } from '../../../lib/pumpIdentity'
import type { SchematicNode } from './types'

export type LiveNozzleState = {
  state: string
  activeTransactionId?: string | null
  stationId?: string
  pumpId: string
  nozzleId?: string
  connectionId?: string
  tankId?: string
  mappingWarning?: string
}

export type PipeFlowNetwork = {
  branches?: PipeRoute[]
}

type FlowRoute = {
  id: string
  pumpId: string
  tankId?: string
  connection?: Record<string, any> | null
  segmentType?: PipeRoute['segmentType']
  stationId?: string
  nozzleId?: string
  connectionId?: string
  physicalPumpId?: string
  nozzleIds?: string[]
  connectionIds?: string[]
  active?: boolean
  product?: string
}

function identitySet(...values: Array<unknown>): Set<string> {
  return new Set(values.map((v) => String(v || '').trim()).filter(Boolean))
}

function idsOverlap(a: Set<string>, b: Iterable<string>): boolean {
  for (const id of b) {
    if (a.has(id)) return true
  }
  return false
}

/** Nozzle-scoped IDs only. Never include the physical pump's MQTT id. */
export function branchNozzleIds(route: FlowRoute, pump?: SchematicNode): Set<string> {
  const raw = route.connection || {}
  const pumpRaw = pump?.raw || {}
  return identitySet(
    route.nozzleId,
    raw.nozzleId,
    raw.mqttNozzleId,
    raw.nozzleCode,
    raw.destinationNozzleId,
    pumpRaw.nozzleCode,
    pumpRaw.mqttNozzleId,
    pumpRaw.sourceIdentifier,
    pumpRaw.assetRole === 'NOZZLE' ? pumpRaw.id : undefined,
    pumpRaw.assetRole === 'NOZZLE' ? pump?.id : undefined,
    pumpRaw.assetRole === 'NOZZLE' ? pump?.assetId : undefined,
  )
}

export function branchPumpIds(route: FlowRoute, pump?: SchematicNode): Set<string> {
  const raw = route.connection || {}
  const pumpRaw = pump?.raw || {}
  return identitySet(
    route.physicalPumpId,
    raw.physicalPumpId,
    raw.mqttPumpId,
    raw.mqtt_pump_id,
    raw.pumpCode,
    raw.pump_code,
    pumpRaw.parentPumpId,
    pumpRaw.mqttPumpId,
    pumpRaw.pumpCode,
  )
}

export function liveNozzleKey(stationId: string, pumpId: string, nozzleId: string): string {
  return `${String(stationId || '').trim()}/${String(pumpId || '').trim()}/${String(nozzleId || '').trim()}`
}

export const isNozzleDispensing = (liveState: LiveNozzleState | undefined): boolean =>
  String(liveState?.state || '').toUpperCase() === 'DISPENSING' &&
  Boolean(liveState?.activeTransactionId)

export function toLiveNozzleState(state: ActiveDispensingState): LiveNozzleState {
  return {
    state: state.phase,
    activeTransactionId: state.phase === 'DISPENSING' ? state.transactionId : null,
    stationId: state.stationId,
    pumpId: state.pumpId,
    nozzleId: state.nozzleId,
    connectionId: state.connectionId,
    tankId: state.tankId,
    mappingWarning: state.mappingWarning,
  }
}

export function liveNozzleStatesFromActive(
  activeByPump: Record<string, ActiveDispensingState> = {},
): Record<string, LiveNozzleState> {
  const out: Record<string, LiveNozzleState> = {}
  for (const [key, state] of Object.entries(activeByPump)) {
    const live = toLiveNozzleState(state)
    out[key] = live
    if (live.nozzleId) {
      out[live.nozzleId] = live
      out[liveNozzleKey(live.stationId || '', live.pumpId, live.nozzleId)] = live
    }
    if (live.connectionId) out[live.connectionId] = live
  }
  return out
}

function uniqueDispensing(states: Iterable<LiveNozzleState>): LiveNozzleState[] {
  const seen = new Set<string>()
  const out: LiveNozzleState[] = []
  for (const live of states) {
    if (!isNozzleDispensing(live)) continue
    const token = `${live.stationId || ''}|${live.pumpId}|${live.nozzleId || ''}|${live.activeTransactionId}`
    if (seen.has(token)) continue
    seen.add(token)
    out.push(live)
  }
  return out
}

function stationMatches(route: FlowRoute, live: LiveNozzleState): boolean {
  if (!route.stationId || !live.stationId) return true
  return String(route.stationId) === String(live.stationId)
}

function pumpMatchesLive(route: FlowRoute, live: LiveNozzleState, pump?: SchematicNode): boolean {
  const ids = branchPumpIds(route, pump)
  if (ids.has(String(live.pumpId || '').trim())) return true
  return pumpMatchesId(
    {
      id: route.physicalPumpId || route.pumpId,
      mqttPumpId: route.connection?.mqttPumpId || route.connection?.mqtt_pump_id,
      pumpCode: route.connection?.pumpCode || route.connection?.pump_code,
    },
    live.pumpId,
  )
}

function connectionMatchesLive(route: FlowRoute, live: LiveNozzleState): boolean {
  if (!live.connectionId) return false
  return (
    live.connectionId === route.id ||
    live.connectionId === String(route.connectionId || '') ||
    live.connectionId === String(route.connection?.id || '')
  )
}

export function mappedNozzleIdsForPump(
  pumpId: string,
  branches: PipeRoute[] | FlowRoute[] = [],
): string[] {
  const hits = branches.filter((branch) => {
    if (branch.segmentType === 'TANK_TRUNK') return false
    return pumpMatchesLive(branch, { state: 'DISPENSING', pumpId, activeTransactionId: 'x' })
  })
  const ids = [
    ...new Set(
      hits
        .map((b) => String(b.nozzleId || b.connection?.nozzleId || b.connection?.mqttNozzleId || '').trim())
        .filter(Boolean),
    ),
  ]
  return ids
}

export type LegacyNozzleResolution = {
  nozzleId: string | null
  ambiguous: boolean
  mappingWarning?: string
}

export function resolveLegacyNozzle(
  live: LiveNozzleState,
  branches: PipeRoute[] | FlowRoute[] = [],
): LegacyNozzleResolution {
  const ids = mappedNozzleIdsForPump(live.pumpId, branches)
  if (ids.length === 1) return { nozzleId: ids[0], ambiguous: false }
  if (ids.length === 0) {
    return {
      nozzleId: null,
      ambiguous: true,
      mappingWarning: 'Missing tank/nozzle mapping',
    }
  }
  return {
    nozzleId: null,
    ambiguous: true,
    mappingWarning: 'Ambiguous nozzle mapping',
  }
}

export function isBranchFlowing(
  branch: FlowRoute,
  liveNozzleStates: Record<string, LiveNozzleState>,
  network: PipeFlowNetwork = {},
  pump?: SchematicNode,
): boolean {
  if (branch.active === false) return false
  const live = uniqueDispensing(Object.values(liveNozzleStates))
  const nozzleIds = branchNozzleIds(branch, pump)
  const pumpIds = branchPumpIds(branch, pump)
  const branches = network.branches || []

  for (const state of live) {
    if (!stationMatches(branch, state)) continue
    if (connectionMatchesLive(branch, state)) {
      if (state.nozzleId) {
        if (nozzleIds.size && !idsOverlap(nozzleIds, [state.nozzleId])) continue
        return true
      }
      // Connection id alone is not enough on multi-nozzle pumps — a pump-scoped
      // entry often points at the primary (nozzle-1) connection incorrectly.
      const resolved = resolveLegacyNozzle(state, branches.length ? branches : [branch])
      if (resolved.ambiguous || !resolved.nozzleId) continue
      if (idsOverlap(nozzleIds, [resolved.nozzleId])) return true
      continue
    }
    if (state.nozzleId) {
      if (!idsOverlap(nozzleIds, [state.nozzleId])) continue
      const sameNozzleElsewhere = (network.branches || []).filter(
        (other) =>
          other !== branch &&
          other.segmentType !== 'TANK_TRUNK' &&
          idsOverlap(branchNozzleIds(other), [state.nozzleId || '']),
      )
      if (
        sameNozzleElsewhere.length &&
        pumpIds.size &&
        !pumpMatchesLive(branch, state, pump) &&
        sameNozzleElsewhere.some((other) => pumpMatchesLive(other, state))
      ) {
        continue
      }
      return true
    }
    const resolved = resolveLegacyNozzle(state, branches.length ? branches : [branch])
    if (resolved.ambiguous || !resolved.nozzleId) continue
    if (idsOverlap(nozzleIds, [resolved.nozzleId])) return true
  }
  return false
}

export function isTrunkFlowing(
  trunk: FlowRoute,
  liveNozzleStates: Record<string, LiveNozzleState>,
  network: PipeFlowNetwork = {},
): boolean {
  const supplied = identitySet(...(trunk.nozzleIds || []))
  const branches = (network.branches || []).filter((b) => {
    if (b.segmentType === 'TANK_TRUNK') return false
    if (trunk.tankId && b.tankId && b.tankId !== trunk.tankId) return false
    const connIds = trunk.connectionIds || []
    if (connIds.length) {
      return connIds.includes(String(b.connectionId || b.connection?.id || ''))
    }
    if (supplied.size && b.nozzleId) return supplied.has(String(b.nozzleId))
    if (supplied.size && b.nozzleIds?.length) {
      return b.nozzleIds.some((id) => supplied.has(String(id)))
    }
    return true
  })
  if (branches.length) {
    return branches.some((b) => {
      if (b.segmentType === 'PUMP_SUPPLY') {
        const live = uniqueDispensing(Object.values(liveNozzleStates))
        return live.some((state) => {
          if (!stationMatches(b, state)) return false
          if (connectionMatchesLive(b, state)) return true
          if (pumpMatchesLive(b, state)) return true
          const nozzles = identitySet(...(b.nozzleIds || []), b.nozzleId)
          return Boolean(state.nozzleId && nozzles.has(String(state.nozzleId)))
        })
      }
      return isBranchFlowing(b, liveNozzleStates, { branches }, undefined)
    })
  }
  return [...supplied].some((nozzleId) => isNozzleDispensing(liveNozzleStates[nozzleId]))
}

/**
 * Per-segment flow. Never uses physical pump aggregate DISPENSING
 * to light every child branch.
 */
export function isSchematicPipeFlowing(
  route: FlowRoute,
  pump: SchematicNode | undefined,
  activeByPump: Record<string, ActiveDispensingState> = {},
  network: PipeFlowNetwork = {},
): boolean {
  const liveNozzleStates = liveNozzleStatesFromActive(activeByPump)
  if (route.segmentType === 'TANK_TRUNK') {
    return isTrunkFlowing(route, liveNozzleStates, network)
  }
  if (route.segmentType === 'PUMP_SUPPLY') {
    // Shared supply: animate when any nozzle on this physical pump is dispensing.
    const live = uniqueDispensing(Object.values(liveNozzleStates))
    return live.some((state) => {
      if (!stationMatches(route, state)) return false
      if (connectionMatchesLive(route, state)) return true
      if (pumpMatchesLive(route, state, pump)) return true
      const supplied = identitySet(...(route.nozzleIds || []), route.nozzleId)
      return Boolean(state.nozzleId && supplied.has(String(state.nozzleId)))
    })
  }
  return isBranchFlowing(route, liveNozzleStates, network, pump)
}
