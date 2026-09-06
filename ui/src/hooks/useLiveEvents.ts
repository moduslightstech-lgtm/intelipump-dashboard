import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { eventsStreamUrl } from '../api/client'
import { useAuth } from '../context/AuthContext'

/** Subscribe to FastAPI SSE for live transaction updates. No browser MQTT. */
export function useLiveEvents(enabled = true) {
  const { token } = useAuth()
  const queryClient = useQueryClient()
  const esRef = useRef<EventSource | null>(null)

  useEffect(() => {
    if (!enabled || !token) return

    const url = eventsStreamUrl(token)
    const es = new EventSource(url)
    esRef.current = es

    const invalidateTwin = (stationId?: string) => {
      if (stationId) {
        queryClient.invalidateQueries({ queryKey: ['twin', 'live-state', stationId] })
      } else {
        queryClient.invalidateQueries({ queryKey: ['twin'] })
      }
    }

    const invalidateTx = (ev?: MessageEvent) => {
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      queryClient.invalidateQueries({ queryKey: ['transactions'] })
      queryClient.invalidateQueries({ queryKey: ['alerts'] })
      queryClient.invalidateQueries({ queryKey: ['reconciliations'] })
      try {
        const data = ev?.data ? JSON.parse(String(ev.data)) : null
        invalidateTwin(data?.stationId)
      } catch {
        invalidateTwin()
      }
    }

    const invalidateAlerts = () => {
      queryClient.invalidateQueries({ queryKey: ['alerts'] })
      invalidateTwin()
    }

    es.addEventListener('transaction.created', (ev) => invalidateTx(ev as MessageEvent))
    es.addEventListener('alert.created', () => invalidateAlerts())
    const onStationStatus = (ev: Event) => {
      const me = ev as MessageEvent
      try {
        const data = me.data ? JSON.parse(String(me.data)) : null
        const key = data?.mqttStationId || data?.stationCode || data?.stationId
        invalidateTwin(key)
        queryClient.invalidateQueries({ queryKey: ['stations'] })
      } catch {
        invalidateTwin()
        queryClient.invalidateQueries({ queryKey: ['stations'] })
      }
    }
    ;[
      'station.opened',
      'station.closed',
      'station.online',
      'station.offline',
      'station.degraded',
      'pump.powered_off',
      'pump.online',
      'station.status',
    ].forEach((name) => es.addEventListener(name, onStationStatus))
    es.onerror = () => {
      // EventSource reconnects automatically; avoid noisy logs
    }

    return () => {
      es.close()
      esRef.current = null
    }
  }, [enabled, token, queryClient])
}
