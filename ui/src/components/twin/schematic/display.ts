import { READING_STALE_MS } from './constants'

export function displayPumpStatus(status?: string | null): string {
  const s = (status || 'UNKNOWN').toUpperCase()
  if (s === 'SALE_COMPLETED') return 'SALE_COMPLETED'
  if (s === 'LAST_SALE') return 'IDLE'
  if (s === 'HANG_UP' || s === 'HANGUP') return 'IDLE'
  if (s === 'COMPLETED') return 'IDLE'
  if (s === 'CANCELLED_NO_SALE' || s === 'CANCELLED' || s === 'CANCELED') return 'IDLE'
  if (s === 'AUTHORIZED' || s === 'NOZZLE_LIFTED' || s === 'READY' || s === 'FILLING_NO_FLOW') {
    return 'READY'
  }
  if (s === 'POSSIBLE_UNINTENDED_FLOW') return 'FAULT'
  if (s === 'ACTIVE' || s === 'IN_PROGRESS' || s === 'VERIFIED_DISPENSING' || s === 'PROGRESS') {
    return 'DISPENSING'
  }
  if (s === 'ERROR') return 'FAULT'
  if (s === 'CLOSED') return 'POWERED_OFF'
  return s
}

export function pumpStatusLabel(status?: string | null): string {
  const s = displayPumpStatus(status)
  if (s === 'POWERED_OFF') return 'Powered off'
  if (s === 'DISPENSING') return 'Dispensing'
  if (s === 'SALE_COMPLETED') return 'Sale completed'
  if (s === 'READY') return 'Ready'
  if (s === 'IDLE') return 'Idle'
  if (s === 'FAULT') return 'Fault'
  if (s === 'OFFLINE') return 'Offline'
  if (s === 'INACTIVE') return 'Inactive'
  if (s === 'UNKNOWN') return 'Status unavailable'
  return s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())
}

export function readingSourceLabel(tank: Record<string, any>): 'Probe' | 'Manual' | 'Estimated' | 'Missing' {
  const src = String(tank.measurementSource || tank.source || '').toUpperCase()
  if (tank.isLiveTelemetry === true || src === 'AUTOMATED' || src === 'PROBE') return 'Probe'
  if (src === 'ESTIMATED' || Number(tank.drawnLiters) > 0) return 'Estimated'
  if (src === 'MANUAL') return 'Manual'
  if (!tank.measuredAt && tank.reportedLiters == null) return 'Missing'
  return src ? 'Manual' : 'Missing'
}

export function readingAgeMs(iso?: string | null, now = Date.now()): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  return Math.max(0, now - t)
}

export function isReadingStale(tank: Record<string, any>, now = Date.now()): boolean {
  if (tank.isStale === true) return true
  const age = readingAgeMs(tank.measuredAt, now)
  if (age == null) return readingSourceLabel(tank) !== 'Probe'
  return age > READING_STALE_MS
}

export function formatAge(ms: number): string {
  const min = Math.floor(ms / 60_000)
  if (min < 60) return `${Math.max(1, min)}m`
  const hr = Math.floor(min / 60)
  if (hr < 48) return `${hr}h`
  return `${Math.floor(hr / 24)}d`
}
