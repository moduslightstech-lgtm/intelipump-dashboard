import axios from 'axios'

/**
 * Local / same-origin FastAPI for auth, admin, twin catalog.
 * Live sales / devices / SSE use `src/config/api.ts` (VITE_API_BASE_URL, default `/api`).
 */
const BASE_URL = (import.meta as any).env?.VITE_APP_API_BASE_URL ?? ''

export const api = axios.create({
  baseURL: BASE_URL,
  headers: { 'Content-Type': 'application/json' },
})

const ACCESS_KEY = 'intelipump_access_token'
const REFRESH_KEY = 'intelipump_refresh_token'

export function loadStoredTokens() {
  if (typeof localStorage === 'undefined') {
    return { access: null as string | null, refresh: null as string | null }
  }
  const access = localStorage.getItem(ACCESS_KEY)
  const refresh = localStorage.getItem(REFRESH_KEY)
  if (access) {
    api.defaults.headers.common['Authorization'] = `Bearer ${access}`
  }
  return { access, refresh }
}

export function storeTokens(access: string, refresh: string) {
  localStorage.setItem(ACCESS_KEY, access)
  localStorage.setItem(REFRESH_KEY, refresh)
  api.defaults.headers.common['Authorization'] = `Bearer ${access}`
}

export function clearTokens() {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem(ACCESS_KEY)
    localStorage.removeItem(REFRESH_KEY)
  }
  delete api.defaults.headers.common['Authorization']
}

// Restore auth header on app boot when localStorage is available (browser only).
if (typeof localStorage !== 'undefined') {
  loadStoredTokens()
}

export type DashboardSummary = {
  total_amount_today: number
  total_volume_today: number
  transaction_count_today: number
  average_transaction_amount: number
  active_stations: number
  online_devices: number
  offline_devices: number
  last_transaction_time: string | null
  rejected_mqtt_messages_today: number
  timezone: string
}

export type HourlySalesPoint = {
  hour: string
  amount: number
  volume: number
  count: number
}

export type ProductBreakdownItem = {
  product: string
  amount: number
  volume: number
  count: number
}

export type StationPerformanceItem = {
  station_id: string
  station_name: string | null
  amount: number
  volume: number
  count: number
}

export type Transaction = {
  id: string
  station_id: string
  device_id: string | null
  pump_id: string
  nozzle_id: string | null
  product: string | null
  volume_liters: number | null
  amount: number | null
  currency: string | null
  price_per_liter: number | null
  raw_frame: string | null
  status: string | null
  source_topic: string | null
  device_timestamp: string | null
  transaction_completed_at: string | null
  raw_payload: Record<string, unknown> | null
  received_at: string | null
}

export type Station = {
  id: string
  organization_id?: string | null
  station_code: string
  mqtt_station_id?: string | null
  name: string
  address: string | null
  city: string | null
  state: string | null
  country?: string | null
  timezone: string
  status: string
  operational_status?: string
  connectivity_status?: string
  opens_at?: string | null
  closes_at?: string | null
  operating_days?: number[] | null
  last_opened_at?: string | null
  last_closed_at?: string | null
  last_seen_at?: string | null
  last_heartbeat_at?: string | null
  status_source?: string | null
  status_reason?: string | null
  created_at: string
  updated_at: string
  pump_count?: number
  active_pump_count?: number
  device_count?: number
  tank_count?: number
  connection_count?: number
}

export type Device = {
  id: string
  station_id: string | null
  device_code: string
  name: string | null
  mqtt_client_id: string | null
  external_device_id?: string | null
  agent_version: string | null
  status: string
  active?: boolean
  deactivated_at?: string | null
  last_seen_at: string | null
  last_transaction_at: string | null
  created_at: string
  updated_at: string
}

export type DeviceAvailability =
  | 'ONLINE'
  | 'DELAYED'
  | 'OFFLINE'
  | 'NEVER_CONNECTED'
  | 'UNKNOWN'
  | 'STALE' // legacy alias treated as DELAYED in UI

export type EdgeDeviceStatus = {
  deviceId: string
  stationId: string
  hostname: string | null
  status: DeviceAvailability
  statusReason?: string
  mqttConnectionStatus: string
  lastSeen: string | null
  secondsSinceLastHeartbeat: number | null
  heartbeatAgeSeconds?: number | null
  lastHeartbeatAt?: string | null
  mqttConnected?: boolean | null
  mqttStatus?: string
  deviceName?: string | null
}

export type EdgeDevice = EdgeDeviceStatus & {
  id?: string
  agentVersion?: string | null
  serialPort?: string | null
  serialPortOpen?: boolean | null
  pumpCommunicationStatus?: string
  pumpCommunicationReason?: string
  localIp?: string | null
  tailscaleIp?: string | null
  lastSerialDataAt?: string | null
  lastTransactionAt?: string | null
  lastSuccessfulUploadAt?: string | null
  pendingTransactions?: number | null
  syncedTransactions?: number | null
  failedTransactions?: number | null
  uptimeSeconds?: number | null
  cpuTemperatureCelsius?: number | null
  diskUsagePercent?: number | null
  memoryUsagePercent?: number | null
}

export type EdgeDeviceSummary = {
  deviceId: string
  deviceName: string | null
  status: string
  statusReason?: string
  heartbeatAgeSeconds: number | null
  mqttConnected: boolean | null
  mqttStatus?: string
  serialPortOpen: boolean | null
  pumpCommunicationStatus: string
  tailscaleIp?: string | null
  lastHeartbeatAt: string | null
  lastSerialDataAt: string | null
  lastTransactionAt: string | null
}

export type StationDevicesResponse = {
  stationId: string
  mqttStationId?: string
  stationAvailability?: DeviceAvailability | string
  onlineCount: number
  delayedCount: number
  offlineCount: number
  neverConnectedCount?: number
  totalCount: number
  lastStationHeartbeat: string | null
  lastTransactionAt?: string | null
  pumpCommunicationStatus?: string
  pumpCommunicationLabel?: string
  devices: EdgeDeviceStatus[]
}

export type EdgeConnectivitySummary = {
  stationId: string
  totalDevices: number
  onlineDevices: number
  staleDevices: number
  delayedDevices?: number
  offlineDevices: number
  mqttConnectedDevices: number
  serialHealthyDevices: number
  devices: EdgeDeviceSummary[]
}

export type EdgeNetworkSummary = {
  asOf: string
  stationsOnline: number
  stationsDelayed: number
  stationsOffline: number
  devicesNeverConnected: number
  stations: Array<{
    stationId: string
    stationName: string
    stationCode: string
    mqttStationId: string
    status: string
    onlineCount: number
    totalCount: number
    lastHeartbeatAt: string | null
    secondsSinceLastHeartbeat: number | null
    devices: EdgeDeviceStatus[]
  }>
}

export type Pump = {
  id: string
  organization_id?: string | null
  station_id: string | null
  device_id: string | null
  pump_code: string
  mqtt_pump_id?: string | null
  name?: string | null
  pump_number: number | null
  island_number?: number | null
  display_order?: number
  manufacturer: string | null
  model: string | null
  protocol: string | null
  status: string
  active?: boolean
  deactivated_at?: string | null
  notes?: string | null
  operational_state?: string
  device_name?: string | null
  device_code?: string | null
  nozzle_count?: number
  product?: string | null
  has_transactions?: boolean
  can_hard_delete?: boolean
  created_at: string
  updated_at: string
}

export type Nozzle = {
  id: string
  station_id: string | null
  pump_id: string | null
  pump_code: string | null
  nozzle_code: string
  mqtt_nozzle_id?: string | null
  nozzle_number?: number | null
  product: string | null
  display_order?: number
  status: string
  active?: boolean
  deactivated_at?: string | null
  created_at: string
  updated_at: string
}

export type TankConnection = {
  id: string
  station_id: string
  tank_id: string
  pump_id: string
  product: string | null
  line_label?: string | null
  active: boolean
  is_primary: boolean
  display_order: number
  created_at: string
  updated_at: string
  tank_code?: string | null
  tank_name?: string | null
  pump_code?: string | null
  pump_name?: string | null
}

export type Alert = {
  id: string
  station_id: string | null
  device_id: string | null
  alert_type: string
  severity: string
  title: string
  message: string | null
  status: string
  detected_at: string
  acknowledged_at: string | null
  resolved_at: string | null
}

export type MqttMessage = {
  id: string
  topic: string
  payload: Record<string, unknown> | null
  qos: number | null
  retained: boolean | null
  processing_status: string
  transaction_id: string | null
  error_message: string | null
  received_at: string
  processed_at: string | null
}

export type RejectedMessage = {
  id: string
  topic: string
  payload: Record<string, unknown> | null
  error_type: string
  error_message: string
  received_at: string
  resolved: boolean
  resolved_at: string | null
}

export type UserMe = {
  id: string
  email: string
  first_name: string | null
  last_name: string | null
  role: string
  normalizedRole?: string
  status: string
  last_login_at: string | null
  landingPath?: string
  organizationId?: string | null
  stationCount?: number
}

export const login = (email: string, password: string) =>
  api.post<{ access_token: string; refresh_token: string }>('/api/v1/auth/login', { email, password })

export const refreshToken = (refresh_token: string) =>
  api.post<{ access_token: string; refresh_token: string }>('/api/v1/auth/refresh', { refresh_token })

export const getMe = () => api.get<UserMe>('/api/v1/me')
export const getMyStations = () => api.get<any[]>('/api/v1/me/stations')

export const getStationManagerStations = () => api.get<any[]>('/api/v1/me/stations')
export const getStationManagerCurrentReadings = (stationId: string, businessDate?: string) =>
  api.get<any>('/api/v1/station-manager/tank-readings/current', {
    params: { station_id: stationId, business_date: businessDate },
  })
export const getStationManagerHistory = (params?: {
  station_id?: string
  date_from?: string
  date_to?: string
  status?: string
  page?: number
  page_size?: number
}) =>
  api.get<{
    items: any[]
    page: number
    pageSize: number
    total: number
    hasMore: boolean
  }>('/api/v1/station-manager/tank-readings/history', { params })
export const getStationManagerReconciliation = (stationId: string, businessDate?: string) =>
  api.get<any>('/api/v1/station-manager/reconciliation', {
    params: { station_id: stationId, business_date: businessDate },
  })
export const saveTankReadingDraft = (body: Record<string, unknown>) =>
  api.post<any>('/api/v1/station-manager/tank-readings/draft', body)
export const submitTankReadings = (body: Record<string, unknown>) =>
  api.post<any>('/api/v1/station-manager/tank-readings/submit', body)
export const correctTankReadingBatch = (batchId: string, body: Record<string, unknown>) =>
  api.put<any>(`/api/v1/station-manager/admin/tank-readings/${batchId}/correct`, body)
export const getTankReadingAudit = (batchId: string) =>
  api.get<any[]>(`/api/v1/station-manager/tank-readings/batches/${batchId}/audit`)

export const getExecutiveDashboard = () => api.get<any>('/api/v1/executive/dashboard')
export const getExecutiveStationPerformance = () => api.get<any[]>('/api/v1/executive/station-performance')
export const getExecutiveReconSummary = () => api.get<any[]>('/api/v1/executive/reconciliation-summary')
export const getExecutiveTankInventory = () => api.get<any[]>('/api/v1/executive/tank-inventory-summary')
export const getExecutiveAlertsSummary = () => api.get<any>('/api/v1/executive/alerts-summary')

export const getAdminUsers = () => api.get<any[]>('/api/v1/admin/users')
export const createAdminUser = (body: Record<string, unknown>) =>
  api.post<any>('/api/v1/admin/users', body)
export const assignUserRole = (id: string, role: string) =>
  api.post<any>(`/api/v1/admin/users/${id}/roles`, { role })
export const assignUserStations = (id: string, station_ids: string[]) =>
  api.post<any>(`/api/v1/admin/users/${id}/station-assignments`, { station_ids })

/** Admin station catalog */
export const getAdminStations = () => api.get<Station[]>('/api/v1/admin/stations')
export const getAdminStation = (stationId: string) =>
  api.get<Station>(`/api/v1/admin/stations/${stationId}`)
export const updateAdminStation = (stationId: string, body: Partial<Station>) =>
  api.put<Station>(`/api/v1/admin/stations/${stationId}`, body)

export const getAdminStationDevices = (stationId: string) =>
  api.get<Device[]>(`/api/v1/admin/stations/${stationId}/devices`)
export const createAdminStationDevice = (stationId: string, body: Record<string, unknown>) =>
  api.post<Device>(`/api/v1/admin/stations/${stationId}/devices`, body)
export const updateAdminDevice = (deviceId: string, body: Partial<Device>) =>
  api.put<Device>(`/api/v1/admin/devices/${deviceId}`, body)

export const getAdminStationPumps = (stationId: string, includeInactive = true) =>
  api.get<Pump[]>(`/api/v1/admin/stations/${stationId}/pumps`, {
    params: { include_inactive: includeInactive },
  })
export const createAdminStationPump = (stationId: string, body: Record<string, unknown>) =>
  api.post<Pump>(`/api/v1/admin/stations/${stationId}/pumps`, body)
export const getAdminPump = (pumpId: string) => api.get<Pump>(`/api/v1/admin/pumps/${pumpId}`)
export const updateAdminPump = (pumpId: string, body: Record<string, unknown>) =>
  api.put<Pump>(`/api/v1/admin/pumps/${pumpId}`, body)
export const deactivateAdminPump = (pumpId: string) =>
  api.post<Pump>(`/api/v1/admin/pumps/${pumpId}/deactivate`)
export const reactivateAdminPump = (pumpId: string) =>
  api.post<Pump>(`/api/v1/admin/pumps/${pumpId}/reactivate`)
export const duplicateAdminPump = (pumpId: string) =>
  api.post<Pump>(`/api/v1/admin/pumps/${pumpId}/duplicate`)
export const deleteAdminPump = (pumpId: string) =>
  api.delete<{ deleted: boolean; softDeleted: boolean; id: string; reason?: string }>(
    `/api/v1/admin/pumps/${pumpId}`,
  )

export const getAdminPumpNozzles = (pumpId: string, includeInactive = true) =>
  api.get<Nozzle[]>(`/api/v1/admin/pumps/${pumpId}/nozzles`, {
    params: { include_inactive: includeInactive },
  })
export const createAdminNozzle = (pumpId: string, body: Record<string, unknown>) =>
  api.post<Nozzle>(`/api/v1/admin/pumps/${pumpId}/nozzles`, body)
export const updateAdminNozzle = (nozzleId: string, body: Record<string, unknown>) =>
  api.put<Nozzle>(`/api/v1/admin/nozzles/${nozzleId}`, body)
export const deactivateAdminNozzle = (nozzleId: string) =>
  api.post<Nozzle>(`/api/v1/admin/nozzles/${nozzleId}/deactivate`)

export const getAdminTankConnections = (stationId: string) =>
  api.get<TankConnection[]>(`/api/v1/admin/stations/${stationId}/tank-connections`)
export const createAdminTankConnection = (stationId: string, body: Record<string, unknown>) =>
  api.post<TankConnection>(`/api/v1/admin/stations/${stationId}/tank-connections`, body)
export const updateAdminTankConnection = (connectionId: string, body: Record<string, unknown>) =>
  api.put<TankConnection>(`/api/v1/admin/tank-connections/${connectionId}`, body)
export const deleteAdminTankConnection = (connectionId: string) =>
  api.delete<{ deleted: boolean; id: string }>(`/api/v1/admin/tank-connections/${connectionId}`)

export const getTanks = (stationId?: string) =>
  api.get<any[]>('/api/v1/tanks', { params: stationId ? { station_id: stationId } : {} })
export const createTank = (body: Record<string, unknown>) => api.post<any>('/api/v1/tanks', body)
export const updateTank = (tankId: string, body: Record<string, unknown>) =>
  api.put<any>(`/api/v1/tanks/${tankId}`, body)

export const getDashboardSummary = () => api.get<DashboardSummary>('/api/v1/dashboard/summary')
export const getHourlySales = () => api.get<HourlySalesPoint[]>('/api/v1/dashboard/hourly-sales')
export const getProductBreakdown = () => api.get<ProductBreakdownItem[]>('/api/v1/dashboard/product-breakdown')
export const getStationPerformance = () => api.get<StationPerformanceItem[]>('/api/v1/dashboard/station-performance')

export const getTransactions = (params: Record<string, unknown>) =>
  api.get<{ items: Transaction[]; total: number; page: number; size: number }>('/api/v1/transactions', { params })

export const getTransaction = (id: string) => api.get<Transaction>(`/api/v1/transactions/${id}`)

export const exportTransactionsUrl = (params: Record<string, string | undefined>) => {
  const qs = new URLSearchParams()
  Object.entries(params).forEach(([k, v]) => {
    if (v) qs.set(k, v)
  })
  const base = BASE_URL || ''
  return `${base}/api/v1/transactions/export?${qs.toString()}`
}

export const getStations = () => api.get<Station[]>('/api/v1/stations')
export const createStation = (
  body: Partial<Station> & { station_code: string; name: string; mqtt_station_id?: string },
) => api.post<Station>('/api/v1/stations', body)
export const updateStation = (id: string, body: Partial<Station>) =>
  api.put<Station>(`/api/v1/stations/${id}`, body)

export const getDevices = () => api.get<Device[]>('/api/v1/devices')
export const createDevice = (body: { device_code: string; name?: string; station_id?: string }) =>
  api.post<Device>('/api/v1/devices', body)
export const updateDevice = (id: string, body: Partial<Device>) =>
  api.put<Device>(`/api/v1/devices/${id}`, body)

export const getEdgeDevices = (params?: { stationId?: string; status?: string; search?: string }) =>
  api.get<EdgeDeviceStatus[]>('/api/v1/edge-devices', { params })
export const getEdgeDevice = (deviceId: string) =>
  api.get<EdgeDevice>(`/api/v1/edge-devices/${encodeURIComponent(deviceId)}`)
/** Prefer `services/edgeDeviceApi.getDeviceStatus` for the live DigitalOcean contract. */
export { getDeviceStatus } from '../services/edgeDeviceApi'
export const getStationEdgeDevices = (stationId: string) =>
  api.get<EdgeDevice[]>(`/api/v1/stations/${encodeURIComponent(stationId)}/edge-devices`)
export const getStationDevices = (stationId: string) =>
  api.get<StationDevicesResponse>(`/api/v1/stations/${encodeURIComponent(stationId)}/devices`)
export const getStationConnectivitySummary = (stationId: string) =>
  api.get<EdgeConnectivitySummary>(
    `/api/v1/stations/${encodeURIComponent(stationId)}/connectivity-summary`,
  )
export const getEdgeNetworkSummary = () =>
  api.get<EdgeNetworkSummary>('/api/v1/edge-connectivity/network-summary')


export const getPumps = () => api.get<Pump[]>('/api/v1/pumps')
export const createPump = (body: {
  pump_code: string
  mqtt_pump_id?: string
  station_id?: string
  device_id?: string
}) => api.post<Pump>('/api/v1/pumps', body)
export const updatePump = (id: string, body: Partial<Pump>) =>
  api.put<Pump>(`/api/v1/pumps/${id}`, body)

export const getAlerts = (statusOrParams?: string | Record<string, unknown>) => {
  const params =
    typeof statusOrParams === 'string'
      ? statusOrParams
        ? { status: statusOrParams }
        : {}
      : statusOrParams || {}
  return api.get<Alert[]>('/api/v1/alerts', { params })
}
export const acknowledgeAlert = (id: string) => api.post<Alert>(`/api/v1/alerts/${id}/acknowledge`)
export const resolveAlert = (id: string) => api.post<Alert>(`/api/v1/alerts/${id}/resolve`)
export const getAlertSummary = () => api.get<AlertSummary>('/api/v1/alerts/summary')
export const dismissAlert = (id: string) => api.post<Alert>(`/api/v1/alerts/${id}/dismiss`)
export const reopenAlert = (id: string, comment?: string) =>
  api.post<Alert>(`/api/v1/alerts/${id}/reopen`, comment ? { comment } : undefined)

export type AlertSummary = {
  total: number
  open: number
  acknowledged: number
  in_progress: number
  resolved: number
  dismissed: number
  by_type: Record<string, number>
}

export type ReconciliationRun = {
  id: string
  station_id: string
  business_date: string
  shift_id?: string | null
  reconciliation_type: string
  status: string
  started_at?: string | null
  completed_at?: string | null
  created_by?: string | null
  notes?: string | null
  created_at: string
  updated_at: string
  items?: ReconciliationItem[] | null
}

export type ReconciliationItem = {
  id: string
  reconciliation_run_id: string
  station_id: string
  pump_id?: string | null
  nozzle_id?: string | null
  tank_id?: string | null
  product?: string | null
  reference_type: string
  opening_value?: number | string | null
  closing_value?: number | string | null
  expected_value?: number | string | null
  actual_value?: number | string | null
  variance_value?: number | string | null
  variance_percentage?: number | string | null
  tolerance_value?: number | string | null
  status: string
  notes?: string | null
  created_at?: string
  updated_at?: string
  [key: string]: unknown
}

export type TwinLiveState = {
  station?: Record<string, any>
  layout?: {
    mode?: string
    canvasWidth?: number
    canvasHeight?: number
    items?: Record<string, any>[]
    [key: string]: unknown
  } | null
  tanks?: Record<string, any>[]
  pumps?: Record<string, any>[]
  nozzles?: Record<string, any>[]
  devices?: Record<string, any>[]
  latestTransactions?: Record<string, any>[]
  activeAlerts?: Record<string, any>[]
  currentStatuses?: Record<string, any>
  tankMeasurements?: Record<string, any>[]
  diagnostics?: Record<string, any>
  hasAssets?: boolean
  tankPumpConnections?: Record<string, any>[]
  connections?: Record<string, any>[]
  connectionMappingConfigured?: boolean
  connectionMappingMessage?: string | null
  activeTransactions?: Record<string, any>[]
  salesToday?: number
  volumeToday?: number
  transactionCountToday?: number
  businessDate?: string
  reconciliation?: Record<string, any> | null
  reconciliationStatus?: string
  lastUpdatedAt?: string
  [key: string]: unknown
}

export type StationSearchItem = {
  id: string
  stationCode: string
  name: string
  city?: string | null
  state?: string | null
  status?: string
  connectivity?: string
  activeAlertCount?: number
  criticalAlertCount?: number
  isFavorite?: boolean
  viewedAt?: string | null
}

export type StationSearchResponse = {
  items: StationSearchItem[]
  page: number
  pageSize: number
  total: number
  hasMore: boolean
}

export const getReconciliations = (params?: Record<string, unknown>) =>
  api.get<ReconciliationRun[]>('/api/v1/reconciliations', { params })

export const createReconciliation = (body: {
  station_id: string
  business_date: string
  shift_id?: string
  reconciliation_type?: string
  notes?: string
}) => api.post<ReconciliationRun>('/api/v1/reconciliations', body)

export const getReconciliation = (id: string) =>
  api.get<ReconciliationRun>(`/api/v1/reconciliations/${id}`)

export const calculateReconciliation = (id: string) =>
  api.post<ReconciliationRun>(`/api/v1/reconciliations/${id}/calculate`)

export const submitReconciliation = (id: string, comment?: string) =>
  api.post<ReconciliationRun>(
    `/api/v1/reconciliations/${id}/submit`,
    comment ? { comment } : undefined,
  )

export const approveReconciliation = (id: string, comment?: string) =>
  api.post<ReconciliationRun>(
    `/api/v1/reconciliations/${id}/approve`,
    comment ? { comment } : undefined,
  )

export const rejectReconciliation = (id: string, comment?: string) =>
  api.post<ReconciliationRun>(
    `/api/v1/reconciliations/${id}/reject`,
    comment ? { comment } : undefined,
  )

export const reopenReconciliation = (id: string, comment?: string) =>
  api.post<ReconciliationRun>(
    `/api/v1/reconciliations/${id}/reopen`,
    comment ? { comment } : undefined,
  )

export const getReconciliationItems = (id: string) =>
  api.get<ReconciliationItem[]>(`/api/v1/reconciliations/${id}/items`)

export const getTwinLiveState = (stationId: string, opts?: { touch?: boolean }) =>
  api.get<TwinLiveState>(`/api/v1/digital-twin/stations/${stationId}/live-state`, {
    params: opts?.touch ? { touch: true } : undefined,
  })

export const putTwinLayout = (
  stationId: string,
  body: {
    name?: string
    canvas_width?: number
    canvas_height?: number
    background_image_url?: string | null
    items: Array<{
      asset_type: string
      asset_id?: string | null
      label?: string | null
      x_position: number
      y_position: number
      width: number
      height: number
      rotation?: number
      z_index?: number
      configuration_json?: Record<string, unknown> | null
    }>
  },
) => api.put(`/api/v1/digital-twin/stations/${stationId}/layout`, body)

export const resetTwinLayout = (stationId: string) =>
  api.post(`/api/v1/digital-twin/stations/${stationId}/layout/reset`)

export const searchStations = (params: {
  q?: string
  page?: number
  pageSize?: number
  region?: string
  state?: string
  city?: string
  status?: string
  hasAlerts?: boolean
  sort?: string
}) => api.get<StationSearchResponse>('/api/v1/stations/search', { params })

export const getStationSearchMeta = () =>
  api.get<{
    favorites: StationSearchItem[]
    recent: StationSearchItem[]
    criticalAlerts: StationSearchItem[]
    lastTwinStationId: string | null
  }>('/api/v1/stations/search/meta')

export const toggleStationFavorite = (stationId: string) =>
  api.post<{ stationId: string; isFavorite: boolean }>(`/api/v1/stations/${stationId}/favorite`)

export const getMqttMessages = () => api.get<MqttMessage[]>('/api/v1/mqtt/messages')
export const getRejectedMessages = () => api.get<RejectedMessage[]>('/api/v1/mqtt/rejected')

export function eventsStreamUrl(accessToken: string) {
  const base = BASE_URL || ''
  return `${base}/api/v1/events/stream?access_token=${encodeURIComponent(accessToken)}`
}

export function fmtNaira(n: number | null | undefined) {
  if (n == null || Number.isNaN(Number(n))) return '—'
  return new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
    maximumFractionDigits: 2,
  }).format(Number(n))
}

export function fmtLiters(n: number | null | undefined) {
  if (n == null || Number.isNaN(Number(n))) return '—'
  return `${Number(n).toFixed(2)} L`
}

export function fmtTime(iso: string | null | undefined) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('en-NG', { timeZone: 'Africa/Lagos' })
  } catch {
    return iso
  }
}
