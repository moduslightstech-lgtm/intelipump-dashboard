import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { apiUrls } from '../config/api'
import { parseSaleCreatedEvent } from '../types/sales'
import { pumpMatchesId } from '../lib/pumpIdentity'
import type { ActiveDispensingState } from '../components/twin/pipe/pipeTypes'
import { createRecentTransactionDedup } from './useRecentTransactionDedup'

export type TwinAnimTx = {
  transactionId?: string
  stationId?: string
  pumpId?: string
  nozzleId?: string
  product?: string
  volumeLiters?: number
  amount?: number
  currency?: string
  status?: string
  timestamp?: string
}

export const PLAYBACK_MS = 3000
const COMPLETED_HOLD_MS = 1000

/**
 * @deprecated Hang-up idle timeouts caused Idle↔Dispensing flicker when fill
 * ticks arrived more than a few seconds apart. Live nozzle sessions are the
 * source of truth for operational twin; do not reintroduce short timers that
 * clear DISPENSING between meter updates.
 */
export const HANGUP_IDLE_MS = 0

export function playbackProgress(elapsedMs: number, durationMs = PLAYBACK_MS): number {
  const t = Math.min(1, Math.max(0, elapsedMs / durationMs))
  return 1 - (1 - t) * (1 - t)
}

export function playbackStateKey(pumpId: string, nozzleId?: string | null): string {
  const pump = String(pumpId || '').trim()
  const nozzle = String(nozzleId || '').trim()
  return nozzle ? `${pump}|${nozzle}` : pump
}

/** Prefer the connection for the exact nozzle; never fall back to an unrelated primary. */
export function resolveConnection(tx: TwinAnimTx, state: any) {
  const connections = (state?.connections || state?.tankPumpConnections || []) as Record<
    string,
    any
  >[]
  const pumps = (state?.pumps || []) as Record<string, any>[]
  const pump = pumps.find((p) => pumpMatchesId(p, tx.pumpId))
  const nozzleToken = String(tx.nozzleId || '').trim()
  const matches = connections.filter((c) => {
    const pumpMatch =
      (pump && (c.pumpId === pump.id || c.physicalPumpId === pump.id)) ||
      c.mqttPumpId === tx.pumpId ||
      c.pumpCode === tx.pumpId ||
      c.physicalPumpId === tx.pumpId
    if (!pumpMatch) return false
    if (!nozzleToken) return true
    const nozzleIds = [c.nozzleId, c.mqttNozzleId, c.nozzleCode, c.destinationNozzleId, c.sourceIdentifier]
      .map((v) => String(v || '').trim())
      .filter(Boolean)
    return nozzleIds.includes(nozzleToken)
  })
  if (nozzleToken && matches.length) {
    return matches[0]
  }
  if (matches.length && !nozzleToken) {
    const nozzles = [
      ...new Set(
        matches
          .map((c) => String(c.nozzleId || c.mqttNozzleId || c.nozzleCode || '').trim())
          .filter(Boolean),
      ),
    ]
    // Ambiguous multi-nozzle pump without nozzleId → do not guess primary.
    if (nozzles.length > 1) return null
    return (
      matches.find((c) => c.isPrimary) ||
      [...matches].sort((a, b) =>
        String(a.tankId || '').localeCompare(String(b.tankId || '')),
      )[0]
    )
  }
  if (tx.product) {
    const prod = tx.product.toUpperCase()
    const byProd = connections.filter((c) => (c.product || '').toUpperCase() === prod)
    if (nozzleToken) {
      const exact = byProd.filter((c) =>
        [c.nozzleId, c.mqttNozzleId, c.nozzleCode]
          .map((v) => String(v || '').trim())
          .includes(nozzleToken),
      )
      return exact[0] || null
    }
    return byProd.find((c) => c.isPrimary) || byProd[0] || null
  }
  return null
}

/**
 * Optional completed-event playback for legacy map/list chrome.
 * Operational twin pipes/hoses/LCD must use nozzle sessions — not this hook.
 * In-progress sales no longer auto-clear via hang-up timeout.
 */
export function useDispensingPlayback(opts: {
  stationId: string
  mqttStationId?: string | null
  stationCode?: string | null
  durationMs?: number
  enabled?: boolean
}) {
  const qc = useQueryClient()
  const dedup = useMemo(() => createRecentTransactionDedup(), [])
  const [activeByPump, setActiveByPump] = useState<Record<string, ActiveDispensingState>>({})
  const [restoredPumpIds] = useState<string[]>([])
  const timersRef = useRef<Map<string, number[]>>(new Map())
  const completedLatch = useRef<Map<string, { amount: number; volume: number; at: number }>>(
    new Map(),
  )
  const rafRef = useRef<number | null>(null)

  const clearPumpTimers = (pumpKey: string) => {
    const list = timersRef.current.get(pumpKey) || []
    list.forEach((id) => window.clearTimeout(id))
    timersRef.current.delete(pumpKey)
  }

  const matchesStation = useCallback(
    (payloadStationId?: string) => {
      if (!payloadStationId) return false
      const keys = [opts.stationId, opts.mqttStationId, opts.stationCode].filter(Boolean)
      return keys.some((k) => String(k) === String(payloadStationId))
    },
    [opts.stationId, opts.mqttStationId, opts.stationCode],
  )

  useEffect(() => {
    const tick = () => {
      setActiveByPump((prev) => {
        const keys = Object.keys(prev)
        if (!keys.length) return prev
        let changed = false
        const next: Record<string, ActiveDispensingState> = { ...prev }
        for (const k of keys) {
          const s = next[k]
          if (s.phase !== 'DISPENSING') continue
          const elapsed = performance.now() - s.startedAt
          const p = playbackProgress(elapsed, s.durationMs)
          const vol = s.finalVolume * p
          const amt = s.finalAmount * p
          if (vol !== s.currentVolume || amt !== s.currentAmount) {
            next[k] = { ...s, currentVolume: vol, currentAmount: amt }
            changed = true
          }
        }
        return changed ? next : prev
      })
      rafRef.current = window.requestAnimationFrame(tick)
    }
    rafRef.current = window.requestAnimationFrame(tick)
    return () => {
      if (rafRef.current != null) window.cancelAnimationFrame(rafRef.current)
    }
  }, [])

  const trigger = useCallback(
    (tx: TwinAnimTx) => {
      if (!matchesStation(tx.stationId)) return
      if (!tx.pumpId) return

      const txId = tx.transactionId || `${tx.pumpId}:${tx.timestamp}:${tx.amount}`
      const nozzleId = tx.nozzleId ? String(tx.nozzleId).trim() : undefined
      const stateKey = playbackStateKey(String(tx.pumpId), nozzleId)
      const status = String(tx.status || '').toUpperCase()
      const inProgress =
        status === 'DISPENSING' || status === 'IN_PROGRESS' || status === 'ACTIVE'
      const isComplete = status === 'COMPLETED' || status === 'COMPLETE'

      const finalVol = Number(tx.volumeLiters || 0)
      const finalAmt = Number(tx.amount || 0)
      const latch = completedLatch.current.get(stateKey)
      const staleAfterComplete = Boolean(
        inProgress &&
          latch &&
          Number(latch.amount) === finalAmt &&
          Number(latch.volume) === finalVol &&
          Date.now() - latch.at < 120_000,
      )
      if (staleAfterComplete) return

      let tankId = ''
      let connectionId = ''
      qc.setQueriesData({ queryKey: ['twin', 'live-state', opts.stationId] }, (old: any) => {
        if (!old) return old
        const conn = resolveConnection(tx, old)
        tankId = conn?.tankId ? String(conn.tankId) : ''
        connectionId = conn?.id ? String(conn.id) : ''
        // Do not mutate pump-level inferredStatus — that flickered Idle↔Dispensing
        // for the whole cabinet and mis-marked sibling nozzles.
        return old
      })

      const finishPump = (markCompleted: boolean) => {
        if (markCompleted) {
          completedLatch.current.set(stateKey, {
            amount: finalAmt,
            volume: finalVol,
            at: Date.now(),
          })
        }
        setActiveByPump((prev) => {
          const cur = prev[stateKey]
          if (!cur) return prev
          return {
            ...prev,
            [stateKey]: {
              ...cur,
              phase: 'COMPLETED',
              currentVolume: cur.finalVolume,
              currentAmount: cur.finalAmount,
            },
          }
        })
        clearPumpTimers(stateKey)
        const t2 = window.setTimeout(() => {
          setActiveByPump((prev) => {
            const next = { ...prev }
            delete next[stateKey]
            return next
          })
        }, COMPLETED_HOLD_MS)
        timersRef.current.set(stateKey, [t2])
      }

      if (inProgress) {
        // Persist DISPENSING until an explicit COMPLETED event — never auto-clear
        // between irregular meter ticks.
        clearPumpTimers(stateKey)
        setActiveByPump((prev) => {
          const cur = prev[stateKey]
          if (
            cur &&
            cur.transactionId !== txId &&
            Number(cur.finalAmount) === finalAmt &&
            Number(cur.finalVolume) === finalVol
          ) {
            return prev
          }
          // Refuse pump-scoped in-progress when nozzle is unknown on multi-nozzle pumps
          if (!nozzleId && !connectionId) {
            return prev
          }
          return {
            ...prev,
            [stateKey]: {
              transactionId: txId,
              pumpId: String(tx.pumpId),
              nozzleId,
              stationId: tx.stationId,
              tankId: tankId || cur?.tankId || '',
              finalVolume: finalVol,
              finalAmount: finalAmt,
              currentVolume: finalVol,
              currentAmount: finalAmt,
              phase: 'DISPENSING',
              startedAt: cur?.transactionId === txId ? cur.startedAt : performance.now(),
              durationMs: 1,
              product: tx.product,
              connectionId: connectionId || cur?.connectionId,
              mappingWarning: nozzleId ? undefined : 'Missing tank/nozzle mapping',
            },
          }
        })
        return
      }

      if (isComplete) {
        dedup.remember(txId)
        finishPump(true)
        return
      }
    },
    [dedup, matchesStation, opts.stationId, qc],
  )

  useEffect(() => {
    if (opts.enabled === false || !opts.stationId) return
    const streamStation =
      opts.mqttStationId?.trim() || opts.stationCode?.trim() || opts.stationId
    if (!streamStation) return

    let cancelled = false
    let es: EventSource | null = null
    const timer = window.setTimeout(() => {
      if (cancelled) return
      es = new EventSource(apiUrls.eventsStream(streamStation))
      const onSale = (ev: MessageEvent) => {
        try {
          const parsed = parseSaleCreatedEvent(JSON.parse(String(ev.data)))
          if (!parsed) return
          const sale = parsed.transaction
          trigger({
            transactionId: sale.transactionId,
            stationId: sale.stationId,
            pumpId: sale.pumpId,
            nozzleId: sale.nozzleId || undefined,
            product: sale.product || undefined,
            volumeLiters: sale.volumeLiters ?? undefined,
            amount: sale.amount ?? undefined,
            currency: sale.currency,
            status: sale.status || undefined,
            timestamp: sale.receivedAt,
          })
        } catch {
          /* ignore */
        }
      }
      es.addEventListener('sale.created', onSale as EventListener)
    }, 0)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
      es?.close()
      for (const ids of timersRef.current.values()) ids.forEach((id) => window.clearTimeout(id))
      timersRef.current.clear()
    }
  }, [opts.enabled, opts.mqttStationId, opts.stationCode, opts.stationId, trigger])

  const entries = Object.values(activeByPump)
  const primary = entries[0] || null

  return {
    activeByPump,
    activePumpIds: entries.map((e) => e.pumpId),
    activeTankIds: entries.map((e) => e.tankId).filter(Boolean),
    activeConnectionIds: entries.map((e) => e.connectionId).filter(Boolean) as string[],
    activePumpId: primary?.pumpId ?? null,
    activeTankId: primary?.tankId ?? null,
    activeConnectionId: primary?.connectionId ?? null,
    liveVolume: primary?.currentVolume ?? 0,
    liveAmount: primary?.currentAmount ?? 0,
    phase:
      primary?.phase === 'DISPENSING'
        ? ('pulse' as const)
        : primary?.phase === 'COMPLETED'
          ? ('completed' as const)
          : ('idle' as const),
    flashTx: primary
      ? {
          pumpId: primary.pumpId,
          amount: primary.currentAmount,
          volumeLiters: primary.currentVolume,
          product: primary.product,
        }
      : null,
    restoredPumpIds,
    trigger,
  }
}

/** @deprecated use useDispensingPlayback — re-export for tests/compat */
export const useTwinTransactionAnimation = useDispensingPlayback
