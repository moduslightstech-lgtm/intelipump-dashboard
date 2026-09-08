import type { PumpSale } from '../types/sales'
import { canonicalPumpId } from '../utils/pumpMatching'

/** Lab hang-up can post a twin 30–90s after the live fill settles. */
export const HANGUP_DUP_WINDOW_MS = 120_000

export function isHangupDuplicateSale(
  existing: PumpSale,
  incoming: PumpSale,
  windowMs = HANGUP_DUP_WINDOW_MS,
): boolean {
  if (existing.transactionId === incoming.transactionId) return false
  if (canonicalPumpId(existing.pumpId) !== canonicalPumpId(incoming.pumpId)) return false
  if (Number(existing.amount) !== Number(incoming.amount)) return false
  if (Number(existing.volumeLiters) !== Number(incoming.volumeLiters)) return false
  const a = Date.parse(existing.receivedAt)
  const b = Date.parse(incoming.receivedAt)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return true
  return Math.abs(b - a) <= windowMs
}

export function isInProgressSale(status?: string | null): boolean {
  const s = String(status || '').toUpperCase()
  return s === 'DISPENSING' || s === 'IN_PROGRESS' || s === 'ACTIVE'
}

export function isCompletedSale(status?: string | null): boolean {
  const s = String(status || '').toUpperCase()
  return s === 'COMPLETED' || s === 'COMPLETE'
}

/** Late FILLING_UPDATED after holster must not restart the pump box. */
export function isStaleDispensingAfterComplete(
  existing: PumpSale | null | undefined,
  incoming: PumpSale,
  windowMs = HANGUP_DUP_WINDOW_MS,
): boolean {
  if (!existing || !isCompletedSale(existing.status) || !isInProgressSale(incoming.status)) {
    return false
  }
  if (existing.transactionId === incoming.transactionId) return true
  return isHangupDuplicateSale(existing, incoming, windowMs)
}

/** Keep the first (newest) sale; drop holster twins. */
export function collapseHangupDuplicates(
  sales: PumpSale[],
  windowMs = HANGUP_DUP_WINDOW_MS,
): PumpSale[] {
  const out: PumpSale[] = []
  for (const sale of sales) {
    if (out.some((s) => isHangupDuplicateSale(s, sale, windowMs))) continue
    out.push(sale)
  }
  return out
}

