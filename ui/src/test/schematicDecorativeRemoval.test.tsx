import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { TwinLiveState } from '../api/client'
import {
  autoArrangeNodes,
  buildAutoForecourtLayout,
  buildForecourtNodes,
  canvasSizeFromNodes,
  equipmentBoxes,
  isDecorativeLayoutNode,
  nodesHaveNoOverlap,
  stripDecorativeLayoutNodes,
  toLayoutPersist,
} from '../components/twin/schematic/autoLayout'
import { LAYOUT_SCHEMA_VERSION } from '../components/twin/schematic/constants'
import { buildConnectionGraph } from '../components/twin/schematic/connectionGraph'
import { buildManifoldRoutes } from '../components/twin/schematic/orthogonalRouting'
import { idleTwoNozzleState } from '../components/twin/schematic/dispenserFixtures'

vi.mock('../hooks/useDeviceStatus', () => ({
  useStationEdgeDevices: () => ({
    hasMapping: false,
    primary: null,
    isError: false,
    isLoading: false,
  }),
}))

vi.mock('../hooks/useStationLiveSales', () => ({
  useStationLiveSales: () => ({
    summary: null,
    pumpLiveState: {},
    sales: [],
    nozzleSessions: {},
    streamStatus: 'IDLE',
    restError: null,
  }),
}))

vi.mock('../components/twin/ForecourtMap', () => ({
  default: () => (
    <div data-testid="forecourt-map">
      <span>Tank and pump schematic</span>
    </div>
  ),
}))

function stateWithDecorativeSavedLayout(): TwinLiveState {
  const base = idleTwoNozzleState()
  return {
    ...base,
    layout: {
      mode: 'CUSTOM',
      canvasWidth: 1200,
      canvasHeight: 700,
      items: [
        {
          id: 'office',
          assetType: 'OFFICE',
          label: 'Control room',
          x: 1020,
          y: 70,
          width: 140,
          height: 70,
        },
        {
          id: 'entrance',
          assetType: 'ENTRANCE',
          label: 'ENTRANCE',
          x: 48,
          y: 330,
          width: 70,
          height: 28,
        },
        {
          id: 'exit',
          assetType: 'EXIT',
          label: 'EXIT',
          x: 1082,
          y: 330,
          width: 70,
          height: 28,
        },
        {
          id: 'control-room',
          assetType: 'LABEL',
          label: 'Control room',
          x: 900,
          y: 40,
          width: 100,
          height: 20,
        },
        {
          assetType: 'TANK',
          assetId: String(base.tanks![0].id),
          x: 120,
          y: 56,
          width: 200,
          height: 118,
        },
        {
          assetType: 'ISLAND',
          assetId: String(base.pumps![0].id),
          x: 200,
          y: 280,
          width: 444,
          height: 296,
        },
      ],
    },
  }
}

describe('decorative schematic removals', () => {
  it('recognizes control room, entrance, and exit identifiers', () => {
    expect(isDecorativeLayoutNode({ kind: 'OFFICE', id: 'office', label: 'Control room' })).toBe(true)
    expect(isDecorativeLayoutNode({ kind: 'ENTRANCE', id: 'entrance', label: 'ENTRANCE' })).toBe(true)
    expect(isDecorativeLayoutNode({ kind: 'EXIT', id: 'exit', label: 'EXIT' })).toBe(true)
    expect(isDecorativeLayoutNode({ kind: 'TANK', id: 't1', label: 'PMS' })).toBe(false)
  })

  it('does not create control room, entrance, or exit in auto layout', () => {
    const { nodes } = buildAutoForecourtLayout(idleTwoNozzleState(), 1440)
    expect(nodes.some((n) => n.kind === 'OFFICE' || n.kind === 'ENTRANCE' || n.kind === 'EXIT')).toBe(false)
    expect(nodes.some((n) => /control room|entrance|exit/i.test(n.label))).toBe(false)
    expect(nodes.some((n) => n.kind === 'TANK')).toBe(true)
    expect(nodes.some((n) => n.kind === 'ISLAND')).toBe(true)
  })

  it('ignores obsolete decorative nodes in a saved CUSTOM layout', () => {
    const nodes = buildForecourtNodes(stateWithDecorativeSavedLayout(), 1440)
    expect(nodes.find((n) => n.kind === 'OFFICE')).toBeUndefined()
    expect(nodes.find((n) => n.kind === 'ENTRANCE')).toBeUndefined()
    expect(nodes.find((n) => n.kind === 'EXIT')).toBeUndefined()
    expect(nodes.find((n) => /control room/i.test(n.label || ''))).toBeUndefined()
    expect(nodes.filter((n) => n.kind === 'TANK')).toHaveLength(1)
    expect(nodes.filter((n) => n.kind === 'ISLAND')).toHaveLength(1)
  })

  it('does not restore decorative nodes on auto-arrange / reset', () => {
    const arranged = autoArrangeNodes(stateWithDecorativeSavedLayout(), 1440)
    expect(arranged.some((n) => n.kind === 'OFFICE' || n.kind === 'ENTRANCE' || n.kind === 'EXIT')).toBe(false)
    const persist = toLayoutPersist(arranged)
    expect(persist.layout_version).toBe(LAYOUT_SCHEMA_VERSION)
    expect(persist.items.every((i) => !['OFFICE', 'ENTRANCE', 'EXIT'].includes(String(i.asset_type)))).toBe(true)
  })

  it('keeps fuel connections between the correct tank and pump nozzles', () => {
    const state = idleTwoNozzleState()
    const nodes = buildForecourtNodes(state, 1440)
    const { edges } = buildConnectionGraph(nodes, state.tankPumpConnections || state.connections)
    const { routes } = buildManifoldRoutes(nodes, edges)
    expect(edges.length).toBeGreaterThan(0)
    expect(routes.every((r) => nodes.some((n) => n.kind === 'TANK' && n.id === r.tankId))).toBe(true)
    expect(
      routes.every((r) =>
        nodes.some(
          (n) =>
            (n.kind === 'PUMP' || n.kind === 'ISLAND') &&
            (n.id === r.pumpId || n.id === r.targetNodeId),
        ),
      ),
    ).toBe(true)
  })

  it('computes fit/canvas bounds from tanks and physical pumps only', () => {
    const deco = [
      { id: 'office', kind: 'OFFICE' as const, x: 2000, y: 2000, w: 140, h: 70, label: 'Control room', status: 'STATIC', raw: {} },
      { id: 'entrance', kind: 'ENTRANCE' as const, x: 0, y: 1800, w: 70, h: 28, label: 'ENTRANCE', status: 'STATIC', raw: {} },
    ]
    const equipment = buildForecourtNodes(idleTwoNozzleState(), 1440)
    const mixed = stripDecorativeLayoutNodes([...equipment, ...deco])
    const bounds = canvasSizeFromNodes([...equipment, ...deco])
    const equipOnly = canvasSizeFromNodes(equipment)
    expect(mixed.some((n) => n.kind === 'OFFICE')).toBe(false)
    expect(bounds).toEqual(equipOnly)
    expect(equipmentBoxes(equipment).every((n) => n.kind === 'TANK' || n.kind === 'ISLAND')).toBe(true)
  })

  it('does not overlap tanks and physical pumps for multi-equipment stations', () => {
    const pumps = Array.from({ length: 12 }, (_, i) => ({
      id: `p${i}`,
      name: `Pump ${i + 1}`,
      pumpCode: `P${i + 1}`,
      displayOrder: i,
      product: i % 2 === 0 ? 'PMS' : 'AGO',
      nozzles: [
        { id: `p${i}-n1`, name: 'Nozzle 1', product: i % 2 === 0 ? 'PMS' : 'AGO' },
        { id: `p${i}-n2`, name: 'Nozzle 2', product: i % 2 === 0 ? 'PMS' : 'AGO' },
      ],
    }))
    const tanks = [
      { id: 't-pms', name: 'PMS', product: 'PMS' },
      { id: 't-ago', name: 'AGO', product: 'AGO' },
      { id: 't-dpk', name: 'DPK', product: 'DPK' },
      { id: 't-pms2', name: 'PMS 2', product: 'PMS' },
    ]
    const state: TwinLiveState = {
      layout: { mode: 'AUTO', items: [] },
      tanks,
      pumps,
      tankPumpConnections: pumps.map((p, i) => ({
        id: `c${i}`,
        tankId: p.product === 'AGO' ? 't-ago' : 't-pms',
        pumpId: p.id,
        product: p.product,
        isPrimary: true,
        active: true,
      })),
    }
    const nodes = buildForecourtNodes(state, 1440)
    expect(nodes.filter((n) => n.kind === 'TANK')).toHaveLength(4)
    expect(nodes.filter((n) => n.kind === 'ISLAND')).toHaveLength(12)
    expect(nodesHaveNoOverlap(nodes)).toBe(true)
  })
})

describe('Digital Twin page no longer renders decorative or list widgets', () => {
  it('omits tank/pump list widgets and decorative labels', async () => {
    const { default: OperationalTwinView } = await import('../components/twin/OperationalTwinView')
    render(<OperationalTwinView state={idleTwoNozzleState()} stationId="US-LAB-001" />)
    expect(screen.queryByText(/Tank list/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Pump list/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Control room/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/^ENTRANCE$/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/^EXIT$/i)).not.toBeInTheDocument()
    expect(screen.getByText(/Tank and pump schematic/i)).toBeInTheDocument()
  })
})
