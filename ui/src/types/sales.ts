/** Live sales contracts from DigitalOcean `/api/v1/sales/*` and SSE `sale.created`. */

export interface PumpSale {
  transactionId: string
  stationId: string
  pumpId: string
  nozzleId: string | null
  product: string | null
  volumeLiters: number | null
  amount: number | null
  currency: string
  pricePerLiter: number | null
  status: string | null
  sourceTopic: string | null
  receivedAt: string
}

export interface RecentSalesResponse {
  count: number
  sales: PumpSale[]
}

export interface SalesSummary {
  stationId: string
  period: string
  transactionCount: number
  totalAmount: number
  totalVolumeLiters: number
  averageTransactionAmount: number
  latestTransactionAt: string | null
}

export interface SaleCreatedEvent {
  type: 'sale.created'
  occurredAt: string
  transaction: PumpSale
}

export interface PumpLiveState {
  pumpId: string
  latestSale: PumpSale | null
  lastSaleAt: string | null
  todaySalesAmount: number
  todayVolumeLiters: number
  todayTransactionCount: number
  liveActivityStatus: 'ACTIVE' | 'IDLE' | 'NO_DATA'
  isRecentlyActive: boolean
}

export type LiveStreamStatus =
  | 'CONNECTING'
  | 'LIVE'
  | 'RECONNECTING'
  | 'DISCONNECTED'
  | 'ERROR'

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function parsePumpSale(raw: unknown): PumpSale | null {
  if (!raw || typeof raw !== 'object') return null
  const d = raw as Record<string, unknown>
  const transactionId = String(d.transactionId || '').trim()
  const stationId = String(d.stationId || '').trim()
  const pumpId = String(d.pumpId || '').trim()
  if (!transactionId || !stationId || !pumpId) return null
  return {
    transactionId,
    stationId,
    pumpId,
    nozzleId: d.nozzleId == null || d.nozzleId === '' ? null : String(d.nozzleId),
    product: d.product == null || d.product === '' ? null : String(d.product),
    volumeLiters: num(d.volumeLiters),
    amount: num(d.amount),
    currency: displayCurrency(d.currency == null ? null : String(d.currency)),
    pricePerLiter: num(d.pricePerLiter),
    status: d.status == null || d.status === '' ? null : String(d.status),
    sourceTopic: d.sourceTopic == null || d.sourceTopic === '' ? null : String(d.sourceTopic),
    receivedAt: String(d.receivedAt || d.occurredAt || new Date().toISOString()),
  }
}

export function parseSaleCreatedEvent(raw: unknown): SaleCreatedEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const d = raw as Record<string, unknown>
  const transaction = parsePumpSale(d.transaction)
  if (!transaction) return null
  return {
    type: 'sale.created',
    occurredAt: String(d.occurredAt || transaction.receivedAt),
    transaction,
  }
}

export function parseSalesSummary(raw: unknown): SalesSummary {
  const d = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    stationId: String(d.stationId || ''),
    period: String(d.period || 'TODAY'),
    transactionCount: Number(d.transactionCount || 0),
    totalAmount: Number(d.totalAmount || 0),
    totalVolumeLiters: Number(d.totalVolumeLiters || 0),
    averageTransactionAmount: Number(d.averageTransactionAmount || 0),
    latestTransactionAt:
      d.latestTransactionAt == null || d.latestTransactionAt === ''
        ? null
        : String(d.latestTransactionAt),
  }
}

export function parseRecentSales(raw: unknown): RecentSalesResponse {
  const d = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const list = Array.isArray(d.sales) ? d.sales : []
  const sales = list.map(parsePumpSale).filter((s): s is PumpSale => s != null)
  return { count: Number(d.count ?? sales.length), sales }
}

export function applySaleToSummary(current: SalesSummary, sale: PumpSale): SalesSummary {
  const totalAmount = current.totalAmount + (sale.amount ?? 0)
  const totalVolumeLiters = current.totalVolumeLiters + (sale.volumeLiters ?? 0)
  const transactionCount = current.transactionCount + 1
  return {
    ...current,
    totalAmount,
    totalVolumeLiters,
    transactionCount,
    averageTransactionAmount: transactionCount > 0 ? totalAmount / transactionCount : 0,
    latestTransactionAt: sale.receivedAt,
  }
}

/** Stations settle in naira. Ignore USD leftovers from older MQTT rows. */
export function displayCurrency(_currency?: string | null): string {
  return 'NGN'
}

export function formatSaleAmount(amount: number | null | undefined, _currency = 'NGN'): string {
  if (amount == null || !Number.isFinite(amount)) return '—'
  return new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
    maximumFractionDigits: 2,
  }).format(amount)
}
