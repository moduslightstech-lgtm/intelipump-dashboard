/** Catalog row fields used to talk to live sales / device APIs. */
export type CatalogStationRef = {
  mqtt_station_id?: string | null
  station_code?: string | null
  name?: string | null
}

/** MQTT station id first, then dashboard station code. Never invent an id. */
export function liveStationId(station?: CatalogStationRef | null): string {
  return (station?.mqtt_station_id || station?.station_code || '').trim()
}

export function firstLiveStationId(
  stations?: Array<CatalogStationRef> | null,
): string {
  for (const row of stations || []) {
    const id = liveStationId(row)
    if (id) return id
  }
  return ''
}
