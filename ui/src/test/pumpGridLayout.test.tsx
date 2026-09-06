import { describe, expect, it } from 'vitest'
import {
  buildForecourtNodes,
  buildForecourtPipes,
  pumpsHaveNoOverlap,
} from '../components/twin/forecourtLayout'
import {
  assertNoPumpOverlaps,
  computePumpGridLayout,
  computeRowCenteredXPositions,
  groupPumpsIntoRows,
  PUMP_CARD_W,
  PUMP_MAX_COLS,
} from '../components/twin/pumpGridLayout'
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
    layout: {
      mode: 'AUTO',
      canvasWidth: 1200,
      canvasHeight: 700,
      items: [],
    },
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

describe('groupPumpsIntoRows', () => {
  it('chunks by 4', () => {
    expect(groupPumpsIntoRows([1, 2, 3, 4, 5], 4)).toEqual([[1, 2, 3, 4], [5]])
    expect(groupPumpsIntoRows([1, 2], 4)).toEqual([[1, 2]])
    expect(groupPumpsIntoRows(Array.from({ length: 10 }, (_, i) => i), 4).map((r) => r.length)).toEqual([
      4, 4, 2,
    ])
  })
})

describe('computeRowCenteredXPositions', () => {
  it('centers a short row within the 4-col footprint', () => {
    const bounds = { left: 130, top: 200, width: 940, height: 400 }
    const xs2 = computeRowCenteredXPositions(2, bounds)
    const xs4 = computeRowCenteredXPositions(4, bounds)
    expect(xs2).toHaveLength(2)
    expect(xs4).toHaveLength(4)
    const mid2 = (xs2[0] + xs2[1] + PUMP_CARD_W) / 2
    const mid4 = (xs4[0] + xs4[3] + PUMP_CARD_W) / 2
    expect(Math.abs(mid2 - mid4)).toBeLessThan(1)
  })
})

describe('AUTO pump grid layout', () => {
  const cases: Array<{ n: number; rows: number[]; label: string }> = [
    { n: 1, rows: [1], label: '1 pump centered' },
    { n: 2, rows: [2], label: '2 pumps centered' },
    { n: 4, rows: [4], label: '4 pumps one row' },
    { n: 5, rows: [4, 1], label: '5 = 4 + 1 centered' },
    { n: 6, rows: [4, 2], label: '6 = 4 + 2 centered' },
    { n: 8, rows: [4, 4], label: '8 = 4 + 4' },
    { n: 10, rows: [4, 4, 2], label: '10 = 4 + 4 + 2' },
    { n: 12, rows: [4, 4, 4], label: '12 = 3 rows' },
    { n: 20, rows: [4, 4, 4, 4, 4], label: '20 = 5 rows' },
  ]

  for (const c of cases) {
    it(c.label, () => {
      const nodes = buildForecourtNodes(autoState(c.n))
      const pumps = nodes.filter((n) => n.kind === 'PUMP')
      expect(pumps).toHaveLength(c.n)
      expect(pumpsHaveNoOverlap(nodes)).toBe(true)

      const ys = [...new Set(pumps.map((p) => Math.round(p.y)))].sort((a, b) => a - b)
      expect(ys).toHaveLength(c.rows.length)
      c.rows.forEach((count, i) => {
        const row = pumps.filter((p) => Math.round(p.y) === ys[i])
        expect(row).toHaveLength(count)
      })

      // Incomplete last row centered vs full row midpoint
      if (c.rows[c.rows.length - 1] < PUMP_MAX_COLS && c.rows.length > 1) {
        const full = pumps.filter((p) => Math.round(p.y) === ys[0])
        const last = pumps.filter((p) => Math.round(p.y) === ys[ys.length - 1])
        const midFull =
          (Math.min(...full.map((p) => p.x)) + Math.max(...full.map((p) => p.x + p.w))) / 2
        const midLast =
          (Math.min(...last.map((p) => p.x)) + Math.max(...last.map((p) => p.x + p.w))) / 2
        expect(Math.abs(midFull - midLast)).toBeLessThan(40)
      }
    })
  }
})

describe('CUSTOM missing pump staging', () => {
  it('places a new pump in a free slot without overlapping the existing pump', () => {
    const pumps = makePumps(2)
    const state = {
      ...autoState(2),
      layout: {
        mode: 'CUSTOM',
        canvasWidth: 1200,
        canvasHeight: 700,
        items: [
          {
            id: 'forecourt',
            assetType: 'FORECOURT',
            x: 40,
            y: 55,
            width: 1120,
            height: 605,
          },
          {
            id: 't1',
            assetType: 'TANK',
            assetId: 'tank-pms',
            x: 100,
            y: 70,
            width: 180,
            height: 70,
          },
          {
            id: 'p1',
            assetType: 'PUMP',
            assetId: 'pump-0',
            x: 520,
            y: 280,
            width: 100,
            height: 108,
          },
          // pump-1 intentionally omitted — must be staged
        ],
      },
      pumps,
    } as TwinLiveState

    const nodes = buildForecourtNodes(state)
    const pumpNodes = nodes.filter((n) => n.kind === 'PUMP')
    expect(pumpNodes).toHaveLength(2)
    expect(pumpsHaveNoOverlap(nodes)).toBe(true)
    const existing = pumpNodes.find((p) => p.id === 'pump-0')!
    const staged = pumpNodes.find((p) => p.id === 'pump-1')!
    expect(staged.x).not.toBe(existing.x)
    expect(Math.abs(staged.y - existing.y) > 20 || Math.abs(staged.x - existing.x) > 50).toBe(true)
  })
})

describe('pipe branches vs pump cards', () => {
  it('manifold sits between tanks and pumps; branches target pump tops', () => {
    const state = autoState(8)
    const nodes = buildForecourtNodes(state)
    const pipes = buildForecourtPipes(nodes, state.tankPumpConnections)
    expect(pipes).toHaveLength(8)
    const tanks = nodes.filter((n) => n.kind === 'TANK')
    const pumps = nodes.filter((n) => n.kind === 'PUMP')
    const tankBottom = Math.max(...tanks.map((t) => t.y + t.h))
    const pumpTop = Math.min(...pumps.map((p) => p.y))
    for (const pipe of pipes) {
      expect(pipe.midY).toBeGreaterThan(tankBottom)
      expect(pipe.midY).toBeLessThan(pumpTop)
      // Path should not contain diagonals (no freehand curves beyond Q corners)
      expect(pipe.d).not.toMatch(/C |A /)
    }
  })
})

describe('computePumpGridLayout overlap', () => {
  it('never overlaps cards for 1–20 pumps', () => {
    const bounds = { left: 130, top: 220, width: 940, height: 420 }
    for (let n = 1; n <= 20; n++) {
      const cells = computePumpGridLayout(makePumps(n), bounds)
      expect(assertNoPumpOverlaps(cells)).toBe(true)
    }
  })
})
