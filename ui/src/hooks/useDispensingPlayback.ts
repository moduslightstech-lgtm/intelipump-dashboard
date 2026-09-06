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

export function playbackProgress(elapsedMs: number, durationMs = PLAYBACK_MS): number {
  const t = Math.min(1, Math.max(0, elapsedMs / durationMs))
  return 1 - (1 - t) * (1 - t)
}

function resolveConnection(tx: TwinAnimTx, state: any) {
  const connections = (state?.connections || state?.tankPumpConnections || []) as Record<
    string,
    any
  >[]
  const pumps = (state?.pumps || []) as Record<string, any>[]
  const pump = pumps.find((p) => pumpMatchesId(p, tx.pumpId))
  const matches = connections.filter(
    (c) =>
      (pump && c.pumpId === pump.id) ||
      c.mqttPumpId === tx.pumpId ||
      c.pumpCode === tx.pumpId,
  )
  if (matches.length) {
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
    return byProd.find((c) => c.isPrimary) || byProd[0] || null
  }
  return null
}

/**
 * Multi-pump completed-event playback.
 * State is keyed by MQTT pumpId (slash-safe).
 */
export function useDispensingPlayback(opts: {
  stationId: string
  mqttStationId?: string | null
  stationCode?: string | null
  durationMs?: number
  enabled?: boolean
}) {
  const qc = useQueryClient()
  const durationMs = opts.durationMs ?? PLAYBACK_MS
  const dedup = useMemo(() => createRecentTransactionDedup(), [])
  const [activeByPump, setActiveByPump] = useState<Record<string, ActiveDispensingState>>({})
  const [restoredPumpIds, setRestoredPumpIds] = useState<string[]>([])
  const timersRef = useRef<Map<string, number[]>>(new Map())
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

  // Shared rAF loop updates all active count-ups from elapsed time (no drift).
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
      if (dedup.has(txId)) return
      dedup.remember(txId)

      const pumpKey = String(tx.pumpId)
      clearPumpTimers(pumpKey)

      const finalVol = Number(tx.volumeLiters || 0)
      const finalAmt = Number(tx.amount || 0)
      const startedAt = performance.now()

      let tankId = ''
      let connectionId = ''

      qc.setQueriesData({ queryKey: ['twin', 'live-state', opts.stationId] }, (old: any) => {
        if (!old) return old
        const conn = resolveConnection(tx, old)
        tankId = conn?.tankId ? String(conn.tankId) : ''
        connectionId = conn?.id ? String(conn.id) : ''

        const pumps = (old.pumps || []).map((p: any) => {
          if (!pumpMatchesId(p, tx.pumpId)) return p
          return {
            ...p,
            inferredStatus: 'DISPENSING',
            lastTransactionAmount: tx.amount ?? p.lastTransactionAmount,
            lastTransactionVolume: tx.volumeLiters ?? p.lastTransactionVolume,
            lastTransactionAt: tx.timestamp || new Date().toISOString(),
            product: tx.product || p.product,
          }
        })
        const latest = [
          {
            id: txId,
            stationId: tx.stationId,
            pumpId: tx.pumpId,
            nozzleId: tx.nozzleId,
            product: tx.product,
            volumeLiters: tx.volumeLiters,
            amount: tx.amount,
            status: tx.status || 'COMPLETED',
            receivedAt: tx.timestamp || new Date().toISOString(),
          },
          ...(old.latestTransactions || []).filter((t: any) => t.id !== txId),
        ].slice(0, 20)
        return {
          ...old,
          pumps,
          latestTransactions: latest,
          salesToday: Number(old.salesToday || 0) + Number(tx.amount || 0),
          volumeToday: Number(old.volumeToday || 0) + Number(tx.volumeLiters || 0),
          transactionCountToday: Number(old.transactionCountToday || 0) + 1,
          lastUpdatedAt: new Date().toISOString(),
        }
      })

      setActiveByPump((prev) => ({
        ...prev,
        [pumpKey]: {
          transactionId: txId,
          pumpId: pumpKey,
          tankId,
          finalVolume: finalVol,
          finalAmount: finalAmt,
          currentVolume: 0,
          currentAmount: 0,
          phase: 'DISPENSING',
          startedAt,
          durationMs,
          product: tx.product,
          connectionId,
        },
      }))

      const t1 = window.setTimeout(() => {
        setActiveByPump((prev) => {
          const cur = prev[pumpKey]
          if (!cur || cur.transactionId !== txId) return prev
          return {
            ...prev,
            [pumpKey]: {
              ...cur,
              phase: 'COMPLETED',
              currentVolume: cur.finalVolume,
              currentAmount: cur.finalAmount,
            },
          }
        })
        qc.setQueriesData({ queryKey: ['twin', 'live-state', opts.stationId] }, (old: any) => {
          if (!old) return old
          return {
            ...old,
            pumps: (old.pumps || []).map((p: any) =>
              pumpMatchesId(p, tx.pumpId) ? { ...p, inferredStatus: 'COMPLETED' } : p,
            ),
          }
        })

        const t2 = window.setTimeout(() => {
          setActiveByPump((prev) => {
            const next = { ...prev }
            if (next[pumpKey]?.transactionId === txId) delete next[pumpKey]
            return next
          })
          qc.invalidateQueries({ queryKey: ['twin', 'live-state', opts.stationId] })
        }, COMPLETED_HOLD_MS)
        timersRef.current.set(pumpKey, [t2])
      }, durationMs)

      timersRef.current.set(pumpKey, [t1])
    },
    [dedup, durationMs, matchesStation, opts.stationId, qc],
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

  // Compatibility helpers for existing ForecourtMap props
  const entries = Object.values(activeByPump)
  const primary = entries[0] || null

  return {
    activeByPump,
    activePumpIds: entries.map((e) => e.pumpId),
    activeTankIds: entries.map((e) => e.tankId).filter(Boolean),
    activeConnectionIds: entries.map((e) => e.connectionId).filter(Boolean) as string[],
    // legacy single-active fields (first active)
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
