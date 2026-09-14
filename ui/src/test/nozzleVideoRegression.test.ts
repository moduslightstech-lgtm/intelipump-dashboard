import { describe, expect, it } from 'vitest'
import {
  HANGUP_IDLE_MS,
  playbackStateKey,
  resolveConnection,
} from '../hooks/useDispensingPlayback'
import {
  applyNozzleEvent,
  flowingSessions,
  findSession,
  type NozzleLiveEvent,
} from '../lib/nozzleSessions'
import { canonicalizeLiveIdentity, catalogFromPumps } from '../lib/nozzleIdentity'
import {
  isSchematicPipeFlowing,
  type LiveNozzleState,
} from '../components/twin/schematic/pipeFlow'
import type { ActiveDispensingState, PipeRoute } from '../components/twin/pipe/pipeTypes'

const stationId = 'InteliPump-US-Lab'

const usLabCatalog = catalogFromPumps([
  {
    id: 'p1',
    mqttPumpId: 'pump-1',
    pumpCode: 'P1',
    nozzles: [
      {
        id: 'n1',
        nozzleCode: 'nozzle-1',
        mqttNozzleId: 'nozzle-1',
        sourceIdentifier: 'pump-1',
        nozzleNumber: 1,
      },
      {
        id: 'n2',
        nozzleCode: 'nozzle-2',
        mqttNozzleId: 'nozzle-2',
        sourceIdentifier: 'pump-2',
        nozzleNumber: 2,
      },
    ],
  },
])

function sessionFromChannel(
  channelPumpId: string,
  status: string,
  amount: number,
  volume: number,
  sequence: number,
  transactionId: string,
) {
  const ident = canonicalizeLiveIdentity(
    {
      pumpId: channelPumpId,
      nozzleId: 'nozzle-1',
      sourceIdentifier: channelPumpId,
    },
    usLabCatalog,
  )
  const expected =
    channelPumpId === 'pump-2'
      ? { pumpId: 'pump-1', nozzleId: 'nozzle-2' }
      : { pumpId: 'pump-1', nozzleId: 'nozzle-1' }
  expect(ident.pumpId).toBe(expected.pumpId)
  expect(ident.nozzleId).toBe(expected.nozzleId)

  const event: NozzleLiveEvent = {
    stationId,
    pumpId: ident.pumpId,
    nozzleId: ident.nozzleId,
    transactionId,
    status,
    amount,
    volumeLiters: volume,
    sequence,
    receivedAt: new Date().toISOString(),
  }
  return event
}

function branch(nozzleId: string): PipeRoute {
  return {
    id: `branch:c-${nozzleId}:pump-1:${nozzleId}`,
    tankId: 't1',
    pumpId: `${nozzleId}-uuid`,
    product: 'PMS',
    path: 'M 0 0 L 0 40',
    source: { x: 0, y: 0 },
    target: { x: 0, y: 40 },
    manifoldY: 20,
    status: 'IDLE',
    connection: {
      id: `c-${nozzleId}`,
      nozzleId,
      mqttNozzleId: nozzleId,
      mqttPumpId: 'pump-1',
      physicalPumpId: 'pump-1',
      isPrimary: nozzleId === 'nozzle-1',
    },
    mappingSource: 'PRIMARY',
    segmentType: 'NOZZLE_BRANCH',
    stationId,
    nozzleId,
    connectionId: `c-${nozzleId}`,
    physicalPumpId: 'pump-1',
    active: true,
  }
}

const n1 = branch('nozzle-1')
const n2 = branch('nozzle-2')
const trunk: PipeRoute = {
  id: 'trunk:t1',
  tankId: 't1',
  pumpId: n1.pumpId,
  product: 'PMS',
  path: 'M 0 0 L 0 20',
  source: { x: 0, y: 0 },
  target: { x: 0, y: 20 },
  manifoldY: 20,
  status: 'IDLE',
  connection: {},
  mappingSource: 'PRIMARY',
  segmentType: 'TANK_TRUNK',
  stationId,
  nozzleIds: ['nozzle-1', 'nozzle-2'],
  connectionIds: ['c-nozzle-1', 'c-nozzle-2'],
  active: true,
  targetNodeId: n1.pumpId,
}
const network = { branches: [n1, n2] }

function assertFlow(opts: {
  live: Record<string, ActiveDispensingState>
  trunk: boolean
  left: boolean
  right: boolean
}) {
  expect(isSchematicPipeFlowing(trunk, undefined, opts.live, network)).toBe(opts.trunk)
  expect(isSchematicPipeFlowing(n1, undefined, opts.live, network)).toBe(opts.left)
  expect(isSchematicPipeFlowing(n2, undefined, opts.live, network)).toBe(opts.right)
}

describe('video regression: Nozzle-1 ₦300 and Nozzle-2 ₦200', () => {
  it('does not clear DISPENSING with a hang-up idle timeout', () => {
    expect(HANGUP_IDLE_MS).toBe(0)
  })

  it('Scenario A — Nozzle 1 ₦300: only left branch and continuous session', () => {
    let sessions = {}
    const ticks = [
      { amount: 50, volume: 0.04, seq: 1 },
      { amount: 120, volume: 0.1, seq: 2 },
      { amount: 220, volume: 0.19, seq: 3 },
      { amount: 300, volume: 0.255, seq: 4 },
    ]
    for (const t of ticks) {
      const ev = sessionFromChannel('pump-1', 'DISPENSING', t.amount, t.volume, t.seq, 'tx-n300')
      const applied = applyNozzleEvent(sessions, ev)
      expect(applied.accepted).toBe(true)
      sessions = applied.sessions
      const s = findSession(sessions, stationId, ['pump-1'], ['nozzle-1'])
      expect(s?.state).toBe('DISPENSING')
      expect(s?.amount).toBe(t.amount)
      expect(findSession(sessions, stationId, ['pump-1'], ['nozzle-2'])?.state).not.toBe('DISPENSING')
    }

    const flowing = flowingSessions(sessions)
    expect(flowing).toHaveLength(1)
    expect(flowing[0].nozzleId).toBe('nozzle-1')

    const live: Record<string, ActiveDispensingState> = {
      [flowing[0].key]: {
        transactionId: flowing[0].transactionId!,
        pumpId: flowing[0].pumpId,
        nozzleId: flowing[0].nozzleId,
        stationId,
        tankId: 't1',
        finalVolume: Number(flowing[0].volumeLiters),
        finalAmount: Number(flowing[0].amount),
        currentVolume: Number(flowing[0].volumeLiters),
        currentAmount: Number(flowing[0].amount),
        phase: 'DISPENSING',
        startedAt: 0,
        durationMs: 1,
        connectionId: 'c-nozzle-1',
      },
    }
    assertFlow({ live, trunk: true, left: true, right: false })

    sessions = applyNozzleEvent(
      sessions,
      sessionFromChannel('pump-1', 'COMPLETED', 300, 0.255, 5, 'tx-n300'),
    ).sessions
    expect(findSession(sessions, stationId, ['pump-1'], ['nozzle-1'])?.state).toBe('COMPLETED')
    expect(flowingSessions(sessions)).toHaveLength(0)
  })

  it('Scenario B — Nozzle 2 ₦200: only right branch; pump-scoped playback must not light left', () => {
    let sessions = {}
    const ticks = [
      { amount: 40, volume: 0.03, seq: 1 },
      { amount: 110, volume: 0.09, seq: 2 },
      { amount: 200, volume: 0.17, seq: 3 },
    ]
    for (const t of ticks) {
      const ev = sessionFromChannel('pump-2', 'DISPENSING', t.amount, t.volume, t.seq, 'tx-n200')
      sessions = applyNozzleEvent(sessions, ev).sessions
      expect(findSession(sessions, stationId, ['pump-1'], ['nozzle-2'])?.state).toBe('DISPENSING')
      expect(findSession(sessions, stationId, ['pump-1'], ['nozzle-1'])?.state).not.toBe('DISPENSING')
    }

    const flowing = flowingSessions(sessions)
    expect(flowing[0].nozzleId).toBe('nozzle-2')

    // Reproduce the bug: playback keyed by physical pump with primary connection (nozzle-1)
    const buggyPlayback: ActiveDispensingState = {
      transactionId: 'tx-n200',
      pumpId: 'pump-1',
      // missing nozzleId — old playback behavior
      tankId: 't1',
      finalVolume: 0.17,
      finalAmount: 200,
      currentVolume: 0.17,
      currentAmount: 200,
      phase: 'DISPENSING',
      startedAt: 0,
      durationMs: 1,
      connectionId: 'c-nozzle-1',
    }
    // Alone, pump-scoped primary connection must NOT light nozzle-1 on multi-nozzle pump
    assertFlow({
      live: { 'pump-1': buggyPlayback },
      trunk: false,
      left: false,
      right: false,
    })

    const sessionLive: ActiveDispensingState = {
      ...buggyPlayback,
      nozzleId: 'nozzle-2',
      connectionId: 'c-nozzle-2',
    }
    assertFlow({
      live: {
        [flowing[0].key]: sessionLive,
        // Even if buggy playback is still merged, connection without nozzleId is ignored
        'pump-1-playback': buggyPlayback,
      },
      trunk: true,
      left: false,
      right: true,
    })
  })

  it('both nozzles dispensing independently', () => {
    let sessions = applyNozzleEvent(
      {},
      sessionFromChannel('pump-1', 'DISPENSING', 100, 0.08, 1, 'tx-a'),
    ).sessions
    sessions = applyNozzleEvent(
      sessions,
      sessionFromChannel('pump-2', 'DISPENSING', 80, 0.07, 1, 'tx-b'),
    ).sessions
    const flowing = flowingSessions(sessions)
    expect(flowing).toHaveLength(2)
    const live: Record<string, ActiveDispensingState> = {}
    for (const s of flowing) {
      live[s.key] = {
        transactionId: s.transactionId!,
        pumpId: s.pumpId,
        nozzleId: s.nozzleId,
        stationId,
        tankId: 't1',
        finalVolume: Number(s.volumeLiters),
        finalAmount: Number(s.amount),
        currentVolume: Number(s.volumeLiters),
        currentAmount: Number(s.amount),
        phase: 'DISPENSING',
        startedAt: 0,
        durationMs: 1,
        connectionId: s.nozzleId === 'nozzle-1' ? 'c-nozzle-1' : 'c-nozzle-2',
      }
    }
    assertFlow({ live, trunk: true, left: true, right: true })
  })

  it('resolveConnection prefers exact nozzle over primary', () => {
    const state = {
      pumps: [{ id: 'p1', mqttPumpId: 'pump-1', pumpCode: 'pump-1' }],
      connections: [
        {
          id: 'c-nozzle-1',
          pumpId: 'p1',
          mqttPumpId: 'pump-1',
          nozzleId: 'nozzle-1',
          isPrimary: true,
          tankId: 't1',
        },
        {
          id: 'c-nozzle-2',
          pumpId: 'p1',
          mqttPumpId: 'pump-1',
          nozzleId: 'nozzle-2',
          isPrimary: false,
          tankId: 't1',
        },
      ],
    }
    const conn = resolveConnection({ pumpId: 'pump-1', nozzleId: 'nozzle-2' }, state)
    expect(conn?.id).toBe('c-nozzle-2')
    expect(resolveConnection({ pumpId: 'pump-1' }, state)).toBeNull()
    expect(playbackStateKey('pump-1', 'nozzle-2')).toBe('pump-1|nozzle-2')
  })
})

describe('live nozzle state key shape', () => {
  it('uses station/pump/nozzle tokens', () => {
    const live: LiveNozzleState = {
      state: 'DISPENSING',
      activeTransactionId: 'tx',
      stationId,
      pumpId: 'pump-1',
      nozzleId: 'nozzle-2',
    }
    expect(live.nozzleId).toBe('nozzle-2')
    expect(isSchematicPipeFlowing(n2, undefined, { n2: {
      transactionId: 'tx',
      pumpId: 'pump-1',
      nozzleId: 'nozzle-2',
      tankId: 't1',
      finalVolume: 1,
      finalAmount: 1,
      currentVolume: 1,
      currentAmount: 1,
      phase: 'DISPENSING',
      startedAt: 0,
      durationMs: 1,
      connectionId: 'c-nozzle-2',
    } }, network)).toBe(true)
  })
})
