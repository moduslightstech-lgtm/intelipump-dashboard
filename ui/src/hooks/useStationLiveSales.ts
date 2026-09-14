import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchStationDevices, type StationDevicesSummary } from '../services/deviceApi'
import { fetchRecentSales, fetchSalesSummary } from '../services/salesApi'
import {
  applySaleToSummary,
  type PumpLiveState,
  type PumpSale,
  type SalesSummary,
} from '../types/sales'
import { canonicalPumpId, warnUnmappedPump } from '../utils/pumpMatching'
import {
  canonicalizeLiveIdentity,
  type NozzleCatalogEntry,
} from '../lib/nozzleIdentity'
import {
  isHangupDuplicateSale,
  isStaleDispensingAfterComplete,
  collapseHangupDuplicates,
} from '../lib/saleDuplicates'
import {
  applyNozzleEvent,
  applyPresentationElapsed,
  markStaleSessions,
  operationalDisplay,
  COMPLETED_PRESENTATION_MS,
  sessionKey,
  type NozzleLiveEvent,
  type NozzleSession,
} from '../lib/nozzleSessions'
import { useLiveSalesStream } from './useLiveSalesStream'
import { createRecentTransactionDedup } from './useRecentTransactionDedup'

const DEFAULT_MAX_RECENT = 100
/** DigitalOcean `/v1/sales/recent` rejects limits above 500. */
export const SALES_HISTORY_FETCH_LIMIT = 500

type Opts = {
  stationId?: string | null
  /** Optional known pump telemetry ids for unmapped detection */
  configuredPumpIds?: string[]
  /** Twin catalog used to remap legacy DART channels (pump-2 → pump-1/nozzle-2). */
  nozzleCatalog?: NozzleCatalogEntry[]
  enabled?: boolean
  /** How many recent sales to keep/fetch (capped at SALES_HISTORY_FETCH_LIMIT). */
  recentLimit?: number
  onSale?: (sale: PumpSale) => void
}

/**
 * Station live data: device summary + sales summary + recent sales + SSE.
 * Load order: REST first, then SSE; dedupe by transactionId.
 */
export function useStationLiveSales(opts: Opts) {
  const stationId = opts.stationId?.trim() || ''
  const enabled = opts.enabled !== false && Boolean(stationId)
  const recentLimit = Math.min(
    Math.max(opts.recentLimit ?? DEFAULT_MAX_RECENT, 1),
    SALES_HISTORY_FETCH_LIMIT,
  )

  const [summary, setSummary] = useState<SalesSummary | null>(null)
  const [sales, setSales] = useState<PumpSale[]>([])
  const [devices, setDevices] = useState<StationDevicesSummary | null>(null)
  const [pumpLiveState, setPumpLiveState] = useState<Record<string, PumpLiveState>>({})
  const [nozzleSessions, setNozzleSessions] = useState<Record<string, NozzleSession>>({})
  const [unmappedPumpIds, setUnmappedPumpIds] = useState<string[]>([])
  const [restError, setRestError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [bootstrapped, setBootstrapped] = useState(false)

  const dedup = useRef(createRecentTransactionDedup({ max: 3000, ttlMs: 24 * 60 * 60 * 1000 }))
  const configured = useMemo(
    () => new Set((opts.configuredPumpIds || []).map(canonicalPumpId).filter(Boolean)),
    [opts.configuredPumpIds],
  )
  const nozzleCatalog = useMemo(() => opts.nozzleCatalog || [], [opts.nozzleCatalog])
  const catalogRef = useRef(nozzleCatalog)
  catalogRef.current = nozzleCatalog
  const onSaleRef = useRef(opts.onSale)
  onSaleRef.current = opts.onSale
  const recentLimitRef = useRef(recentLimit)
  recentLimitRef.current = recentLimit

  const pumpLiveRef = useRef<Record<string, PumpLiveState>>({})
  const sessionsRef = useRef<Record<string, NozzleSession>>({})

  const countedCompleted = useRef(new Set<string>())

  const saleToEvent = (sale: PumpSale): NozzleLiveEvent => {
    const ident = canonicalizeLiveIdentity(
      {
        pumpId: sale.pumpId,
        nozzleId: sale.nozzleId,
        sourceIdentifier: sale.sourceIdentifier,
      },
      catalogRef.current,
    )
    if (
      typeof localStorage !== 'undefined' &&
      localStorage.getItem('INTELIPUMP_DEBUG_LIVE') === '1' &&
      (ident.receivedPumpId !== ident.pumpId || ident.receivedNozzleId !== ident.nozzleId)
    ) {
      // eslint-disable-next-line no-console
      console.debug('[intelipump-live] canonicalize', {
        receivedPump: ident.receivedPumpId,
        receivedNozzle: ident.receivedNozzleId,
        normalizedPump: ident.pumpId,
        normalizedNozzle: ident.nozzleId,
        sourceIdentifier: ident.sourceIdentifier,
        mapped: ident.mapped,
        warning: ident.mappingWarning,
        transactionId: sale.transactionId,
      })
    }
    return {
      stationId: sale.stationId,
      pumpId: ident.pumpId || sale.pumpId,
      nozzleId: ident.nozzleId,
      sourceIdentifier: ident.sourceIdentifier || sale.sourceIdentifier,
      transactionId: sale.transactionId,
      status: sale.status,
      eventType: sale.eventType,
      amount: sale.amount,
      volumeLiters: sale.volumeLiters,
      pricePerLiter: sale.pricePerLiter,
      product: sale.product,
      sequence: sale.sequence,
      startedAt: sale.startedAt,
      completedAt: sale.completedAt,
      receivedAt: sale.receivedAt,
      occurredAt: sale.receivedAt,
      mappingWarning: sale.mappingWarning || ident.mappingWarning,
    }
  }

  const syncPumpLiveFromSessions = (sessions: Record<string, NozzleSession>) => {
    // Build nozzle-scoped rows first. Never let the last nozzle overwrite a
    // shared pump-level dispensing flag used by the other hose.
    const next: Record<string, PumpLiveState> = {}
    const byPump = new Map<string, NozzleSession[]>()

    for (const session of Object.values(sessions)) {
      const pumpKey = canonicalPumpId(session.pumpId)
      const list = byPump.get(pumpKey) || []
      list.push(session)
      byPump.set(pumpKey, list)

      const display = operationalDisplay(session)
      const latest: PumpSale = {
        transactionId: session.transactionId || session.lastCompleted?.transactionId || '',
        stationId: session.stationId,
        pumpId: session.pumpId,
        nozzleId: session.nozzleId,
        product: session.product,
        volumeLiters: session.volumeLiters,
        amount: session.amount,
        currency: 'NGN',
        pricePerLiter: session.pricePerLiter,
        status: display === 'SALE_COMPLETED' ? 'SALE_COMPLETED' : session.state,
        sourceTopic: null,
        receivedAt: session.lastUpdateAt || new Date().toISOString(),
        sequence: session.sequence,
      }
      const row: PumpLiveState = {
        pumpId: session.pumpId,
        latestSale: latest.transactionId ? latest : null,
        lastSaleAt: session.lastUpdateAt,
        todaySalesAmount: 0,
        todayVolumeLiters: 0,
        todayTransactionCount: 0,
        liveActivityStatus: session.state === 'DISPENSING' ? 'ACTIVE' : 'IDLE',
        isRecentlyActive: session.state === 'DISPENSING',
      }
      // Prefer stable station|pump|nozzle key; also index by nozzle id for legacy readers.
      next[session.key || sessionKey(session.stationId, session.pumpId, session.nozzleId)] = {
        ...row,
      }
      if (session.nozzleId && session.nozzleId !== 'unknown') {
        next[canonicalPumpId(session.nozzleId)] = { ...row }
      }
    }

    for (const [pumpKey, list] of byPump) {
      const prev = pumpLiveRef.current[pumpKey]
      const dispensing = list.filter((s) => s.state === 'DISPENSING')
      const focus =
        dispensing.sort((a, b) => b.sequence - a.sequence)[0] ||
        [...list].sort((a, b) => b.sequence - a.sequence)[0]
      const display = operationalDisplay(focus)
      const latest: PumpSale | null = focus
        ? {
            transactionId: focus.transactionId || focus.lastCompleted?.transactionId || '',
            stationId: focus.stationId,
            pumpId: focus.pumpId,
            nozzleId: focus.nozzleId,
            product: focus.product,
            volumeLiters: focus.volumeLiters,
            amount: focus.amount,
            currency: 'NGN',
            pricePerLiter: focus.pricePerLiter,
            status: display === 'SALE_COMPLETED' ? 'SALE_COMPLETED' : focus.state,
            sourceTopic: null,
            receivedAt: focus.lastUpdateAt || new Date().toISOString(),
            sequence: focus.sequence,
          }
        : null
      next[pumpKey] = {
        pumpId: focus?.pumpId || pumpKey,
        latestSale: latest?.transactionId ? latest : null,
        lastSaleAt: focus?.lastUpdateAt || prev?.lastSaleAt || null,
        todaySalesAmount: prev?.todaySalesAmount ?? 0,
        todayVolumeLiters: prev?.todayVolumeLiters ?? 0,
        todayTransactionCount: prev?.todayTransactionCount ?? 0,
        // Pump-level activity is aggregate only — UI must still key off nozzleId.
        liveActivityStatus: dispensing.length ? 'ACTIVE' : 'IDLE',
        isRecentlyActive: dispensing.length > 0,
      }
    }

    pumpLiveRef.current = next
    setPumpLiveState(next)
  }

  const ingestSale = useCallback(
    (sale: PumpSale, optsIngest?: { fromRest?: boolean }) => {
      const isNew = !dedup.current.has(sale.transactionId)
      const status = String(sale.status || '').toUpperCase()
      const eventType = String(sale.eventType || '').toUpperCase()
      const isIncident =
        status === 'POSSIBLE_UNINTENDED_FLOW' ||
        status === 'CANCELLED_NO_SALE' ||
        eventType.includes('POSSIBLE_UNINTENDED_FLOW') ||
        eventType.includes('CANCELLED_NO_SALE')
      const isComplete =
        !isIncident &&
        (status === 'COMPLETED' ||
          status === 'COMPLETE' ||
          eventType.includes('TRANSACTION_COMPLETED') ||
          eventType.includes('FILLING_COMPLETED'))
      const inProgress =
        !isIncident &&
        (status === 'DISPENSING' ||
          status === 'IN_PROGRESS' ||
          status === 'ACTIVE' ||
          eventType.includes('FILLING_UPDATED') ||
          eventType.includes('TRANSACTION_STARTED') ||
          eventType.includes('VERIFIED_DISPENSING') ||
          eventType === 'PROGRESS')
      // Ready (lift/authorize) — update nozzle presentation only; not a sale.
      const isReady =
        !isIncident &&
        !inProgress &&
        !isComplete &&
        (status === 'READY' ||
          status === 'AUTHORIZED' ||
          eventType.includes('NOZZLE_LIFTED') ||
          eventType.includes('AUTHORIZED'))
      if (isComplete || (!inProgress && !isReady)) dedup.current.remember(sale.transactionId)

      if (isIncident) {
        const appliedIncident = applyNozzleEvent(
          sessionsRef.current,
          saleToEvent(sale),
          optsIngest?.fromRest ? 'rest' : 'sse',
        )
        if (appliedIncident.accepted) {
          sessionsRef.current = appliedIncident.sessions
          setNozzleSessions(appliedIncident.sessions)
          syncPumpLiveFromSessions(appliedIncident.sessions)
        }
        // Admin alert only — never add to recent sales or financial totals.
        if (typeof window !== 'undefined' && status === 'POSSIBLE_UNINTENDED_FLOW') {
          window.dispatchEvent(
            new CustomEvent('intelipump:admin-alert', {
              detail: {
                type: 'POSSIBLE_UNINTENDED_FLOW',
                stationId: sale.stationId,
                pumpId: sale.pumpId,
                nozzleId: sale.nozzleId,
                amount: sale.amount,
                volumeLiters: sale.volumeLiters,
                message: 'Possible unintended flow — review required (not counted as a sale)',
              },
            }),
          )
        }
        return true
      }

      const key = canonicalPumpId(sale.pumpId)
      const prevLive = pumpLiveRef.current[key]
      const hangupDup = Boolean(
        prevLive?.latestSale && isHangupDuplicateSale(prevLive.latestSale, sale),
      )
      if (isStaleDispensingAfterComplete(prevLive?.latestSale, sale)) {
        return true
      }
      const applied = applyNozzleEvent(
        sessionsRef.current,
        saleToEvent(sale),
        optsIngest?.fromRest ? 'rest' : 'sse',
      )
      if (applied.accepted) {
        sessionsRef.current = applied.sessions
        setNozzleSessions(applied.sessions)
        syncPumpLiveFromSessions(applied.sessions)
      } else if (optsIngest?.fromRest) {
        return true
      } else {
        syncPumpLiveFromSessions(sessionsRef.current)
      }

      setSales((prev) => {
        const hangupOf = prev.find((s) => isHangupDuplicateSale(s, sale))
        const dropIds = new Set(
          [sale.transactionId, hangupOf?.transactionId].filter(Boolean) as string[],
        )
        const without = prev.filter((s) => !dropIds.has(s.transactionId))
        const kept = hangupOf
          ? { ...hangupOf, ...sale, transactionId: hangupOf.transactionId }
          : sale
        if (!isComplete && inProgress) {
          const existing = without.find((s) => s.transactionId === sale.transactionId)
          if (existing) {
            return [{ ...existing, ...sale }, ...without.filter((s) => s.transactionId !== sale.transactionId)].slice(
              0,
              recentLimitRef.current,
            )
          }
          return [sale, ...without].slice(0, recentLimitRef.current)
        }
        return [kept, ...without.filter((s) => s.transactionId !== sale.transactionId)].slice(
          0,
          recentLimitRef.current,
        )
      })

      if (
        !optsIngest?.fromRest &&
        isComplete &&
        !hangupDup &&
        !countedCompleted.current.has(sale.transactionId)
      ) {
        countedCompleted.current.add(sale.transactionId)
        setSummary((current) => (current ? applySaleToSummary(current, sale) : current))
      }

      if (configured.size > 0 && !configured.has(key) && !configured.has(canonicalPumpId(sale.nozzleId || ''))) {
        warnUnmappedPump(sale.pumpId)
        setUnmappedPumpIds((prev) =>
          prev.includes(sale.pumpId) ? prev : [...prev, sale.pumpId],
        )
      }

      if (!optsIngest?.fromRest && !hangupDup && (isComplete || (inProgress && isNew))) {
        if (isComplete) onSaleRef.current?.(sale)
      }
      return true
    },
    [configured, stationId],
  )

  const loadRest = useCallback(async () => {
    if (!stationId) return
    const ac = new AbortController()
    setIsLoading(true)
    try {
      const [dev, sum, recent] = await Promise.all([
        fetchStationDevices(stationId, ac.signal),
        fetchSalesSummary(stationId, ac.signal),
        fetchRecentSales(stationId, { limit: recentLimit, signal: ac.signal }),
      ])
      setDevices(dev)
      setSummary(sum)
      setRestError(null)

      // Reset pump recent aggregates from limited recent feed (label as recent, not full day)
      const recentSales = collapseHangupDuplicates(recent.sales)
      let merged = { ...sessionsRef.current }
      for (const sale of [...recentSales].reverse()) {
        const st = String(sale.status || '').toUpperCase()
        if (st === 'COMPLETED' || st === 'COMPLETE') {
          countedCompleted.current.add(sale.transactionId)
          dedup.current.remember(sale.transactionId)
        }
        const applied = applyNozzleEvent(merged, saleToEvent(sale), 'rest')
        if (applied.accepted) merged = applied.sessions
        if (configured.size > 0 && !configured.has(canonicalPumpId(sale.pumpId))) {
          warnUnmappedPump(sale.pumpId)
          setUnmappedPumpIds((p) => (p.includes(sale.pumpId) ? p : [...p, sale.pumpId]))
        }
      }
      sessionsRef.current = merged
      setNozzleSessions(merged)
      syncPumpLiveFromSessions(merged)
      setSales(recentSales.slice(0, recentLimit))
      setBootstrapped(true)
    } catch (err) {
      // Preserve previous successful values
      setRestError(err instanceof Error ? err.message : 'Unable to load current sales data.')
    } finally {
      setIsLoading(false)
    }
  }, [configured, recentLimit, stationId])

  useEffect(() => {
    if (!enabled) {
      setBootstrapped(false)
      return
    }
    dedup.current.clear()
    countedCompleted.current.clear()
    pumpLiveRef.current = {}
    sessionsRef.current = {}
    setNozzleSessions({})
    setUnmappedPumpIds([])
    setPumpLiveState({})
    setSales([])
    setSummary(null)
    setDevices(null)
    void loadRest()
  }, [enabled, stationId, loadRest])

  useEffect(() => {
    const t = window.setInterval(() => {
      const stale = markStaleSessions(sessionsRef.current)
      let next = stale
      for (const session of Object.values(stale)) {
        if (!session.completedAtMs) continue
        if (Date.now() - session.completedAtMs < COMPLETED_PRESENTATION_MS) continue
        next = applyPresentationElapsed(next, session.key)
      }
      if (next !== sessionsRef.current) {
        sessionsRef.current = next
        setNozzleSessions(next)
        syncPumpLiveFromSessions(next)
      }
    }, 500)
    return () => window.clearInterval(t)
  }, [])

  const stream = useLiveSalesStream({
    stationId: enabled && bootstrapped ? stationId : null,
    enabled: enabled && bootstrapped,
    onSale: (sale) => {
      ingestSale(sale)
    },
    onSnapshot: (sales) => {
      for (const sale of sales) ingestSale(sale, { fromRest: true })
    },
    onReconnectRefresh: () => {
      void loadRest()
    },
  })

  const primaryDevice = devices?.devices?.[0] || null

  return {
    stationId,
    summary,
    sales,
    devices,
    primaryDevice,
    pumpLiveState,
    nozzleSessions,
    unmappedPumpIds,
    restError,
    isLoading,
    bootstrapped,
    refresh: loadRest,
    ingestSale,
    streamStatus: stream.streamStatus,
    lastStreamHeartbeatAt: stream.lastStreamHeartbeatAt,
    lastEventAt: stream.lastEventAt,
    streamError: stream.lastError,
  }
}
