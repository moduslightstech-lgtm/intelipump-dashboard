import { useEffect, useRef, useState } from 'react'
import { apiUrls } from '../config/api'
import {
  parseSaleCreatedEvent,
  type LiveStreamStatus,
  type PumpSale,
} from '../types/sales'
import { createRecentTransactionDedup } from './useRecentTransactionDedup'

type Opts = {
  stationId?: string | null
  enabled?: boolean
  onSale?: (sale: PumpSale) => void
  onConnected?: () => void
  onHeartbeat?: (timestamp: string) => void
  onReconnectRefresh?: () => void
}

/**
 * Station-level SSE for live sales.
 * Device (Pi) online status must NOT be derived from this stream.
 */
export function useLiveSalesStream(opts: Opts) {
  const stationId = opts.stationId?.trim() || ''
  const enabled = opts.enabled !== false && Boolean(stationId)

  const [streamStatus, setStreamStatus] = useState<LiveStreamStatus>('DISCONNECTED')
  const [lastStreamHeartbeatAt, setLastStreamHeartbeatAt] = useState<string | null>(null)
  const [lastEventAt, setLastEventAt] = useState<string | null>(null)
  const [lastError, setLastError] = useState<string | null>(null)

  const onSaleRef = useRef(opts.onSale)
  const onConnectedRef = useRef(opts.onConnected)
  const onHeartbeatRef = useRef(opts.onHeartbeat)
  const onReconnectRefreshRef = useRef(opts.onReconnectRefresh)
  onSaleRef.current = opts.onSale
  onConnectedRef.current = opts.onConnected
  onHeartbeatRef.current = opts.onHeartbeat
  onReconnectRefreshRef.current = opts.onReconnectRefresh

  const dedup = useRef(createRecentTransactionDedup({ max: 2000, ttlMs: 24 * 60 * 60 * 1000 }))
  const hadConnected = useRef(false)

  useEffect(() => {
    if (!enabled) {
      setStreamStatus('DISCONNECTED')
      return
    }

    let cancelled = false
    let es: EventSource | null = null
    // StrictMode: delay open slightly and cancel on cleanup before connect
    const openTimer = window.setTimeout(() => {
      if (cancelled) return
      setStreamStatus('CONNECTING')
      setLastError(null)
      es = new EventSource(apiUrls.eventsStream(stationId))

      const markLive = (ts?: string) => {
        setStreamStatus('LIVE')
        const when = ts || new Date().toISOString()
        setLastEventAt(when)
      }

      es.addEventListener('connected', (ev) => {
        try {
          const data = JSON.parse(String((ev as MessageEvent).data || '{}'))
          markLive(data.timestamp)
          if (hadConnected.current) {
            onReconnectRefreshRef.current?.()
          }
          hadConnected.current = true
          onConnectedRef.current?.()
        } catch {
          markLive()
          onConnectedRef.current?.()
        }
      })

      es.addEventListener('heartbeat', (ev) => {
        try {
          const data = JSON.parse(String((ev as MessageEvent).data || '{}'))
          const ts = String(data.timestamp || new Date().toISOString())
          setLastStreamHeartbeatAt(ts)
          markLive(ts)
          onHeartbeatRef.current?.(ts)
        } catch {
          const ts = new Date().toISOString()
          setLastStreamHeartbeatAt(ts)
          markLive(ts)
        }
      })

      es.addEventListener('sale.created', (ev) => {
        try {
          const parsed = parseSaleCreatedEvent(JSON.parse(String((ev as MessageEvent).data)))
          if (!parsed) return
          const sale = parsed.transaction
          if (sale.stationId !== stationId) {
            if (import.meta.env.DEV) {
              console.warn('Ignoring sale for mismatched station', sale.stationId, stationId)
            }
            return
          }
          if (dedup.current.has(sale.transactionId)) return
          dedup.current.remember(sale.transactionId)
          markLive(sale.receivedAt)
          onSaleRef.current?.(sale)
        } catch {
          /* ignore malformed */
        }
      })

      es.addEventListener('stream.error', (ev) => {
        try {
          const data = JSON.parse(String((ev as MessageEvent).data || '{}'))
          setLastError(String(data.message || data.error || 'stream.error'))
        } catch {
          setLastError('stream.error')
        }
        setStreamStatus('ERROR')
      })

      es.onerror = () => {
        // Let EventSource reconnect; do not close.
        setStreamStatus((prev) => (prev === 'LIVE' || prev === 'CONNECTING' ? 'RECONNECTING' : prev))
      }
    }, 0)

    return () => {
      cancelled = true
      window.clearTimeout(openTimer)
      es?.close()
      setStreamStatus('DISCONNECTED')
    }
  }, [enabled, stationId])

  return {
    streamStatus,
    lastStreamHeartbeatAt,
    lastEventAt,
    lastError,
    seenTransaction: (id: string) => dedup.current.has(id),
    rememberTransaction: (id: string) => dedup.current.remember(id),
    clearDedup: () => dedup.current.clear(),
  }
}
