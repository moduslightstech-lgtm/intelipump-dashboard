import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchDeviceStatus } from '../services/deviceApi'
import type { EdgeDeviceStatus } from '../types/edgeDevice'

type Opts = {
  deviceId?: string | null
  pollingIntervalMs?: number
  enabled?: boolean
}

/**
 * Raspberry Pi heartbeat polling — separate from SSE dashboard stream heartbeat.
 */
export function useDeviceHeartbeat(opts: Opts) {
  const deviceId = opts.deviceId?.trim() || ''
  const interval = opts.pollingIntervalMs ?? 30_000
  const enabled = opts.enabled !== false && Boolean(deviceId)

  const [device, setDevice] = useState<EdgeDeviceStatus | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastFetchedAt, setLastFetchedAt] = useState<string | null>(null)
  const inFlight = useRef(false)
  const abortRef = useRef<AbortController | null>(null)

  const refresh = useCallback(async () => {
    if (!deviceId || inFlight.current) return
    inFlight.current = true
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    setIsLoading(true)
    try {
      const next = await fetchDeviceStatus(deviceId, ac.signal)
      setDevice(next)
      setError(null)
      setLastFetchedAt(new Date().toISOString())
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return
      // Keep last successful device; do not force OFFLINE on one failed poll
      setError(err instanceof Error ? err.message : 'Unable to reach device status API')
    } finally {
      inFlight.current = false
      setIsLoading(false)
    }
  }, [deviceId])

  useEffect(() => {
    if (!enabled) return
    void refresh()
    const id = window.setInterval(() => void refresh(), interval)
    return () => {
      window.clearInterval(id)
      abortRef.current?.abort()
    }
  }, [enabled, interval, refresh])

  return { device, isLoading, error, lastFetchedAt, refresh }
}
