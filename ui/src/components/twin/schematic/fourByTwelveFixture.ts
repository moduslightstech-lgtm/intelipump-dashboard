import type { TwinLiveState } from '../../../api/client'

const PRODUCTS = [
  { id: 'tank-pms-1', code: 'TANK-PMS-01', name: 'PMS Tank 1', product: 'PMS', fill: 62, liters: 27900 },
  { id: 'tank-pms-2', code: 'TANK-PMS-02', name: 'PMS Tank 2', product: 'PMS', fill: 41, liters: 18450 },
  { id: 'tank-ago', code: 'TANK-AGO-01', name: 'AGO Tank', product: 'AGO', fill: 55, liters: 24750 },
  { id: 'tank-dpk', code: 'TANK-DPK-01', name: 'DPK Tank', product: 'DPK', fill: 28, liters: 12600 },
] as const

const PUMP_PRODUCTS = ['PMS', 'PMS', 'PMS', 'PMS', 'PMS', 'PMS', 'AGO', 'AGO', 'AGO', 'DPK', 'DPK', 'PMS']
const TANK_FOR_PUMP = [
  'tank-pms-1',
  'tank-pms-1',
  'tank-pms-2',
  'tank-pms-2',
  'tank-pms-1',
  'tank-pms-2',
  'tank-ago',
  'tank-ago',
  'tank-ago',
  'tank-dpk',
  'tank-dpk',
  'tank-pms-1',
]

export const FIXTURE_STATION_ID = 'FIXTURE-4x12'

export function fourTankTwelvePumpState(): TwinLiveState {
  const tanks = PRODUCTS.map((t) => ({
    id: t.id,
    tankCode: t.code,
    name: t.name,
    product: t.product,
    capacityLiters: 45000,
    reportedLiters: t.liters,
    fillPercent: t.fill,
    measurementSource: 'MANUAL',
    isLiveTelemetry: false,
    inferredStatus: t.fill < 30 ? 'LOW' : 'NORMAL',
    status: t.fill < 30 ? 'LOW' : 'NORMAL',
    measuredAt: '2026-09-07T18:00:00Z',
  }))

  const pumps = Array.from({ length: 12 }, (_, i) => ({
    id: `pump-${i + 1}`,
    pumpCode: `P${String(i + 1).padStart(2, '0')}`,
    mqttPumpId: i === 0 ? 'PUMP-05/06' : `PUMP-${String(i + 1).padStart(2, '0')}`,
    name: `Pump ${i + 1}`,
    pumpNumber: i + 1,
    displayOrder: i + 1,
    product: PUMP_PRODUCTS[i],
    inferredStatus: i === 2 ? 'DISPENSING' : 'IDLE',
    status: 'UNKNOWN',
    nozzleCount: 2,
    lastTransactionAmount: i === 2 ? 4500 : i % 3 === 0 ? 2100 : null,
    lastTransactionVolume: i === 2 ? 3.2 : i % 3 === 0 ? 1.8 : null,
    lastTransactionAt: i % 3 === 0 ? '2026-09-07T20:10:00Z' : null,
    activeAlertCount: i === 7 ? 1 : 0,
    nozzles: [
      {
        id: `pump-${i + 1}-n1`,
        name: 'Nozzle 1',
        nozzleCode: `nozzle-${i + 1}-1`,
        nozzleNumber: 1,
        product: PUMP_PRODUCTS[i],
        inferredStatus: i === 2 ? 'DISPENSING' : 'IDLE',
        lastTransactionAmount: i === 2 ? 4500 : null,
        lastTransactionVolume: i === 2 ? 3.2 : null,
        lastTransactionAt: i === 2 ? '2026-09-07T20:10:00Z' : null,
      },
      {
        id: `pump-${i + 1}-n2`,
        name: 'Nozzle 2',
        nozzleCode: `nozzle-${i + 1}-2`,
        nozzleNumber: 2,
        product: PUMP_PRODUCTS[i],
        inferredStatus: 'IDLE',
      },
    ],
  }))

  const tankPumpConnections = pumps.flatMap((p, i) => {
    const make = (nozzleId: string, extra?: Record<string, unknown>) => ({
      id: `c-${nozzleId}`,
      tankId: TANK_FOR_PUMP[i],
      pumpId: p.id,
      physicalPumpId: p.id,
      nozzleId,
      mqttPumpId: p.mqttPumpId,
      pumpCode: p.pumpCode,
      product: p.product,
      isPrimary: true,
      active: true,
      source: 'CONFIGURED',
      lineLabel: `Pump ${i + 1} · ${nozzleId.endsWith('n1') ? 'Nozzle 1' : 'Nozzle 2'}`,
      ...extra,
    })
    const rows = [make(p.nozzles[0].id), make(p.nozzles[1].id)]
    if (i === 0) {
      rows.push({
        ...make(p.nozzles[0].id, {
          id: 'c-backup-pump-1',
          tankId: 'tank-pms-2',
          isPrimary: false,
          product: 'PMS',
          lineLabel: 'Pump 1 · Nozzle 1 (backup)',
        }),
      })
    }
    return rows
  })

  return {
    station: {
      id: FIXTURE_STATION_ID,
      name: 'Fixture Forecourt',
      stationCode: 'FIX-4x12',
      mqttStationId: 'InteliPump-Fixture',
      operationalStatus: 'OPEN',
      connectivityStatus: 'ONLINE',
    },
    layout: { mode: 'AUTO', canvasWidth: 1400, canvasHeight: 720, items: [] },
    tanks,
    pumps,
    tankPumpConnections,
    connections: tankPumpConnections,
    connectionMappingConfigured: true,
    devices: [{ id: 'dev-1', name: 'Lab gateway', deviceCode: 'pi-fixture', inferredStatus: 'ONLINE' }],
    latestTransactions: [],
    activeAlerts: [],
    salesToday: 184000,
    volumeToday: 142.5,
    transactionCountToday: 36,
    lastUpdatedAt: new Date().toISOString(),
    hasAssets: true,
  }
}
