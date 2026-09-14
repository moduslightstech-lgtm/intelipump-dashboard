import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import {
  DISPENSER_HEIGHT,
  DISPENSER_WIDTH,
  HOSE_OVERHANG,
} from '../components/twin/schematic/constants'
import { schematicNozzle } from '../components/twin/schematic/dispenserFixtures'
import { lcdViewFromNozzle } from '../components/twin/schematic/lcdDisplay'
import {
  islandPropsEqual,
  isNozzleDispensing,
  nozzleLiveSignature,
} from '../components/twin/schematic/nodes/IslandSchematicNode'
import IslandSchematicNode from '../components/twin/schematic/nodes/IslandSchematicNode'
import { buildForecourtNodes, topologyKey } from '../components/twin/schematic/autoLayout'
import {
  isBranchFlowing,
  isTrunkFlowing,
  liveNozzleStatesFromActive,
} from '../components/twin/schematic/pipeFlow'
import type { ActiveDispensingState, PipeRoute } from '../components/twin/pipe/pipeTypes'
import type { SchematicNode } from '../components/twin/schematic/types'
import { applyNozzleEvent, sessionKey, type NozzleSession } from '../lib/nozzleSessions'
import { idleTwoNozzleState } from '../components/twin/schematic/dispenserFixtures'

function islandNode(nozzles: SchematicNode[], extras: Record<string, unknown> = {}): SchematicNode {
  return {
    id: 'shell-p1',
    kind: 'ISLAND',
    x: 0,
    y: 0,
    w: HOSE_OVERHANG * 2 + DISPENSER_WIDTH,
    h: DISPENSER_HEIGHT,
    label: 'Pump 1',
    status: 'IDLE',
    raw: { pumpCode: 'P1', assetRole: 'PHYSICAL_PUMP', id: 'p1' },
    ...extras,
  }
}

function renderDispenser(nozzles: SchematicNode[], islandStatus = 'IDLE') {
  const node = islandNode(nozzles, { status: islandStatus })
  return render(
    <ReactFlowProvider>
      <IslandSchematicNode
        id="shell-p1"
        type="island"
        data={{ label: 'Pump 1', status: islandStatus, node, nozzles }}
        selected={false}
        zIndex={1}
        isConnectable={false}
        xPos={0}
        yPos={0}
        dragging={false}
      />
    </ReactFlowProvider>,
  )
}

function nozzleRaw(session: NozzleSession | undefined, fallback: Record<string, unknown> = {}) {
  const display =
    session?.state === 'DISPENSING'
      ? 'DISPENSING'
      : session?.state === 'COMPLETED'
        ? 'SALE_COMPLETED'
        : 'IDLE'
  const liveOpen = display === 'DISPENSING' || display === 'SALE_COMPLETED'
  return {
    name: fallback.name,
    product: 'PMS',
    livePresentation: display,
    liveAmount: liveOpen ? session?.amount ?? null : null,
    liveVolume: liveOpen ? session?.volumeLiters ?? null : null,
    lastCompletedAmount: session?.lastCompleted?.amount ?? fallback.lastCompletedAmount ?? null,
    lastCompletedVolume: session?.lastCompleted?.volumeLiters ?? fallback.lastCompletedVolume ?? null,
    liveTransactionId: session?.transactionId ?? null,
    liveSequence: session?.sequence ?? 0,
  }
}

function live(nozzleId: string, extras: Partial<ActiveDispensingState> = {}): ActiveDispensingState {
  return {
    transactionId: `tx-${nozzleId}`,
    pumpId: 'pump-1',
    nozzleId,
    stationId: 'lab',
    tankId: 't1',
    finalVolume: 0.3,
    finalAmount: 360,
    currentVolume: 0.3,
    currentAmount: 360,
    phase: 'DISPENSING',
    startedAt: 0,
    durationMs: 1,
    product: 'PMS',
    connectionId: `c-${nozzleId}`,
    ...extras,
  }
}

const n1Branch: PipeRoute = {
  id: 'branch:n1',
  tankId: 't1',
  pumpId: 'n1',
  product: 'PMS',
  path: 'M 0 0',
  source: { x: 0, y: 0 },
  target: { x: 0, y: 10 },
  manifoldY: 0,
  status: 'IDLE',
  connection: { nozzleId: 'n1', mqttNozzleId: 'n1', physicalPumpId: 'pump-1' },
  mappingSource: 'PRIMARY',
  segmentType: 'NOZZLE_BRANCH',
  stationId: 'lab',
  nozzleId: 'n1',
  connectionId: 'c-n1',
  physicalPumpId: 'pump-1',
  active: true,
  primary: true,
  targetNodeId: 'n1',
}

const n2Branch: PipeRoute = { ...n1Branch, id: 'branch:n2', pumpId: 'n2', nozzleId: 'n2', connectionId: 'c-n2', targetNodeId: 'n2', connection: { nozzleId: 'n2', mqttNozzleId: 'n2', physicalPumpId: 'pump-1' } }
const trunk: PipeRoute = {
  ...n1Branch,
  id: 'trunk:t1',
  segmentType: 'TANK_TRUNK',
  nozzleIds: ['n1', 'n2'],
  connectionIds: ['c-n1', 'c-n2'],
}

describe('live LCD values from exact-nozzle sessions', () => {
  it('updates Nozzle 1 LCD amount during dispensing without changing Nozzle 2', () => {
    const idle = [
      schematicNozzle('n1', 'Nozzle 1', {
        raw: { name: 'Nozzle 1', livePresentation: 'IDLE', lastCompletedAmount: 210, lastCompletedVolume: 0.18 },
      }),
      schematicNozzle('n2', 'Nozzle 2', {
        raw: { name: 'Nozzle 2', livePresentation: 'IDLE', lastCompletedAmount: 420, lastCompletedVolume: 0.36 },
      }),
    ]
    const first = renderDispenser(idle)
    const n2Before = first.getByTestId('nozzle-panel-n2').textContent
    const liveNozzles = [
      schematicNozzle('n1', 'Nozzle 1', {
        status: 'DISPENSING',
        raw: {
          name: 'Nozzle 1',
          livePresentation: 'DISPENSING',
          liveAmount: 600,
          liveVolume: 0.51,
          lastCompletedAmount: 210,
          lastCompletedVolume: 0.18,
          liveSequence: 2,
        },
      }),
      idle[1],
    ]
    first.rerender(
      <ReactFlowProvider>
        <IslandSchematicNode
          id="shell-p1"
          type="island"
          data={{
            label: 'Pump 1',
            status: 'DISPENSING',
            node: islandNode(liveNozzles, { status: 'DISPENSING' }),
            nozzles: liveNozzles,
          }}
          selected={false}
          zIndex={1}
          isConnectable={false}
          xPos={0}
          yPos={0}
          dragging={false}
        />
      </ReactFlowProvider>,
    )
    expect(first.getByTestId('nozzle-panel-n1').getAttribute('data-sale-label')).toBe('THIS SALE')
    expect(first.getByTestId('nozzle-panel-n1').getAttribute('aria-label')).toMatch(/600/)
    expect(first.getByTestId('island-node-Pump 1')).toBeInTheDocument()
    expect(first.getByTestId('nozzle-panel-n2').textContent).toBe(n2Before)
  })

  it('changes volume on the same island node without rebuilding topology', () => {
    const state = idleTwoNozzleState()
    const before = topologyKey(state)
    state.pumps![0].nozzles[0].livePresentation = 'DISPENSING'
    state.pumps![0].nozzles[0].liveAmount = 600
    state.pumps![0].nozzles[0].liveVolume = 0.51
    const mid = topologyKey(state)
    state.pumps![0].nozzles[0].liveVolume = 0.62
    expect(topologyKey(state)).toBe(before)
    expect(mid).toBe(before)
    expect(buildForecourtNodes(state).find((n) => n.kind === 'ISLAND')?.id).toBe('shell-p1')
  })

  it('does not let last-sale values override an active session, including missing live amounts', () => {
    expect(
      lcdViewFromNozzle({
        livePresentation: 'DISPENSING',
        liveAmount: 720,
        liveVolume: 0.61,
        lastCompletedAmount: 420,
        lastCompletedVolume: 0.36,
        lastTransactionAmount: 420,
        lastTransactionVolume: 0.36,
      }),
    ).toEqual({ mode: 'THIS SALE', amount: 720, volume: 0.61, status: 'DISPENSING' })
    expect(
      lcdViewFromNozzle({
        livePresentation: 'DISPENSING',
        liveAmount: null,
        liveVolume: null,
        lastCompletedAmount: 420,
        lastCompletedVolume: 0.36,
        lastTransactionAmount: 420,
      }),
    ).toEqual({ mode: 'THIS SALE', amount: null, volume: null, status: 'DISPENSING' })
  })

  it('applies completion then keeps LAST SALE values', () => {
    let sessions = applyNozzleEvent(
      {},
      {
        stationId: 'lab',
        pumpId: 'pump-1',
        nozzleId: 'n1',
        transactionId: 'tx-1',
        status: 'DISPENSING',
        amount: 400,
        volumeLiters: 0.34,
        sequence: 4,
      },
    ).sessions
    sessions = applyNozzleEvent(sessions, {
      stationId: 'lab',
      pumpId: 'pump-1',
      nozzleId: 'n1',
      transactionId: 'tx-1',
      status: 'COMPLETED',
      amount: 500,
      volumeLiters: 0.42,
      sequence: 5,
    }).sessions
    const session = sessions[sessionKey('lab', 'pump-1', 'n1')]
    const complete = lcdViewFromNozzle(nozzleRaw(session, { name: 'Nozzle 1' }))
    expect(complete).toEqual({ mode: 'SALE COMPLETE', amount: 500, volume: 0.42, status: 'SALE_COMPLETED' })
    const last = lcdViewFromNozzle({
      livePresentation: 'IDLE',
      liveAmount: null,
      liveVolume: null,
      lastCompletedAmount: session.lastCompleted?.amount,
      lastCompletedVolume: session.lastCompleted?.volumeLiters,
    })
    expect(last).toEqual({ mode: 'LAST SALE', amount: 500, volume: 0.42, status: 'IDLE' })
  })

  it('rejects out-of-order snapshots so the display is not reset', () => {
    let sessions = applyNozzleEvent(
      {},
      {
        stationId: 'lab',
        pumpId: 'pump-1',
        nozzleId: 'n1',
        transactionId: 'tx-1',
        status: 'DISPENSING',
        amount: 720,
        volumeLiters: 0.61,
        sequence: 8,
        receivedAt: '2026-09-08T18:00:10Z',
      },
    ).sessions
    const rejected = applyNozzleEvent(
      sessions,
      {
        stationId: 'lab',
        pumpId: 'pump-1',
        nozzleId: 'n1',
        transactionId: 'tx-old',
        status: 'IDLE',
        amount: 210,
        volumeLiters: 0.18,
        sequence: 2,
        receivedAt: '2026-09-08T18:00:01Z',
      },
      'rest',
    )
    expect(rejected.accepted).toBe(false)
    const session = rejected.sessions[sessionKey('lab', 'pump-1', 'n1')]
    expect(lcdViewFromNozzle(nozzleRaw(session)).amount).toBe(720)
    expect(lcdViewFromNozzle(nozzleRaw(session)).mode).toBe('THIS SALE')
  })

  it('rerenders memoized island props when live amount, volume, state, or sequence change', () => {
    const baseNozzles = [
      schematicNozzle('n1', 'Nozzle 1', {
        raw: { livePresentation: 'DISPENSING', liveAmount: 100, liveVolume: 0.1, liveSequence: 1 },
      }),
    ]
    const prev: NodeProps = {
      id: 'shell-p1',
      type: 'island',
      data: { label: 'Pump 1', status: 'DISPENSING', nozzles: baseNozzles },
      selected: false,
      zIndex: 1,
      isConnectable: false,
      xPos: 0,
      yPos: 0,
      dragging: false,
    }
    const same = { ...prev, data: { ...prev.data, nozzles: [...baseNozzles] } }
    expect(islandPropsEqual(prev, same as NodeProps)).toBe(true)
    const amountChanged = {
      ...prev,
      data: {
        ...prev.data,
        nozzles: [
          schematicNozzle('n1', 'Nozzle 1', {
            raw: { livePresentation: 'DISPENSING', liveAmount: 220, liveVolume: 0.1, liveSequence: 1 },
          }),
        ],
      },
    }
    expect(islandPropsEqual(prev, amountChanged as NodeProps)).toBe(false)
    expect(nozzleLiveSignature(baseNozzles[0])).not.toBe(
      nozzleLiveSignature(amountChanged.data.nozzles[0] as SchematicNode),
    )
  })
})

describe('compact physical pump height', () => {
  it('fits pump height to content without a large empty interior', () => {
    expect(DISPENSER_HEIGHT).toBeLessThanOrEqual(340)
    const nodes = buildForecourtNodes(idleTwoNozzleState())
    const island = nodes.find((n) => n.kind === 'ISLAND')!
    expect(island.h).toBeLessThanOrEqual(340)
    const { getByTestId, queryByTestId } = renderDispenser([
      schematicNozzle('n1', 'Nozzle 1', { raw: { name: 'Nozzle 1', lastCompletedAmount: 600, lastCompletedVolume: 0.51 } }),
      schematicNozzle('n2', 'Nozzle 2', { raw: { name: 'Nozzle 2', lastCompletedAmount: 420, lastCompletedVolume: 0.36 } }),
    ])
    const cabinet = getByTestId('physical-pump-cabinet') as HTMLElement
    expect(cabinet.style.height || 'auto').toMatch(/auto|^$/)
    expect(queryByTestId('hose-left')).toBeNull()
    expect(queryByTestId('hose-right')).toBeNull()
    expect(queryByTestId('lcd-panel-n1')).toBeNull()
  })

  it('keeps a single supply handle on the physical pump card', () => {
    const nodes = buildForecourtNodes(idleTwoNozzleState())
    const island = nodes.find((n) => n.kind === 'ISLAND')!
    expect(island).toBeTruthy()
    const { container } = renderDispenser([
      schematicNozzle('n1', 'Nozzle 1', { raw: { name: 'Nozzle 1' } }),
      schematicNozzle('n2', 'Nozzle 2', { raw: { name: 'Nozzle 2' } }),
    ])
    expect(container.querySelector('.react-flow__handle')).toBeTruthy()
  })
})

describe('independent nozzle panel highlighting', () => {
  it('highlights only Nozzle 1 while dispensing', () => {
    const { getByTestId } = renderDispenser(
      [
        schematicNozzle('n1', 'Nozzle 1', {
          status: 'DISPENSING',
          raw: { name: 'Nozzle 1', livePresentation: 'DISPENSING', liveAmount: 100, liveVolume: 0.1 },
        }),
        schematicNozzle('n2', 'Nozzle 2', {
          raw: { name: 'Nozzle 2', livePresentation: 'IDLE', lastCompletedAmount: 420, lastCompletedVolume: 0.36 },
        }),
      ],
      'DISPENSING',
    )
    expect(isNozzleDispensing(schematicNozzle('n1', 'Nozzle 1', { raw: { livePresentation: 'DISPENSING' } }))).toBe(true)
    expect(getByTestId('nozzle-panel-n1').getAttribute('data-live-state')).toBe('DISPENSING')
    expect(getByTestId('nozzle-panel-n1').getAttribute('data-sale-label')).toBe('THIS SALE')
    expect(getByTestId('nozzle-panel-n2').getAttribute('data-live-state')).toBe('IDLE')
    expect(getByTestId('nozzle-panel-n2').getAttribute('data-sale-label')).toBe('LAST SALE')
    expect(getByTestId('nozzle-panel-n1').getAttribute('style')).toMatch(/22C55E|34, 197, 94/i)
  })

  it('highlights only Nozzle 2 while dispensing', () => {
    const { getByTestId } = renderDispenser(
      [
        schematicNozzle('n1', 'Nozzle 1', {
          raw: { name: 'Nozzle 1', livePresentation: 'IDLE', lastCompletedAmount: 600, lastCompletedVolume: 0.51 },
        }),
        schematicNozzle('n2', 'Nozzle 2', {
          status: 'DISPENSING',
          raw: { name: 'Nozzle 2', livePresentation: 'DISPENSING', liveAmount: 200, liveVolume: 0.2 },
        }),
      ],
      'DISPENSING',
    )
    expect(getByTestId('nozzle-panel-n1').getAttribute('data-live-state')).toBe('IDLE')
    expect(getByTestId('nozzle-panel-n2').getAttribute('data-live-state')).toBe('DISPENSING')
    expect(getByTestId('nozzle-panel-n2').getAttribute('data-sale-label')).toBe('THIS SALE')
  })

  it('highlights both panels independently when both dispense', () => {
    const { getByTestId } = renderDispenser(
      [
        schematicNozzle('n1', 'Nozzle 1', {
          status: 'DISPENSING',
          raw: { name: 'Nozzle 1', livePresentation: 'DISPENSING', liveAmount: 100, liveVolume: 0.1 },
        }),
        schematicNozzle('n2', 'Nozzle 2', {
          status: 'DISPENSING',
          raw: { name: 'Nozzle 2', livePresentation: 'DISPENSING', liveAmount: 200, liveVolume: 0.2 },
        }),
      ],
      'DISPENSING',
    )
    expect(getByTestId('nozzle-panel-n1').getAttribute('data-live-state')).toBe('DISPENSING')
    expect(getByTestId('nozzle-panel-n2').getAttribute('data-live-state')).toBe('DISPENSING')
  })

  it('keeps idle panels neutral', () => {
    const { getByTestId } = renderDispenser([
      schematicNozzle('n1', 'Nozzle 1', { raw: { name: 'Nozzle 1', lastCompletedAmount: 600, lastCompletedVolume: 0.51 } }),
      schematicNozzle('n2', 'Nozzle 2', { raw: { name: 'Nozzle 2', lastCompletedAmount: 420, lastCompletedVolume: 0.36 } }),
    ])
    expect(getByTestId('nozzle-panel-n1').getAttribute('data-live-state')).toBe('IDLE')
    expect(getByTestId('nozzle-panel-n2').getAttribute('data-live-state')).toBe('IDLE')
  })

  it('keeps completion on one nozzle while the other keeps dispensing', () => {
    const { getByTestId, rerender } = renderDispenser(
      [
        schematicNozzle('n1', 'Nozzle 1', {
          status: 'DISPENSING',
          raw: { name: 'Nozzle 1', livePresentation: 'DISPENSING', liveAmount: 100, liveVolume: 0.1 },
        }),
        schematicNozzle('n2', 'Nozzle 2', {
          status: 'DISPENSING',
          raw: { name: 'Nozzle 2', livePresentation: 'DISPENSING', liveAmount: 200, liveVolume: 0.2 },
        }),
      ],
      'DISPENSING',
    )
    const after = [
      schematicNozzle('n1', 'Nozzle 1', {
        status: 'SALE_COMPLETED',
        raw: { name: 'Nozzle 1', livePresentation: 'SALE_COMPLETED', liveAmount: 500, liveVolume: 0.42 },
      }),
      schematicNozzle('n2', 'Nozzle 2', {
        status: 'DISPENSING',
        raw: { name: 'Nozzle 2', livePresentation: 'DISPENSING', liveAmount: 260, liveVolume: 0.22 },
      }),
    ]
    rerender(
      <ReactFlowProvider>
        <IslandSchematicNode
          id="shell-p1"
          type="island"
          data={{
            label: 'Pump 1',
            status: 'DISPENSING',
            node: islandNode(after, { status: 'DISPENSING' }),
            nozzles: after,
          }}
          selected={false}
          zIndex={1}
          isConnectable={false}
          xPos={0}
          yPos={0}
          dragging={false}
        />
      </ReactFlowProvider>,
    )
    expect(getByTestId('nozzle-panel-n1').getAttribute('data-sale-label')).toBe('SALE COMPLETED')
    expect(getByTestId('nozzle-panel-n2').getAttribute('data-sale-label')).toBe('THIS SALE')
  })

  it('disables status pulse under reduced motion', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: String(query).includes('prefers-reduced-motion'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
    const { getByTestId } = renderDispenser(
      [
        schematicNozzle('n1', 'Nozzle 1', {
          status: 'DISPENSING',
          raw: { name: 'Nozzle 1', livePresentation: 'DISPENSING', liveAmount: 100, liveVolume: 0.1 },
        }),
        schematicNozzle('n2', 'Nozzle 2', { raw: { name: 'Nozzle 2', lastCompletedAmount: 420 } }),
      ],
      'DISPENSING',
    )
    const status = getByTestId('nozzle-panel-n1').querySelector('[data-testid="nozzle-status"]')
    expect(status?.innerHTML).not.toMatch(/nozzle-status-pulse/)
    expect(getByTestId('nozzle-panel-n1').getAttribute('data-sale-label')).toBe('THIS SALE')
    vi.unstubAllGlobals()
  })

  it('keeps panel and shared supply pipe in agreement for each nozzle', () => {
    const n1 = schematicNozzle('n1', 'Nozzle 1', {
      status: 'DISPENSING',
      raw: { name: 'Nozzle 1', livePresentation: 'DISPENSING', liveAmount: 100, liveVolume: 0.1, liveTransactionId: 'tx-n1' },
    })
    const n2 = schematicNozzle('n2', 'Nozzle 2', {
      raw: { name: 'Nozzle 2', livePresentation: 'IDLE', lastCompletedAmount: 420, lastCompletedVolume: 0.36 },
    })
    const { getByTestId } = renderDispenser([n1, n2], 'DISPENSING')
    const active = { n1: live('n1'), 'c-n1': live('n1') }
    const states = liveNozzleStatesFromActive(active)
    const supply: PipeRoute = {
      ...n1Branch,
      id: 'supply:t1:pump-1',
      segmentType: 'PUMP_SUPPLY',
      nozzleIds: ['n1', 'n2'],
      connectionIds: ['c-n1', 'c-n2'],
      pumpId: 'shell-p1',
      targetNodeId: 'shell-p1',
    }
    const network = { branches: [supply] }
    expect(getByTestId('nozzle-panel-n1').getAttribute('data-live-state')).toBe('DISPENSING')
    expect(isNozzleDispensing(n1)).toBe(true)
    expect(isBranchFlowing(n1Branch, states, { branches: [n1Branch, n2Branch] })).toBe(true)
    expect(isBranchFlowing(n2Branch, states, { branches: [n1Branch, n2Branch] })).toBe(false)
    expect(isTrunkFlowing(trunk, states, network)).toBe(true)
    expect(getByTestId('nozzle-panel-n2').getAttribute('data-sale-label')).toBe('LAST SALE')
  })
})
