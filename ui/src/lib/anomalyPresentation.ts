import { paginateItems } from './salesDateFilter'

export const ANOMALY_PAGE_SIZES = [10, 25, 50] as const
export const DEFAULT_ANOMALY_PAGE_SIZE = 10

export type AnomalyIssueFilter = 'ALL' | 'PRICE' | 'VALUE' | 'MAPPING'

export type IntegrityTransaction = {
  transactionId: string
  pumpId?: string | null
  nozzleId?: string | null
  product?: string | null
  volumeLiters?: number | null
  pricePerLiter?: number | null
  recordedAmount?: number | null
  calculatedAmount?: number | null
  difference?: number | null
  flags?: string[]
  receivedAt?: string | null
  completedAt?: string | null
}

export type IntegrityAnomaly = {
  code?: string
  severity?: string
  transactionId?: string
  message?: string
  pumpId?: string | null
  nozzleId?: string | null
  product?: string | null
  volumeLiters?: number | null
  amount?: number | null
  recordedAmount?: number | null
  pricePerLiter?: number | null
  calculatedAmount?: number | null
  difference?: number | null
  receivedAt?: string | null
  completedAt?: string | null
}

type AnomalyCopy = { label: string; description: string }

const ANOMALY_COPY: Record<string, AnomalyCopy> = {
  SUSPICIOUS_UNIT_PRICE: {
    label: 'Price issue',
    description: 'The transaction unit price is outside the expected range.',
  },
  METER_VALUE_MISMATCH: {
    label: 'Value mismatch',
    description: 'The recorded amount differs from volume × transaction unit price.',
  },
  MISSING_NOZZLE_MAPPING: {
    label: 'No nozzle mapping',
    description: 'The transaction nozzle is not mapped to a configured nozzle/tank.',
  },
  MISSING_PRODUCT_MAPPING: {
    label: 'No product mapping',
    description: 'The transaction product could not be resolved from the configured mapping.',
  },
  MISSING_PUMP_MAPPING: {
    label: 'No pump mapping',
    description: 'The transaction pump is not mapped to a configured pump.',
  },
  MISSING_TANK_MAPPING: {
    label: 'No tank mapping',
    description: 'The pump or product has no configured tank mapping.',
  },
  DUPLICATE_TRANSACTION_ID: {
    label: 'Duplicate ID',
    description: 'This transaction ID appears more than once and was counted once.',
  },
  ZERO_OR_NEGATIVE_VOLUME: {
    label: 'Volume issue',
    description: 'The transaction volume is zero or negative.',
  },
  ZERO_OR_NEGATIVE_AMOUNT: {
    label: 'Amount issue',
    description: 'The recorded amount is zero or negative.',
  },
  IMPOSSIBLE_PRICE: {
    label: 'Invalid price',
    description: 'The unit price is missing, zero, or negative.',
  },
  LATE_ARRIVING_TRANSACTION: {
    label: 'Late arrival',
    description: 'The transaction arrived after the business-day window closed.',
  },
}

const FILTER_CODES: Record<Exclude<AnomalyIssueFilter, 'ALL'>, string[]> = {
  PRICE: ['SUSPICIOUS_UNIT_PRICE', 'IMPOSSIBLE_PRICE'],
  VALUE: ['METER_VALUE_MISMATCH'],
  MAPPING: [
    'MISSING_NOZZLE_MAPPING',
    'MISSING_PRODUCT_MAPPING',
    'MISSING_PUMP_MAPPING',
    'MISSING_TANK_MAPPING',
  ],
}

export const ISSUE_FILTERS: { id: AnomalyIssueFilter; label: string }[] = [
  { id: 'ALL', label: 'All' },
  { id: 'PRICE', label: 'Price issues' },
  { id: 'VALUE', label: 'Value mismatch' },
  { id: 'MAPPING', label: 'Missing mappings' },
]

function humanizeCode(code: string) {
  return code
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (ch) => ch.toUpperCase())
}

export function getAnomalyLabel(flag?: string | null) {
  if (!flag) return 'Issue'
  return ANOMALY_COPY[flag]?.label || humanizeCode(flag)
}

export function getAnomalyDescription(flag?: string | null) {
  if (!flag) return 'This transaction has an integrity issue.'
  return ANOMALY_COPY[flag]?.description || `${humanizeCode(flag)} was flagged for this transaction.`
}

export function matchesIssueFilter(flags: string[] | undefined, filter: AnomalyIssueFilter) {
  if (filter === 'ALL') return true
  const wanted = FILTER_CODES[filter]
  return (flags || []).some((flag) => wanted.includes(flag))
}

export function reviewTransactions(input?: {
  transactions?: IntegrityTransaction[] | null
  anomalies?: IntegrityAnomaly[] | null
}): IntegrityTransaction[] {
  const rows: IntegrityTransaction[] = (input?.transactions || []).map((tx) => ({
    ...tx,
    transactionId: String(tx.transactionId),
    flags: [...(tx.flags || [])],
  }))
  const byId = new Map(rows.map((row) => [row.transactionId, row]))

  for (const anomaly of input?.anomalies || []) {
    const id = anomaly.transactionId ? String(anomaly.transactionId) : ''
    if (!id) continue
    let row = byId.get(id)
    if (!row) {
      row = {
        transactionId: id,
        pumpId: anomaly.pumpId,
        nozzleId: anomaly.nozzleId,
        product: anomaly.product,
        volumeLiters: anomaly.volumeLiters,
        pricePerLiter: anomaly.pricePerLiter,
        recordedAmount: anomaly.amount ?? anomaly.recordedAmount,
        calculatedAmount: anomaly.calculatedAmount,
        difference: anomaly.difference,
        flags: [],
        receivedAt: anomaly.receivedAt,
        completedAt: anomaly.completedAt,
      }
      byId.set(id, row)
      rows.push(row)
    }
    if (anomaly.code && !row.flags!.includes(anomaly.code)) {
      row.flags!.push(anomaly.code)
    }
    if (!row.receivedAt && anomaly.receivedAt) row.receivedAt = anomaly.receivedAt
    if (!row.completedAt && anomaly.completedAt) row.completedAt = anomaly.completedAt
  }

  return rows.filter((row) => (row.flags || []).length > 0)
}

export function paginateReviewRows<T>(items: T[], page: number, pageSize: number) {
  return paginateItems(items, page, pageSize)
}

export type ReviewSortKey = 'difference' | 'volume' | 'recorded'

export function sortReviewRows(
  rows: IntegrityTransaction[],
  key: ReviewSortKey | null,
  direction: 'asc' | 'desc',
) {
  if (!key) return rows
  const sign = direction === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const av =
      key === 'difference'
        ? Number(a.difference ?? 0)
        : key === 'volume'
          ? Number(a.volumeLiters ?? 0)
          : Number(a.recordedAmount ?? 0)
    const bv =
      key === 'difference'
        ? Number(b.difference ?? 0)
        : key === 'volume'
          ? Number(b.volumeLiters ?? 0)
          : Number(b.recordedAmount ?? 0)
    if (av === bv) return 0
    return av > bv ? sign : -sign
  })
}

export function shortTransactionId(id?: string | null) {
  const value = String(id || '')
  return value.length > 8 ? value.slice(0, 8) : value || '—'
}

export function pageWindow(page: number, pageCount: number) {
  const start = Math.max(1, Math.min(page - 2, pageCount - 4))
  const from = Math.max(1, start)
  const to = Math.min(pageCount, from + 4)
  const pages: number[] = []
  for (let n = from; n <= to; n += 1) pages.push(n)
  return pages
}
