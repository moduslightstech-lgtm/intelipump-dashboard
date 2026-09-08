import { describe, expect, it } from 'vitest'
import {
  buildManifoldRoutes,
  buildOrthogonalPipePath,
  getPumpInletAnchor,
  getTankOutletAnchor,
  pipePath,
} from '../components/twin/pipe/pipeRouting'
import { createRecentTransactionDedup } from '../hooks/useRecentTransactionDedup'
import { playbackProgress } from '../hooks/useDispensingPlayback'
import type { ForecourtNode } from '../components/twin/forecourtLayout'

function box(id: string, x: number, y: number, w = 100, h = 60): ForecourtNode {
  return {
    id,
    kind: 'TANK',
    x,
    y,
    w,
    h,
    label: id,
    status: 'NORMAL',
    product: 'PMS',
    raw: { id, tankCode: id },
  }
}

function pump(id: string, x: number, y: number, mqtt?: string): ForecourtNode {
  return {
    id,
    kind: 'PUMP',
    x,
    y,
    w: 88,
    h: 96,
    label: mqtt || id,
    status: 'IDLE',
    product: 'PMS',
    raw: { id, pumpCode: id, mqttPumpId: mqtt || id },
  }
}

describe('anchors', () => {
  it('uses tank vessel outlet and pump top-center', () => {
    const t = box('t1', 100, 50, 120, 70)
    const p = pump('p1', 200, 280)
    expect(getTankOutletAnchor(t)).toEqual({ x: 160, y: 50 + Math.min(110, Math.max(8, 70 - 38)) })
    expect(getPumpInletAnchor(p)).toEqual({ x: 244, y: 280 })
  })
})

describe('orthogonal trunk-and-branch path', () => {
  it('builds manifold path with Q corners', () => {
    const { path, mid } = buildOrthogonalPipePath({ x: 100, y: 120 }, { x: 300, y: 280 }, 180)
    expect(path).toContain('M 100 120')
    expect(path).toContain('Q ')
    expect(mid.y).toBe(180)
  })

  it('pipePath helper returns d string', () => {
    const { d } = pipePath({ x: 0, y: 0, w: 100, h: 50 }, { x: 200, y: 200, w: 80, h: 90 }, 100)
    expect(d.length).toBeGreaterThan(10)
  })
})

describe('buildManifoldRoutes', () => {
  it('routes 8 pumps to tank with separate branches', () => {
    const tank = box('tank-pms', 100, 70, 180, 64)
    tank.product = 'PMS'
    const nodes: ForecourtNode[] = [
      tank,
      ...Array.from({ length: 8 }, (_, i) =>
        pump(`pump-${i}`, 80 + (i % 4) * 120, 280 + Math.floor(i / 4) * 120, i === 0 ? 'PUMP-05/06' : `PUMP-${i}`),
      ),
    ]
    const connections = nodes
      .filter((n) => n.kind === 'PUMP')
      .map((p, i) => ({
        id: `c${i}`,
        tankId: 'tank-pms',
        pumpId: p.id,
        mqttPumpId: p.raw.mqttPumpId,
        product: 'PMS',
        isPrimary: true,
        source: 'CONFIGURED',
      }))
    const { routes, trunks } = buildManifoldRoutes(nodes, connections)
    expect(routes).toHaveLength(8)
    expect(trunks.length).toBeGreaterThanOrEqual(1)
    expect(routes.some((r) => (r.connection as any).mqttPumpId === 'PUMP-05/06')).toBe(true)
    // distinct branch X where possible
    const xs = new Set(routes.map((r) => Math.round(r.target.x)))
    expect(xs.size).toBeGreaterThan(1)
  })

  it('offsets manifold Y for multiple tanks', () => {
    const nodes: ForecourtNode[] = [
      { ...box('t-pms', 100, 70), product: 'PMS', raw: { id: 't-pms', tankCode: 'T-PMS' } },
      { ...box('t-ago', 320, 70), product: 'AGO', raw: { id: 't-ago', tankCode: 'T-AGO' } },
      pump('p1', 120, 300, 'PUMP-PMS'),
      pump('p2', 340, 300, 'PUMP-AGO'),
    ]
    nodes[2].product = 'PMS'
    nodes[3].product = 'AGO'
    const connections = [
      { id: 'c1', tankId: 't-pms', pumpId: 'p1', mqttPumpId: 'PUMP-PMS', product: 'PMS', isPrimary: true },
      { id: 'c2', tankId: 't-ago', pumpId: 'p2', mqttPumpId: 'PUMP-AGO', product: 'AGO', isPrimary: true },
    ]
    const { trunks, routes } = buildManifoldRoutes(nodes, connections)
    expect(routes).toHaveLength(2)
    expect(trunks).toHaveLength(2)
    expect(trunks[0].y).not.toBe(trunks[1].y)
  })
})

describe('transaction dedup', () => {
  it('ignores duplicate transaction ids', () => {
    const d = createRecentTransactionDedup({ ttlMs: 60_000 })
    expect(d.has('896ff23f-4b41-429a-9dbe-760c33b9b95a')).toBe(false)
    d.remember('896ff23f-4b41-429a-9dbe-760c33b9b95a')
    expect(d.has('896ff23f-4b41-429a-9dbe-760c33b9b95a')).toBe(true)
  })
})

describe('playback count-up', () => {
  it('ease-out reaches final at duration', () => {
    expect(playbackProgress(0, 3000)).toBe(0)
    expect(playbackProgress(3000, 3000)).toBe(1)
    const mid = playbackProgress(1500, 3000)
    expect(mid).toBeGreaterThan(0.5)
    expect(mid).toBeLessThan(1)
  })
})
