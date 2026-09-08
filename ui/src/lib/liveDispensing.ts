import type { ActiveDispensingState } from '../components/twin/pipe/pipeTypes'
import { pumpMatchesId } from './pumpIdentity'
import type { PumpLiveState } from '../types/sales'

export function inProgressSaleStatus(status?: string | null): boolean {
  const s = String(status || '').toUpperCase()
  return s === 'DISPENSING' || s === 'IN_PROGRESS' || s === 'ACTIVE'
}

export function completedSaleStatus(status?: string | null): boolean {
  const s = String(status || '').toUpperCase()
  return s === 'COMPLETED' || s === 'COMPLETE'
}

export function livePumpInferredStatus(
  operational: string | undefined,
  live: PumpLiveState | undefined,
  fallback?: string | null,
): string {
  const op = String(operational || '').toUpperCase()
  const current = String(fallback || 'IDLE')
  if (op !== 'OPEN') return current
  if (live?.isRecentlyActive && inProgressSaleStatus(live.latestSale?.status)) {
    return 'DISPENSING'
  }
  if (completedSaleStatus(live?.latestSale?.status)) return 'COMPLETED'
  if (inProgressSaleStatus(live?.latestSale?.status) && !live?.isRecentlyActive) {
    return 'COMPLETED'
  }
  if (['DISPENSING', 'IN_PROGRESS', 'ACTIVE'].includes(current.toUpperCase())) {
    return 'COMPLETED'
  }
  return current
}

export function connectionForPump(
  pumpId: string,
  connections: Record<string, unknown>[],
  pumps: Record<string, unknown>[],
) {
  const pump = pumps.find((p) => pumpMatchesId(p, pumpId))
  const matches = connections.filter((c) => {
    const mqtt = String(c.mqttPumpId || c.pumpCode || '')
    return (
      (pump && String(c.pumpId || '') === String(pump.id)) ||
      pumpMatchesId({ mqttPumpId: mqtt, pumpCode: String(c.pumpCode || '') }, pumpId)
    )
  })
  if (!matches.length) return null
  return (
    matches.find((c) => c.isPrimary) ||
    [...matches].sort((a, b) =>
      String(a.tankId || '').localeCompare(String(b.tankId || '')),
    )[0]
  )
}

export function tankIdForPump(
  pumpId: string,
  connections: Record<string, unknown>[] = [],
  pumps: Record<string, unknown>[] = [],
): string {
  const conn = connectionForPump(pumpId, connections, pumps)
  return conn?.tankId ? String(conn.tankId) : ''
}

/** Pipe animation from live fill ticks — not a replay after hang-up. */
export function liveDispensingFromPumpState(
  pumpLiveState: Record<string, PumpLiveState>,
  connections: Record<string, unknown>[] = [],
  pumps: Record<string, unknown>[] = [],
  now = 0,
): Record<string, ActiveDispensingState> {
  const out: Record<string, ActiveDispensingState> = {}
  for (const [key, live] of Object.entries(pumpLiveState)) {
    const sale = live.latestSale
    if (!sale || !live.isRecentlyActive) continue
    if (!inProgressSaleStatus(sale.status)) continue
    const conn = connectionForPump(sale.pumpId || key, connections, pumps)
    const vol = Number(sale.volumeLiters || 0)
    const amt = Number(sale.amount || 0)
    out[key] = {
      transactionId: sale.transactionId,
      pumpId: key,
      tankId: conn?.tankId ? String(conn.tankId) : '',
      finalVolume: vol,
      finalAmount: amt,
      currentVolume: vol,
      currentAmount: amt,
      phase: 'DISPENSING',
      startedAt: now,
      durationMs: 1,
      product: sale.product || undefined,
      connectionId: conn?.id ? String(conn.id) : undefined,
    }
  }
  return out
}
