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
import { useLiveSalesStream } from './useLiveSalesStream'
import { createRecentTransactionDedup } from './useRecentTransactionDedup'

const RECENT_ACTIVE_MS = 8_000
const DEFAULT_MAX_RECENT = 100
/** DigitalOcean `/v1/sales/recent` rejects limits above 500. */
export const SALES_HISTORY_FETCH_LIMIT = 500

type Opts = {
  stationId?: string | null
  /** Optional known pump telemetry ids for unmapped detection */
  configuredPumpIds?: string[]
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
  const [unmappedPumpIds, setUnmappedPumpIds] = useState<string[]>([])
  const [restError, setRestError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [bootstrapped, setBootstrapped] = useState(false)

  const dedup = useRef(createRecentTransactionDedup({ max: 3000, ttlMs: 24 * 60 * 60 * 1000 }))
  const configured = useMemo(
    () => new Set((opts.configuredPumpIds || []).map(canonicalPumpId).filter(Boolean)),
    [opts.configuredPumpIds],
  )
  const onSaleRef = useRef(opts.onSale)
  onSaleRef.current = opts.onSale
  const recentLimitRef = useRef(recentLimit)
  recentLimitRef.current = recentLimit

  const clearRecentTimer = useRef<Map<string, number>>(new Map())

  const ingestSale = useCallback(
    (sale: PumpSale, optsIngest?: { fromRest?: boolean }) => {
      if (sale.stationId !== stationId) return false
      if (dedup.current.has(sale.transactionId)) return false
      dedup.current.remember(sale.transactionId)

      const key = canonicalPumpId(sale.pumpId)
      setSales((prev) => {
        const without = prev.filter((s) => s.transactionId !== sale.transactionId)
        return [sale, ...without].slice(0, recentLimitRef.current)
      })

      if (!optsIngest?.fromRest) {
        setSummary((current) => (current ? applySaleToSummary(current, sale) : current))
      }

      setPumpLiveState((current) => {
        const prev = current[key]
        return {
          ...current,
          [key]: {
            pumpId: sale.pumpId,
            latestSale: sale,
            lastSaleAt: sale.receivedAt,
            todaySalesAmount: (prev?.todaySalesAmount ?? 0) + (sale.amount ?? 0),
            todayVolumeLiters: (prev?.todayVolumeLiters ?? 0) + (sale.volumeLiters ?? 0),
            todayTransactionCount: (prev?.todayTransactionCount ?? 0) + 1,
            liveActivityStatus: 'ACTIVE',
            isRecentlyActive: !optsIngest?.fromRest,
          },
        }
      })

      if (!optsIngest?.fromRest) {
        const existing = clearRecentTimer.current.get(key)
        if (existing) window.clearTimeout(existing)
        const t = window.setTimeout(() => {
          setPumpLiveState((cur) => {
            const row = cur[key]
            if (!row) return cur
            return {
              ...cur,
              [key]: { ...row, isRecentlyActive: false, liveActivityStatus: 'IDLE' },
            }
          })
        }, RECENT_ACTIVE_MS)
        clearRecentTimer.current.set(key, t)
      }

      if (configured.size > 0 && !configured.has(key)) {
        warnUnmappedPump(sale.pumpId)
        setUnmappedPumpIds((prev) =>
          prev.includes(sale.pumpId) ? prev : [...prev, sale.pumpId],
        )
      }

      if (!optsIngest?.fromRest) onSaleRef.current?.(sale)
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
      const nextPumps: Record<string, PumpLiveState> = {}
      for (const sale of [...recent.sales].reverse()) {
        if (sale.stationId !== stationId) continue
        dedup.current.remember(sale.transactionId)
        const key = canonicalPumpId(sale.pumpId)
        const prev = nextPumps[key]
        nextPumps[key] = {
          pumpId: sale.pumpId,
          latestSale: sale,
          lastSaleAt: sale.receivedAt,
          todaySalesAmount: (prev?.todaySalesAmount ?? 0) + (sale.amount ?? 0),
          todayVolumeLiters: (prev?.todayVolumeLiters ?? 0) + (sale.volumeLiters ?? 0),
          todayTransactionCount: (prev?.todayTransactionCount ?? 0) + 1,
          liveActivityStatus: 'IDLE',
          isRecentlyActive: false,
        }
        if (configured.size > 0 && !configured.has(key)) {
          warnUnmappedPump(sale.pumpId)
          setUnmappedPumpIds((p) => (p.includes(sale.pumpId) ? p : [...p, sale.pumpId]))
        }
      }
      setPumpLiveState(nextPumps)
      setSales(recent.sales.slice(0, recentLimit))
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
    setUnmappedPumpIds([])
    setPumpLiveState({})
    setSales([])
    setSummary(null)
    setDevices(null)
    void loadRest()
    return () => {
      for (const t of clearRecentTimer.current.values()) window.clearTimeout(t)
      clearRecentTimer.current.clear()
    }
  }, [enabled, stationId, loadRest])

  const stream = useLiveSalesStream({
    stationId: enabled && bootstrapped ? stationId : null,
    enabled: enabled && bootstrapped,
    onSale: (sale) => {
      ingestSale(sale)
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
