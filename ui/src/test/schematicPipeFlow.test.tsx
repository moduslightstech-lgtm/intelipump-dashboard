import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { productPipeColor } from '../components/twin/pipe/pipeTheme'
import type { ActiveDispensingState, PipeRoute } from '../components/twin/pipe/pipeTypes'
import PipeEdge from '../components/twin/schematic/edges/PipeEdge'
import { displayPumpStatus } from '../components/twin/schematic/display'
import {
  isBranchFlowing,
  isNozzleDispensing,
  isSchematicPipeFlowing,
  isTrunkFlowing,
  liveNozzleStatesFromActive,
  resolveLegacyNozzle,
} from '../components/twin/schematic/pipeFlow'
import { applyNozzleEvent, type NozzleLiveEvent } from '../lib/nozzleSessions'
import { pumpStatusColor } from '../lib/pumpIdentity'

function branch(nozzleId: string, extras: Partial<PipeRoute> = {}): PipeRoute {
  return {
    id: `branch:c-${nozzleId}:pump-1:${nozzleId}`,
    tankId: 't1',
    pumpId: `${nozzleId}-uuid`,
    product: 'PMS',
    path: 'M 100 180 L 80 180 L 80 240',
    source: { x: 100, y: 180 },
    target: { x: 80, y: 240 },
    manifoldY: 180,
    status: 'IDLE',
    connection: {
      id: `c-${nozzleId}`,
      nozzleId,
      mqttNozzleId: nozzleId,
      mqttPumpId: 'pump-1',
      physicalPumpId: 'pump-1',
    },
    mappingSource: 'PRIMARY',
    segmentType: 'NOZZLE_BRANCH',
    stationId: 'lab',
    nozzleId,
    connectionId: `c-${nozzleId}`,
    physicalPumpId: 'pump-1',
    active: true,
    primary: true,
    targetNodeId: `${nozzleId}-uuid`,
    ...extras,
  }
}

const n1 = branch('nozzle-1')
const n2 = branch('nozzle-2', {
  path: 'M 100 180 L 140 180 L 140 240',
  target: { x: 140, y: 240 },
  pumpId: 'nozzle-2-uuid',
  targetNodeId: 'nozzle-2-uuid',
})
const trunk: PipeRoute = {
  id: 'trunk:t1',
  tankId: 't1',
  pumpId: n1.pumpId,
  product: 'PMS',
  path: 'M 100 120 L 100 180',
  source: { x: 100, y: 120 },
  target: { x: 100, y: 180 },
  manifoldY: 180,
  status: 'IDLE',
  connection: {},
  mappingSource: 'PRIMARY',
  segmentType: 'TANK_TRUNK',
  stationId: 'lab',
  nozzleIds: ['nozzle-1', 'nozzle-2'],
  connectionIds: ['c-nozzle-1', 'c-nozzle-2'],
  active: true,
  primary: true,
  targetNodeId: n1.pumpId,
}
const branches = [n1, n2]
const network = { branches }

function dispensing(
  nozzleId: string,
  extras: Partial<ActiveDispensingState> = {},
): ActiveDispensingState {
  return {
    transactionId: `tx-${nozzleId}`,
    pumpId: 'pump-1',
    nozzleId,
    stationId: 'lab',
    tankId: 't1',
    finalVolume: 0.35,
    finalAmount: 411,
    currentVolume: 0.35,
    currentAmount: 411,
    phase: 'DISPENSING',
    startedAt: 0,
    durationMs: 1,
    product: 'PMS',
    connectionId: `c-${nozzleId}`,
    ...extras,
  }
}

function flow(route: PipeRoute, live: Record<string, ActiveDispensingState>) {
  return isSchematicPipeFlowing(route, undefined, live, network)
}

function dummyEdge(id: string) {
  return {
    id,
    source: 't1',
    target: id,
    sourceX: 0,
    sourceY: 0,
    targetX: 10,
    targetY: 40,
    sourcePosition: 'bottom' as const,
    targetPosition: 'top' as const,
  }
}

describe('schematic pipe flow segments', () => {
  it('keeps the whole route static when no nozzle is dispensing', () => {
    expect(flow(trunk, {})).toBe(false)
    expect(flow(n1, {})).toBe(false)
    expect(flow(n2, {})).toBe(false)
    expect(isSchematicPipeFlowing(n1, undefined, {}, network)).toBe(false)
  })

  it('does not animate branches from physical pump DISPENSING status', () => {
    expect(displayPumpStatus('DISPENSING')).toBe('DISPENSING')
    expect(isSchematicPipeFlowing(n1, undefined, {}, network)).toBe(false)
    expect(isSchematicPipeFlowing(n2, undefined, {}, network)).toBe(false)
  })

  it('animates the trunk and only the Nozzle 1 branch', () => {
    const live = { 'nozzle-1': dispensing('nozzle-1') }
    expect(flow(trunk, live)).toBe(true)
    expect(flow(n1, live)).toBe(true)
    expect(flow(n2, live)).toBe(false)
  })

  it('animates the trunk and only the Nozzle 2 branch', () => {
    const live = { 'nozzle-2': dispensing('nozzle-2') }
    expect(flow(trunk, live)).toBe(true)
    expect(flow(n1, live)).toBe(false)
    expect(flow(n2, live)).toBe(true)
  })

  it('animates the trunk and both branches when both nozzles dispense', () => {
    const live = {
      'nozzle-1': dispensing('nozzle-1'),
      'nozzle-2': dispensing('nozzle-2', { transactionId: 'tx-n2' }),
    }
    expect(flow(trunk, live)).toBe(true)
    expect(flow(n1, live)).toBe(true)
    expect(flow(n2, live)).toBe(true)
  })

  it('keeps the trunk flowing when Nozzle 1 completes and Nozzle 2 stays active', () => {
    const live = {
      'nozzle-1': { ...dispensing('nozzle-1'), phase: 'COMPLETED' as const },
      'nozzle-2': dispensing('nozzle-2', { transactionId: 'tx-n2' }),
    }
    expect(flow(trunk, live)).toBe(true)
    expect(flow(n1, live)).toBe(false)
    expect(flow(n2, live)).toBe(true)
  })

  it('stops the entire route when both nozzles complete', () => {
    const live = {
      'nozzle-1': { ...dispensing('nozzle-1'), phase: 'COMPLETED' as const },
      'nozzle-2': { ...dispensing('nozzle-2'), phase: 'COMPLETED' as const },
    }
    expect(flow(trunk, live)).toBe(false)
    expect(flow(n1, live)).toBe(false)
    expect(flow(n2, live)).toBe(false)
  })

  it('does not animate another physical pump supplied by the same tank', () => {
    const pump2 = branch('nozzle-3', {
      id: 'branch:c-n3:pump-2:nozzle-3',
      pumpId: 'nozzle-3-uuid',
      nozzleId: 'nozzle-3',
      physicalPumpId: 'pump-2',
      connectionId: 'c-n3',
      connection: {
        id: 'c-n3',
        nozzleId: 'nozzle-3',
        mqttNozzleId: 'nozzle-3',
        mqttPumpId: 'pump-2',
        physicalPumpId: 'pump-2',
      },
    })
    const live = { 'nozzle-1': dispensing('nozzle-1') }
    expect(isSchematicPipeFlowing(pump2, undefined, live, { branches: [...branches, pump2] })).toBe(
      false,
    )
    expect(flow(n1, live)).toBe(true)
  })

  it('animates only the matching product tank route', () => {
    const agoBranch = branch('nozzle-ago', {
      id: 'branch:c-ago:pump-9:nozzle-ago',
      tankId: 't-ago',
      product: 'AGO',
      nozzleId: 'nozzle-ago',
      physicalPumpId: 'pump-9',
      connectionId: 'c-ago',
      connection: {
        id: 'c-ago',
        nozzleId: 'nozzle-ago',
        mqttPumpId: 'pump-9',
      },
    })
    const agoTrunk: PipeRoute = {
      ...trunk,
      id: 'trunk:t-ago',
      tankId: 't-ago',
      product: 'AGO',
      nozzleIds: ['nozzle-ago'],
      connectionIds: ['c-ago'],
    }
    const live = { 'nozzle-1': dispensing('nozzle-1') }
    const net = { branches: [...branches, agoBranch] }
    expect(isSchematicPipeFlowing(agoBranch, undefined, live, net)).toBe(false)
    expect(isSchematicPipeFlowing(agoTrunk, undefined, live, net)).toBe(false)
    expect(isSchematicPipeFlowing(trunk, undefined, live, net)).toBe(true)
  })

  it('does not animate every branch for a legacy event without nozzleId', () => {
    const live = {
      'pump-1': dispensing('ignored', { nozzleId: undefined, connectionId: undefined }),
    }
    live['pump-1'].nozzleId = undefined
    const resolved = resolveLegacyNozzle(
      {
        state: 'DISPENSING',
        activeTransactionId: 'tx-legacy',
        pumpId: 'pump-1',
        stationId: 'lab',
      },
      branches,
    )
    expect(resolved.ambiguous).toBe(true)
    expect(flow(n1, live)).toBe(false)
    expect(flow(n2, live)).toBe(false)
    expect(flow(trunk, live)).toBe(false)
  })

  it('resolves a legacy event when exactly one nozzle is mapped', () => {
    const only = [n1]
    const live = {
      'pump-1': { ...dispensing('nozzle-1'), nozzleId: undefined, connectionId: undefined },
    }
    live['pump-1'].nozzleId = undefined
    expect(isSchematicPipeFlowing(n1, undefined, live, { branches: only })).toBe(true)
    expect(isSchematicPipeFlowing(n2, undefined, live, { branches: only })).toBe(false)
  })

  it('ignores duplicate and out-of-order events for the idle branch', () => {
    const event = (partial: Partial<NozzleLiveEvent>): NozzleLiveEvent => ({
      stationId: 'lab',
      pumpId: 'pump-1',
      nozzleId: 'nozzle-1',
      transactionId: 'tx-1',
      state: 'DISPENSING',
      sequence: 2,
      amount: 411,
      volumeLiters: 0.35,
      occurredAt: '2026-09-08T18:00:02Z',
      ...partial,
    })
    let sessions = applyNozzleEvent({}, event({}), 'sse').sessions
    sessions = applyNozzleEvent(sessions, event({ sequence: 1, nozzleId: 'nozzle-2' }), 'sse').sessions
    const stale = applyNozzleEvent(
      sessions,
      event({ sequence: 1, occurredAt: '2026-09-08T17:59:00Z' }),
      'sse',
    )
    expect(stale.accepted).toBe(false)
    const live: Record<string, ActiveDispensingState> = {
      'nozzle-1': dispensing('nozzle-1', { transactionId: 'tx-1' }),
    }
    expect(flow(n1, live)).toBe(true)
    expect(flow(n2, live)).toBe(false)
  })

  it('matches live sessions by destination nozzle, not physical pump id alone', () => {
    const live = {
      'pump-1': dispensing('nozzle-1'),
    }
    expect(flow(n1, live)).toBe(true)
    expect(flow(n2, live)).toBe(false)
  })

  it('still matches when the branch stores a UUID physical pump id', () => {
    const uuidBranch = branch('nozzle-1', {
      physicalPumpId: '11111111-2222-3333-4444-555555555555',
      connection: {
        ...n1.connection,
        physicalPumpId: '11111111-2222-3333-4444-555555555555',
        mqttPumpId: undefined,
      },
    })
    const live = { 'nozzle-1': dispensing('nozzle-1') }
    expect(isSchematicPipeFlowing(uuidBranch, undefined, live, { branches: [uuidBranch, n2] })).toBe(
      true,
    )
    expect(isSchematicPipeFlowing(n2, undefined, live, { branches: [uuidBranch, n2] })).toBe(false)
  })
})

describe('live nozzle helpers', () => {
  it('requires DISPENSING plus an active transaction id', () => {
    expect(isNozzleDispensing({ state: 'DISPENSING', pumpId: 'pump-1' })).toBe(false)
    expect(
      isNozzleDispensing({
        state: 'DISPENSING',
        pumpId: 'pump-1',
        activeTransactionId: 'tx-1',
      }),
    ).toBe(true)
  })

  it('indexes live states without sharing mutable objects across branches', () => {
    const live = liveNozzleStatesFromActive({
      a: dispensing('nozzle-1'),
      b: dispensing('nozzle-2', { transactionId: 'tx-2' }),
    })
    expect(isBranchFlowing(n1, live, network)).toBe(true)
    expect(isBranchFlowing(n2, live, network)).toBe(true)
    expect(isTrunkFlowing(trunk, live, network)).toBe(true)
  })
})

describe('pipe edge overlay', () => {
  it('renders flowing overlay only for the active segment', () => {
    const { rerender, queryByTestId } = render(
      <svg>
        <PipeEdge
          {...dummyEdge('branch:c-nozzle-1:pump-1:nozzle-1')}
          data={{
            path: 'M 0 0 L 0 40',
            product: 'PMS',
            isFlowing: true,
            flowing: true,
            segmentType: 'NOZZLE_BRANCH',
            nozzleId: 'nozzle-1',
          }}
        />
        <PipeEdge
          {...dummyEdge('branch:c-nozzle-2:pump-1:nozzle-2')}
          data={{
            path: 'M 10 0 L 10 40',
            product: 'PMS',
            isFlowing: false,
            flowing: false,
            segmentType: 'NOZZLE_BRANCH',
            nozzleId: 'nozzle-2',
          }}
        />
      </svg>,
    )
    expect(queryByTestId('pipe-flow-branch:c-nozzle-1:pump-1:nozzle-1')).toBeInTheDocument()
    expect(queryByTestId('pipe-flow-branch:c-nozzle-2:pump-1:nozzle-2')).not.toBeInTheDocument()
    expect(queryByTestId('pipe-edge-branch:c-nozzle-2:pump-1:nozzle-2')?.innerHTML || '').not.toMatch(
      /schematic-pipe-flow|fuel-pipe-flow/,
    )
    rerender(
      <svg>
        <PipeEdge
          {...dummyEdge('branch:c-nozzle-2:pump-1:nozzle-2')}
          data={{ path: 'M 0 0 L 0 40', product: 'PMS', isFlowing: false, nozzleId: 'nozzle-2' }}
        />
      </svg>,
    )
    expect(queryByTestId('pipe-flow-branch:c-nozzle-2:pump-1:nozzle-2')).not.toBeInTheDocument()
  })

  it('keeps product pipe color distinct from pump status green', () => {
    expect(productPipeColor('PMS')).toBe('#2563eb')
    expect(productPipeColor('PMS')).not.toBe(pumpStatusColor('DISPENSING'))
  })
})
