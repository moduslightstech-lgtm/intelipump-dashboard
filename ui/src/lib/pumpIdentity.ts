/** Match pumps using MQTT / telemetry identifiers (slash-safe; never topic-split). */

import { getConfiguredPumpId, pumpIdsEqual, canonicalPumpId } from '../utils/pumpMatching'

export function pumpMatchesId(
  pump: {
    id?: string
    pumpCode?: string | null
    mqttPumpId?: string | null
    mqtt_pump_id?: string | null
    telemetryPumpId?: string | null
    [key: string]: unknown
  },
  pumpId: string | null | undefined,
): boolean {
  if (!pumpId) return false
  if (pumpIdsEqual(getConfiguredPumpId(pump as Record<string, unknown>), pumpId)) return true
  // Internal UUID / code exact match (non-telemetry lookups)
  if (pump.id === pumpId || pump.pumpCode === pumpId) return true
  // ledger-only synthetic ids
  if (pump.id === `ledger:${pumpId}` || pump.id === `ledger:${canonicalPumpId(pumpId)}`) {
    return true
  }
  return false
}

export function pumpGridClass(count: number): string {
  if (count <= 1) return 'grid-cols-1 sm:grid-cols-1'
  if (count <= 4) return 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4'
  if (count <= 10) return 'grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5'
  return 'grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5'
}

export function pumpStatusColor(status: string): string {
  const s = status.toUpperCase()
  // Spec: IDLE = blue/neutral; DISPENSING = flashing green (base green here)
  if (s === 'DISPENSING' || s === 'ACTIVE') return '#22c55e'
  if (s === 'COMPLETED') return '#4ade80'
  if (s === 'POWERED_OFF' || s === 'CLOSED') return '#64748b'
  if (s === 'OFFLINE' || s === 'ERROR' || s === 'FAULT') return '#ef4444'
  if (s === 'IDLE' || s === 'ONLINE') return '#3b82f6'
  if (s === 'WARNING' || s === 'MAINTENANCE' || s === 'DEGRADED') return '#f59e0b'
  return '#94a3b8'
}
