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
      if (closed) {
        return { ...p, inferredStatus: 'POWERED_OFF' }
      }
      const liveOnline = ['ONLINE', 'DELAYED'].includes(
        String(connectivityStatus || '').toUpperCase(),
      )
      // Pi heartbeat is the site link. Do not keep catalog OFFLINE (red) on the map.
      if (liveOnline && (status === 'OFFLINE' || status === 'DEGRADED' || status === 'UNKNOWN')) {
        return { ...p, inferredStatus: 'IDLE' }
      }
      if (status === 'POWERED_OFF' || status === 'CLOSED') {
        return { ...p, inferredStatus: 'IDLE' }
      }
      return p
    }),
  }
}
