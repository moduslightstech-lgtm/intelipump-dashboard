import type { PumpSale } from '../types/sales'
import { tankIdForPump } from './liveDispensing'

function saleTimeMs(sale: PumpSale): number {
  const t = Date.parse(sale.receivedAt)
  return Number.isFinite(t) ? t : 0
}

function readingTimeMs(tank: Record<string, unknown>): number | null {
  const raw = tank.measuredAt || tank.measured_at
  if (!raw) return null
  const t = Date.parse(String(raw))
  return Number.isFinite(t) ? t : null
}

/** Last manual/probe reading minus connected-pump sales after that reading. */
export function applyLiveTankDrawdown(
  tanks: Record<string, unknown>[],
  sales: PumpSale[],
  connections: Record<string, unknown>[] = [],
  pumps: Record<string, unknown>[] = [],
): Record<string, unknown>[] {
  if (!tanks.length || !sales.length) return tanks

  const drawn = new Map<string, number>()
  for (const sale of sales) {
    const vol = Number(sale.volumeLiters || 0)
    if (!(vol > 0)) continue
    const tankId = tankIdForPump(sale.pumpId, connections, pumps)
    if (!tankId) continue
    const tank = tanks.find(
      (t) => String(t.id) === tankId || String(t.tankCode || '') === tankId,
    )
    const readingAt = tank ? readingTimeMs(tank) : null
    const when = saleTimeMs(sale)
    if (readingAt != null && when < readingAt) continue
    if (readingAt == null && Date.now() - when > 3 * 60 * 60 * 1000) continue
    drawn.set(tankId, (drawn.get(tankId) || 0) + vol)
  }

  return tanks.map((tank) => {
    const id = String(tank.id)
    const code = String(tank.tankCode || '')
    const sold = drawn.get(id) || drawn.get(code) || 0
    const base = Number(tank.reportedLiters)
    if (!Number.isFinite(base) || sold <= 0) return tank
    const estimated = Math.max(0, Math.round((base - sold) * 100) / 100)
    const capacity = Number(tank.capacityLiters)
    const fillPercent =
      Number.isFinite(capacity) && capacity > 0
        ? Math.round((estimated / capacity) * 1000) / 10
        : tank.fillPercent
    return {
      ...tank,
      reportedLiters: estimated,
      fillPercent,
      estimatedLiters: estimated,
      baselineLiters: base,
      drawnLiters: sold,
    }
  })
}
