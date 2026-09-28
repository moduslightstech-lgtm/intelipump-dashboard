import { useQuery } from '@tanstack/react-query'
import {
  DeviceApiError,
  fetchDeviceStatus,
  fetchStationDevices,
  type StationDevicesSummary,
} from '../services/deviceApi'
import { EdgeDeviceStatus } from '../types/edgeDevice'

const POLL_MS = 30_000

export function useDeviceStatus(deviceId?: string | null) {
  const id = deviceId?.trim() || ''
  return useQuery<EdgeDeviceStatus, DeviceApiError>({
    queryKey: ['edge-device-status', id],
    queryFn: () => fetchDeviceStatus(id),
    enabled: Boolean(id),
    refetchInterval: POLL_MS,
    staleTime: 10_000,
    retry: false,
    placeholderData: (previous) => previous,
  })
}

export function useStationEdgeDevices(stationKey?: string | null) {
  const key = stationKey?.trim() || ''

  const query = useQuery<StationDevicesSummary, DeviceApiError>({
    queryKey: ['edge-station-devices', key],
    queryFn: () => fetchStationDevices(key),
    enabled: Boolean(key),
    refetchInterval: POLL_MS,
    staleTime: 10_000,
    retry: false,
    placeholderData: (previous) => previous,
  })

  const devices = query.data?.devices || []
  const primary = devices[0]
  const deviceIds = devices.map((d) => d.deviceId)
  const primaryId = primary?.deviceId

  const onlineCount =
    query.data?.onlineCount ?? devices.filter((d) => d.status === 'ONLINE').length
  const delayedCount =
    query.data?.delayedCount ?? devices.filter((d) => d.status === 'DELAYED').length
  const offlineCount =
    query.data?.offlineCount ?? devices.filter((d) => d.status === 'OFFLINE').length
  const neverCount = devices.filter((d) => d.status === 'NEVER_CONNECTED').length
  const unknownCount = devices.filter((d) => d.status === 'UNKNOWN').length

  // Station-level status: ONLINE if any Pi is ONLINE (not devices[0] alone).
  const stationAvailability =
    query.data?.stationAvailability ||
    (devices.length
      ? devices.some((d) => d.status === 'ONLINE')
        ? 'ONLINE'
        : devices.some((d) => d.status === 'DELAYED')
          ? 'DELAYED'
          : devices.some((d) => d.status === 'OFFLINE')
            ? 'OFFLINE'
            : 'UNKNOWN'
      : undefined)

  const notFound =
    query.error?.status === 404 ||
    /not registered/i.test(query.error?.message || '')

  const hasMapping = devices.length > 0 || query.isLoading || query.isError

  return {
    ...query,
    deviceIds,
    primaryId,
    devices,
    primary,
    stationAvailability,
    onlineCount,
    delayedCount,
    offlineCount,
    neverCount,
    unknownCount,
    totalCount: devices.length || query.data?.totalCount || 0,
    hasMapping,
    notFound,
  }
}

export function useEdgeNetworkSummary(stationKeys: string[]) {
  const keys = stationKeys.filter(Boolean)

  return useQuery({
    queryKey: ['edge-network-from-stations', ...keys],
    queryFn: async () => {
      const summaries = await Promise.all(keys.map((k) => fetchStationDevices(k)))
      const devices = summaries.flatMap((row) => row.devices)
      return {
        devices,
        online: devices.filter((d) => d.status === 'ONLINE').length,
        delayed: devices.filter((d) => d.status === 'DELAYED').length,
        offline: devices.filter((d) => d.status === 'OFFLINE').length,
        unavailable: devices.filter((d) =>
          ['NEVER_CONNECTED', 'UNKNOWN'].includes(d.status),
        ).length,
      }
    },
    enabled: keys.length > 0,
    refetchInterval: POLL_MS,
    staleTime: 10_000,
    retry: false,
    placeholderData: (previous) => previous,
  })
}
