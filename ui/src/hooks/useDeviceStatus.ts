import { useQuery } from '@tanstack/react-query'
import { EdgeDeviceApiError, getDeviceStatus, getDevicesStatus } from '../services/edgeDeviceApi'
import { EdgeDeviceStatus } from '../types/edgeDevice'
import {
  edgeDeviceIdsForStation,
  primaryEdgeDeviceIdForStation,
} from '../config/edgeDevices'

const POLL_MS = 30_000

export function useDeviceStatus(deviceId?: string | null) {
  const id = deviceId?.trim() || ''
  return useQuery<EdgeDeviceStatus, EdgeDeviceApiError>({
    queryKey: ['edge-device-status', id],
    queryFn: () => getDeviceStatus(id),
    enabled: Boolean(id),
    refetchInterval: POLL_MS,
    staleTime: 10_000,
    retry: false,
    placeholderData: (previous) => previous,
  })
}

export function useStationEdgeDevices(stationKey?: string | null) {
  const deviceIds = edgeDeviceIdsForStation(stationKey)
  const primaryId = primaryEdgeDeviceIdForStation(stationKey)

  const query = useQuery<EdgeDeviceStatus[], EdgeDeviceApiError>({
    queryKey: ['edge-station-devices', stationKey, ...deviceIds],
    queryFn: () => getDevicesStatus(deviceIds),
    enabled: deviceIds.length > 0,
    refetchInterval: POLL_MS,
    staleTime: 10_000,
    retry: false,
    placeholderData: (previous) => previous,
  })

  const devices = query.data || []
  const primary = devices.find((d) => d.deviceId === primaryId) || devices[0]

  const onlineCount = devices.filter((d) => d.status === 'ONLINE').length
  const delayedCount = devices.filter((d) => d.status === 'DELAYED').length
  const offlineCount = devices.filter((d) => d.status === 'OFFLINE').length
  const neverCount = devices.filter((d) => d.status === 'NEVER_CONNECTED').length
  const unknownCount = devices.filter((d) => d.status === 'UNKNOWN').length

  const notFound =
    query.error?.status === 404 ||
    /not registered/i.test(query.error?.message || '')

  return {
    ...query,
    deviceIds,
    primaryId,
    devices,
    primary,
    onlineCount,
    delayedCount,
    offlineCount,
    neverCount,
    unknownCount,
    totalCount: deviceIds.length,
    hasMapping: deviceIds.length > 0,
    notFound,
  }
}

export function useEdgeNetworkSummary(stationKeys: string[]) {
  const keys = stationKeys.filter(Boolean)
  const allIds = [...new Set(keys.flatMap((k) => edgeDeviceIdsForStation(k)))]

  return useQuery({
    queryKey: ['edge-network-from-devices', ...allIds],
    queryFn: async () => {
      const devices = await getDevicesStatus(allIds)
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
    enabled: allIds.length > 0,
    refetchInterval: POLL_MS,
    staleTime: 10_000,
    retry: false,
    placeholderData: (previous) => previous,
  })
}
