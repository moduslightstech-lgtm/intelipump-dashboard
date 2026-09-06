/** Match backend `transaction.pumpId` to configured dashboard pumps. */

export function normalizePumpId(value: string | null | undefined): string {
  return String(value || '')
    .trim()
    .toUpperCase()
}

/** Slash and hyphen variants of the same MQTT pump id (e.g. PUMP-05/06 ↔ PUMP-05-06). */
export function canonicalPumpId(value: string | null | undefined): string {
  return normalizePumpId(value).replace(/\//g, '-')
}

export function pumpIdsEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  const na = normalizePumpId(a)
  const nb = normalizePumpId(b)
  if (na === nb) return true
  return canonicalPumpId(na) === canonicalPumpId(nb)
}

/**
 * Configured telemetry / MQTT pump identifier used to match `transaction.pumpId`.
 * Prefer mqttPumpId / telemetryPumpId over internal UUID.
 */
export function getConfiguredPumpId(pump: Record<string, unknown> | null | undefined): string {
  if (!pump) return ''
  const candidates = [
    pump.telemetryPumpId,
    pump.telemetry_pump_id,
    pump.mqttPumpId,
    pump.mqtt_pump_id,
    pump.externalPumpId,
    pump.external_pump_id,
    pump.hardwareId,
    pump.hardware_id,
    pump.pumpCode,
    pump.pump_code,
    pump.code,
  ]
  for (const c of candidates) {
    const s = String(c || '').trim()
    if (s) return s
  }
  return String(pump.id || '').trim()
}

export function findPumpBySalePumpId<T extends Record<string, unknown>>(
  pumps: T[],
  salePumpId: string | null | undefined,
): T | undefined {
  if (!salePumpId) return undefined
  return pumps.find((p) => pumpIdsEqual(getConfiguredPumpId(p), salePumpId))
}

export function warnUnmappedPump(salePumpId: string): void {
  if (import.meta.env.DEV) {
    console.warn(`No dashboard pump configuration found for backend pumpId: ${salePumpId}`)
  }
}
