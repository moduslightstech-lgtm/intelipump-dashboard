export type DeviceAvailability =
  | 'ONLINE'
  | 'DELAYED'
  | 'OFFLINE'
  | 'NEVER_CONNECTED'
  | 'UNKNOWN'

export interface EdgeDeviceStatus {
  deviceId: string
  stationId: string
  hostname: string | null
  status: DeviceAvailability
  mqttConnectionStatus: string
  lastSeen: string | null
  secondsSinceLastHeartbeat: number | null
}

const AVAILABILITY = new Set<DeviceAvailability>([
  'ONLINE',
  'DELAYED',
  'OFFLINE',
  'NEVER_CONNECTED',
  'UNKNOWN',
])

export function normalizeDeviceAvailability(value: unknown): DeviceAvailability {
  const raw = String(value || 'UNKNOWN').toUpperCase()
  if (raw === 'STALE') return 'DELAYED'
  if (AVAILABILITY.has(raw as DeviceAvailability)) return raw as DeviceAvailability
  return 'UNKNOWN'
}

export function parseEdgeDeviceStatus(payload: unknown): EdgeDeviceStatus {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid device status payload')
  }
  const data = payload as Record<string, unknown>
  const deviceId = String(data.deviceId || '').trim()
  const stationId = String(data.stationId || '').trim()
  if (!deviceId) {
    throw new Error('Device status missing deviceId')
  }

  const secondsRaw = data.secondsSinceLastHeartbeat
  let seconds: number | null = null
  if (typeof secondsRaw === 'number' && Number.isFinite(secondsRaw)) {
    seconds = Math.max(0, Math.floor(secondsRaw))
  } else if (secondsRaw != null && secondsRaw !== '') {
    const n = Number(secondsRaw)
    if (Number.isFinite(n)) seconds = Math.max(0, Math.floor(n))
  }

  return {
    deviceId,
    stationId: stationId || 'UNKNOWN',
    hostname: data.hostname == null || data.hostname === '' ? null : String(data.hostname),
    status: normalizeDeviceAvailability(data.status),
    mqttConnectionStatus: String(data.mqttConnectionStatus || 'UNKNOWN').toUpperCase(),
    lastSeen: data.lastSeen == null || data.lastSeen === '' ? null : String(data.lastSeen),
    secondsSinceLastHeartbeat: seconds,
  }
}
