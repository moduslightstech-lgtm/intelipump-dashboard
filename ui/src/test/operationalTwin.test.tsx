import { describe, expect, it } from 'vitest'
import { pumpGridClass, pumpMatchesId, pumpStatusColor } from '../lib/pumpIdentity'
import { getTwinViewPreference, setTwinViewPreference } from '../lib/twinViewPreference'
import { buildSceneAssets } from '../components/twin/StationSceneCanvas'
import { applyLiveStationStatus } from '../lib/twinLiveStatus'
import { canAccessPath, normalizeRole } from '../lib/roles'

describe('applyLiveStationStatus', () => {
  it('overlays edge connectivity and schedule on twin state', () => {
    const next = applyLiveStationStatus(
      {
        station: {
          name: 'Boluwaji',
          operationalStatus: 'CLOSED',
          connectivityStatus: 'OFFLINE',
        },
        pumps: [{ id: 'p1', inferredStatus: 'POWERED_OFF' }],
      },
      'OPEN',
      'ONLINE',
      'ONLINE',
    )
    expect(next?.station?.operationalStatus).toBe('OPEN')
    expect(next?.station?.connectivityStatus).toBe('ONLINE')
    expect(next?.station?.edgeDeviceStatus).toBe('ONLINE')
    expect(next?.pumps?.[0]?.inferredStatus).toBe('IDLE')
  })

  it('forces pumps powered off when schedule says CLOSED', () => {
    const next = applyLiveStationStatus(
      {
        station: { operationalStatus: 'OPEN' },
        pumps: [{ id: 'p1', inferredStatus: 'IDLE' }],
      },
      'CLOSED',
      'ONLINE',
      'ONLINE',
    )
    expect(next?.pumps?.[0]?.inferredStatus).toBe('POWERED_OFF')
  })
})

describe('pump identity (slash-safe)', () => {
  it('matches mqtt pump id containing a slash', () => {
    const pump = { id: 'uuid-1', pumpCode: 'P1', mqttPumpId: 'PUMP-05/06' }
    expect(pumpMatchesId(pump, 'PUMP-05/06')).toBe(true)
    expect(pumpMatchesId(pump, 'PUMP-05')).toBe(false)
    expect(pumpMatchesId(pump, 'uuid-1')).toBe(true)
  })

  it('matches ledger-only synthetic ids', () => {
    expect(pumpMatchesId({ id: 'ledger:PUMP-05/06', pumpCode: 'PUMP-05/06' }, 'PUMP-05/06')).toBe(
      true,
    )
  })
})

describe('automatic pump grid classes', () => {
  it('scales for 1, 4, 10, 20 pumps', () => {
    expect(pumpGridClass(1)).toContain('grid-cols-1')
    expect(pumpGridClass(4)).toContain('lg:grid-cols-4')
    expect(pumpGridClass(10)).toContain('lg:grid-cols-5')
    expect(pumpGridClass(20)).toContain('xl:grid-cols-5')
  })
})

describe('pump status colors (closure vs outage)', () => {
  it('uses gray for powered off / closed, green for dispensing, blue for idle', () => {
    expect(pumpStatusColor('POWERED_OFF')).toBe('#64748b')
    expect(pumpStatusColor('CLOSED')).toBe('#64748b')
    expect(pumpStatusColor('FAULT')).toBe('#ef4444')
    expect(pumpStatusColor('OFFLINE')).toBe('#ef4444')
    expect(pumpStatusColor('IDLE')).toBe('#3b82f6')
    expect(pumpStatusColor('DISPENSING')).toBe('#22c55e')
  })
})

describe('twin view preference', () => {
  it('defaults to operational and persists 3d', () => {
    localStorage.removeItem('intelipump.twinView')
    expect(getTwinViewPreference()).toBe('operational')
    setTwinViewPreference('3d')
    expect(getTwinViewPreference()).toBe('3d')
    setTwinViewPreference('operational')
    expect(getTwinViewPreference()).toBe('operational')
  })
})

describe('scene assets from live-state (no WebGL)', () => {
  it('builds tank/pump assets including manual source and slash mqtt id', () => {
    const assets = buildSceneAssets({
      layout: {
        mode: 'AUTO',
        canvasWidth: 1200,
        canvasHeight: 700,
        items: [
          {
            id: 't1',
            assetType: 'TANK',
            assetId: 'tank-1',
            label: 'PMS',
            x: 10,
            y: 10,
            width: 100,
            height: 60,
            rotation: 0,
          },
          {
            id: 'p1',
            assetType: 'PUMP',
            assetId: 'pump-1',
            label: 'PUMP-05/06',
            x: 200,
            y: 200,
            width: 72,
            height: 78,
            rotation: 0,
          },
        ],
      },
      tanks: [
        {
          id: 'tank-1',
          tankCode: 'TANK-PMS-01',
          name: 'PMS',
          product: 'PMS',
          capacityLiters: 45000,
          reportedLiters: 22000,
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
          inferredStatus: 'IDLE',
          product: 'PMS',
        },
      ],
    })
    const tank = assets.find((a) => a.kind === 'TANK')
    const pump = assets.find((a) => a.kind === 'PUMP')
    expect(tank?.source || (tank?.raw as any)?.measurementSource).toBeTruthy()
    expect((tank?.raw as any)?.measurementSource).toBe('MANUAL')
    expect((pump?.raw as any)?.mqttPumpId).toBe('PUMP-05/06')
    expect(pumpMatchesId(pump!.raw as any, 'PUMP-05/06')).toBe(true)
  })

  it('handles station closure styling statuses', () => {
    const assets = buildSceneAssets({
      layout: {
        mode: 'AUTO',
        items: [
          {
            id: 'p1',
            assetType: 'PUMP',
            assetId: 'pump-1',
            label: 'P1',
            x: 0,
            y: 0,
            width: 72,
            height: 78,
            rotation: 0,
          },
        ],
      },
      pumps: [{ id: 'pump-1', pumpCode: 'P1', inferredStatus: 'POWERED_OFF' }],
      station: { operationalStatus: 'CLOSED', connectivityStatus: 'ONLINE' },
    })
    expect(assets[0].status).toBe('POWERED_OFF')
    expect(pumpStatusColor(assets[0].status)).toBe('#64748b')
  })
})

describe('role-based twin access', () => {
  it('allows admin and executive, blocks station manager', () => {
    expect(canAccessPath(normalizeRole('ADMIN'), '/digital-twin')).toBe(true)
    expect(canAccessPath(normalizeRole('EXECUTIVE'), '/digital-twin/abc')).toBe(true)
    expect(canAccessPath(normalizeRole('STATION_MANAGER'), '/digital-twin')).toBe(false)
  })

  it('hides admin station routes from executive and station manager', () => {
    expect(canAccessPath(normalizeRole('ADMIN'), '/admin/stations')).toBe(true)
    expect(canAccessPath(normalizeRole('ADMIN'), '/admin/stations/abc/pumps')).toBe(true)
    expect(canAccessPath(normalizeRole('EXECUTIVE'), '/admin/stations')).toBe(false)
    expect(canAccessPath(normalizeRole('STATION_MANAGER'), '/admin/stations/abc/edit')).toBe(false)
  })
})
