import { apiUrls, jsonRequestHeaders } from '../config/api'
import {
  parseEdgeDeviceStatus,
  type EdgeDeviceStatus,
  normalizeDeviceAvailability,
} from '../types/edgeDevice'

export type StationDevicesSummary = {
  stationId: string
  onlineCount: number
  delayedCount: number
  offlineCount: number
  totalCount: number
  lastStationHeartbeat: string | null
  devices: EdgeDeviceStatus[]
}

export class DeviceApiError extends Error {
  status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'DeviceApiError'
    this.status = status
  }
}

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, {
    signal,
    headers: jsonRequestHeaders(),
  })
  if (!res.ok) {
    throw new DeviceApiError(`Device API ${res.status}`, res.status)
  }
  return res.json()
}

export async function fetchDeviceStatus(
  deviceId: string,
  signal?: AbortSignal,
): Promise<EdgeDeviceStatus> {
  const id = deviceId.trim()
  if (!id) throw new DeviceApiError('deviceId is required', 422)
  try {
    return parseEdgeDeviceStatus(await getJson(apiUrls.deviceStatus(id), signal))
  } catch (err) {
    if (err instanceof DeviceApiError) throw err
    if ((err as Error)?.name === 'AbortError') throw err
    throw new DeviceApiError('Unable to reach device status API')
  }
}

export async function fetchAllDevices(signal?: AbortSignal): Promise<EdgeDeviceStatus[]> {
  const raw = await getJson(apiUrls.devices, signal)
  const list = Array.isArray(raw) ? raw : (raw as any)?.devices
  if (!Array.isArray(list)) return []
  return list.map((row) => parseEdgeDeviceStatus(row))
}

export async function fetchStationDevices(
  stationId: string,
  signal?: AbortSignal,
): Promise<StationDevicesSummary> {
  const id = stationId.trim()
  if (!id) throw new DeviceApiError('stationId is required', 422)
  const raw = (await getJson(apiUrls.stationDevices(id), signal)) as Record<string, unknown>
  const devicesRaw = Array.isArray(raw.devices) ? raw.devices : []
  const devices = devicesRaw.map((row) => parseEdgeDeviceStatus(row))
  return {
    stationId: String(raw.stationId || id),
    onlineCount: Number(raw.onlineCount ?? devices.filter((d) => d.status === 'ONLINE').length),
    delayedCount: Number(raw.delayedCount ?? devices.filter((d) => d.status === 'DELAYED').length),
    offlineCount: Number(raw.offlineCount ?? devices.filter((d) => d.status === 'OFFLINE').length),
    totalCount: Number(raw.totalCount ?? devices.length),
    lastStationHeartbeat:
      raw.lastStationHeartbeat == null || raw.lastStationHeartbeat === ''
        ? null
        : String(raw.lastStationHeartbeat),
    devices: devices.map((d) => ({
      ...d,
      status: normalizeDeviceAvailability(d.status),
    })),
  }
}

/** @deprecated prefer fetchDeviceStatus — kept for existing imports */
export { fetchDeviceStatus as getDeviceStatus }
