import type { TwinLiveState } from '../api/client'

/** Overlay live schedule + edge Pi status onto twin live-state for display. */
export function applyLiveStationStatus(
  state: TwinLiveState | undefined,
  operationalStatus: string,
  connectivityStatus: string,
  edgeStatus?: string | null,
): TwinLiveState | undefined {
  if (!state) return state
  const closed = operationalStatus.toUpperCase() === 'CLOSED'
  return {
    ...state,
    station: {
      ...(state.station || {}),
      operationalStatus,
      connectivityStatus,
      edgeDeviceStatus: edgeStatus || null,
    },
    pumps: (state.pumps || []).map((p) => {
      const status = String(p.inferredStatus || '').toUpperCase()
      const withStatus = (next: string) => ({
        ...p,
        inferredStatus: next,
        nozzles: Array.isArray(p.nozzles)
          ? p.nozzles.map((n: Record<string, unknown>) => ({ ...n, inferredStatus: next }))
          : p.nozzles,
      })
      if (closed) {
        return withStatus('POWERED_OFF')
      }
      // Pi heartbeat is station connectivity only. It must not turn an offline
      // physical pump or its nozzles Idle.
      if (status === 'POWERED_OFF' || status === 'CLOSED') {
        return withStatus('IDLE')
      }
      return p
    }),
  }
}
