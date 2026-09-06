import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  applySaleToSummary,
  parsePumpSale,
  parseSaleCreatedEvent,
  parseSalesSummary,
} from '../types/sales'
import {
  canonicalPumpId,
  findPumpBySalePumpId,
  getConfiguredPumpId,
  normalizePumpId,
  pumpIdsEqual,
} from '../utils/pumpMatching'
import { pumpMatchesId } from '../lib/pumpIdentity'
import { createRecentTransactionDedup } from '../hooks/useRecentTransactionDedup'
import { parseEdgeDeviceStatus } from '../types/edgeDevice'
import { API_BASE_URL, apiUrls } from '../config/api'
import { firstLiveStationId, liveStationId } from '../config/stations'

describe('API URL construction', () => {
  it('does not double /api', () => {
    expect(API_BASE_URL.endsWith('/api')).toBe(true)
    expect(apiUrls.deviceStatus('InteliPump-Lab-pi-001')).toBe(
      `${API_BASE_URL}/v1/devices/InteliPump-Lab-pi-001/status`,
    )
    expect(apiUrls.recentSales('InteliPump-US-Lab', 50)).toContain(
      '/v1/sales/recent?stationId=InteliPump-US-Lab',
    )
    expect(apiUrls.eventsStream('InteliPump-US-Lab')).toContain(
      '/v1/events/stream?stationId=InteliPump-US-Lab',
    )
    expect(apiUrls.devices).not.toContain('/api/api/')
    expect(apiUrls.stationDevices('InteliPump-US-Lab')).toBe(
      `${API_BASE_URL}/v1/stations/InteliPump-US-Lab/devices`,
    )
  })
})

describe('live station id from catalog', () => {
  it('prefers mqtt_station_id and never invents an id', () => {
    expect(
      liveStationId({ mqtt_station_id: 'InteliPump-US-Lab', station_code: 'US-LAB-001' }),
    ).toBe('InteliPump-US-Lab')
    expect(liveStationId({ station_code: 'US-LAB-001' })).toBe('US-LAB-001')
    expect(liveStationId({})).toBe('')
    expect(
      firstLiveStationId([
        { station_code: '' },
        { mqtt_station_id: 'InteliPump-US-Lab', station_code: 'US-LAB-001' },
      ]),
    ).toBe('InteliPump-US-Lab')
  })
})

describe('device status parsing', () => {
  it('parses ONLINE DELAYED OFFLINE NEVER_CONNECTED', () => {
    const online = parseEdgeDeviceStatus({
      deviceId: 'InteliPump-Lab-pi-001',
      stationId: 'InteliPump-US-Lab',
      hostname: 'raspberrypi',
      status: 'ONLINE',
      mqttConnectionStatus: 'ONLINE',
      lastSeen: '2026-07-13T19:27:34.292255+00:00',
      secondsSinceLastHeartbeat: 25,
    })
    expect(online.status).toBe('ONLINE')
    expect(parseEdgeDeviceStatus({ ...online, status: 'DELAYED' }).status).toBe('DELAYED')
    expect(parseEdgeDeviceStatus({ ...online, status: 'OFFLINE' }).status).toBe('OFFLINE')
    expect(parseEdgeDeviceStatus({ ...online, status: 'NEVER_CONNECTED' }).status).toBe(
      'NEVER_CONNECTED',
    )
  })
})

describe('sale parsing and summary', () => {
  const saleRaw = {
    transactionId: 'tx-1',
    stationId: 'InteliPump-US-Lab',
    pumpId: 'PUMP-05-06',
    nozzleId: 'NOZZLE-06',
    product: 'PMS',
    volumeLiters: 10,
    amount: 11950,
    currency: 'NGN',
    pricePerLiter: 1195,
    status: 'COMPLETED',
    sourceTopic: 'intelipump/...',
    receivedAt: '2026-07-14T13:00:00+00:00',
  }

  it('parses PumpSale and sale.created', () => {
    const sale = parsePumpSale(saleRaw)
    expect(sale?.pumpId).toBe('PUMP-05-06')
    const ev = parseSaleCreatedEvent({
      type: 'sale.created',
      occurredAt: saleRaw.receivedAt,
      transaction: saleRaw,
    })
    expect(ev?.transaction.transactionId).toBe('tx-1')
  })

  it('increments summary once per unique sale', () => {
    const base = parseSalesSummary({
      stationId: 'InteliPump-US-Lab',
      period: 'TODAY',
      transactionCount: 25,
      totalAmount: 450000,
      totalVolumeLiters: 376.57,
      averageTransactionAmount: 18000,
      latestTransactionAt: null,
    })
    const sale = parsePumpSale(saleRaw)!
    const next = applySaleToSummary(base, sale)
    expect(next.transactionCount).toBe(26)
    expect(next.totalAmount).toBe(450000 + 11950)
    expect(next.totalVolumeLiters).toBeCloseTo(376.57 + 10)
  })
})

describe('pump matching', () => {
  it('matches PUMP-05-06 to PUMP-05/06 telemetry id', () => {
    expect(normalizePumpId(' pump-05-06 ')).toBe('PUMP-05-06')
    expect(canonicalPumpId('PUMP-05/06')).toBe('PUMP-05-06')
    expect(pumpIdsEqual('PUMP-05/06', 'PUMP-05-06')).toBe(true)

    const pumps = [
      { id: 'uuid-1', name: 'Pump 5–6', mqttPumpId: 'PUMP-05/06' },
      { id: 'uuid-2', name: 'Pump 2', mqttPumpId: 'PUMP-02' },
    ]
    const match = findPumpBySalePumpId(pumps, 'PUMP-05-06')
    expect(match?.id).toBe('uuid-1')
    expect(getConfiguredPumpId(pumps[0])).toBe('PUMP-05/06')
    expect(pumpMatchesId(pumps[0], 'PUMP-05-06')).toBe(true)
    expect(pumpMatchesId(pumps[1], 'PUMP-05-06')).toBe(false)
  })

  it('does not fall back to another pump when unmapped', () => {
    const pumps = [{ id: 'uuid-2', mqttPumpId: 'PUMP-02' }]
    expect(findPumpBySalePumpId(pumps, 'PUMP-05-06')).toBeUndefined()
  })
})

describe('transaction dedup', () => {
  it('remembers transaction ids', () => {
    const d = createRecentTransactionDedup({ max: 10 })
    expect(d.has('tx-1')).toBe(false)
    d.remember('tx-1')
    expect(d.has('tx-1')).toBe(true)
  })
})

describe('EventSource mock listeners', () => {
  class MockEventSource {
    static instances: MockEventSource[] = []
    listeners = new Map<string, Set<(ev: MessageEvent) => void>>()
    onerror: ((ev: Event) => void) | null = null
    url: string
    constructor(url: string) {
      this.url = url
      MockEventSource.instances.push(this)
    }
    addEventListener(type: string, fn: (ev: MessageEvent) => void) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set())
      this.listeners.get(type)!.add(fn)
    }
    close() {
      /* no-op */
    }
    emit(type: string, data: unknown) {
      const ev = { data: JSON.stringify(data) } as MessageEvent
      this.listeners.get(type)?.forEach((fn) => fn(ev))
    }
  }

  beforeEach(() => {
    MockEventSource.instances = []
    vi.stubGlobal('EventSource', MockEventSource as any)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sale.created updates only matching pump totals conceptually', () => {
    const sales: string[] = []
    const es = new MockEventSource(apiUrls.eventsStream('InteliPump-US-Lab'))
    es.addEventListener('sale.created', (ev) => {
      const parsed = parseSaleCreatedEvent(JSON.parse(String(ev.data)))
      if (parsed) sales.push(parsed.transaction.pumpId)
    })
    es.addEventListener('heartbeat', () => {
      /* must not push sales */
    })
    es.emit('heartbeat', { type: 'heartbeat', timestamp: '2026-07-14T13:00:15+00:00' })
    es.emit('sale.created', {
      type: 'sale.created',
      occurredAt: '2026-07-14T13:00:00+00:00',
      transaction: {
        transactionId: 'tx-9',
        stationId: 'InteliPump-US-Lab',
        pumpId: 'PUMP-05-06',
        nozzleId: null,
        product: 'PMS',
        volumeLiters: 1,
        amount: 1000,
        currency: 'NGN',
        pricePerLiter: 1000,
        status: 'COMPLETED',
        sourceTopic: null,
        receivedAt: '2026-07-14T13:00:00+00:00',
      },
    })
    expect(sales).toEqual(['PUMP-05-06'])
    expect(MockEventSource.instances).toHaveLength(1)
  })
})
