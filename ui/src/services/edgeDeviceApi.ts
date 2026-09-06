import { API_BASE_URL, apiUrls, jsonRequestHeaders } from '../config/api'
import {
  EdgeDeviceStatus,
  parseEdgeDeviceStatus,
} from '../types/edgeDevice'

/**
 * Edge device status — same-origin FastAPI (`VITE_API_BASE_URL`, default `/api`).
 * Login / catalog remain on VITE_APP_API_BASE_URL.
 */
export function getEdgeApiBaseUrl(): string {
  return API_BASE_URL
}

/** @deprecated use getEdgeApiBaseUrl */
export function getApiBaseUrl(): string {
  return getEdgeApiBaseUrl()
}

export class EdgeDeviceApiError extends Error {
  status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'EdgeDeviceApiError'
    this.status = status
  }
}

export async function getDeviceStatus(deviceId: string): Promise<EdgeDeviceStatus> {
  const id = deviceId.trim()
  if (!id) throw new EdgeDeviceApiError('deviceId is required', 422)
  try {
    const res = await fetch(apiUrls.deviceStatus(id), {
      headers: jsonRequestHeaders(),
    })
    if (res.status === 404) throw new EdgeDeviceApiError('Edge device is not registered', 404)
    if (!res.ok) throw new EdgeDeviceApiError(`Unable to retrieve device status: ${res.status}`, res.status)
    return parseEdgeDeviceStatus(await res.json())
  } catch (err) {
    if (err instanceof EdgeDeviceApiError) throw err
    throw new EdgeDeviceApiError('Unable to reach device status API')
  }
}

export async function getDevicesStatus(deviceIds: string[]): Promise<EdgeDeviceStatus[]> {
  const unique = [...new Set(deviceIds.map((d) => d.trim()).filter(Boolean))]
  return Promise.all(unique.map((id) => getDeviceStatus(id)))
}
