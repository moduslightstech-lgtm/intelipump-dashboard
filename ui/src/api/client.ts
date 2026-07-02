import axios from 'axios'

const BASE_URL = (import.meta as any).env?.VITE_API_BASE_URL || 'http://localhost:8080'

export const api = axios.create({
    baseURL: BASE_URL,
    headers: { 'Content-Type': 'application/json' },
})

// Restore tenant header on reload
const savedUser = localStorage.getItem('fuelops_user')
const savedToken = localStorage.getItem('fuelops_token')
if (savedToken && savedUser) {
    const parsed = JSON.parse(savedUser)
    api.defaults.headers.common['Authorization'] = `Bearer ${savedToken}`
    api.defaults.headers.common['X-Tenant-Id'] = parsed.tenantId
}

// --- Dashboard ---
export const getDashboardOverview = () => api.get('/api/dashboard/overview')

// --- Stations ---
export const getStations = () => api.get('/api/stations')
export const getStationTwin = (stationId: string) => api.get(`/api/stations/${stationId}/twin`)
export const getReconciliation = (stationId: string, from?: string, to?: string) =>
    api.get(`/api/stations/${stationId}/reconciliation`, { params: { from, to } })
export const createAdjustment = (stationId: string, data: object) =>
    api.post(`/api/stations/${stationId}/adjustments`, data)
export const runAllReconciliation = () =>
    api.post('/api/stations/reconciliation/run-all')

// --- Alerts ---
export const getAlerts = (status?: string, type?: string) =>
    api.get('/api/alerts', { params: { status, type } })
export const acknowledgeAlert = (alertId: string) => api.patch(`/api/alerts/${alertId}/acknowledge`)
export const resolveAlert = (alertId: string) => api.patch(`/api/alerts/${alertId}/resolve`)
export const getAlertSummary = () => api.get('/api/alerts/summary')

// --- Seed ---
export const runSeed = () => api.post('/api/seed/run')

// --- Ingest ---
export const ingestEvents = (events: object[]) =>
    api.post('/api/ingest/raw-events', { events }, {
        headers: { 'X-Tenant-Id': api.defaults.headers.common['X-Tenant-Id'] }
    })
