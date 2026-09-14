import { describe, expect, it } from 'vitest'
import {
  COMPLETED_PRESENTATION_MS,
  applyNozzleEvent,
  applyPresentationElapsed,
  findSession,
  flowingSessions,
  markStaleSessions,
  operationalDisplay,
  presentationOf,
  sessionKey,
} from '../lib/nozzleSessions'

const base = {
  stationId: 'InteliPump-US-Lab',
  pumpId: 'pump-1',
  nozzleId: 'nozzle-2',
  transactionId: 'tx-stable',
  product: 'PMS',
  pricePerLiter: 1190.48,
}

function ev(partial: Record<string, unknown>) {
  return { ...base, ...partial }
}

describe('nozzle session machine', () => {
  it('idle to dispensing', () => {
    const r = applyNozzleEvent({}, ev({ status: 'DISPENSING', amount: 100, volumeLiters: 0.1, sequence: 1 }))
    expect(r.accepted).toBe(true)
    const s = r.sessions[sessionKey(base.stationId, 'pump-1', 'nozzle-2')]
    expect(s.state).toBe('DISPENSING')
    expect(s.transactionId).toBe('tx-stable')
  })

  it('multiple dispensing updates stay dispensing and accumulate', () => {
    let sessions = applyNozzleEvent({}, ev({ status: 'DISPENSING', amount: 100, volumeLiters: 0.1, sequence: 1 })).sessions
    sessions = applyNozzleEvent(sessions, ev({ status: 'DISPENSING', amount: 300, volumeLiters: 0.25, sequence: 2 })).sessions
    const s = sessions[sessionKey(base.stationId, 'pump-1', 'nozzle-2')]
    expect(s.state).toBe('DISPENSING')
    expect(s.amount).toBe(300)
    expect(s.volumeLiters).toBe(0.25)
    expect(s.transactionId).toBe('tx-stable')
  })

  it('stays dispensing when no new event arrives for a short gap', () => {
    const r = applyNozzleEvent({}, ev({ status: 'DISPENSING', amount: 200, volumeLiters: 0.2, sequence: 1 }))
    const later = markStaleSessions(r.sessions, Date.now() + 20_000)
    expect(later[sessionKey(base.stationId, 'pump-1', 'nozzle-2')].state).toBe('DISPENSING')
  })

  it('dispensing to completed keeps final values', () => {
    let sessions = applyNozzleEvent({}, ev({ status: 'DISPENSING', amount: 400, volumeLiters: 0.34, sequence: 4 })).sessions
    sessions = applyNozzleEvent(sessions, ev({ status: 'COMPLETED', amount: 500, volumeLiters: 0.42, sequence: 5 })).sessions
    const s = sessions[sessionKey(base.stationId, 'pump-1', 'nozzle-2')]
    expect(s.state).toBe('COMPLETED')
    expect(s.amount).toBe(500)
    expect(s.volumeLiters).toBe(0.42)
    expect(s.lastCompleted?.amount).toBe(500)
  })

  it('completed presentation then idle keeps last sale', () => {
    const now = 1_000_000
    let sessions = applyNozzleEvent(
      {},
      ev({ status: 'COMPLETED', amount: 500, volumeLiters: 0.42, sequence: 5 }),
      'sse',
      now,
    ).sessions
    const key = sessionKey(base.stationId, 'pump-1', 'nozzle-2')
    expect(presentationOf(sessions[key], now + 1_000)).toBe('SALE_COMPLETED')
    expect(operationalDisplay(sessions[key], now + 1_000)).toBe('SALE_COMPLETED')
    expect(presentationOf(sessions[key], now + COMPLETED_PRESENTATION_MS + 10)).toBe('LAST_SALE')
    sessions = applyPresentationElapsed(sessions, key)
    expect(sessions[key].state).toBe('IDLE')
    expect(sessions[key].lastCompleted?.amount).toBe(500)
    expect(sessions[key].amount).toBe(500)
    expect(presentationOf(sessions[key], now + COMPLETED_PRESENTATION_MS + 20)).toBe('LAST_SALE')
  })

  it('ignores duplicate dispensing and completed', () => {
    let sessions = applyNozzleEvent({}, ev({ status: 'DISPENSING', amount: 100, volumeLiters: 0.1, sequence: 1 })).sessions
    expect(applyNozzleEvent(sessions, ev({ status: 'DISPENSING', amount: 100, volumeLiters: 0.1, sequence: 1 })).accepted).toBe(false)
    sessions = applyNozzleEvent(sessions, ev({ status: 'COMPLETED', amount: 100, volumeLiters: 0.1, sequence: 2 })).sessions
    expect(applyNozzleEvent(sessions, ev({ status: 'COMPLETED', amount: 100, volumeLiters: 0.1, sequence: 2 })).accepted).toBe(false)
  })

  it('rejects out-of-order dispensing after completed', () => {
    let sessions = applyNozzleEvent({}, ev({ status: 'COMPLETED', amount: 500, volumeLiters: 0.42, sequence: 5 })).sessions
    const r = applyNozzleEvent(sessions, ev({ status: 'DISPENSING', amount: 400, volumeLiters: 0.3, sequence: 4 }))
    expect(r.accepted).toBe(false)
    expect(r.reason).toMatch(/stale_sequence|reopen_completed/)
  })

  it('rejects an older REST snapshot during live dispensing', () => {
    let sessions = applyNozzleEvent(
      {},
      ev({ status: 'DISPENSING', amount: 300, volumeLiters: 0.25, sequence: 4, receivedAt: '2026-09-08T18:00:10Z' }),
    ).sessions
    const r = applyNozzleEvent(
      sessions,
      ev({ status: 'COMPLETED', amount: 100, volumeLiters: 0.1, sequence: 1, receivedAt: '2026-09-08T18:00:01Z' }),
      'rest',
    )
    expect(r.accepted).toBe(false)
  })

  it('accepts COMPLETED with reset sequence for the same live transaction', () => {
    let sessions = applyNozzleEvent(
      {},
      ev({
        transactionId: 'f020bb5c-76e6-4e64-b8e2-03c09aca5cc0',
        nozzleId: 'nozzle-2',
        status: 'DISPENSING',
        amount: 350,
        volumeLiters: 0.29,
        sequence: 17,
      }),
    ).sessions
    const r = applyNozzleEvent(
      sessions,
      ev({
        transactionId: 'f020bb5c-76e6-4e64-b8e2-03c09aca5cc0',
        nozzleId: 'nozzle-2',
        status: 'COMPLETED',
        amount: 350,
        volumeLiters: 0.29,
        sequence: 2,
      }),
    )
    expect(r.accepted).toBe(true)
    const s = findSession(r.sessions, base.stationId, ['pump-1'], ['nozzle-2'])
    expect(s?.state).toBe('COMPLETED')
    expect(s?.lastCompleted?.amount).toBe(350)
    expect(s?.lastCompleted?.volumeLiters).toBe(0.29)
  })

  it('keeps nozzle-2 last sale after refresh and rejects older REST overwrite', () => {
    let sessions = applyNozzleEvent(
      {},
      ev({
        transactionId: 'f020bb5c-76e6-4e64-b8e2-03c09aca5cc0',
        nozzleId: 'nozzle-2',
        status: 'COMPLETED',
        amount: 350,
        volumeLiters: 0.29,
        sequence: 18,
        completedAt: '2026-09-13T12:58:29Z',
        receivedAt: '2026-09-13T12:58:29Z',
      }),
    ).sessions
    sessions = applyPresentationElapsed(sessions, sessionKey(base.stationId, 'pump-1', 'nozzle-2'))
    expect(sessions[sessionKey(base.stationId, 'pump-1', 'nozzle-2')].lastCompleted?.amount).toBe(350)
    const older = applyNozzleEvent(
      sessions,
      ev({
        transactionId: 'old-950',
        nozzleId: 'nozzle-2',
        status: 'COMPLETED',
        amount: 950,
        volumeLiters: 0.8,
        sequence: 1,
        completedAt: '2026-09-01T00:00:00Z',
        receivedAt: '2026-09-01T00:00:00Z',
      }),
      'rest',
    )
    expect(older.accepted).toBe(false)
    expect(sessions[sessionKey(base.stationId, 'pump-1', 'nozzle-2')].lastCompleted?.amount).toBe(350)
  })

  it('supports two independent nozzles on one pump', () => {
    let sessions = applyNozzleEvent({}, ev({ nozzleId: 'nozzle-1', status: 'DISPENSING', amount: 10, volumeLiters: 0.01, sequence: 1 })).sessions
    sessions = applyNozzleEvent(sessions, ev({ nozzleId: 'nozzle-2', status: 'DISPENSING', amount: 20, volumeLiters: 0.02, sequence: 1 })).sessions
    const a = findSession(sessions, base.stationId, ['pump-1'], ['nozzle-1'])
    const b = findSession(sessions, base.stationId, ['pump-1'], ['nozzle-2'])
    expect(a?.state).toBe('DISPENSING')
    expect(b?.state).toBe('DISPENSING')
    expect(a?.amount).toBe(10)
    expect(b?.amount).toBe(20)
    expect(flowingSessions(sessions)).toHaveLength(2)
  })

  it('keeps one nozzle idle while the other dispenses', () => {
    const sessions = applyNozzleEvent({}, ev({ nozzleId: 'nozzle-2', status: 'DISPENSING', amount: 50, volumeLiters: 0.04, sequence: 1 })).sessions
    expect(findSession(sessions, base.stationId, ['pump-1'], ['nozzle-1'])).toBeUndefined()
    expect(findSession(sessions, base.stationId, ['pump-1'], ['nozzle-2'])?.state).toBe('DISPENSING')
  })

  it('loads an older completed sale as last sale after refresh', () => {
    const r = applyNozzleEvent(
      {},
      ev({
        status: 'COMPLETED',
        amount: 500,
        volumeLiters: 0.42,
        sequence: 5,
        completedAt: '2026-09-08T17:00:00Z',
        receivedAt: '2026-09-08T17:00:00Z',
      }),
      'rest',
      Date.parse('2026-09-08T18:00:00Z'),
    )
    const s = r.sessions[sessionKey(base.stationId, 'pump-1', 'nozzle-2')]
    expect(s.state).toBe('IDLE')
    expect(s.lastCompleted?.amount).toBe(500)
    expect(s.amount).toBe(500)
    expect(presentationOf(s, Date.parse('2026-09-08T18:00:00Z'))).toBe('LAST_SALE')
  })

  it('surfaces a mapping warning when nozzle id is missing', () => {
    const r = applyNozzleEvent(
      {},
      ev({ nozzleId: null, status: 'DISPENSING', amount: 10, volumeLiters: 0.01, sequence: 1 }),
    )
    const s = Object.values(r.sessions)[0]
    expect(s.mappingWarning).toMatch(/mapping/i)
    expect(s.state).toBe('DISPENSING')
  })

  it('keeps dispensing across a 30s irregular update scenario then completes', () => {
    const start = Date.parse('2026-09-08T18:00:00Z')
    let sessions = applyNozzleEvent(
      {},
      ev({ status: 'DISPENSING', amount: 100, volumeLiters: 0.08, sequence: 1, receivedAt: '2026-09-08T18:00:00Z' }),
      'sse',
      start,
    ).sessions
    const gaps = [3_000, 8_000, 14_000, 19_000, 27_000]
    const amounts = [180, 260, 340, 410, 480]
    const volumes = [0.15, 0.22, 0.29, 0.35, 0.4]
    gaps.forEach((gap, i) => {
      sessions = markStaleSessions(sessions, start + gap)
      expect(sessions[sessionKey(base.stationId, 'pump-1', 'nozzle-2')].state).toBe('DISPENSING')
      sessions = applyNozzleEvent(
        sessions,
        ev({
          status: 'DISPENSING',
          amount: amounts[i],
          volumeLiters: volumes[i],
          sequence: i + 2,
          receivedAt: new Date(start + gap).toISOString(),
        }),
        'sse',
        start + gap,
      ).sessions
      expect(sessions[sessionKey(base.stationId, 'pump-1', 'nozzle-2')].state).toBe('DISPENSING')
      expect(flowingSessions(sessions)).toHaveLength(1)
    })
    sessions = applyNozzleEvent(
      sessions,
      ev({
        status: 'COMPLETED',
        amount: 500,
        volumeLiters: 0.42,
        sequence: 8,
        receivedAt: '2026-09-08T18:00:32Z',
        completedAt: '2026-09-08T18:00:32Z',
      }),
      'sse',
      start + 32_000,
    ).sessions
    const done = sessions[sessionKey(base.stationId, 'pump-1', 'nozzle-2')]
    expect(done.state).toBe('COMPLETED')
    expect(done.amount).toBe(500)
    expect(done.volumeLiters).toBe(0.42)
    expect(flowingSessions(sessions)).toHaveLength(0)
    sessions = applyPresentationElapsed(sessions, done.key)
    expect(sessions[done.key].state).toBe('IDLE')
    expect(sessions[done.key].lastCompleted?.amount).toBe(500)
    expect(sessions[done.key].amount).toBe(500)
  })

  it('does not inherit last-sale amounts when a new dispensing transaction starts', () => {
    let sessions = applyNozzleEvent({}, ev({ status: 'COMPLETED', amount: 500, volumeLiters: 0.42, sequence: 5 })).sessions
    const r = applyNozzleEvent(
      sessions,
      ev({
        transactionId: 'tx-new',
        status: 'DISPENSING',
        amount: null,
        volumeLiters: null,
        sequence: 6,
      }),
    )
    expect(r.accepted).toBe(true)
    const s = r.sessions[sessionKey(base.stationId, 'pump-1', 'nozzle-2')]
    expect(s.state).toBe('DISPENSING')
    expect(s.transactionId).toBe('tx-new')
    expect(s.amount).toBeNull()
    expect(s.volumeLiters).toBeNull()
    expect(s.lastCompleted?.amount).toBe(500)
  })

  it('does not attach another nozzle session just because sourceIdentifier equals pumpId', () => {
    const sessions = applyNozzleEvent(
      {},
      ev({ nozzleId: 'nozzle-2', status: 'DISPENSING', amount: 50, volumeLiters: 0.04, sequence: 1 }),
    ).sessions
    expect(
      findSession(sessions, base.stationId, ['pump-1'], ['n1', 'pump-1', 'nozzle-1']),
    ).toBeUndefined()
    expect(findSession(sessions, base.stationId, ['pump-1'], ['nozzle-2', 'pump-1'])?.amount).toBe(50)
  })

  it('marks a stale active session interrupted', () => {
    const start = Date.parse('2026-09-08T18:00:00Z')
    const r = applyNozzleEvent(
      {},
      ev({ status: 'DISPENSING', amount: 10, volumeLiters: 0.01, sequence: 1, receivedAt: '2026-09-08T18:00:00Z' }),
      'sse',
      start,
    )
    const stale = markStaleSessions(r.sessions, start + 121_000)
    expect(stale[sessionKey(base.stationId, 'pump-1', 'nozzle-2')].state).toBe('INTERRUPTED')
  })
})
