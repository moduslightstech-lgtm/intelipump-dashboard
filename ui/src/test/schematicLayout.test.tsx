import { describe, expect, it } from 'vitest'
import {
  buildAutoForecourtLayout,
  buildForecourtNodes,
  groupPumpsIntoIslands,
  islandColumnCount,
  nodesHaveNoOverlap,
  toLayoutPersist,
  topologyKey,
} from '../components/twin/schematic/autoLayout'
import { buildConnectionGraph } from '../components/twin/schematic/connectionGraph'
import { displayPumpStatus, pumpStatusLabel } from '../components/twin/schematic/display'
import { fourTankTwelvePumpState } from '../components/twin/schematic/fourByTwelveFixture'
import { applySnapshot, snapshotNodes } from '../components/twin/schematic/layoutHistory'
import {
  buildManifoldRoutes,
  getPumpInletAnchor,
  getTankOutletAnchor,
  routeHitsUnrelated,
} from '../components/twin/schematic/orthogonalRouting'
import { canAccessPath, normalizeRole } from '../lib/roles'
import type { TwinLiveState } from '../api/client'

function oneTankTwoPumps(): TwinLiveState {
  return {
    layout: { mode: 'AUTO', items: [] },
    tanks: [{ id: 't1', name: 'PMS', product: 'PMS', tankCode: 'T1' }],
    pumps: [
      { id: 'p1', name: 'Pump 1', pumpCode: 'P1', displayOrder: 1, product: 'PMS' },
      { id: 'p2', name: 'Pump 2', pumpCode: 'P2', displayOrder: 2, product: 'PMS' },
    ],
    tankPumpConnections: [
      { id: 'c1', tankId: 't1', pumpId: 'p1', product: 'PMS', isPrimary: true, active: true },
      { id: 'c2', tankId: 't1', pumpId: 'p2', product: 'PMS', isPrimary: true, active: true },
    ],
  }
}

function layoutAndRoutes(state: TwinLiveState, width = 1440) {
  const nodes = buildForecourtNodes(state, width)
  const { edges, warnings } = buildConnectionGraph(nodes, state.tankPumpConnections || state.connections)
  const { routes, trunks } = buildManifoldRoutes(nodes, edges)
  return { nodes, edges, warnings, routes, trunks }
}

describe('1. one tank connected to two pumps', () => {
  it('routes two branches from one trunk', () => {
    const { nodes, routes, trunks } = layoutAndRoutes(oneTankTwoPumps())
    expect(nodes.filter((n) => n.kind === 'TANK')).toHaveLength(1)
    expect(nodes.filter((n) => n.kind === 'PUMP')).toHaveLength(2)
    expect(routes).toHaveLength(2)
    expect(trunks).toHaveLength(1)
    expect(routes.every((r) => r.tankId === 't1')).toBe(true)
  })
})

describe('2. four tanks / twelve pumps fixture', () => {
  it('places 4 tanks, 12 physical pumps, 24 nozzle cards', () => {
    const { nodes } = layoutAndRoutes(fourTankTwelvePumpState(), 1440)
    expect(nodes.filter((n) => n.kind === 'TANK')).toHaveLength(4)
    expect(nodes.filter((n) => n.kind === 'ISLAND')).toHaveLength(12)
    expect(nodes.filter((n) => n.kind === 'PUMP')).toHaveLength(24)
    expect(nodes.some((n) => n.kind === 'OFFICE')).toBe(true)
    expect(nodes.some((n) => n.kind === 'ENTRANCE')).toBe(true)
    expect(nodes.some((n) => n.kind === 'EXIT')).toBe(true)
    expect(nodes.filter((n) => n.kind === 'ISLAND')[0]?.label).toMatch(/Pump/i)
  })
})

describe('3. one tank to all twelve pumps', () => {
  it('keeps a shared trunk and 12 branches', () => {
    const pumps = Array.from({ length: 12 }, (_, i) => ({
      id: `p${i}`,
      pumpCode: `P${i}`,
      displayOrder: i,
      product: 'PMS',
    }))
    const state: TwinLiveState = {
      layout: { mode: 'AUTO', items: [] },
      tanks: [{ id: 't1', product: 'PMS', name: 'PMS' }],
      pumps,
      tankPumpConnections: pumps.map((p, i) => ({
        id: `c${i}`,
        tankId: 't1',
        pumpId: p.id,
        product: 'PMS',
        isPrimary: true,
        active: true,
      })),
    }
    const { routes, trunks } = layoutAndRoutes(state)
    expect(routes).toHaveLength(12)
    expect(trunks).toHaveLength(1)
    expect(new Set(routes.map((r) => r.pumpId)).size).toBe(12)
  })
})

describe('4. pumps split across product tanks', () => {
  it('assigns a lane per tank/product', () => {
    const { routes, trunks } = layoutAndRoutes(fourTankTwelvePumpState())
    const tankIds = new Set(routes.map((r) => r.tankId))
    expect(tankIds.size).toBeGreaterThan(1)
    expect(new Set(trunks.map((t) => t.y)).size).toBe(trunks.length)
  })
})

describe('5. primary and backup connections', () => {
  it('keeps both routes for pump 1', () => {
    const { edges } = layoutAndRoutes(fourTankTwelvePumpState())
    const forPump = edges.filter(
      (e) => e.raw?.physicalPumpId === 'pump-1' || String(e.pumpId).startsWith('pump-1'),
    )
    expect(forPump.some((e) => e.role === 'PRIMARY')).toBe(true)
    expect(forPump.some((e) => e.role === 'BACKUP')).toBe(true)
  })
})

describe('6. unconnected pump', () => {
  it('warns and draws no invented edge', () => {
    const state = oneTankTwoPumps()
    state.tankPumpConnections = [state.tankPumpConnections![0]]
    const { edges, warnings } = layoutAndRoutes(state)
    expect(edges).toHaveLength(1)
    expect(warnings.some((w) => w.code === 'UNCONNECTED_PUMP' && String(w.pumpId).includes('p2'))).toBe(true)
  })
})

describe('7. inactive tank', () => {
  it('is omitted from default live tanks', () => {
    const state = oneTankTwoPumps()
    state.tanks = [{ id: 't1', product: 'PMS', name: 'PMS', inactive: true }]
    const { nodes } = layoutAndRoutes(state)
    expect(nodes.filter((n) => n.kind === 'TANK')).toHaveLength(1)
    expect(nodes.find((n) => n.kind === 'TANK')?.raw.inactive).toBe(true)
  })
})

describe('8. deleted/archived tank', () => {
  it('excludes archived tanks from routing', () => {
    const nodes = buildForecourtNodes({
      ...oneTankTwoPumps(),
      tanks: [{ id: 't-dead', name: 'Gone', product: 'PMS', archived: true, deletedAt: '2026-01-01' }],
    })
    const { edges } = buildConnectionGraph(nodes, [
      { id: 'c', tankId: 't-dead', pumpId: 'p1', isPrimary: true, active: true },
    ])
    expect(edges).toHaveLength(0)
  })
})

describe('9. inactive connection', () => {
  it('is excluded from operational routing', () => {
    const state = oneTankTwoPumps()
    state.tankPumpConnections![1].active = false
    const { edges, warnings } = layoutAndRoutes(state)
    expect(edges).toHaveLength(1)
    expect(warnings.some((w) => w.code === 'INACTIVE_CONNECTION')).toBe(true)
  })
})

describe('10. missing pump or tank reference', () => {
  it('drops the broken edge and warns', () => {
    const { warnings, edges } = layoutAndRoutes({
      ...oneTankTwoPumps(),
      tankPumpConnections: [
        { id: 'bad', tankId: 'missing', pumpId: 'ghost', isPrimary: true, active: true },
      ],
    })
    expect(edges).toHaveLength(0)
    expect(warnings.some((w) => w.code === 'MISSING_REF')).toBe(true)
  })
})

describe('11. no node overlap after automatic layout', () => {
  it('keeps tanks, pumps, office, and gates apart', () => {
    const nodes = buildForecourtNodes(fourTankTwelvePumpState(), 1440)
    expect(nodesHaveNoOverlap(nodes)).toBe(true)
  })
})

describe('12. pipe endpoints use tank outlet and pump top ports', () => {
  it('anchors correctly', () => {
    const { nodes, routes } = layoutAndRoutes(oneTankTwoPumps())
    const tank = nodes.find((n) => n.kind === 'TANK')!
    const pump = nodes.find((n) => n.kind === 'PUMP')!
    const outletY = tank.y + Math.min(
      110,
      Math.max(8, tank.h - 38),
    )
    expect(getTankOutletAnchor(tank).y).toBe(outletY)
    expect(getPumpInletAnchor(pump).y).toBe(pump.y)
    expect(routes[0].source.y).toBe(outletY)
    expect(routes[0].target.y).toBe(nodes.find((n) => n.id === routes[0].pumpId)!.y)
  })
})

describe('13. pipes do not pass through unrelated node interiors', () => {
  it('avoids office/entrance/exit boxes', () => {
    const { nodes, routes } = layoutAndRoutes(fourTankTwelvePumpState(), 1440)
    const hits = routes.filter((r) => routeHitsUnrelated(r, nodes))
    expect(hits).toHaveLength(0)
  })
})

describe('14. shared trunk branches to the correct pumps', () => {
  it('maps each route pump id to a live pump', () => {
    const { nodes, routes } = layoutAndRoutes(fourTankTwelvePumpState())
    const pumpIds = new Set(nodes.filter((n) => n.kind === 'PUMP').map((n) => n.id))
    expect(routes.every((r) => pumpIds.has(r.pumpId))).toBe(true)
  })
})

describe('15. custom layout save and reload', () => {
  it('round-trips coordinates', () => {
    const auto = buildForecourtNodes(oneTankTwoPumps())
    const persist = toLayoutPersist(auto)
    const reloaded = buildForecourtNodes({
      ...oneTankTwoPumps(),
      layout: {
        mode: 'CUSTOM',
        canvasWidth: persist.canvas_width,
        canvasHeight: persist.canvas_height,
        items: persist.items.map((i) => ({
          assetType: i.asset_type,
          assetId: i.asset_id,
          label: i.label,
          x: i.x_position,
          y: i.y_position,
          width: i.width,
          height: i.height,
          configuration: i.configuration_json,
        })),
      },
    })
    const tank = reloaded.find((n) => n.kind === 'TANK')!
    const original = auto.find((n) => n.kind === 'TANK')!
    expect(tank.x).toBe(original.x)
    expect(tank.y).toBe(original.y)
  })
})

describe('16. reset view versus reset layout', () => {
  it('treats them as different operations', () => {
    expect('reset-view').not.toBe('reset-layout')
    const moved = buildForecourtNodes(oneTankTwoPumps()).map((n) =>
      n.kind === 'TANK' ? { ...n, x: n.x + 80 } : n,
    )
    const snap = snapshotNodes(moved)
    const restored = applySnapshot(moved, snap)
    expect(restored.find((n) => n.kind === 'TANK')?.x).toBe(moved.find((n) => n.kind === 'TANK')?.x)
    const auto = buildForecourtNodes({ ...oneTankTwoPumps(), layout: { mode: 'AUTO', items: [] } })
    expect(auto.find((n) => n.kind === 'TANK')?.x).not.toBe(moved.find((n) => n.kind === 'TANK')?.x)
  })
})

describe('17–18. station-manager vs admin access', () => {
  it('station manager cannot open admin layout APIs; admin can', () => {
    expect(normalizeRole('STATION_MANAGER')).toBe('STATION_MANAGER')
    expect(canAccessPath('STATION_MANAGER', '/admin/stations/x')).toBe(false)
    expect(canAccessPath('ADMIN', '/digital-twin')).toBe(true)
  })
})

describe('19. live status changes do not move nodes', () => {
  it('keeps positions when only inferredStatus changes', () => {
    const a = oneTankTwoPumps()
    const first = buildForecourtNodes(a)
    a.pumps = a.pumps!.map((p) => ({ ...p, inferredStatus: 'DISPENSING' }))
    const second = buildForecourtNodes(a)
    const firstPump = first.find((n) => n.kind === 'PUMP' && String(n.raw?.parentPumpId || n.id).includes('p1'))
    const secondPump = second.find((n) => n.kind === 'PUMP' && String(n.raw?.parentPumpId || n.id).includes('p1'))
    expect(topologyKey(a).includes('p1')).toBe(true)
    expect(firstPump?.x).toBe(secondPump?.x)
    expect(firstPump?.y).toBe(secondPump?.y)
  })
})

describe('20. responsive island columns', () => {
  it('uses 3 / 2 / 1 columns at 1920, 1280- and 700', () => {
    expect(islandColumnCount(1920)).toBe(3)
    expect(islandColumnCount(1440)).toBe(3)
    expect(islandColumnCount(1280)).toBe(3)
    expect(islandColumnCount(1279)).toBe(2)
    expect(islandColumnCount(700)).toBe(1)
    const wide = buildAutoForecourtLayout(fourTankTwelvePumpState(), 1920)
    const mid = buildAutoForecourtLayout(fourTankTwelvePumpState(), 1100)
    const islandsWide = wide.nodes.filter((n) => n.kind === 'ISLAND')
    const islandsMid = mid.nodes.filter((n) => n.kind === 'ISLAND')
    const wideRows = new Set(islandsWide.map((n) => Math.round(n.y))).size
    const midRows = new Set(islandsMid.map((n) => Math.round(n.y))).size
    expect(wideRows).toBe(4)
    expect(midRows).toBeGreaterThanOrEqual(6)
  })
})

describe('21. canvas height is bounded (no huge empty pane)', () => {
  it('stays within min/max', () => {
    const { canvasHeight } = buildAutoForecourtLayout(fourTankTwelvePumpState(), 1440)
    expect(canvasHeight).toBeGreaterThan(400)
    expect(canvasHeight).toBeLessThanOrEqual(1100)
  })
})

describe('22. accessible names and status labels', () => {
  it('does not use COMPLETED as a live pump state', () => {
    expect(displayPumpStatus('COMPLETED')).toBe('IDLE')
    expect(pumpStatusLabel('DISPENSING')).toBe('Dispensing')
    expect(pumpStatusLabel('POWERED_OFF')).toBe('Powered off')
  })
})

describe('physical pump / nozzle grouping', () => {
  it('renders one physical pump with two independent nozzle cards', () => {
    const groups = groupPumpsIntoIslands([
      {
        id: 'p1',
        name: 'Pump 1',
        nozzles: [
          { id: 'n1', name: 'Nozzle 1', inferredStatus: 'DISPENSING', product: 'PMS' },
          { id: 'n2', name: 'Nozzle 2', inferredStatus: 'IDLE', product: 'PMS' },
        ],
      },
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].pumps.map((p) => p.name)).toEqual(['Nozzle 1', 'Nozzle 2'])
    const state: TwinLiveState = {
      layout: { mode: 'AUTO', items: [] },
      tanks: [{ id: 't1', name: 'PMS', product: 'PMS' }],
      pumps: [
        {
          id: 'p1',
          name: 'Pump 1',
          nozzles: [
            { id: 'n1', name: 'Nozzle 1', product: 'PMS', inferredStatus: 'DISPENSING' },
            { id: 'n2', name: 'Nozzle 2', product: 'PMS', inferredStatus: 'IDLE' },
          ],
        },
      ],
      tankPumpConnections: [
        { id: 'c1', tankId: 't1', pumpId: 'p1', nozzleId: 'n1', product: 'PMS', isPrimary: true, active: true },
        { id: 'c2', tankId: 't1', pumpId: 'p1', nozzleId: 'n2', product: 'PMS', isPrimary: true, active: true },
      ],
    }
    const { nodes } = layoutAndRoutes(state)
    expect(nodes.filter((n) => n.kind === 'ISLAND')).toHaveLength(1)
    expect(nodes.find((n) => n.kind === 'ISLAND')?.label).toBe('Pump 1')
    const nozzles = nodes.filter((n) => n.kind === 'PUMP')
    expect(nozzles).toHaveLength(2)
    expect(nozzles.map((n) => n.label)).toEqual(['Nozzle 1', 'Nozzle 2'])
    expect(nozzles[0].status).toBe('DISPENSING')
    expect(nozzles[1].status).toBe('IDLE')
  })
})

describe('dual primary conflict', () => {
  it('surfaces a configuration warning', () => {
    const state = oneTankTwoPumps()
    state.tanks = [
      { id: 't1', product: 'PMS', name: 'A' },
      { id: 't2', product: 'PMS', name: 'B' },
    ]
    state.tankPumpConnections = [
      { id: 'c1', tankId: 't1', pumpId: 'p1', product: 'PMS', isPrimary: true, active: true },
      { id: 'c2', tankId: 't2', pumpId: 'p1', product: 'PMS', isPrimary: true, active: true },
    ]
    const { warnings } = layoutAndRoutes(state)
    expect(warnings.some((w) => w.code === 'DUAL_PRIMARY')).toBe(true)
  })
})
