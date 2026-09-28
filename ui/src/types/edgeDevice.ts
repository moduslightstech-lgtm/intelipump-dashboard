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
  serialPortOpen?: boolean | null
  serialPort?: string | null
  lastSerialDataAt?: string | null
  pumpCommunicationStatus?: string | null
  pumpCommunicationLabel?: string | null
  rs485Healthy?: boolean | null
  statusReason?: string | null
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

/** Heartbeat + RS485 composite label for MQTT / edge cards. */
export function edgeConnectivityLabel(device: {
  status?: string | null
  serialPortOpen?: boolean | null
  pumpCommunicationStatus?: string | null
}): string {
  const status = String(device.status || 'UNKNOWN').toUpperCase()
  const pump = String(device.pumpCommunicationStatus || '').toUpperCase()
  const base =
    status === 'ONLINE'
      ? 'Online'
      : status === 'DELAYED'
        ? 'Delayed'
        : status === 'OFFLINE'
          ? 'Offline'
          : status === 'NEVER_CONNECTED'
            ? 'Never connected'
            : 'Unknown'
  if (status === 'ONLINE' || status === 'DELAYED') {
    if (pump === 'SERIAL_PORT_CLOSED' || device.serialPortOpen === false) {
      return `${base} · RS485 down`
    }
    if (pump === 'NO_SERIAL_DATA') {
      return `${base} · No pump data`
    }
  }
  return base
}

export function edgeConnectivityTone(device: {
  status?: string | null
  serialPortOpen?: boolean | null
  pumpCommunicationStatus?: string | null
}): 'green' | 'amber' | 'red' | 'gray' {
  const status = String(device.status || 'UNKNOWN').toUpperCase()
  const pump = String(device.pumpCommunicationStatus || '').toUpperCase()
  if (status === 'OFFLINE') return 'red'
  if (status === 'DELAYED') return 'amber'
  if (status === 'ONLINE') {
    if (pump === 'SERIAL_PORT_CLOSED' || device.serialPortOpen === false || pump === 'NO_SERIAL_DATA') {
      return 'amber'
    }
    return 'green'
  }
  return 'gray'
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

  let serialPortOpen: boolean | null = null
  if (typeof data.serialPortOpen === 'boolean') serialPortOpen = data.serialPortOpen
  else if (data.serialPortOpen === 'true' || data.serialPortOpen === 1) serialPortOpen = true
  else if (data.serialPortOpen === 'false' || data.serialPortOpen === 0) serialPortOpen = false

  return {
    deviceId,
    stationId: stationId || 'UNKNOWN',
    hostname: data.hostname == null || data.hostname === '' ? null : String(data.hostname),
    status: normalizeDeviceAvailability(data.status),
    mqttConnectionStatus: String(data.mqttConnectionStatus || 'UNKNOWN').toUpperCase(),
    lastSeen: data.lastSeen == null || data.lastSeen === '' ? null : String(data.lastSeen),
    secondsSinceLastHeartbeat: seconds,
    serialPortOpen,
    serialPort: data.serialPort == null || data.serialPort === '' ? null : String(data.serialPort),
    lastSerialDataAt:
      data.lastSerialDataAt == null || data.lastSerialDataAt === ''
        ? null
        : String(data.lastSerialDataAt),
    pumpCommunicationStatus:
      data.pumpCommunicationStatus == null || data.pumpCommunicationStatus === ''
        ? null
        : String(data.pumpCommunicationStatus),
    pumpCommunicationLabel:
      data.pumpCommunicationLabel == null || data.pumpCommunicationLabel === ''
        ? null
        : String(data.pumpCommunicationLabel),
    rs485Healthy: typeof data.rs485Healthy === 'boolean' ? data.rs485Healthy : null,
    statusReason:
      data.statusReason == null || data.statusReason === '' ? null : String(data.statusReason),
  }
}

/** Match backend aggregate_station_availability: ONLINE if any Pi is ONLINE. */
export function aggregateStationAvailability(
  statuses: Array<DeviceAvailability | string | null | undefined>,
): DeviceAvailability {
  if (!statuses.length) return 'NEVER_CONNECTED'
  const normalized = statuses.map((s) => normalizeDeviceAvailability(s))
  if (normalized.some((s) => s === 'ONLINE')) return 'ONLINE'
  if (normalized.some((s) => s === 'DELAYED')) return 'DELAYED'
  if (normalized.some((s) => s === 'OFFLINE')) return 'OFFLINE'
  if (normalized.some((s) => s === 'NEVER_CONNECTED')) return 'NEVER_CONNECTED'
  return 'UNKNOWN'
}
