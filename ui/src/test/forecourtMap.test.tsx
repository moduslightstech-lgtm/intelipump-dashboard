import { describe, expect, it } from 'vitest'
import {
  buildForecourtNodes,
  buildForecourtPipes,
  buildManifoldPath,
  pipePath,
  productStroke,
} from '../components/twin/forecourtLayout'
import { playbackProgress } from '../hooks/useTwinTransactionAnimation'
import { pumpMatchesId, pumpStatusColor } from '../lib/pumpIdentity'
import type { TwinLiveState } from '../api/client'

function sampleState(overrides: Partial<TwinLiveState> = {}): TwinLiveState {
  return {
    station: { operationalStatus: 'OPEN', connectivityStatus: 'ONLINE' },
    layout: {
      mode: 'AUTO',
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
          id: 'office',
          assetType: 'OFFICE',
          label: 'Control room',
          x: 1020,
          y: 70,
          width: 140,
          height: 70,
        },
        {
          id: 'ent',
          assetType: 'ENTRANCE',
          label: 'ENTRANCE',
          x: 48,
          y: 330,
          width: 70,
          height: 28,
        },
        {
          id: 'ex',
          assetType: 'EXIT',
          label: 'EXIT',
          x: 1082,
          y: 330,
          width: 70,
          height: 28,
        },
        {
          id: 't1',
          assetType: 'TANK',
          assetId: 'tank-pms',
          label: 'PMS',
          x: 100,
          y: 70,
          width: 180,
          height: 64,
        },
        {
          id: 't2',
          assetType: 'TANK',
          assetId: 'tank-ago',
          label: 'AGO',
          x: 300,
          y: 70,
          width: 180,
          height: 64,
        },
        {
          id: 'p1',
          assetType: 'PUMP',
          assetId: 'pump-1',
          label: 'PUMP-05/06',
          x: 200,
          y: 280,
          width: 88,
          height: 96,
        },
      ],
    },
    tanks: [
      {
        id: 'tank-pms',
        tankCode: 'TANK-PMS-01',
        name: 'PMS',
        product: 'PMS',
        capacityLiters: 45000,
        reportedLiters: 22000,
        fillPercent: 48.9,
        measurementSource: 'MANUAL',
        isLiveTelemetry: false,
        inferredStatus: 'NORMAL',
        submittedBy: 'manager@test',
        measuredAt: '2026-07-12T22:00:00Z',
      },
      {
        id: 'tank-ago',
        tankCode: 'TANK-AGO-01',
        name: 'AGO',
        product: 'AGO',
        capacityLiters: 45000,
        reportedLiters: 18000,
        fillPercent: 40,
        measurementSource: 'MANUAL',
        isLiveTelemetry: false,
        inferredStatus: 'NORMAL',
      },
    ],
    pumps: [
      {
        id: 'pump-1',
        pumpCode: 'P1',
        mqttPumpId: 'PUMP-05/06',
        product: 'PMS',
        inferredStatus: 'IDLE',
        lastTransactionAmount: 3000,
        lastTransactionVolume: 2.62,
      },
    ],
    tankPumpConnections: [
      {
        id: 'c1',
        tankId: 'tank-pms',
        pumpId: 'pump-1',
        mqttPumpId: 'PUMP-05/06',
        product: 'PMS',
        source: 'CONFIGURED',
        lineLabel: 'TANK-PMS-01 → PUMP-05/06',
      },
    ],
    connectionMappingConfigured: true,
    ...overrides,
  }
}

describe('forecourt pipe geometry', () => {
  it('builds an SVG path from tank to pump', () => {
    const { d, midY } = pipePath({ x: 0, y: 0, w: 100, h: 50 }, { x: 200, y: 200, w: 80, h: 90 })
    expect(d).toContain('M ')
    expect(d).toContain('L ')
    expect(midY).toBeGreaterThan(50)
  })
})

describe('auto layout node counts', () => {
  it('renders 1 pump', () => {
    const nodes = buildForecourtNodes(sampleState())
    expect(nodes.filter((n) => n.kind === 'PUMP')).toHaveLength(1)
    expect(nodes.filter((n) => n.kind === 'TANK')).toHaveLength(2)
    expect(nodes.some((n) => n.kind === 'OFFICE')).toBe(true)
    expect(nodes.some((n) => n.kind === 'ENTRANCE')).toBe(true)
    expect(nodes.some((n) => n.kind === 'EXIT')).toBe(true)
  })

  it('scales pump nodes for 4, 8 and 12 pumps including auto-placed missing', () => {
    const make = (n: number) => {
      const pumps = Array.from({ length: n }, (_, i) => ({
        id: `pump-${i}`,
        pumpCode: `P${i}`,
        mqttPumpId: i === 0 ? 'PUMP-05/06' : `PUMP-${i}`,
        inferredStatus: 'IDLE',
        product: 'PMS',
      }))
      // Layout only includes first pump — rest must be auto-placed
      return buildForecourtNodes(
        sampleState({
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
        }),
      )
    }
    expect(make(4).filter((n) => n.kind === 'PUMP')).toHaveLength(4)
    expect(make(8).filter((n) => n.kind === 'PUMP')).toHaveLength(8)
    expect(make(12).filter((n) => n.kind === 'PUMP')).toHaveLength(12)
  })
})

describe('manifold pipe routing', () => {
  it('builds manifold rail and branch pipes', () => {
    const state = sampleState()
    const nodes = buildForecourtNodes(state)
    const manifold = buildManifoldPath(nodes)
    expect(manifold).toBeTruthy()
    expect(manifold!).toContain('M ')
    const pipes = buildForecourtPipes(nodes, state.tankPumpConnections)
    expect(pipes).toHaveLength(1)
    expect(pipes[0].d.split('L').length).toBeGreaterThanOrEqual(3)
  })
})

describe('completed-event playback progress', () => {
  it('ease-out count-up reaches final at duration', () => {
    expect(playbackProgress(0)).toBe(0)
    expect(playbackProgress(3500)).toBe(1)
    expect(playbackProgress(1750)).toBeGreaterThan(0.5)
  })
})

describe('tank-to-pump pipes', () => {
  it('draws pipes for configured connections including slash mqtt id', () => {
    const state = sampleState()
    const nodes = buildForecourtNodes(state)
    const pipes = buildForecourtPipes(nodes, state.tankPumpConnections)
    expect(pipes).toHaveLength(1)
    expect(pipes[0].d.length).toBeGreaterThan(10)
    expect(pipes[0].product).toBe('PMS')
    expect(pumpMatchesId({ id: 'pump-1', mqttPumpId: 'PUMP-05/06' }, 'PUMP-05/06')).toBe(true)
  })

  it('shows empty pipes with message path when no connections', () => {
    const state = sampleState({ tankPumpConnections: [], connectionMappingConfigured: false })
    const nodes = buildForecourtNodes(state)
    const pipes = buildForecourtPipes(nodes, state.tankPumpConnections)
    expect(pipes).toHaveLength(0)
    expect(nodes.filter((n) => n.kind === 'TANK').length).toBeGreaterThan(0)
  })
})

describe('manual tank display + closure colors', () => {
  it('exposes manual source on tank nodes', () => {
    const tank = buildForecourtNodes(sampleState()).find((n) => n.kind === 'TANK')
    expect(tank?.raw.measurementSource).toBe('MANUAL')
    expect(tank?.raw.isLiveTelemetry).toBe(false)
  })

  it('uses gray for powered-off, not red', () => {
    expect(pumpStatusColor('POWERED_OFF')).toBe('#64748b')
    expect(pumpStatusColor('FAULT')).toBe('#ef4444')
    expect(productStroke('PMS')).toBe('#2563eb')
    expect(productStroke('AGO')).toBe('#ca8a04')
  })
})
