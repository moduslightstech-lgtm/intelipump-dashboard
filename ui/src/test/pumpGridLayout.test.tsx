import { describe, expect, it } from 'vitest'
import {
  buildForecourtNodes,
  buildForecourtPipes,
  pumpsHaveNoOverlap,
} from '../components/twin/forecourtLayout'
import { groupPumpsIntoIslands } from '../components/twin/schematic/autoLayout'
import type { TwinLiveState } from '../api/client'

function makePumps(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `pump-${i}`,
    pumpCode: `P${i + 1}`,
    mqttPumpId: i === 0 ? 'PUMP-05/06' : `PUMP-${String(i + 1).padStart(2, '0')}`,
    displayOrder: i + 1,
    inferredStatus: 'IDLE',
    product: 'PMS',
  }))
}

function autoState(nPumps: number): TwinLiveState {
  const pumps = makePumps(nPumps)
  return {
    station: { name: 'Boluwaji', stationCode: 'BLJ-IB001', operationalStatus: 'OPEN' },
    layout: { mode: 'AUTO', canvasWidth: 1400, canvasHeight: 720, items: [] },
    tanks: [
      {
        id: 'tank-pms',
        tankCode: 'TANK-PMS-01',
        name: 'PMS Tank 1',
        product: 'PMS',
        capacityLiters: 45000,
        reportedLiters: 23000,
        fillPercent: 51,
        measurementSource: 'MANUAL',
        inferredStatus: 'NORMAL',
      },
    ],
    pumps,
    tankPumpConnections: pumps.map((p, i) => ({
      id: `c${i}`,
      tankId: 'tank-pms',
      pumpId: p.id,
      mqttPumpId: p.mqttPumpId,
      product: 'PMS',
      isPrimary: true,
      source: 'CONFIGURED',
    })),
  } as TwinLiveState
}

describe('island grouping', () => {
  it('uses one outer box per physical pump', () => {
    expect(groupPumpsIntoIslands(makePumps(12))).toHaveLength(12)
    expect(groupPumpsIntoIslands(makePumps(5))).toHaveLength(5)
  })
})

describe('AUTO island layout', () => {
  const cases: Array<{ n: number; islandRows: number; label: string }> = [
    { n: 1, islandRows: 1, label: '1 pump one island row' },
    { n: 2, islandRows: 1, label: '2 pumps one island row' },
    { n: 4, islandRows: 2, label: '4 pumps two island rows' },
    { n: 6, islandRows: 2, label: '6 pumps two island rows' },
    { n: 8, islandRows: 3, label: '8 pumps three island rows' },
    { n: 12, islandRows: 4, label: '12 pumps 3x4 islands' },
  ]

  for (const c of cases) {
    it(c.label, () => {
      const nodes = buildForecourtNodes(autoState(c.n), 1440)
      const pumps = nodes.filter((n) => n.kind === 'PUMP')
      expect(pumps).toHaveLength(c.n)
      expect(pumpsHaveNoOverlap(nodes)).toBe(true)
      const islands = nodes.filter((n) => n.kind === 'ISLAND')
      const ys = [...new Set(islands.map((p) => Math.round(p.y)))].sort((a, b) => a - b)
      expect(ys).toHaveLength(c.islandRows)
    })
  }
})

describe('CUSTOM missing pump staging', () => {
  it('places a new pump without overlapping the existing pump', () => {
    const pumps = makePumps(2)
    const state = {
      ...autoState(2),
      layout: {
        mode: 'CUSTOM',
        canvasWidth: 1200,
        canvasHeight: 700,
        items: [
          { id: 'office', assetType: 'OFFICE', x: 1000, y: 56, width: 140, height: 70 },
          { id: 't1', assetType: 'TANK', assetId: 'tank-pms', x: 100, y: 56, width: 200, height: 118 },
          { id: 'p1', assetType: 'PUMP', assetId: 'pump-0', x: 200, y: 280, width: 168, height: 124 },
        ],
      },
      pumps,
    } as TwinLiveState

    const nodes = buildForecourtNodes(state)
    const pumpNodes = nodes.filter((n) => n.kind === 'PUMP')
    expect(pumpNodes).toHaveLength(2)
    expect(pumpsHaveNoOverlap(nodes)).toBe(true)
  })
})

describe('pipe branches vs pump cards', () => {
  it('manifold sits between tanks and pumps; branches target pump tops', () => {
    const state = autoState(8)
    const nodes = buildForecourtNodes(state, 1440)
    const pipes = buildForecourtPipes(nodes, state.tankPumpConnections)
    expect(pipes).toHaveLength(8)
    const tanks = nodes.filter((n) => n.kind === 'TANK')
    const pumps = nodes.filter((n) => n.kind === 'PUMP')
    const tankBottom = Math.max(...tanks.map((t) => t.y + t.h))
    const pumpTop = Math.min(...pumps.map((p) => p.y))
    for (const pipe of pipes) {
      expect(pipe.midY).toBeGreaterThan(tankBottom)
      expect(pipe.midY).toBeLessThan(pumpTop)
      expect(pipe.d).not.toMatch(/C |A /)
    }
  })
})
