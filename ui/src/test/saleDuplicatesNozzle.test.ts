import { describe, expect, it } from 'vitest'
import { isHangupDuplicateSale } from '../lib/saleDuplicates'
import type { PumpSale } from '../types/sales'

function sale(partial: Partial<PumpSale>): PumpSale {
  return {
    transactionId: 'tx-a',
    stationId: 'InteliPump-US-Lab',
    pumpId: 'pump-1',
    nozzleId: 'nozzle-1',
    product: 'PMS',
    volumeLiters: 0.25,
    amount: 300,
    currency: 'NGN',
    pricePerLiter: 1200,
    status: 'COMPLETED',
    sourceTopic: null,
    receivedAt: '2026-09-10T18:51:00.000Z',
    ...partial,
  }
}

describe('isHangupDuplicateSale nozzle scope', () => {
  it('does not treat same totals on different nozzles as hangup twins', () => {
    const n1 = sale({ transactionId: 'tx-n1', nozzleId: 'nozzle-1', sourceIdentifier: 'pump-1' })
    const n2 = sale({
      transactionId: 'tx-n2',
      nozzleId: 'nozzle-2',
      sourceIdentifier: 'pump-2',
      receivedAt: '2026-09-10T18:52:00.000Z',
    })
    expect(isHangupDuplicateSale(n1, n2)).toBe(false)
  })

  it('still folds same-nozzle holster twins', () => {
    const live = sale({ transactionId: 'tx-live', status: 'DISPENSING' })
    const hangup = sale({
      transactionId: 'tx-hangup',
      status: 'COMPLETED',
      receivedAt: '2026-09-10T18:51:30.000Z',
    })
    expect(isHangupDuplicateSale(live, hangup)).toBe(true)
  })
})
