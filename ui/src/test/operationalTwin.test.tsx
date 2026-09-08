import { describe, expect, it } from 'vitest'
import { pumpGridClass, pumpMatchesId, pumpStatusColor } from '../lib/pumpIdentity'
import { getTwinViewPreference, setTwinViewPreference } from '../lib/twinViewPreference'
import { buildSceneAssets } from '../components/twin/StationSceneCanvas'
import { applyLiveStationStatus } from '../lib/twinLiveStatus'
import { liveDispensingFromPumpState, livePumpInferredStatus } from '../lib/liveDispensing'
import { applyLiveTankDrawdown } from '../lib/liveTankLevels'
import {
  collapseHangupDuplicates,
  isHangupDuplicateSale,
  isStaleDispensingAfterComplete,
} from '../lib/saleDuplicates'
import { canAccessPath, normalizeRole } from '../lib/roles'
import type { PumpSale } from '../types/sales'

describe('applyLiveStationStatus', () => {
  it('clears pump OFFLINE when the live Pi is ONLINE', () => {
    const next = applyLiveStationStatus(
      {
        station: { operationalStatus: 'OPEN', connectivityStatus: 'OFFLINE' },
        pumps: [{ id: 'p1', inferredStatus: 'OFFLINE' }],
      },
      'OPEN',
      'ONLINE',
      'ONLINE',
    )
    expect(next?.station?.connectivityStatus).toBe('ONLINE')
    expect(next?.pumps?.[0]?.inferredStatus).toBe('IDLE')
  })

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

describe('live dispensing pipes', () => {
  it('animates pipes only while a fill is in progress', () => {
    const live = liveDispensingFromPumpState({
      'pump-2': {
        pumpId: 'pump-2',
        latestSale: {
          transactionId: 'tx-a',
          stationId: 'lab',
          pumpId: 'pump-2',
          nozzleId: null,
          product: 'PMS',
          volumeLiters: 0.17,
          amount: 2000,
          currency: 'NGN',
          pricePerLiter: 11764,
          status: 'DISPENSING',
          sourceTopic: null,
          receivedAt: '2026-09-07T16:44:00Z',
        },
        lastSaleAt: '2026-09-07T16:44:00Z',
        todaySalesAmount: 2000,
        todayVolumeLiters: 0.17,
        todayTransactionCount: 1,
        liveActivityStatus: 'ACTIVE',
        isRecentlyActive: true,
      },
    })
    expect(live['pump-2']?.phase).toBe('DISPENSING')
    expect(live['pump-2']?.currentAmount).toBe(2000)
  })

  it('does not animate pipes after hang-up', () => {
    const live = liveDispensingFromPumpState({
      'pump-2': {
        pumpId: 'pump-2',
        latestSale: {
          transactionId: 'tx-a',
          stationId: 'lab',
          pumpId: 'pump-2',
          nozzleId: null,
          product: 'PMS',
          volumeLiters: 0.17,
          amount: 2000,
          currency: 'NGN',
          pricePerLiter: 11764,
          status: 'COMPLETED',
          sourceTopic: null,
          receivedAt: '2026-09-07T16:44:09Z',
        },
        lastSaleAt: '2026-09-07T16:44:09Z',
        todaySalesAmount: 2000,
        todayVolumeLiters: 0.17,
        todayTransactionCount: 1,
        liveActivityStatus: 'IDLE',
        isRecentlyActive: true,
      },
    })
    expect(live['pump-2']).toBeUndefined()
  })
})

describe('hang-up duplicate collapse', () => {
  it('treats a second same-pump sale as the holster twin', () => {
    const live: PumpSale = {
      transactionId: 'tx-live',
      stationId: 'lab',
      pumpId: 'pump-2',
      nozzleId: null,
      product: 'PMS',
      volumeLiters: 1.7,
      amount: 2000,
      currency: 'NGN',
      pricePerLiter: 1176.47,
      status: 'DISPENSING',
      sourceTopic: null,
      receivedAt: '2026-09-07T16:44:00Z',
    }
    const hangup: PumpSale = {
      ...live,
      transactionId: 'tx-hangup',
      status: 'COMPLETED',
      receivedAt: '2026-09-07T16:44:06Z',
    }
    expect(isHangupDuplicateSale(live, hangup)).toBe(true)
    expect(collapseHangupDuplicates([hangup, live])).toEqual([hangup])
    expect(
      isStaleDispensingAfterComplete(
        { ...hangup, status: 'COMPLETED' },
        { ...hangup, transactionId: 'tx-late', status: 'DISPENSING' },
      ),
    ).toBe(true)
    const later = {
      ...hangup,
      transactionId: 'tx-minute-later',
      receivedAt: '2026-09-07T16:45:01Z',
    }
    expect(isHangupDuplicateSale({ ...hangup, status: 'COMPLETED' }, later)).toBe(true)
  })

  it('does not overlay DISPENSING on a completed hang-up', () => {
    expect(
      livePumpInferredStatus(
        'OPEN',
        {
          pumpId: 'pump-2',
          latestSale: {
            transactionId: 'tx-hangup',
            stationId: 'lab',
            pumpId: 'pump-2',
            nozzleId: null,
            product: 'PMS',
            volumeLiters: 1.7,
            amount: 2000,
            currency: 'NGN',
            pricePerLiter: 1176.47,
            status: 'COMPLETED',
            sourceTopic: null,
            receivedAt: '2026-09-07T16:44:06Z',
          },
          lastSaleAt: '2026-09-07T16:44:06Z',
          todaySalesAmount: 2000,
          todayVolumeLiters: 1.7,
          todayTransactionCount: 1,
          liveActivityStatus: 'IDLE',
          isRecentlyActive: false,
        },
        'IDLE',
      ),
    ).toBe('IDLE')
  })

  it('clears DISPENSING after live ticks go idle', () => {
    expect(
      livePumpInferredStatus(
        'OPEN',
        {
          pumpId: 'pump-1',
          latestSale: {
            transactionId: 'tx-live',
            stationId: 'lab',
            pumpId: 'pump-1',
            nozzleId: null,
            product: 'PMS',
            volumeLiters: 1.7,
            amount: 2000,
            currency: 'NGN',
            pricePerLiter: 1176.47,
            status: 'DISPENSING',
            sourceTopic: null,
            receivedAt: '2026-09-07T16:44:00Z',
          },
          lastSaleAt: '2026-09-07T16:44:00Z',
          todaySalesAmount: 2000,
          todayVolumeLiters: 1.7,
          todayTransactionCount: 1,
          liveActivityStatus: 'IDLE',
          isRecentlyActive: false,
        },
        'DISPENSING',
      ),
    ).toBe('IDLE')
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

describe('live tank drawdown', () => {
  it('reduces a 25 L lab tank by connected pump sales', () => {
    const tanks = applyLiveTankDrawdown(
      [
        {
          id: 'lab-tank',
          tankCode: 'PMS-LAB',
          reportedLiters: 25,
          capacityLiters: 25,
          fillPercent: 100,
          measuredAt: '2026-09-07T10:00:00Z',
        },
      ],
      [
        {
          transactionId: 'tx-1',
          stationId: 'lab',
          pumpId: 'pump-2',
          nozzleId: null,
          product: 'PMS',
          volumeLiters: 1,
          amount: 1175,
          currency: 'NGN',
          pricePerLiter: 1175,
          status: 'COMPLETED',
          sourceTopic: null,
          receivedAt: '2026-09-07T11:00:00Z',
        },
      ],
      [{ tankId: 'lab-tank', mqttPumpId: 'pump-2', pumpId: 'p2', isPrimary: true }],
      [{ id: 'p2', mqttPumpId: 'pump-2', pumpCode: 'P2' }],
    )
    expect(tanks[0].reportedLiters).toBe(24)
    expect(tanks[0].drawnLiters).toBe(1)
    expect(tanks[0].fillPercent).toBe(96)
  })

  it('ignores sales from before the tank reading', () => {
    const tanks = applyLiveTankDrawdown(
      [
        {
          id: 'lab-tank',
          reportedLiters: 25,
          capacityLiters: 25,
          measuredAt: '2026-09-07T12:00:00Z',
        },
      ],
      [
        {
          transactionId: 'tx-old',
          stationId: 'lab',
          pumpId: 'pump-2',
          nozzleId: null,
          product: 'PMS',
          volumeLiters: 8,
          amount: 9400,
          currency: 'NGN',
          pricePerLiter: 1175,
          status: 'COMPLETED',
          sourceTopic: null,
          receivedAt: '2026-09-07T11:00:00Z',
        },
      ],
      [{ tankId: 'lab-tank', mqttPumpId: 'pump-2', isPrimary: true }],
      [{ id: 'p2', mqttPumpId: 'pump-2' }],
    )
    expect(tanks[0].reportedLiters).toBe(25)
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
    expect(canAccessPath(normalizeRole('STATION_MANAGER'), '/station-manager/reconciliation')).toBe(false)
    expect(canAccessPath(normalizeRole('STATION_MANAGER'), '/reconciliations')).toBe(false)
    expect(canAccessPath(normalizeRole('ADMIN'), '/reconciliations')).toBe(true)
  })
})
