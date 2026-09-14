import { describe, expect, it } from 'vitest'
import {
  canonicalizeLiveIdentity,
  catalogFromPumps,
  nozzleStateKey,
} from '../lib/nozzleIdentity'
import {
  applyNozzleEvent,
  findSession,
  sessionKey,
} from '../lib/nozzleSessions'

const catalog = catalogFromPumps([
  {
    id: 'p1',
    mqttPumpId: 'pump-1',
    pumpCode: 'P1',
    nozzles: [
      {
        id: 'n1',
        name: 'Nozzle 1',
        nozzleCode: 'nozzle-1',
        mqttNozzleId: 'nozzle-1',
        sourceIdentifier: 'pump-1',
        nozzleNumber: 1,
      },
      {
        id: 'n2',
        name: 'Nozzle 2',
        nozzleCode: 'nozzle-2',
        mqttNozzleId: 'nozzle-2',
        sourceIdentifier: 'pump-2',
        nozzleNumber: 2,
      },
    ],
  },
])

describe('legacy pump-2 → pump-1/nozzle-2 identity', () => {
  it('remaps default Pi identity pump-2/nozzle-1 to physical Nozzle 2', () => {
    const ident = canonicalizeLiveIdentity(
      { pumpId: 'pump-2', nozzleId: 'nozzle-1', sourceIdentifier: 'pump-2' },
      catalog,
    )
    expect(ident.mapped).toBe(true)
    expect(ident.pumpId).toBe('pump-1')
    expect(ident.nozzleId).toBe('nozzle-2')
    expect(ident.sourceIdentifier).toBe('pump-2')
  })

  it('remaps pump-2 with null nozzle without assigning Nozzle 1', () => {
    const ident = canonicalizeLiveIdentity({ pumpId: 'pump-2', nozzleId: null }, catalog)
    expect(ident.mapped).toBe(true)
    expect(ident.pumpId).toBe('pump-1')
    expect(ident.nozzleId).toBe('nozzle-2')
  })

  it('does not fall back to Nozzle 1 when mapping fails', () => {
    const ident = canonicalizeLiveIdentity(
      { pumpId: 'pump-99', nozzleId: null, sourceIdentifier: 'unknown-channel' },
      catalog,
    )
    expect(ident.mapped).toBe(false)
    expect(ident.nozzleId).not.toBe('nozzle-1')
    expect(ident.mappingWarning).toMatch(/mapping/i)
  })

  it('keeps Nozzle 1 identity unchanged', () => {
    const ident = canonicalizeLiveIdentity(
      { pumpId: 'pump-1', nozzleId: 'nozzle-1', sourceIdentifier: 'pump-1' },
      catalog,
    )
    expect(ident.pumpId).toBe('pump-1')
    expect(ident.nozzleId).toBe('nozzle-1')
  })

  it('attaches a legacy pump-2/nozzle-1 session only to Nozzle 2', () => {
    const sessions = applyNozzleEvent(
      {},
      {
        stationId: 'InteliPump-US-Lab',
        pumpId: 'pump-2',
        nozzleId: 'nozzle-1',
        sourceIdentifier: 'pump-2',
        transactionId: 'tx-n2',
        status: 'DISPENSING',
        amount: 120,
        volumeLiters: 0.1,
        sequence: 1,
      },
    ).sessions
    // After FE canonicalize the key is pump-1|nozzle-2; also cover raw legacy attach.
    const remapped = applyNozzleEvent(
      {},
      {
        stationId: 'InteliPump-US-Lab',
        pumpId: 'pump-1',
        nozzleId: 'nozzle-2',
        sourceIdentifier: 'pump-2',
        transactionId: 'tx-n2b',
        status: 'DISPENSING',
        amount: 200,
        volumeLiters: 0.17,
        sequence: 1,
      },
    ).sessions
    expect(
      findSession(remapped, 'InteliPump-US-Lab', ['pump-1'], ['nozzle-1', 'pump-1'])?.amount,
    ).toBeUndefined()
    expect(
      findSession(remapped, 'InteliPump-US-Lab', ['pump-1', 'pump-2'], ['nozzle-2', 'pump-2'])
        ?.amount,
    ).toBe(200)

    expect(
      findSession(sessions, 'InteliPump-US-Lab', ['pump-1'], ['nozzle-1', 'pump-1']),
    ).toBeUndefined()
    expect(
      findSession(sessions, 'InteliPump-US-Lab', ['pump-1', 'pump-2'], ['nozzle-2', 'pump-2', 'n2'])
        ?.amount,
    ).toBe(120)
  })

  it('updates only Nozzle 2 through progress events after remap', () => {
    let sessions = {}
    const stationId = 'InteliPump-US-Lab'
    for (const [seq, amount, volume] of [
      [1, 100, 0.08],
      [2, 250, 0.21],
      [3, 400, 0.34],
      [4, 550, 0.46],
      [5, 700, 0.59],
    ] as const) {
      const ident = canonicalizeLiveIdentity(
        { pumpId: 'pump-2', nozzleId: 'nozzle-1', sourceIdentifier: 'pump-2' },
        catalog,
      )
      sessions = applyNozzleEvent(sessions, {
        stationId,
        pumpId: ident.pumpId,
        nozzleId: ident.nozzleId,
        sourceIdentifier: ident.sourceIdentifier,
        transactionId: 'tx-stable-n2',
        status: 'DISPENSING',
        amount,
        volumeLiters: volume,
        sequence: seq,
      }).sessions
    }
    const n2 = findSession(sessions, stationId, ['pump-1'], ['nozzle-2'])
    const n1 = findSession(sessions, stationId, ['pump-1'], ['nozzle-1'])
    expect(n2?.amount).toBe(700)
    expect(n2?.volumeLiters).toBe(0.59)
    expect(n2?.state).toBe('DISPENSING')
    expect(n1).toBeUndefined()
    expect(nozzleStateKey(stationId, 'pump-1', 'nozzle-2')).toBe(
      'InteliPump-US-Lab/pump-1/nozzle-2',
    )
    expect(sessions[sessionKey(stationId, 'pump-1', 'nozzle-2')]?.transactionId).toBe('tx-stable-n2')
  })

  it('keeps simultaneous Nozzle 1 and Nozzle 2 sessions independent', () => {
    let sessions = applyNozzleEvent(
      {},
      {
        stationId: 'InteliPump-US-Lab',
        pumpId: 'pump-1',
        nozzleId: 'nozzle-1',
        transactionId: 'tx-1',
        status: 'DISPENSING',
        amount: 10,
        volumeLiters: 0.01,
        sequence: 1,
      },
    ).sessions
    const ident = canonicalizeLiveIdentity(
      { pumpId: 'pump-2', nozzleId: 'nozzle-1', sourceIdentifier: 'pump-2' },
      catalog,
    )
    sessions = applyNozzleEvent(sessions, {
      stationId: 'InteliPump-US-Lab',
      pumpId: ident.pumpId,
      nozzleId: ident.nozzleId,
      transactionId: 'tx-2',
      status: 'DISPENSING',
      amount: 20,
      volumeLiters: 0.02,
      sequence: 1,
    }).sessions
    expect(findSession(sessions, 'InteliPump-US-Lab', ['pump-1'], ['nozzle-1'])?.amount).toBe(10)
    expect(findSession(sessions, 'InteliPump-US-Lab', ['pump-1'], ['nozzle-2'])?.amount).toBe(20)
  })
})
