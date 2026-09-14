/** PhysicalPumpCard / NozzlePanel design contract. */

import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { COMPLETED_PRESENTATION_MS, applyNozzleEvent, applyPresentationElapsed, sessionKey } from '../lib/nozzleSessions'
import { schematicNozzle } from '../components/twin/schematic/dispenserFixtures'
import IslandSchematicNode from '../components/twin/schematic/nodes/IslandSchematicNode'
import type { SchematicNode } from '../components/twin/schematic/types'
import { PUMP_SUPPLY_HANDLE_ID } from '../components/twin/schematic/constants'
import { buildManifoldRoutes } from '../components/twin/schematic/orthogonalRouting'
import { buildForecourtNodes } from '../components/twin/schematic/autoLayout'
import { idleTwoNozzleState } from '../components/twin/schematic/dispenserFixtures'
import { buildConnectionGraph } from '../components/twin/schematic/connectionGraph'

function renderCard(nozzles: SchematicNode[], status = 'IDLE') {
  return render(
    <ReactFlowProvider>
      <IslandSchematicNode
        id="shell-p1"
        type="island"
        data={{
          label: 'Pump 1',
          status,
          node: {
            id: 'shell-p1',
            kind: 'ISLAND',
            x: 0,
            y: 0,
            w: 520,
            h: 320,
            label: 'Pump 1',
            status,
            raw: { pumpCode: 'P1', id: 'p1' },
          },
          nozzles,
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
}

describe('PhysicalPumpCard design', () => {
  it('renders two independent nozzle panels without LCD or hose chrome', () => {
    const { getByTestId, queryByTestId, getAllByText } = renderCard([
      schematicNozzle('n1', 'Nozzle 1', {
        raw: { name: 'Nozzle 1', product: 'PMS', lastCompletedAmount: 540.5, lastCompletedVolume: 0.46 },
      }),
      schematicNozzle('n2', 'Nozzle 2', {
        raw: { name: 'Nozzle 2', product: 'PMS', lastCompletedAmount: 420, lastCompletedVolume: 0.36 },
      }),
    ])
    expect(getByTestId('physical-pump-cabinet')).toBeInTheDocument()
    expect(getByTestId('nozzle-panel-n1')).toBeInTheDocument()
    expect(getByTestId('nozzle-panel-n2')).toBeInTheDocument()
    expect(getAllByText('Idle').length).toBeGreaterThanOrEqual(2)
    expect(queryByTestId('hose-left')).toBeNull()
    expect(queryByTestId('lcd-panel-n1')).toBeNull()
    expect(PUMP_SUPPLY_HANDLE_ID).toBe('in:supply')
  })

  it('isolates dispensing highlight to one nozzle', () => {
    const { getByTestId } = renderCard(
      [
        schematicNozzle('n1', 'Nozzle 1', {
          status: 'DISPENSING',
          raw: {
            name: 'Nozzle 1',
            product: 'PMS',
            livePresentation: 'DISPENSING',
            liveAmount: 350,
            liveVolume: 0.29,
            livePricePerLitre: 1175,
          },
        }),
        schematicNozzle('n2', 'Nozzle 2', {
          raw: { name: 'Nozzle 2', product: 'PMS', lastCompletedAmount: 420, lastCompletedVolume: 0.36 },
        }),
      ],
      'DISPENSING',
    )
    expect(getByTestId('nozzle-panel-n1').getAttribute('data-sale-label')).toBe('THIS SALE')
    expect(getByTestId('nozzle-panel-n1').textContent).toMatch(/350/)
    expect(getByTestId('nozzle-panel-n2').getAttribute('data-sale-label')).toBe('LAST SALE')
    expect(getByTestId('nozzle-panel-n2').textContent).toMatch(/420/)
  })

  it('shows sale completed confirmation then last sale after timeout', () => {
    let sessions = applyNozzleEvent(
      {},
      {
        stationId: 'lab',
        pumpId: 'pump-1',
        nozzleId: '1',
        transactionId: 'tx-a',
        status: 'DISPENSING',
        amount: 700,
        volumeLiters: 0.59,
        sequence: 1,
      },
    ).sessions
    sessions = applyNozzleEvent(sessions, {
      stationId: 'lab',
      pumpId: 'pump-1',
      nozzleId: '1',
      transactionId: 'tx-a',
      status: 'COMPLETED',
      amount: 700,
      volumeLiters: 0.59,
      sequence: 2,
    }).sessions
    const key = sessionKey('lab', 'pump-1', '1')
    expect(sessions[key].state).toBe('COMPLETED')
    expect(COMPLETED_PRESENTATION_MS).toBeGreaterThanOrEqual(8000)
    expect(COMPLETED_PRESENTATION_MS).toBeLessThanOrEqual(10000)
    sessions = applyPresentationElapsed(sessions, key)
    expect(sessions[key].state).toBe('IDLE')
    expect(sessions[key].lastCompleted?.amount).toBe(700)
  })

  it('does not let an old completion timer overwrite newer dispensing', () => {
    let sessions = applyNozzleEvent(
      {},
      {
        stationId: 'lab',
        pumpId: 'pump-1',
        nozzleId: '1',
        transactionId: 'tx-old',
        status: 'COMPLETED',
        amount: 100,
        volumeLiters: 0.1,
        sequence: 1,
      },
    ).sessions
    sessions = applyNozzleEvent(sessions, {
      stationId: 'lab',
      pumpId: 'pump-1',
      nozzleId: '1',
      transactionId: 'tx-new',
      status: 'DISPENSING',
      amount: 200,
      volumeLiters: 0.2,
      sequence: 2,
    }).sessions
    const key = sessionKey('lab', 'pump-1', '1')
    sessions = applyPresentationElapsed(sessions, key)
    expect(sessions[key].state).toBe('DISPENSING')
    expect(sessions[key].transactionId).toBe('tx-new')
  })

  it('builds one supply pipe per physical pump, not per nozzle', () => {
    const state = idleTwoNozzleState()
    const nodes = buildForecourtNodes(state)
    const { edges } = buildConnectionGraph(nodes, state.tankPumpConnections || state.connections)
    const { routes } = buildManifoldRoutes(nodes, edges, { stationId: 'lab' })
    expect(routes.every((r) => r.segmentType === 'PUMP_SUPPLY')).toBe(true)
    expect(routes.every((r) => !String(r.id).startsWith('branch:'))).toBe(true)
  })

  it('respects reduced motion for status pulse', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: String(query).includes('prefers-reduced-motion'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
    const { getByTestId } = renderCard(
      [
        schematicNozzle('n1', 'Nozzle 1', {
          status: 'DISPENSING',
          raw: { name: 'Nozzle 1', livePresentation: 'DISPENSING', liveAmount: 10, liveVolume: 0.01 },
        }),
        schematicNozzle('n2', 'Nozzle 2', { raw: { name: 'Nozzle 2' } }),
      ],
      'DISPENSING',
    )
    expect(getByTestId('nozzle-panel-n1').innerHTML).not.toMatch(/nozzle-status-pulse/)
    vi.unstubAllGlobals()
  })
})
