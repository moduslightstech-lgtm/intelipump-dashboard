import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import {
  DISPENSER_HEIGHT,
  DISPENSER_WIDTH,
  HOSE_OVERHANG,
  PUMP_HORIZONTAL_GAP,
  PUMP_SUPPLY_HANDLE_ID,
} from '../components/twin/schematic/constants'
import {
  dispenserVisualFixtures,
  schematicNozzle,
} from '../components/twin/schematic/dispenserFixtures'
import { lcdMode, hasMeaningfulSale } from '../components/twin/schematic/lcdDisplay'
import { aggregatePhysicalPumpStatus, physicalPumpIsOffline } from '../components/twin/schematic/physicalPump'
import IslandSchematicNode from '../components/twin/schematic/nodes/IslandSchematicNode'
import type { SchematicNode } from '../components/twin/schematic/types'
import {
  buildForecourtNodes,
  toLayoutPersist,
  topologyKey,
} from '../components/twin/schematic/autoLayout'
import { fourTankTwelvePumpState } from '../components/twin/schematic/fourByTwelveFixture'
import { idleTwoNozzleState } from '../components/twin/schematic/dispenserFixtures'

function islandNode(nozzles: SchematicNode[], extras: Record<string, unknown> = {}) {
  return {
    id: 'shell-p1',
    kind: 'ISLAND' as const,
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

function renderDispenser(
  nozzles: SchematicNode[],
  extras: Record<string, unknown> = {},
  islandStatus = 'IDLE',
) {
  const node = islandNode(nozzles, { status: islandStatus })
  return render(
    <ReactFlowProvider>
      <svg>
        <foreignObject>
          <IslandSchematicNode
            id="shell-p1"
            type="island"
            data={{
              label: 'Pump 1',
              status: islandStatus,
              node,
              nozzles,
              ...extras,
            }}
            selected={false}
            zIndex={1}
            isConnectable={false}
            xPos={0}
            yPos={0}
            dragging={false}
          />
        </foreignObject>
      </svg>
    </ReactFlowProvider>,
  )
}

const idleNozzles = [
  schematicNozzle('n1', 'Nozzle 1', {
    raw: {
      name: 'Nozzle 1',
      product: 'PMS',
      livePresentation: 'IDLE',
      lastTransactionAmount: 600,
      lastTransactionVolume: 0.51,
      lastCompletedAmount: 600,
      lastCompletedVolume: 0.51,
      lastTransactionAt: '2026-09-08T10:00:00Z',
    },
  }),
  schematicNozzle('n2', 'Nozzle 2', {
    raw: {
      name: 'Nozzle 2',
      product: 'PMS',
      livePresentation: 'IDLE',
      lastTransactionAmount: 420,
      lastTransactionVolume: 0.36,
      lastCompletedAmount: 420,
      lastCompletedVolume: 0.36,
    },
  }),
]

describe('physical dispenser LCD', () => {
  it('labels the outer node Pump 1 with inner Nozzle 1 and Nozzle 2 LCDs', () => {
    const { getByTestId, getAllByText } = renderDispenser(idleNozzles)
    expect(getByTestId('island-node-Pump 1')).toBeInTheDocument()
    expect(getByTestId('physical-pump-heading').textContent).toContain('Pump 1')
    expect(getByTestId('nozzle-panel-n1')).toBeInTheDocument()
    expect(getByTestId('nozzle-panel-n2')).toBeInTheDocument()
    expect(getAllByText('Nozzle 1').length).toBeGreaterThan(0)
    expect(getAllByText('Nozzle 2').length).toBeGreaterThan(0)
    expect(getByTestId('nozzle-panel-n1').getAttribute('aria-label')).toMatch(/600/)
    expect(getByTestId('nozzle-panel-n1').getAttribute('aria-label')).toMatch(/0\.51/)
  })

  it('shows THIS SALE with naira and litres while dispensing', () => {
    const nozzles = [
      schematicNozzle('n1', 'Nozzle 1', {
        status: 'DISPENSING',
        raw: {
          name: 'Nozzle 1',
          product: 'PMS',
          livePresentation: 'DISPENSING',
          liveAmount: 600,
          liveVolume: 0.51,
          lastCompletedAmount: 210,
          lastCompletedVolume: 0.18,
          lastTransactionAmount: 210,
          lastTransactionVolume: 0.18,
        },
      }),
      idleNozzles[1],
    ]
    const { getByTestId, getByText } = renderDispenser(nozzles, {}, 'DISPENSING')
    expect(getByTestId('nozzle-panel-n1').getAttribute('data-sale-label')).toBe('THIS SALE')
    expect(getByTestId('nozzle-panel-n1').getAttribute('data-live-state')).toBe('DISPENSING')
    expect(getByText('THIS SALE')).toBeInTheDocument()
    expect(getByTestId('nozzle-panel-n1').textContent).toMatch(/₦/)
    expect(getByTestId('nozzle-panel-n1').textContent).toMatch(/L/)
    expect(getByTestId('nozzle-panel-n1').getAttribute('aria-label')).toMatch(/600/)
    expect(getByTestId('nozzle-panel-n1').getAttribute('aria-label')).toMatch(/0\.51/)
    expect(getByTestId('nozzle-panel-n2').getAttribute('data-sale-label')).toBe('LAST SALE')
  })

  it('shows SALE COMPLETED then LAST SALE with retained values', () => {
    const completed = renderDispenser([
      schematicNozzle('n1', 'Nozzle 1', {
        status: 'SALE_COMPLETED',
        raw: {
          name: 'Nozzle 1',
          livePresentation: 'SALE_COMPLETED',
          liveAmount: 600,
          liveVolume: 0.51,
          lastCompletedAmount: 600,
          lastCompletedVolume: 0.51,
          lastTransactionAmount: 600,
          lastTransactionVolume: 0.51,
          product: 'PMS',
        },
      }),
      idleNozzles[1],
    ])
    expect(completed.getByTestId('nozzle-panel-n1').getAttribute('data-sale-label')).toBe('SALE COMPLETED')
    expect(completed.getByText('SALE COMPLETED')).toBeInTheDocument()
    expect(completed.getByText('Sale completed')).toBeInTheDocument()
    completed.unmount()
    const idle = renderDispenser([
      schematicNozzle('n1', 'Nozzle 1', {
        status: 'IDLE',
        raw: {
          name: 'Nozzle 1',
          livePresentation: 'IDLE',
          lastCompletedAmount: 600,
          lastCompletedVolume: 0.51,
          lastTransactionAmount: 600,
          lastTransactionVolume: 0.51,
          product: 'PMS',
        },
      }),
      idleNozzles[1],
    ])
    expect(idle.getByTestId('nozzle-panel-n1').getAttribute('data-sale-label')).toBe('LAST SALE')
    expect(idle.getAllByText('LAST SALE').length).toBeGreaterThan(0)
    expect(idle.getAllByText('Idle').length).toBeGreaterThan(0)
    expect(idle.getByTestId('nozzle-panel-n1').getAttribute('aria-label')).toMatch(/600/)
  })

  it('shows LAST SALE empty state when idle with no sale history', () => {
    const { getByTestId, getAllByText } = renderDispenser([
      schematicNozzle('n1', 'Nozzle 1', {
        raw: { name: 'Nozzle 1', product: 'PMS', livePresentation: 'IDLE' },
      }),
      schematicNozzle('n2', 'Nozzle 2', {
        raw: { name: 'Nozzle 2', product: 'PMS', livePresentation: 'IDLE' },
      }),
    ])
    expect(getByTestId('nozzle-panel-n1').getAttribute('data-sale-label')).toBe('LAST SALE')
    expect(getAllByText('No completed sale').length).toBeGreaterThan(0)
    expect(hasMeaningfulSale(0, 0)).toBe(false)
  })

  it('does not change Nozzle 2 when Nozzle 1 live values update', () => {
    const first = renderDispenser(idleNozzles)
    const n2 = first.getByTestId('nozzle-panel-n2').textContent
    first.rerender(
      <ReactFlowProvider>
        <svg>
          <foreignObject>
            <IslandSchematicNode
              id="shell-p1"
              type="island"
              data={{
                label: 'Pump 1',
                status: 'DISPENSING',
                node: islandNode(idleNozzles, { status: 'DISPENSING' }),
                nozzles: [
                  schematicNozzle('n1', 'Nozzle 1', {
                    status: 'DISPENSING',
                    raw: {
                      name: 'Nozzle 1',
                      product: 'PMS',
                      livePresentation: 'DISPENSING',
                      liveAmount: 720,
                      liveVolume: 0.61,
                      lastCompletedAmount: 600,
                      lastCompletedVolume: 0.51,
                    },
                  }),
                  idleNozzles[1],
                ],
              }}
              selected={false}
              zIndex={1}
              isConnectable={false}
              xPos={0}
              yPos={0}
              dragging={false}
            />
          </foreignObject>
        </svg>
      </ReactFlowProvider>,
    )
    expect(first.getByTestId('nozzle-panel-n1').getAttribute('data-sale-label')).toBe('THIS SALE')
    expect(first.getByTestId('nozzle-panel-n1').getAttribute('aria-label')).toMatch(/720/)
    expect(first.getByTestId('nozzle-panel-n2').textContent).toBe(n2)
  })

  it('shows Product not mapped instead of a generic mapping warning', () => {
    const { getByText } = renderDispenser(
      [
        schematicNozzle('n1', 'Nozzle 1', { product: '', raw: { name: 'Nozzle 1', product: '' } }),
        schematicNozzle('n2', 'Nozzle 2', { product: 'PMS', raw: { name: 'Nozzle 2', product: 'PMS' } }),
      ],
      { productMissingIds: ['n1'] },
    )
    expect(getByText('Product not mapped')).toBeInTheDocument()
  })

  it('uses a single supply handle for the physical pump', () => {
    expect(PUMP_SUPPLY_HANDLE_ID).toBe('in:supply')
  })
})

describe('LCD mode helpers', () => {
  it('maps operational states to display headers', () => {
    expect(lcdMode('DISPENSING', 600, 0.51)).toBe('THIS SALE')
    expect(lcdMode('SALE_COMPLETED', 600, 0.51)).toBe('SALE COMPLETE')
    expect(lcdMode('IDLE', 600, 0.51)).toBe('LAST SALE')
    expect(lcdMode('IDLE', null, null)).toBe('LAST SALE')
    expect(lcdMode('IDLE', 0, 0)).toBe('LAST SALE')
  })

  it('keeps LAST SALE values while both nozzles stay Offline on an offline pump', () => {
    const { getByTestId } = renderDispenser(
      [
        schematicNozzle('n1', 'Nozzle 1', {
          status: 'OFFLINE',
          raw: {
            name: 'Nozzle 1',
            product: 'PMS',
            livePresentation: 'LAST_SALE',
            inferredStatus: 'OFFLINE',
            lastCompletedAmount: 600,
            lastCompletedVolume: 0.5,
          },
        }),
        schematicNozzle('n2', 'Nozzle 2', {
          status: 'OFFLINE',
          raw: {
            name: 'Nozzle 2',
            product: 'PMS',
            inferredStatus: 'OFFLINE',
            lastCompletedAmount: 500,
            lastCompletedVolume: 0.42,
          },
        }),
      ],
      {},
      'OFFLINE',
    )
    expect(getByTestId('island-node-Pump 1').getAttribute('data-live-state')).toBe('OFFLINE')
    expect(getByTestId('nozzle-panel-n1').getAttribute('data-sale-label')).toBe('LAST SALE')
    expect(getByTestId('nozzle-panel-n1').getAttribute('data-live-state')).toBe('OFFLINE')
    expect(getByTestId('nozzle-panel-n1').getAttribute('aria-label')).toMatch(/600/)
    expect(getByTestId('nozzle-panel-n2').getAttribute('data-sale-label')).toBe('LAST SALE')
    expect(getByTestId('nozzle-panel-n2').getAttribute('data-live-state')).toBe('OFFLINE')
  })
})

describe('physical pump aggregate status', () => {
  it('follows nozzle priority', () => {
    expect(aggregatePhysicalPumpStatus(['DISPENSING', 'IDLE'])).toBe('DISPENSING')
    expect(aggregatePhysicalPumpStatus(['FAULT', 'IDLE'])).toBe('FAULT')
    expect(aggregatePhysicalPumpStatus(['OFFLINE', 'OFFLINE'])).toBe('OFFLINE')
    expect(aggregatePhysicalPumpStatus(['POWERED_OFF', 'POWERED_OFF'])).toBe('POWERED_OFF')
    expect(aggregatePhysicalPumpStatus(['IDLE', 'POWERED_OFF'])).toBe('IDLE')
    expect(aggregatePhysicalPumpStatus(['UNKNOWN', 'UNKNOWN'])).toBe('UNKNOWN')
  })

  it('treats a physical pump as offline when any sibling nozzle is offline', () => {
    expect(physicalPumpIsOffline('IDLE', ['IDLE', 'OFFLINE'])).toBe(true)
    expect(physicalPumpIsOffline('OFFLINE', ['IDLE', 'IDLE'])).toBe(true)
    expect(physicalPumpIsOffline('IDLE', ['IDLE', 'IDLE'])).toBe(false)
    expect(physicalPumpIsOffline('OFFLINE', ['OFFLINE', 'OFFLINE'], ['DISPENSING', 'IDLE'])).toBe(
      false,
    )
  })
})

describe('reduced motion', () => {
  it('does not pulse the dispensing status when reduced motion is preferred', () => {
    const matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: String(query).includes('prefers-reduced-motion'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
    vi.stubGlobal('matchMedia', matchMedia)
    const nozzles = [
      schematicNozzle('n1', 'Nozzle 1', {
        status: 'DISPENSING',
        raw: { name: 'Nozzle 1', livePresentation: 'DISPENSING', liveAmount: 600, liveVolume: 0.51, product: 'PMS' },
      }),
      idleNozzles[1],
    ]
    const { getByTestId } = renderDispenser(nozzles, {}, 'DISPENSING')
    const status = getByTestId('nozzle-panel-n1').querySelector('[data-testid="nozzle-status"]')
    expect(status?.innerHTML).not.toMatch(/nozzle-status-pulse/)
    expect(getByTestId('nozzle-panel-n2').getAttribute('data-live-state')).toBe('IDLE')
    vi.unstubAllGlobals()
  })
})

describe('dispenser visual fixtures', () => {
  it('covers the required development states', () => {
    expect(Object.keys(dispenserVisualFixtures)).toEqual([
      'idleTwoNozzles',
      'nozzle1Dispensing',
      'nozzle2Dispensing',
      'bothDispensing',
      'completedAndIdle',
      'faultedNozzle',
      'offlinePump',
      'missingProduct',
      'twoPumps',
    ])
    expect(dispenserVisualFixtures.idleTwoNozzles().pumps).toHaveLength(1)
    expect(dispenserVisualFixtures.twoPumps().pumps).toHaveLength(2)
    expect(fourTankTwelvePumpState().pumps).toHaveLength(12)
    expect(fourTankTwelvePumpState().pumps!.every((p) => (p.nozzles || []).length === 2)).toBe(true)
  })
})

describe('layout persistence and live amounts', () => {
  it('saves the outer physical pump as one unit', () => {
    const nodes = buildForecourtNodes(idleTwoNozzleState(), 1440)
    const persist = toLayoutPersist(nodes)
    expect(persist.items.filter((i) => i.asset_type === 'ISLAND')).toHaveLength(1)
    expect(persist.items.filter((i) => i.asset_type === 'PUMP')).toHaveLength(0)
    const island = nodes.find((n) => n.kind === 'ISLAND')!
    const moved = nodes.map((n) =>
      n.id === island.id || n.parentId === island.id ? { ...n, x: n.x + 80 } : n,
    )
    const saved = toLayoutPersist(moved).items.find((i) => i.asset_type === 'ISLAND')
    expect(saved?.x_position).toBe(island.x + 80)
  })

  it('does not change topology when only live amounts change', () => {
    const state = idleTwoNozzleState()
    const before = topologyKey(state)
    state.pumps![0].nozzles[0].lastTransactionAmount = 720
    state.pumps![0].nozzles[0].lastTransactionVolume = 0.61
    expect(topologyKey(state)).toBe(before)
  })
})

describe('hose clearance between adjacent pumps', () => {
  it('keeps dispenser cabinets and hose overhangs from overlapping', () => {
    const nodes = buildForecourtNodes(dispenserVisualFixtures.twoPumps(), 1440)
    const islands = nodes.filter((n) => n.kind === 'ISLAND').sort((a, b) => a.x - b.x)
    expect(islands).toHaveLength(2)
    expect(islands[0].w).toBe(HOSE_OVERHANG * 2 + DISPENSER_WIDTH)
    const gap = islands[1].x - (islands[0].x + islands[0].w)
    expect(gap).toBeGreaterThanOrEqual(PUMP_HORIZONTAL_GAP)
  })
})
