import type { TwinLiveState } from '../../../api/client'
import type { SchematicNode } from './types'

function nozzle(
  id: string,
  name: string,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    name,
    nozzleNumber: name.endsWith('2') ? 2 : 1,
    product: 'PMS',
    inferredStatus: 'IDLE',
    ...extras,
  }
}

function physicalPump(id: string, name: string, nozzles: Record<string, unknown>[], extras: Record<string, unknown> = {}) {
  return {
    id,
    name,
    pumpCode: id.toUpperCase(),
    mqttPumpId: id,
    inferredStatus: 'IDLE',
    nozzles,
    ...extras,
  }
}

export function schematicNozzle(
  id: string,
  label: string,
  extras: Partial<SchematicNode> & { raw?: Record<string, unknown> } = {},
): SchematicNode {
  const { raw, ...rest } = extras
  return {
    id,
    kind: 'PUMP',
    x: 0,
    y: 0,
    w: 18,
    h: 18,
    label,
    status: String(raw?.inferredStatus || rest.status || 'IDLE'),
    product: String(raw?.product || rest.product || 'PMS'),
    parentId: 'shell-p1',
    islandId: 'shell-p1',
    raw: {
      name: label,
      assetRole: 'NOZZLE',
      parentPumpId: 'p1',
      parentPumpName: 'Pump 1',
      product: 'PMS',
      ...raw,
    },
    ...rest,
  }
}

/** 1. One pump with two idle nozzles — no sample last-sale amounts */
export function idleTwoNozzleState(): TwinLiveState {
  return {
    layout: { mode: 'AUTO', items: [] },
    tanks: [{ id: 't1', name: 'PMS', product: 'PMS', tankCode: 'T1' }],
    pumps: [
      physicalPump('p1', 'Pump 1', [
        nozzle('n1', 'Nozzle 1', {
          lastTransactionAmount: null,
          lastTransactionVolume: null,
          lastCompletedAmount: null,
          lastCompletedVolume: null,
          lastTransactionAt: null,
        }),
        nozzle('n2', 'Nozzle 2', {
          lastTransactionAmount: null,
          lastTransactionVolume: null,
          lastCompletedAmount: null,
          lastCompletedVolume: null,
          lastTransactionAt: null,
        }),
      ]),
    ],
    tankPumpConnections: [
      { id: 'c1', tankId: 't1', pumpId: 'p1', nozzleId: 'n1', product: 'PMS', isPrimary: true, active: true },
      { id: 'c2', tankId: 't1', pumpId: 'p1', nozzleId: 'n2', product: 'PMS', isPrimary: true, active: true },
    ],
  }
}

/** 2. Nozzle 1 dispensing, Nozzle 2 idle */
export function nozzle1DispensingState(): TwinLiveState {
  const state = idleTwoNozzleState()
  const pump = state.pumps![0]
  pump.inferredStatus = 'DISPENSING'
  pump.nozzles[0] = {
    ...pump.nozzles[0],
    inferredStatus: 'DISPENSING',
    livePresentation: 'DISPENSING',
    liveAmount: 600,
    liveVolume: 0.51,
    lastCompletedAmount: null,
    lastCompletedVolume: null,
    lastTransactionAmount: null,
    lastTransactionVolume: null,
  }
  return state
}

/** 3. Nozzle 2 dispensing, Nozzle 1 idle */
export function nozzle2DispensingState(): TwinLiveState {
  const state = idleTwoNozzleState()
  const pump = state.pumps![0]
  pump.inferredStatus = 'DISPENSING'
  pump.nozzles[1] = {
    ...pump.nozzles[1],
    inferredStatus: 'DISPENSING',
    livePresentation: 'DISPENSING',
    liveAmount: 420,
    liveVolume: 0.36,
    lastCompletedAmount: null,
    lastCompletedVolume: null,
    lastTransactionAmount: null,
    lastTransactionVolume: null,
  }
  return state
}

/** 4. Both nozzles dispensing */
export function bothDispensingState(): TwinLiveState {
  const state = idleTwoNozzleState()
  const pump = state.pumps![0]
  pump.inferredStatus = 'DISPENSING'
  pump.nozzles[0] = {
    ...pump.nozzles[0],
    inferredStatus: 'DISPENSING',
    livePresentation: 'DISPENSING',
    liveAmount: 600,
    liveVolume: 0.51,
    lastCompletedAmount: null,
    lastCompletedVolume: null,
  }
  pump.nozzles[1] = {
    ...pump.nozzles[1],
    inferredStatus: 'DISPENSING',
    livePresentation: 'DISPENSING',
    liveAmount: 420,
    liveVolume: 0.36,
    lastCompletedAmount: null,
    lastCompletedVolume: null,
  }
  return state
}

/** 5. One completed sale and one idle nozzle */
export function completedAndIdleState(): TwinLiveState {
  const state = idleTwoNozzleState()
  const pump = state.pumps![0]
  pump.nozzles[0] = {
    ...pump.nozzles[0],
    inferredStatus: 'SALE_COMPLETED',
    livePresentation: 'SALE_COMPLETED',
    liveAmount: 600,
    liveVolume: 0.51,
    lastCompletedAmount: 600,
    lastCompletedVolume: 0.51,
    lastTransactionAmount: 600,
    lastTransactionVolume: 0.51,
    lastTransactionAt: '2026-09-08T11:00:00Z',
  }
  pump.nozzles[1] = {
    ...pump.nozzles[1],
    inferredStatus: 'IDLE',
    livePresentation: 'IDLE',
    lastTransactionAmount: null,
    lastTransactionVolume: null,
  }
  return state
}

/** 6. Faulted nozzle */
export function faultedNozzleState(): TwinLiveState {
  const state = idleTwoNozzleState()
  state.pumps![0].inferredStatus = 'FAULT'
  state.pumps![0].nozzles[0] = { ...state.pumps![0].nozzles[0], inferredStatus: 'FAULT', livePresentation: 'FAULT' }
  return state
}

/** 7. Offline physical pump */
export function offlinePumpState(): TwinLiveState {
  const state = idleTwoNozzleState()
  state.pumps![0].inferredStatus = 'OFFLINE'
  state.pumps![0].nozzles[0] = { ...state.pumps![0].nozzles[0], inferredStatus: 'OFFLINE' }
  state.pumps![0].nozzles[1] = { ...state.pumps![0].nozzles[1], inferredStatus: 'OFFLINE' }
  return state
}

/** 8. Missing product mapping */
export function missingProductState(): TwinLiveState {
  const state = idleTwoNozzleState()
  state.pumps![0].product = undefined
  state.pumps![0].nozzles[0] = { ...state.pumps![0].nozzles[0], product: '' }
  state.pumps![0].nozzles[1] = { ...state.pumps![0].nozzles[1], product: '' }
  state.tankPumpConnections = (state.tankPumpConnections || []).map((c) => ({ ...c, product: undefined }))
  return state
}

/** 9. Two pumps */
export function twoPumpState(): TwinLiveState {
  return {
    layout: { mode: 'AUTO', items: [] },
    tanks: [{ id: 't1', name: 'PMS', product: 'PMS', tankCode: 'T1' }],
    pumps: [
      physicalPump('p1', 'Pump 1', [
        nozzle('n1', 'Nozzle 1'),
        nozzle('n2', 'Nozzle 2'),
      ]),
      physicalPump('p2', 'Pump 2', [
        nozzle('n3', 'Nozzle 1'),
        nozzle('n4', 'Nozzle 2'),
      ]),
    ],
    tankPumpConnections: [
      { id: 'c1', tankId: 't1', pumpId: 'p1', nozzleId: 'n1', product: 'PMS', isPrimary: true, active: true },
      { id: 'c2', tankId: 't1', pumpId: 'p1', nozzleId: 'n2', product: 'PMS', isPrimary: true, active: true },
      { id: 'c3', tankId: 't1', pumpId: 'p2', nozzleId: 'n3', product: 'PMS', isPrimary: true, active: true },
      { id: 'c4', tankId: 't1', pumpId: 'p2', nozzleId: 'n4', product: 'PMS', isPrimary: true, active: true },
    ],
  }
}

export const dispenserVisualFixtures = {
  idleTwoNozzles: idleTwoNozzleState,
  nozzle1Dispensing: nozzle1DispensingState,
  nozzle2Dispensing: nozzle2DispensingState,
  bothDispensing: bothDispensingState,
  completedAndIdle: completedAndIdleState,
  faultedNozzle: faultedNozzleState,
  offlinePump: offlinePumpState,
  missingProduct: missingProductState,
  twoPumps: twoPumpState,
} as const
