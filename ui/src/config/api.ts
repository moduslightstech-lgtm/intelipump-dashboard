/**
 * Live DigitalOcean (or same-origin) InteliPump cloud API.
 * VITE_API_BASE_URL must end with `/api` and must not have a trailing slash after that.
 *
 * Auth / admin / twin catalog stay on VITE_APP_API_BASE_URL (local FastAPI).
 */
export const API_BASE_URL = (
  (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim() ||
  'http://157.230.215.93:8000/api'
).replace(/\/$/, '')

export const USE_MOCK_DATA =
  String(import.meta.env.VITE_USE_MOCK_DATA || 'false').toLowerCase() === 'true'

export const apiUrls = {
  health: API_BASE_URL.replace(/\/api$/, '') + '/health',

  devices: `${API_BASE_URL}/devices`,

  deviceStatus: (deviceId: string) =>
    `${API_BASE_URL}/devices/${encodeURIComponent(deviceId)}/status`,

  stationDevices: (stationId: string) =>
    `${API_BASE_URL}/stations/${encodeURIComponent(stationId)}/devices`,

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
