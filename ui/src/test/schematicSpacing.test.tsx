import { describe, expect, it } from 'vitest'
import {
  autoArrangeNodes,
  buildAutoForecourtLayout,
  buildForecourtNodes,
  canvasSizeFromNodes,
  detectOverlappingEquipment,
  minGap,
  nodesHaveNoOverlap,
  pumpCardsConflict,
  pumpsInSameIsland,
} from '../components/twin/schematic/autoLayout'
import { buildConnectionGraph, relatedEquipment } from '../components/twin/schematic/connectionGraph'
import {
  ISLAND_GAP_X,
  ISLAND_GAP_Y,
  MAX_CANVAS_H,
  MIN_CANVAS_H,
  MIN_ZOOM,
  PIPE_CLEARANCE,
  PUMP_HORIZONTAL_GAP,
  PUMP_NODE_WIDTH,
  PUMP_VERTICAL_GAP,
} from '../components/twin/schematic/constants'
import { fourTankTwelvePumpState } from '../components/twin/schematic/fourByTwelveFixture'
import {
  buildManifoldRoutes,
  getPumpInletAnchor,
  getTankOutletAnchor,
  routeHitsUnrelated,
  tankOutletOffset,
} from '../components/twin/schematic/orthogonalRouting'
import type { TwinLiveState } from '../api/client'
import type { SchematicNode } from '../components/twin/schematic/types'

function nPumpState(nPumps: number, nTanks = 1): TwinLiveState {
  const tanks = Array.from({ length: nTanks }, (_, i) => ({
    id: `t${i + 1}`,
    name: i === 0 ? 'PMS Lab Tank' : `Tank ${i + 1}`,
    product: i % 2 === 0 ? 'PMS' : 'AGO',
    tankCode: `T${i + 1}`,
    reportedLiters: 10.39,
    capacityLiters: 25,
  }))
  const pumps = Array.from({ length: nPumps }, (_, i) => ({
    id: `p${i + 1}`,
    name: `Pump ${i + 1}`,
    pumpCode: `P${i + 1}`,
    displayOrder: i + 1,
    islandNumber: Math.floor(i / 2) + 1,
    product: tanks[Math.min(i % nTanks, nTanks - 1)].product,
  }))
  return {
    layout: { mode: 'AUTO', items: [] },
    tanks,
    pumps,
    tankPumpConnections: pumps.map((p, i) => ({
      id: `c${i}`,
      tankId: tanks[i % nTanks].id,
      pumpId: p.id,
      product: p.product,
      isPrimary: true,
      active: true,
    })),
  }
}

function horizontalGap(a: SchematicNode, b: SchematicNode) {
  if (a.x > b.x) return horizontalGap(b, a)
  return b.x - (a.x + a.w)
}

function verticalGap(a: SchematicNode, b: SchematicNode) {
  if (a.y > b.y) return verticalGap(b, a)
  return b.y - (a.y + a.h)
}

function rectsHorizontallyAligned(a: SchematicNode, b: SchematicNode) {
  return a.x < b.x + b.w && b.x < a.x + a.w
}

function assertPumpSpacing(nodes: SchematicNode[]) {
  const pumps = nodes.filter((n) => n.kind === 'PUMP')
  const islands = nodes.filter((n) => n.kind === 'ISLAND')
  const tanks = nodes.filter((n) => n.kind === 'TANK')
  expect(nodesHaveNoOverlap(nodes)).toBe(true)
  expect(pumpCardsConflict(nodes)).toBe(false)
  expect(pumps.every((p) => p.w >= PUMP_NODE_WIDTH)).toBe(true)

  for (let i = 0; i < pumps.length; i++) {
    for (let j = i + 1; j < pumps.length; j++) {
      const a = pumps[i]
      const b = pumps[j]
      expect(minGap(a, b)).toBeGreaterThan(0)
      const sameIsland = pumpsInSameIsland(a, b)
      const sameRow = Math.abs(a.y - b.y) < 4
      if (sameIsland && sameRow) {
        expect(horizontalGap(a, b)).toBeGreaterThanOrEqual(PUMP_HORIZONTAL_GAP)
      }
      if (rectsHorizontallyAligned(a, b) && Math.abs(a.x - b.x) < 4) {
        expect(verticalGap(a, b)).toBeGreaterThanOrEqual(PUMP_VERTICAL_GAP)
      }
    }
  }

  const rowYs = [...new Set(islands.map((i) => Math.round(i.y)))].sort((a, b) => a - b)
  for (const y of rowYs) {
    const row = islands.filter((i) => Math.round(i.y) === y).sort((a, b) => a.x - b.x)
    for (let i = 0; i < row.length - 1; i++) {
      expect(horizontalGap(row[i], row[i + 1])).toBeGreaterThanOrEqual(ISLAND_GAP_X)
    }
  }
  for (let i = 0; i < rowYs.length - 1; i++) {
    const top = islands.find((n) => Math.round(n.y) === rowYs[i])!
    const bot = islands.find((n) => Math.round(n.y) === rowYs[i + 1])!
    expect(verticalGap(top, bot)).toBeGreaterThanOrEqual(ISLAND_GAP_Y)
  }

  for (const tank of tanks) {
    for (const pump of pumps) {
      expect(minGap(tank, pump)).toBeGreaterThan(0)
    }
  }
}

describe('pump bounding boxes and required spacing', () => {
  const cases = [
    { pumps: 2, tanks: 1 },
    { pumps: 4, tanks: 2 },
    { pumps: 8, tanks: 3 },
    { pumps: 12, tanks: 4 },
  ]
  for (const c of cases) {
    it(`${c.tanks} tank(s) / ${c.pumps} pumps never overlap`, () => {
      const nodes = buildForecourtNodes(nPumpState(c.pumps, c.tanks), 1440)
      assertPumpSpacing(nodes)
    })
  }

  it('uses measured pump/tank sizes when they exceed estimates', () => {
    const nodes = buildForecourtNodes(nPumpState(2, 1), {
      viewportWidth: 1440,
      metrics: { pumpW: 220, pumpH: 150, tankW: 248, tankH: 168 },
    })
    const pumps = nodes.filter((n) => n.kind === 'PUMP').sort((a, b) => a.x - b.x)
    expect(pumps[0].w).toBe(220)
    expect(pumps[0].h).toBe(150)
    expect(horizontalGap(pumps[0], pumps[1])).toBeGreaterThanOrEqual(32)
    assertPumpSpacing(nodes)
  })
})

describe('pipe handles and clearance', () => {
  it('starts at the vessel outlet and ends on centered pump tops', () => {
    const state = nPumpState(2, 1)
    const nodes = buildForecourtNodes(state, 1440)
    const { edges } = buildConnectionGraph(nodes, state.tankPumpConnections)
    const { routes } = buildManifoldRoutes(nodes, edges)
    const tank = nodes.find((n) => n.kind === 'TANK')!
    const pumps = nodes.filter((n) => n.kind === 'PUMP')
    expect(getTankOutletAnchor(tank).y).toBe(tank.y + tankOutletOffset(tank.h))
    expect(getTankOutletAnchor(tank).y).toBeLessThan(tank.y + tank.h)
    for (const r of routes) {
      const pump = pumps.find((p) => p.id === r.pumpId)!
      expect(r.source.y).toBe(getTankOutletAnchor(tank).y)
      expect(r.target.x).toBe(getPumpInletAnchor(pump).x)
      expect(r.target.y).toBe(pump.y)
      expect(r.manifoldY).toBeGreaterThanOrEqual(tank.y + tank.h + PIPE_CLEARANCE)
    }
  })

  it('does not send pipes through node interiors', () => {
    const state = fourTankTwelvePumpState()
    const nodes = buildForecourtNodes(state, 1440)
    const { edges } = buildConnectionGraph(nodes, state.tankPumpConnections)
    const { routes } = buildManifoldRoutes(nodes, edges)
    expect(routes.filter((r) => routeHitsUnrelated(r, nodes))).toHaveLength(0)
  })
})

describe('selection keeps connected equipment readable', () => {
  it('selecting a pump keeps its source tank related', () => {
    const state = nPumpState(2, 1)
    const nodes = buildForecourtNodes(state, 1440)
    const { edges } = buildConnectionGraph(nodes, state.tankPumpConnections)
    const related = relatedEquipment(edges, { pumpId: 'p2' })
    expect(related.tanks.has('t1')).toBe(true)
    expect(related.pumps.has('p2')).toBe(true)
    expect(related.pumps.has('p1')).toBe(false)
    expect(related.pipes.size).toBeGreaterThan(0)
  })

  it('selecting a tank keeps every connected pump related', () => {
    const state = nPumpState(4, 1)
    const nodes = buildForecourtNodes(state, 1440)
    const { edges } = buildConnectionGraph(nodes, state.tankPumpConnections)
    const related = relatedEquipment(edges, { tankId: 't1' })
    expect(related.pumps.has('p1')).toBe(true)
    expect(related.pumps.has('p2')).toBe(true)
    expect(related.pumps.has('p3')).toBe(true)
    expect(related.pumps.has('p4')).toBe(true)
  })

  it('drawer copy uses tank names rather than raw ids', () => {
    const state = nPumpState(2, 1)
    const nodes = buildForecourtNodes(state, 1440)
    const { edges } = buildConnectionGraph(nodes, state.tankPumpConnections)
    expect(edges[0].tankName).toBe('PMS Lab Tank')
    expect(edges[0].tankName).not.toMatch(/t1/)
    expect(`Primary tank: ${edges[0].tankName} · ${edges[0].product}`).toBe('Primary tank: PMS Lab Tank · PMS')
  })
})

describe('compact vs maximum canvas', () => {
  it('shrinks canvas for 1 tank and 2 pumps', () => {
    const small = buildAutoForecourtLayout(nPumpState(2, 1), 1440)
    const large = buildAutoForecourtLayout(fourTankTwelvePumpState(), 1440)
    expect(small.canvasHeight).toBeGreaterThanOrEqual(MIN_CANVAS_H)
    expect(small.canvasHeight).toBeLessThan(large.canvasHeight)
    expect(small.canvasWidth).toBeLessThan(large.canvasWidth)
  })

  it('4 tanks / 12 pumps stay navigable at desktop widths', () => {
    for (const width of [1280, 1440, 1920]) {
      const { nodes, canvasWidth, canvasHeight } = buildAutoForecourtLayout(fourTankTwelvePumpState(), width)
      assertPumpSpacing(nodes)
      expect(canvasHeight).toBeLessThanOrEqual(MAX_CANVAS_H)
      const size = canvasSizeFromNodes(nodes)
      expect(width / MIN_ZOOM).toBeGreaterThanOrEqual(Math.min(size.width, canvasWidth) * 0.5)
      expect(nodes.filter((n) => n.kind === 'ISLAND')).toHaveLength(12)
      expect(nodes.filter((n) => n.kind === 'PUMP')).toHaveLength(24)
      expect(nodes.filter((n) => n.kind === 'TANK')).toHaveLength(4)
    }
  })
})

describe('saved overlapping CUSTOM layout', () => {
  function overlappingCustom(): TwinLiveState {
    const base = nPumpState(2, 1)
    return {
      ...base,
      layout: {
        mode: 'CUSTOM',
        canvasWidth: 1200,
        canvasHeight: 700,
        items: [
          { assetType: 'OFFICE', x: 1000, y: 48, width: 140, height: 70 },
          { assetType: 'TANK', assetId: 't1', x: 80, y: 48, width: 200, height: 118 },
          {
            assetType: 'ISLAND',
            assetId: 'island-1',
            x: 188,
            y: 252,
            width: 370,
            height: 164,
          },
          {
            assetType: 'PUMP',
            assetId: 'p1',
            x: 200,
            y: 280,
            width: 168,
            height: 124,
            configuration: { islandId: 'island-1' },
          },
          {
            assetType: 'PUMP',
            assetId: 'p2',
            x: 378,
            y: 280,
            width: 168,
            height: 124,
            configuration: { islandId: 'island-1' },
          },
        ],
      },
    }
  }

  it('detects overlapping saved pump rectangles', () => {
    const nodes = buildForecourtNodes(overlappingCustom(), 1440)
    const pumps = nodes.filter((n) => n.kind === 'PUMP').sort((a, b) => a.x - b.x)
    expect(pumps).toHaveLength(2)
    expect(pumps[0].w).toBe(PUMP_NODE_WIDTH)
    expect(pumps[1].w).toBe(PUMP_NODE_WIDTH)
    expect(detectOverlappingEquipment(nodes)).toBe(true)
    expect(pumpCardsConflict(nodes)).toBe(true)
    expect(horizontalGap(pumps[0], pumps[1])).toBeLessThan(PUMP_HORIZONTAL_GAP)
  })

  it('auto arrange corrects overlapping coordinates without needing a save first', () => {
    const arranged = autoArrangeNodes(overlappingCustom(), 1440)
    expect(detectOverlappingEquipment(arranged)).toBe(false)
    assertPumpSpacing(arranged)
    const pumps = arranged.filter((n) => n.kind === 'PUMP').sort((a, b) => a.x - b.x)
    expect(getPumpInletAnchor(pumps[0]).x).toBe(pumps[0].x + pumps[0].w / 2)
    expect(getPumpInletAnchor(pumps[1]).x).toBe(pumps[1].x + pumps[1].w / 2)
    expect(getPumpInletAnchor(pumps[1]).x - getPumpInletAnchor(pumps[0]).x).toBeGreaterThanOrEqual(
      PUMP_NODE_WIDTH + PUMP_HORIZONTAL_GAP,
    )
  })
})
