import { displayPumpStatus } from './display'

export function friendlyNozzleName(nozzle: Record<string, any>, index: number): string {
  const name = String(nozzle.name || '').trim()
  if (name && !/^pump-\d+$/i.test(name) && !/^pump-\d+-n\d+$/i.test(name)) return name
  const n = Number(nozzle.nozzleNumber ?? nozzle.nozzle_number ?? index + 1)
  return `Nozzle ${Number.isFinite(n) ? n : index + 1}`
}

export function nozzlesForPhysicalPump(pump: Record<string, any>): Record<string, any>[] {
  const nested = Array.isArray(pump.nozzles) ? pump.nozzles.filter(Boolean) : []
  if (nested.length) {
    return nested.map((n, i) => ({
      ...n,
      id: String(n.id || `${pump.id}-n${i + 1}`),
      name: friendlyNozzleName(n, i),
      parentPumpId: String(pump.id),
      parentPumpName: String(pump.name || pump.pumpCode || 'Pump'),
      assetRole: 'NOZZLE',
      mqttPumpId: n.sourceIdentifier || n.mqttNozzleId || n.mqttPumpId,
      pumpCode: n.nozzleCode || n.pumpCode,
      sourceIdentifier: n.sourceIdentifier || n.mqttNozzleId,
    }))
  }
  return [
    {
      ...pump,
      id: `${pump.id}::nozzle`,
      name: 'Nozzle 1',
      parentPumpId: String(pump.id),
      parentPumpName: String(pump.name || pump.pumpCode || 'Pump'),
      assetRole: 'NOZZLE',
      nozzleCode: pump.pumpCode,
      sourceIdentifier: pump.mqttPumpId || pump.pumpCode,
    },
  ]
}

export function aggregatePhysicalPumpStatus(nozzleStatuses: Array<string | null | undefined>): string {
  const norms = nozzleStatuses.map((s) => displayPumpStatus(s))
  if (!norms.length) return 'UNKNOWN'
  if (norms.some((s) => s === 'DISPENSING')) return 'DISPENSING'
  if (norms.some((s) => s === 'FAULT')) return 'FAULT'
  if (norms.every((s) => s === 'OFFLINE')) return 'OFFLINE'
  if (norms.every((s) => s === 'POWERED_OFF')) return 'POWERED_OFF'
  if (norms.some((s) => s === 'IDLE' || s === 'INACTIVE' || s === 'AVAILABLE')) return 'IDLE'
  if (norms.some((s) => s !== 'UNKNOWN')) return 'IDLE'
  return 'UNKNOWN'
}

export function liveKeysForNozzle(nozzle: Record<string, any>): string[] {
  return [nozzle.sourceIdentifier, nozzle.mqttNozzleId, nozzle.mqttPumpId, nozzle.nozzleCode, nozzle.id]
    .map((v) => String(v || '').trim())
    .filter(Boolean)
}
