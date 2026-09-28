import { describe, expect, it } from 'vitest'
import { canonicalizeLiveIdentity, catalogFromPumps } from '../lib/nozzleIdentity'
import { applyNozzleEvent, findSession } from '../lib/nozzleSessions'

function fullSaoCatalog() {
  const pumps = []
  for (let n = 1; n <= 6; n++) {
    const src1 = n === 1 ? 'pump-1' : `pump-${n}-n1`
    const src2 = n === 1 ? 'pump-2' : `pump-${n}-n2`
    pumps.push({
      id: `p${n}`,
      mqttPumpId: `pump-${n}`,
      pumpCode: `pump-${n}`,
      nozzles: [
        {
          id: `p${n}-a`,
          nozzleCode: n === 1 ? 'nozzle-1' : `nozzle-1-pump-${n}`,
          mqttNozzleId: n === 1 ? 'nozzle-1' : `nozzle-1-pump-${n}`,
          sourceIdentifier: src1,
          nozzleNumber: 1,
        },
        {
          id: `p${n}-b`,
          nozzleCode: n === 1 ? 'nozzle-2' : `nozzle-2-pump-${n}`,
          mqttNozzleId: n === 1 ? 'nozzle-2' : `nozzle-2-pump-${n}`,
          sourceIdentifier: src2,
          nozzleNumber: 2,
        },
      ],
    })
  }
  return { pumps, catalog: catalogFromPumps(pumps) }
}

describe('pump-5 with full SAO catalog', () => {
  it('maps Pi sale to hose 9 panel only', () => {
    const { catalog } = fullSaoCatalog()
    const ident = canonicalizeLiveIdentity(
      { pumpId: 'pump-5', nozzleId: 'nozzle-1', sourceIdentifier: 'pump-5-n1' },
      catalog,
    )
    expect(ident.nozzleId).toBe('nozzle-1-pump-5')
    const sessions = applyNozzleEvent(
      {},
      {
        stationId: 'SAO-Redeemed-Station-1',
        pumpId: ident.pumpId,
        nozzleId: ident.nozzleId,
        sourceIdentifier: ident.sourceIdentifier,
        status: 'DISPENSING',
        amount: 1100,
        volumeLiters: 0.8,
        sequence: 1,
        transactionId: 'tx1',
      },
    ).sessions

    const n1 = findSession(sessions, 'SAO-Redeemed-Station-1', ['pump-5', 'p5'], [
      'nozzle-1-pump-5',
      'nozzle-1',
      'pump-5-n1',
      'p5-a',
    ])
    const n2 = findSession(sessions, 'SAO-Redeemed-Station-1', ['pump-5', 'p5'], [
      'nozzle-2-pump-5',
      'nozzle-2',
      'pump-5-n2',
      'p5-b',
    ])
    expect(n1?.amount).toBe(1100)
    expect(n2).toBeUndefined()
  })
})
