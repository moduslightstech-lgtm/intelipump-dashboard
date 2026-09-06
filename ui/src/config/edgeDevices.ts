/**
 * Maps MQTT / catalog station identifiers to Raspberry Pi edge device IDs.
 * Keep device IDs here — never hardcode them inside status card components.
 */
export type StationEdgeConfig = {
  /** MQTT station id (preferred) */
  mqttStationId: string
  /** Optional catalog station_code aliases */
  aliases?: string[]
  /** Primary device for compact cards */
  edgeDeviceId: string
  /** All devices at the station (supports multi-Pi stations) */
  deviceIds: string[]
  displayName?: string
}

export const STATION_EDGE_DEVICES: StationEdgeConfig[] = [
  {
    mqttStationId: 'EnergySwitch-Ibadan-Boluwaji',
    aliases: ['BLJ-IB001', 'Boluwaji'],
    edgeDeviceId: 'EnergySwitch-pi-001',
    deviceIds: ['EnergySwitch-pi-001'],
    displayName: 'Boluwaji',
  },
]

export function resolveStationEdgeConfig(
  stationKey?: string | null,
): StationEdgeConfig | undefined {
  if (!stationKey) return undefined
  const key = stationKey.trim().toLowerCase()
  return STATION_EDGE_DEVICES.find((row) => {
    if (row.mqttStationId.toLowerCase() === key) return true
    if (row.displayName && row.displayName.toLowerCase() === key) return true
    return (row.aliases || []).some((a) => a.toLowerCase() === key)
  })
}

export function edgeDeviceIdsForStation(stationKey?: string | null): string[] {
  return resolveStationEdgeConfig(stationKey)?.deviceIds || []
}

export function primaryEdgeDeviceIdForStation(stationKey?: string | null): string | undefined {
  return resolveStationEdgeConfig(stationKey)?.edgeDeviceId
}
