/**
 * Same-origin InteliPump cloud API (nginx / Vite proxy).
 * VITE_API_BASE_URL must end with `/api` and must not have a trailing slash after that.
 *
 * Auth / admin / twin catalog stay on VITE_APP_API_BASE_URL (local FastAPI).
 */
export const API_BASE_URL = (
  (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim() || '/api'
).replace(/\/$/, '')

export const USE_MOCK_DATA =
  String(import.meta.env.VITE_USE_MOCK_DATA || 'false').toLowerCase() === 'true'

const ACCESS_TOKEN_KEY = 'intelipump_access_token'

export function jsonRequestHeaders(): HeadersInit {
  const headers: Record<string, string> = { Accept: 'application/json' }
  try {
    const token = localStorage.getItem(ACCESS_TOKEN_KEY)
    if (token) headers.Authorization = `Bearer ${token}`
  } catch {
    /* private mode / non-browser */
  }
  return headers
}

export const apiUrls = {
  health: API_BASE_URL.replace(/\/api$/, '') + '/health',

  devices: `${API_BASE_URL}/v1/edge-devices`,

  deviceStatus: (deviceId: string) =>
    `${API_BASE_URL}/v1/devices/${encodeURIComponent(deviceId)}/status`,

  stationDevices: (stationId: string) =>
    `${API_BASE_URL}/v1/stations/${encodeURIComponent(stationId)}/devices`,

  recentSales: (stationId: string, limit = 50, pumpId?: string) => {
    const params = new URLSearchParams({
      stationId,
      limit: String(limit),
    })
    if (pumpId) params.set('pumpId', pumpId)
    return `${API_BASE_URL}/v1/sales/recent?${params.toString()}`
  },

  salesSummary: (stationId: string) =>
    `${API_BASE_URL}/v1/sales/summary?${new URLSearchParams({ stationId }).toString()}`,

  eventsStream: (stationId: string) =>
    `${API_BASE_URL}/v1/events/stream?${new URLSearchParams({ stationId }).toString()}`,
}
