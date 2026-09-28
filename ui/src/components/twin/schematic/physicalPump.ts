import { displayPumpStatus } from './display'

export function isChannelStyleName(name: string | null | undefined): boolean {
  return /^pump[\s_-]*\d+(-n\d+)?$/i.test(String(name || '').trim())
}

/** SAO forecourt: pump N owns station hose numbers 2N-1 and 2N. */
export function stationHoseNumber(pumpNumber: number, localNozzleNumber: number): number {
  return (pumpNumber - 1) * 2 + localNozzleNumber
}

export function friendlyNozzleName(nozzle: Record<string, any>, index: number): string {
  const localRaw = Number(nozzle.nozzleNumber ?? nozzle.nozzle_number ?? index + 1)
  const local = Number.isFinite(localRaw) && localRaw > 0 ? localRaw : index + 1
  const pumpRaw = Number(
    nozzle.parentPumpNumber ?? nozzle.pumpNumber ?? nozzle.pump_number,
  )
  // Prefer station-wide labels when physical pump number is known.
  // Do not change mqtt nozzle-1 / nozzle-2 identities on the Pi.
  if (Number.isFinite(pumpRaw) && pumpRaw > 0) {
    return `Nozzle ${stationHoseNumber(pumpRaw, local)}`
  }
  const name = String(nozzle.name || '').trim()
  if (name && !isChannelStyleName(name)) return name
  return `Nozzle ${local}`
}

export function nozzlesForPhysicalPump(pump: Record<string, any>): Record<string, any>[] {
  const nested = Array.isArray(pump.nozzles) ? pump.nozzles.filter(Boolean) : []
  const pumpNumber = pump.pumpNumber ?? pump.pump_number ?? null
  if (nested.length) {
    return nested.map((n, i) => ({
      ...n,
      id: String(n.id || `${pump.id}-n${i + 1}`),
      name: friendlyNozzleName({ ...n, parentPumpNumber: pumpNumber }, i),
      parentPumpId: String(pump.id),
      parentPumpName: String(pump.name || pump.pumpCode || 'Pump'),
      parentPumpNumber: pumpNumber,
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
      name: friendlyNozzleName({ parentPumpNumber: pumpNumber, nozzleNumber: 1 }, 0),
      parentPumpId: String(pump.id),
      parentPumpName: String(pump.name || pump.pumpCode || 'Pump'),
      parentPumpNumber: pumpNumber,
      assetRole: 'NOZZLE',
      nozzleCode: pump.pumpCode,
      sourceIdentifier: pump.mqttPumpId || pump.pumpCode,
    },
  ]
}

export function isEquipmentOffline(status?: string | null): boolean {
  return displayPumpStatus(status) === 'OFFLINE'
}

/** Last-sale history must not keep one nozzle Idle when the dispenser is offline. */
export function physicalPumpIsOffline(
  pumpStatus?: string | null,
  nozzleStatuses: Array<string | null | undefined> = [],
  livePresentations: Array<string | null | undefined> = [],
): boolean {
  const anyLive = livePresentations.some((s) => {
    const shown = displayPumpStatus(s)
    return shown === 'DISPENSING' || shown === 'SALE_COMPLETED'
  })
  if (anyLive) return false
  return isEquipmentOffline(pumpStatus) || nozzleStatuses.some((s) => isEquipmentOffline(s))
}

export function aggregatePhysicalPumpStatus(nozzleStatuses: Array<string | null | undefined>): string {
  const norms = nozzleStatuses.map((s) => displayPumpStatus(s))
  if (!norms.length) return 'UNKNOWN'
  if (norms.some((s) => s === 'DISPENSING')) return 'DISPENSING'
  if (norms.some((s) => s === 'SALE_COMPLETED')) return 'SALE_COMPLETED'
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
