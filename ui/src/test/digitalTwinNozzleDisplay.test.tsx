/**
 * Digital Twin pump LCD / live-sale state contracts.
 * Guards against hardcoded last-sale fallbacks, cross-nozzle bleed, blinky clears,
 * stale overwrites, and refresh→latest completed behavior.
 */
import React from 'react'
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import {
  COMPLETED_PRESENTATION_MS,
  applyNozzleEvent,
  applyPresentationElapsed,
  findSession,
  operationalDisplay,
  presentationOf,
  sessionKey,
} from '../lib/nozzleSessions'
import { lcdViewFromNozzle } from '../components/twin/schematic/lcdDisplay'
import { aggregatePhysicalPumpStatus } from '../components/twin/schematic/physicalPump'
import {
  nozzleLiveSignature,
  nozzlePanelStableKey,
} from '../components/twin/schematic/nodes/physicalPump/PhysicalPumpCard'
import SaleValueDisplay from '../components/twin/schematic/nodes/physicalPump/SaleValueDisplay'
import type { SchematicNode } from '../components/twin/schematic/types'
import { idleTwoNozzleState } from '../components/twin/schematic/dispenserFixtures'
import fs from 'node:fs'
import path from 'node:path'

const STATION = 'InteliPump-US-Lab'

function ev(partial: Record<string, unknown>) {
  return {
    stationId: STATION,
    pumpId: 'pump-1',
    nozzleId: 'nozzle-1',
    transactionId: 'tx-a',
    product: 'PMS',
    pricePerLiter: 1175,
    ...partial,
  }
}

describe('digital twin nozzle display contracts', () => {
  it('does not invent hardcoded last-sale fallbacks (no 1200 / 950 / 0.10 defaults)', () => {
    const view = lcdViewFromNozzle({ livePresentation: 'IDLE' }, 'IDLE')
    expect(view.mode).toBe('LAST SALE')
    expect(view.amount).toBeNull()
    expect(view.volume).toBeNull()
    expect(JSON.stringify(view)).not.toMatch(/1200|1,?200|950|0\.10/)
    const fixture = JSON.stringify(idleTwoNozzleState())
    expect(fixture).not.toMatch(/"lastCompletedAmount":\s*1200/)
    expect(fixture).not.toMatch(/"lastCompletedAmount":\s*950/)
    expect(fixture).not.toMatch(/"lastTransactionAmount":\s*1200/)
    expect(fixture).not.toMatch(/"lastTransactionAmount":\s*950/)
  })

  it('production nozzle display sources contain no hardcoded ₦1,200 / ₦950 last-sale defaults', () => {
    const roots = [
      path.resolve(__dirname, '../components/twin/schematic/lcdDisplay.ts'),
      path.resolve(__dirname, '../components/twin/schematic/dispenserFixtures.ts'),
      path.resolve(__dirname, '../components/twin/OperationalTwinView.tsx'),
      path.resolve(__dirname, '../lib/nozzleSessions.ts'),
    ]
    for (const file of roots) {
      const text = fs.readFileSync(file, 'utf8')
      expect(text).not.toMatch(/lastCompletedAmount:\s*1200/)
      expect(text).not.toMatch(/lastCompletedAmount:\s*950/)
      expect(text).not.toMatch(/lastTransactionAmount:\s*1200/)
      expect(text).not.toMatch(/lastTransactionAmount:\s*950/)
    }
  })

  it('keeps nozzle-1 and nozzle-2 sessions independent', () => {
    let sessions = applyNozzleEvent(
      {},
      ev({ nozzleId: 'nozzle-1', status: 'DISPENSING', amount: 100, volumeLiters: 0.08, sequence: 1 }),
    ).sessions
    sessions = applyNozzleEvent(
      sessions,
      ev({
        nozzleId: 'nozzle-2',
        transactionId: 'tx-b',
        status: 'DISPENSING',
        amount: 500,
        volumeLiters: 0.42,
        sequence: 1,
      }),
    ).sessions
    const n1 = findSession(sessions, STATION, ['pump-1'], ['nozzle-1'])
    const n2 = findSession(sessions, STATION, ['pump-1'], ['nozzle-2'])
    expect(n1?.amount).toBe(100)
    expect(n2?.amount).toBe(500)
    expect(operationalDisplay(n1)).toBe('DISPENSING')
    expect(operationalDisplay(n2)).toBe('DISPENSING')

    sessions = applyNozzleEvent(
      sessions,
      ev({ nozzleId: 'nozzle-1', status: 'DISPENSING', amount: 250, volumeLiters: 0.21, sequence: 2 }),
    ).sessions
    expect(findSession(sessions, STATION, ['pump-1'], ['nozzle-1'])?.amount).toBe(250)
    expect(findSession(sessions, STATION, ['pump-1'], ['nozzle-2'])?.amount).toBe(500)
  })

  it('never lets a nozzle-2 event rewrite nozzle-1 via findSession', () => {
    const sessions = applyNozzleEvent(
      {},
      ev({
        nozzleId: 'nozzle-2',
        pumpId: 'pump-1',
        status: 'DISPENSING',
        amount: 999,
        volumeLiters: 0.9,
        sequence: 1,
      }),
    ).sessions
    expect(findSession(sessions, STATION, ['pump-1', 'pump-2'], ['nozzle-1', 'n1'])).toBeUndefined()
    expect(findSession(sessions, STATION, ['pump-1'], ['nozzle-2'])?.amount).toBe(999)
  })

  it('increases live values without clearing on partial/duplicate-safe updates', () => {
    let sessions = applyNozzleEvent(
      {},
      ev({ status: 'DISPENSING', amount: 100, volumeLiters: 0.1, sequence: 1 }),
    ).sessions
    const key = sessionKey(STATION, 'pump-1', 'nozzle-1')
    sessions = applyNozzleEvent(
      sessions,
      ev({ status: 'DISPENSING', amount: null, volumeLiters: null, sequence: 2 }),
    ).sessions
    expect(sessions[key].amount).toBe(100)
    expect(sessions[key].volumeLiters).toBe(0.1)
    sessions = applyNozzleEvent(
      sessions,
      ev({ status: 'DISPENSING', amount: 80, volumeLiters: 0.05, sequence: 3 }),
    ).sessions
    // Monotonic for same tx — do not blink backward.
    expect(sessions[key].amount).toBe(100)
    expect(sessions[key].volumeLiters).toBe(0.1)
    sessions = applyNozzleEvent(
      sessions,
      ev({ status: 'DISPENSING', amount: 200, volumeLiters: 0.17, sequence: 4 }),
    ).sessions
    expect(sessions[key].amount).toBe(200)
    expect(sessions[key].volumeLiters).toBe(0.17)
  })

  it('keeps amount/volume mounted while progress advances ₦82.25 → ₦235 → ₦300', () => {
    const amounts = [82.25, 235, 300]
    const { rerender, getByTestId } = render(
      <SaleValueDisplay label="THIS SALE" amount={amounts[0]} volume={0.07} />,
    )
    const amountNode = getByTestId('sale-amount')
    const volumeNode = getByTestId('sale-volume')
    expect(amountNode.textContent).toMatch(/82\.25/)
    for (const next of amounts.slice(1)) {
      rerender(<SaleValueDisplay label="THIS SALE" amount={next} volume={next / 1175} />)
      expect(getByTestId('sale-amount')).toBe(amountNode)
      expect(getByTestId('sale-volume')).toBe(volumeNode)
      expect(amountNode.textContent).toMatch(new RegExp(String(next)))
      expect(amountNode.getAttribute('data-empty')).toBe('0')
    }
  })

  it('rejects stale sequences so older REST/SSE cannot overwrite newer values', () => {
    let sessions = applyNozzleEvent(
      {},
      ev({ status: 'DISPENSING', amount: 300, volumeLiters: 0.25, sequence: 5 }),
    ).sessions
    const rejected = applyNozzleEvent(
      sessions,
      ev({ status: 'DISPENSING', amount: 50, volumeLiters: 0.04, sequence: 2 }),
    )
    expect(rejected.accepted).toBe(false)
    expect(rejected.reason).toBe('stale_sequence')
    expect(rejected.sessions[sessionKey(STATION, 'pump-1', 'nozzle-1')].amount).toBe(300)
  })

  it('accepts COMPLETED even when sequence is lower than last progress (exits Dispensing)', () => {
    const now = 5_000_000
    let sessions = applyNozzleEvent(
      {},
      ev({ status: 'DISPENSING', amount: 300, volumeLiters: 0.25, sequence: 12 }),
      'sse',
      now,
    ).sessions
    const key = sessionKey(STATION, 'pump-1', 'nozzle-1')
    expect(operationalDisplay(sessions[key])).toBe('DISPENSING')
    const completed = applyNozzleEvent(
      sessions,
      ev({
        status: 'COMPLETED',
        amount: 300,
        volumeLiters: 0.25,
        sequence: 1,
        completedAt: new Date(now + 10).toISOString(),
      }),
      'sse',
      now + 10,
    )
    expect(completed.accepted).toBe(true)
    expect(completed.sessions[key].state).toBe('COMPLETED')
    expect(completed.sessions[key].lastCompleted?.amount).toBe(300)
    expect(operationalDisplay(completed.sessions[key], now + 10)).toBe('SALE_COMPLETED')
  })

  it('late progress cannot overwrite Completed', () => {
    const now = 6_000_000
    let sessions = applyNozzleEvent(
      {},
      ev({ status: 'COMPLETED', amount: 400, volumeLiters: 0.34, sequence: 9 }),
      'sse',
      now,
    ).sessions
    const key = sessionKey(STATION, 'pump-1', 'nozzle-1')
    const late = applyNozzleEvent(
      sessions,
      ev({ status: 'DISPENSING', amount: 390, volumeLiters: 0.33, sequence: 10 }),
      'sse',
      now + 50,
    )
    expect(late.accepted).toBe(false)
    expect(late.reason).toBe('reopen_completed')
    expect(late.sessions[key].lastCompleted?.amount).toBe(400)
    expect(operationalDisplay(late.sessions[key], now + 50)).toBe('SALE_COMPLETED')
  })

  it('both nozzles exit Dispensing after their own completion', () => {
    const now = 7_000_000
    let sessions = applyNozzleEvent(
      {},
      ev({ nozzleId: 'nozzle-1', status: 'DISPENSING', amount: 100, sequence: 1 }),
      'sse',
      now,
    ).sessions
    sessions = applyNozzleEvent(
      sessions,
      ev({
        nozzleId: 'nozzle-2',
        transactionId: 'tx-b',
        status: 'DISPENSING',
        amount: 200,
        sequence: 1,
      }),
      'sse',
      now,
    ).sessions
    sessions = applyNozzleEvent(
      sessions,
      ev({ nozzleId: 'nozzle-1', status: 'COMPLETED', amount: 150, sequence: 2 }),
      'sse',
      now + 1,
    ).sessions
    sessions = applyNozzleEvent(
      sessions,
      ev({
        nozzleId: 'nozzle-2',
        transactionId: 'tx-b',
        status: 'COMPLETED',
        amount: 250,
        sequence: 2,
      }),
      'sse',
      now + 1,
    ).sessions
    expect(operationalDisplay(findSession(sessions, STATION, ['pump-1'], ['nozzle-1']), now + 1)).toBe(
      'SALE_COMPLETED',
    )
    expect(operationalDisplay(findSession(sessions, STATION, ['pump-1'], ['nozzle-2']), now + 1)).toBe(
      'SALE_COMPLETED',
    )
    expect(findSession(sessions, STATION, ['pump-1'], ['nozzle-1'])?.lastCompleted?.amount).toBe(150)
    expect(findSession(sessions, STATION, ['pump-1'], ['nozzle-2'])?.lastCompleted?.amount).toBe(250)
  })

  it('keeps completed totals as Last Sale after presentation window', () => {
    const now = 2_000_000
    let sessions = applyNozzleEvent(
      {},
      ev({
        status: 'COMPLETED',
        amount: 2044.5,
        volumeLiters: 1.74,
        sequence: 9,
        completedAt: new Date(now).toISOString(),
      }),
      'sse',
      now,
    ).sessions
    const key = sessionKey(STATION, 'pump-1', 'nozzle-1')
    expect(presentationOf(sessions[key], now + 100)).toBe('SALE_COMPLETED')
    expect(sessions[key].amount).toBe(2044.5)
    sessions = applyPresentationElapsed(sessions, key)
    expect(sessions[key].state).toBe('IDLE')
    expect(sessions[key].lastCompleted?.amount).toBe(2044.5)
    expect(sessions[key].amount).toBe(2044.5)
    expect(presentationOf(sessions[key], now + COMPLETED_PRESENTATION_MS + 50)).toBe('LAST_SALE')
    const lcd = lcdViewFromNozzle(
      {
        livePresentation: 'IDLE',
        lastCompletedAmount: sessions[key].lastCompleted?.amount,
        lastCompletedVolume: sessions[key].lastCompleted?.volumeLiters,
      },
      'IDLE',
    )
    expect(lcd.mode).toBe('LAST SALE')
    expect(lcd.amount).toBe(2044.5)
    expect(lcd.volume).toBe(1.74)
  })

  it('refresh loads an older completed sale as Last Sale without hardcoded values', () => {
    const r = applyNozzleEvent(
      {},
      ev({
        status: 'COMPLETED',
        amount: 540.5,
        volumeLiters: 0.46,
        sequence: 3,
        completedAt: '2026-09-11T12:00:00Z',
        receivedAt: '2026-09-11T12:00:00Z',
      }),
      'rest',
      Date.parse('2026-09-11T14:00:00Z'),
    )
    const s = r.sessions[sessionKey(STATION, 'pump-1', 'nozzle-1')]
    expect(s.state).toBe('IDLE')
    expect(s.lastCompleted?.amount).toBe(540.5)
    expect(s.lastCompleted?.volumeLiters).toBe(0.46)
    expect(presentationOf(s, Date.parse('2026-09-11T14:00:00Z'))).toBe('LAST_SALE')
  })

  it('new dispensing sale cancels prior completion presentation', () => {
    const now = 3_000_000
    let sessions = applyNozzleEvent(
      {},
      ev({ status: 'COMPLETED', amount: 100, volumeLiters: 0.1, sequence: 1, transactionId: 'tx-old' }),
      'sse',
      now,
    ).sessions
    const key = sessionKey(STATION, 'pump-1', 'nozzle-1')
    expect(sessions[key].completedAtMs).toBe(now)
    sessions = applyNozzleEvent(
      sessions,
      ev({
        status: 'DISPENSING',
        amount: 10,
        volumeLiters: 0.01,
        sequence: 2,
        transactionId: 'tx-new',
      }),
      'sse',
      now + 1_000,
    ).sessions
    expect(sessions[key].state).toBe('DISPENSING')
    expect(sessions[key].completedAtMs).toBeNull()
    expect(sessions[key].transactionId).toBe('tx-new')
    expect(sessions[key].lastCompleted?.transactionId).toBe('tx-old')
  })

  it('aggregate pump status does not mark both hoses from one SALE_COMPLETED', () => {
    expect(aggregatePhysicalPumpStatus(['IDLE', 'DISPENSING'])).toBe('DISPENSING')
    expect(aggregatePhysicalPumpStatus(['SALE_COMPLETED', 'IDLE'])).toBe('SALE_COMPLETED')
    expect(aggregatePhysicalPumpStatus(['IDLE', 'IDLE'])).toBe('IDLE')
  })

  it('creates a new live signature when nozzle totals change (immutable React Flow data)', () => {
    const a: SchematicNode = {
      id: 'n1',
      kind: 'PUMP',
      x: 0,
      y: 0,
      w: 10,
      h: 10,
      label: 'Nozzle 1',
      status: 'DISPENSING',
      raw: { livePresentation: 'DISPENSING', liveAmount: 100, liveVolume: 0.1, liveSequence: 1 },
    }
    const b: SchematicNode = {
      ...a,
      raw: { ...a.raw, liveAmount: 200, liveVolume: 0.17, liveSequence: 2 },
    }
    expect(nozzleLiveSignature(a)).not.toBe(nozzleLiveSignature(b))
  })

  it('uses stable nozzle panel keys from station+pump+nozzle (not amount/sequence)', () => {
    const node: SchematicNode = {
      id: 'uuid-n1',
      kind: 'PUMP',
      x: 0,
      y: 0,
      w: 10,
      h: 10,
      label: 'Nozzle 1',
      status: 'DISPENSING',
      raw: {
        stationId: STATION,
        parentPumpId: 'pump-1',
        mqttNozzleId: 'nozzle-1',
        liveAmount: 82.25,
        liveSequence: 3,
        liveTransactionId: 'tx-a',
      },
    }
    const key = nozzlePanelStableKey(node, 0)
    expect(key).toContain('pump-1')
    expect(key).toContain('nozzle-1')
    expect(key).not.toMatch(/82\.25|tx-a|sequence/)
    expect(
      nozzlePanelStableKey(
        { ...node, raw: { ...node.raw, liveAmount: 300, liveSequence: 9 } },
        0,
      ),
    ).toBe(key)
  })
})
