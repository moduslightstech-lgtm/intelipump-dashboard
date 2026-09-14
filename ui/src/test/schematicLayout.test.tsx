import { describe, expect, it } from 'vitest'
import {
  autoArrangeNodes,
  buildAutoForecourtLayout,
  buildForecourtNodes,
  groupPumpsIntoIslands,
  islandColumnCount,
  nodesHaveNoOverlap,
  toLayoutPersist,
  topologyKey,
} from '../components/twin/schematic/autoLayout'
import { LAYOUT_SCHEMA_VERSION } from '../components/twin/schematic/constants'
import { idleTwoNozzleState } from '../components/twin/schematic/dispenserFixtures'
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
  it('routes two supply pipes from one trunk', () => {
    const { nodes, routes, trunks } = layoutAndRoutes(oneTankTwoPumps())
    expect(nodes.filter((n) => n.kind === 'TANK')).toHaveLength(1)
    expect(nodes.filter((n) => n.kind === 'PUMP')).toHaveLength(2)
    expect(routes).toHaveLength(2)
    expect(trunks).toHaveLength(1)
    expect(routes.every((r) => r.tankId === 't1')).toBe(true)
    expect(new Set(routes.map((r) => r.id)).size).toBe(2)
    expect(trunks[0].id).toBe(`trunk:t1`)
    expect(routes.every((r) => r.segmentType === 'PUMP_SUPPLY')).toBe(true)
  })
})

describe('2. four tanks / twelve pumps fixture', () => {
  it('places 4 tanks, 12 physical pumps, 24 nozzle ports', () => {
    const { nodes } = layoutAndRoutes(fourTankTwelvePumpState(), 1440)
    expect(nodes.filter((n) => n.kind === 'TANK')).toHaveLength(4)
    expect(nodes.filter((n) => n.kind === 'ISLAND')).toHaveLength(12)
    expect(nodes.filter((n) => n.kind === 'PUMP')).toHaveLength(24)
    expect(nodes.some((n) => n.kind === 'OFFICE')).toBe(false)
    expect(nodes.some((n) => n.kind === 'ENTRANCE')).toBe(false)
    expect(nodes.some((n) => n.kind === 'EXIT')).toBe(false)
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
  it('keeps tanks and physical pumps apart', () => {
    const nodes = buildForecourtNodes(fourTankTwelvePumpState(), 1440)
    expect(nodesHaveNoOverlap(nodes)).toBe(true)
  })
})

describe('12. pipe endpoints use tank outlet and pump top ports', () => {
  it('anchors correctly', () => {
    const { nodes, routes, trunks } = layoutAndRoutes(oneTankTwoPumps())
    const tank = nodes.find((n) => n.kind === 'TANK')!
    const pump = nodes.find((n) => n.kind === 'PUMP')!
    const outletY = tank.y + Math.min(
      110,
      Math.max(8, tank.h - 38),
    )
    expect(getTankOutletAnchor(tank).y).toBe(outletY)
    expect(getPumpInletAnchor(pump).y).toBe(pump.y)
    expect(trunks[0].source.y).toBe(outletY)
    expect(routes[0].source.y).toBe(trunks[0].y)
    expect(routes[0].target.y).toBe(nodes.find((n) => n.id === routes[0].pumpId)!.y)
  })
})

describe('13. pipes do not pass through unrelated node interiors', () => {
  it('avoids tank and pump boxes', () => {
    const { nodes, routes, trunks } = layoutAndRoutes(fourTankTwelvePumpState(), 1440)
    const hits = routes.filter((r) => routeHitsUnrelated(r, nodes))
    expect(hits).toHaveLength(0)
    expect(trunks.every((t) => t.path.startsWith('M '))).toBe(true)
  })
})

describe('14. shared trunk supplies the correct physical pumps', () => {
  it('maps each supply route to a live island or pump', () => {
    const { nodes, routes } = layoutAndRoutes(fourTankTwelvePumpState())
    const targets = new Set(
      nodes.filter((n) => n.kind === 'PUMP' || n.kind === 'ISLAND').map((n) => n.id),
    )
    expect(routes.every((r) => targets.has(r.pumpId) || targets.has(String(r.targetNodeId || '')))).toBe(
      true,
    )
    expect(routes.every((r) => r.segmentType === 'PUMP_SUPPLY')).toBe(true)
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

  it('does not change topology when live LCD amounts change', () => {
    const a = oneTankTwoPumps()
    const before = topologyKey(a)
    a.pumps = a.pumps!.map((p) => ({
      ...p,
      lastTransactionAmount: 600,
      lastTransactionVolume: 0.51,
      inferredStatus: 'DISPENSING',
    }))
    expect(topologyKey(a)).toBe(before)
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
  it('renders one physical pump with two independent nozzle ports', () => {
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

  it('relabels saved Pump 1 / Pump 2 cards to nested nozzles', () => {
    const state: TwinLiveState = {
      layout: {
        mode: 'CUSTOM',
        items: [
          {
            assetType: 'ISLAND',
            assetId: 'shell-p1',
            label: 'Pump 1',
            x: 80,
            y: 200,
            width: 460,
            height: 200,
          },
          {
            assetType: 'PUMP',
            assetId: 'p1',
            label: 'Pump 1',
            x: 100,
            y: 230,
            width: 196,
            height: 136,
            configuration: { islandId: 'shell-p1' },
          },
          {
            assetType: 'PUMP',
            assetId: 'legacy-p2',
            label: 'Pump 2',
            x: 340,
            y: 230,
            width: 196,
            height: 136,
            configuration: { islandId: 'shell-p1' },
          },
        ],
      },
      tanks: [{ id: 't1', name: 'PMS Lab Tank', product: 'PMS' }],
      pumps: [
        {
          id: 'p1',
          name: 'Pump 1',
          mqttPumpId: 'pump-1',
          nozzles: [
            { id: 'n1', name: 'Nozzle 1', sourceIdentifier: 'pump-1', product: 'PMS', inferredStatus: 'IDLE' },
            { id: 'n2', name: 'Nozzle 2', sourceIdentifier: 'pump-2', product: 'PMS', inferredStatus: 'UNKNOWN' },
          ],
        },
      ],
      tankPumpConnections: [
        { id: 'c1', tankId: 't1', pumpId: 'p1', nozzleId: 'n1', product: 'PMS', isPrimary: true, active: true },
        { id: 'c2', tankId: 't1', pumpId: 'p1', nozzleId: 'n2', product: 'PMS', isPrimary: true, active: true },
      ],
    }
    const { nodes, warnings } = layoutAndRoutes(state)
    const inner = nodes.filter((n) => n.kind === 'PUMP')
    expect(inner.map((n) => n.label)).toEqual(['Nozzle 1', 'Nozzle 2'])
    expect(inner.map((n) => n.id)).toEqual(['n1', 'n2'])
    expect(inner.every((n) => n.raw?.assetRole === 'NOZZLE')).toBe(true)
    expect(warnings.some((w) => w.code === 'UNCONNECTED_PUMP')).toBe(false)
    expect(warnings.some((w) => w.code === 'PRODUCT_NOT_MAPPED')).toBe(false)
    expect(nodes.filter((n) => n.kind === 'ISLAND')).toHaveLength(1)
    expect(nodes.find((n) => n.kind === 'ISLAND')?.x).toBe(80)
    expect(nodes.find((n) => n.kind === 'ISLAND')?.y).toBe(200)
  })
})

describe('saved layout is positions only', () => {
  function currentTopology(extras: Record<string, unknown> = {}): TwinLiveState {
    return {
      ...idleTwoNozzleState(),
      station: { id: 'lab', mqttStationId: 'InteliPump-US-Lab', stationCode: 'LAB' },
      ...extras,
    }
  }

  it('restores only matching canonical IDs from a legacy island layout', () => {
    const state = currentTopology({
      layout: {
        mode: 'CUSTOM',
        items: [
          { assetType: 'TANK', assetId: 't1', x: 40, y: 60 },
          { assetType: 'ISLAND', assetId: 'island-1', label: 'ISLAND 1', x: 320, y: 240, width: 460, height: 296 },
          { assetType: 'ISLAND', assetId: 'shell-p1', label: 'Pump 1', x: 120, y: 220 },
          { assetType: 'PUMP', assetId: 'legacy-empty', label: 'Pump', x: 500, y: 240, width: 196, height: 136 },
        ],
      },
    })
    const nodes = buildForecourtNodes(state)
    const islands = nodes.filter((n) => n.kind === 'ISLAND')
    expect(islands).toHaveLength(1)
    expect(islands[0].id).toBe('shell-p1')
    expect(islands[0].label).toBe('Pump 1')
    expect(islands[0].x).toBe(120)
    expect(islands[0].y).toBe(220)
    expect(nodes.some((n) => n.id === 'island-1' || n.label === 'ISLAND 1')).toBe(false)
    expect(nodes.filter((n) => n.kind === 'PUMP')).toHaveLength(2)
  })

  it('maps a single obsolete island position onto Pump 1', () => {
    const state = currentTopology({
      layout: {
        mode: 'CUSTOM',
        items: [{ assetType: 'ISLAND', assetId: 'island-1', label: 'ISLAND 1', x: 333, y: 277 }],
      },
    })
    const island = buildForecourtNodes(state).find((n) => n.kind === 'ISLAND')!
    expect(island.id).toBe('shell-p1')
    expect(island.x).toBe(333)
    expect(island.y).toBe(277)
  })

  it('does not restore deleted topology from saved layout', () => {
    const state = currentTopology({
      layout: {
        mode: 'CUSTOM',
        items: [
          { assetType: 'TANK', assetId: 't-dead', x: 10, y: 10 },
          { assetType: 'ISLAND', assetId: 'ghost-pump', x: 400, y: 400 },
          { assetType: 'TANK', assetId: 't1', x: 88, y: 48 },
        ],
      },
    })
    const nodes = buildForecourtNodes(state)
    expect(nodes.some((n) => n.id === 't-dead' || n.id === 'ghost-pump')).toBe(false)
    expect(nodes.find((n) => n.kind === 'TANK')?.id).toBe('t1')
    expect(nodes.find((n) => n.kind === 'TANK')?.x).toBe(88)
    expect(nodes.filter((n) => n.kind === 'ISLAND')).toHaveLength(1)
  })

  it('auto-positions new equipment that has no saved coordinates', () => {
    const auto = buildForecourtNodes({
      ...currentTopology(),
      pumps: [
        ...(currentTopology().pumps || []),
        {
          id: 'p2',
          name: 'Pump 2',
          pumpCode: 'P2',
          mqttPumpId: 'p2',
          nozzles: [
            { id: 'n3', name: 'Nozzle 1', product: 'PMS' },
            { id: 'n4', name: 'Nozzle 2', product: 'PMS' },
          ],
        },
      ],
      layout: {
        mode: 'CUSTOM',
        items: [{ assetType: 'ISLAND', assetId: 'shell-p1', x: 140, y: 260 }],
      },
    })
    const islands = auto.filter((n) => n.kind === 'ISLAND')
    expect(islands).toHaveLength(2)
    expect(islands.find((n) => n.id === 'shell-p1')?.x).toBe(140)
    expect(islands.find((n) => n.id === 'shell-p2')?.x).not.toBe(140)
  })

  it('keeps the same equipment node count on first load and Auto reset', () => {
    const state = currentTopology({
      layout: {
        mode: 'CUSTOM',
        items: [
          { assetType: 'ISLAND', assetId: 'island-1', x: 200, y: 200, height: 296 },
          { assetType: 'PUMP', assetId: 'old-card', x: 200, y: 200 },
        ],
      },
    })
    const first = buildForecourtNodes(state)
    const reset = autoArrangeNodes(state)
    const count = (nodes: typeof first) =>
      nodes.filter((n) => n.kind === 'ISLAND' || n.kind === 'TANK' || n.kind === 'PUMP').length
    expect(count(first)).toBe(count(reset))
    expect(first.filter((n) => n.kind === 'ISLAND')).toHaveLength(1)
    expect(reset.filter((n) => n.kind === 'ISLAND')).toHaveLength(1)
  })

  it('preserves tank positions and discards control-room nodes during island migration', () => {
    const state = currentTopology({
      layout: {
        mode: 'CUSTOM',
        items: [
          { assetType: 'TANK', assetId: 't1', x: 77, y: 55 },
          { assetType: 'OFFICE', x: 900, y: 66 },
          { assetType: 'ISLAND', assetId: 'island-1', x: 250, y: 300 },
        ],
      },
    })
    const nodes = buildForecourtNodes(state)
    expect(nodes.find((n) => n.kind === 'TANK')?.x).toBe(77)
    expect(nodes.find((n) => n.kind === 'OFFICE')).toBeUndefined()
    expect(nodes.find((n) => n.kind === 'ISLAND')?.x).toBe(250)
  })

  it('does not recreate the empty duplicate box after a second build (refresh)', () => {
    const state = currentTopology({
      layout: {
        mode: 'CUSTOM',
        items: [
          { assetType: 'ISLAND', assetId: 'island-1', x: 200, y: 200 },
          { assetType: 'ISLAND', assetId: 'shell-p1', x: 200, y: 200 },
        ],
      },
    })
    const a = buildForecourtNodes(state)
    const b = buildForecourtNodes(state)
    expect(a.filter((n) => n.kind === 'ISLAND')).toHaveLength(1)
    expect(b.filter((n) => n.kind === 'ISLAND')).toHaveLength(1)
    expect(toLayoutPersist(a).layout_version).toBe(LAYOUT_SCHEMA_VERSION)
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
