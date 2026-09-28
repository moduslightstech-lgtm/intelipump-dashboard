import type { Station } from '../api/client'

export function canonicalTwinStationId(station: Pick<Station, 'id' | 'station_code' | 'mqtt_station_id'>): string {
  return (station.station_code || station.mqtt_station_id || station.id || '').trim()
}

function keysOf(station: Pick<Station, 'id' | 'station_code' | 'mqtt_station_id'>): string[] {
  return [station.id, station.station_code, station.mqtt_station_id]
    .map((value) => (value || '').trim().toLowerCase())
    .filter(Boolean)
}

/** Map a stale bookmark such as LAB-001 onto US-LAB-001 when that station is visible. */
export function resolveAccessibleStation(
  stations: Station[] | undefined,
  requested: string | null | undefined,
): Station | undefined {
  if (!stations?.length) return undefined
  const query = (requested || '').trim().toLowerCase()
  if (!query) return stations[0]
  const exact = stations.find((station) => keysOf(station).includes(query))
  if (exact) return exact
  const suffix = stations.filter((station) =>
    keysOf(station).some((key) => /[a-z]/.test(query) && key.endsWith(`-${query}`)),
  )
  if (suffix.length === 1) return suffix[0]
  return stations[0]
}
