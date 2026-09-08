import { fmtSignedNaira, type DayCloseRow } from '../api/client'

export type ReconTab = 'summary' | 'transactions' | 'tanks' | 'audit'
export type StatusFilter = '' | 'NEEDS_ATTENTION' | 'INCOMPLETE' | 'READY_TO_CLOSE' | 'CLOSED'

const OK = new Set([
  'MATCH',
  'TILL_MATCHES',
  'STOCK_MATCHES',
  'READY_FOR_REVIEW',
  'CLOSED',
  'RECONCILED',
])
const WARN = new Set([
  'WAITING',
  'INCOMPLETE',
  'AWAITING_REPORTED_SALES',
  'AWAITING_TANK_READING',
  'DRAFT',
  'NOT_ENTERED',
  'WITHIN_TOLERANCE',
  'REOPENED',
])

export function statusBadge(status?: string | null) {
  const key = (status || '').toUpperCase()
  if (OK.has(key)) return { text: status || 'Match', className: 'badge-ok' }
  if (WARN.has(key)) return { text: status || 'Incomplete', className: 'badge-warn' }
  return { text: status || 'Review', className: 'badge-critical' }
}

export function formatBusinessDate(iso?: string | null) {
  if (!iso) return '—'
  const [year, month, day] = iso.split('-').map(Number)
  if (!year || !month || !day) return iso
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

export function financialVarianceAmount(row: DayCloseRow): number | null {
  const value = row.financial?.variance ?? row.tillVariance
  return value == null ? null : Number(value)
}

export function formatFinancialVariance(row: DayCloseRow) {
  return fmtSignedNaira(financialVarianceAmount(row))
}

export function financialStatus(row: DayCloseRow) {
  return row.financial?.status || (row.till?.captured ? 'WAITING' : 'WAITING')
}

export function workflowStatus(row: DayCloseRow) {
  return row.workflowStatus || row.status || 'DRAFT'
}

export function attentionGroup(row: DayCloseRow): Exclude<StatusFilter, ''> {
  const wf = workflowStatus(row).toUpperCase()
  if (wf === 'CLOSED' || wf === 'RECONCILED') return 'CLOSED'
  if (wf === 'READY_FOR_REVIEW') return 'READY_TO_CLOSE'
  if (
    wf === 'REVIEW_REQUIRED' ||
    row.financial?.status === 'SHORT' ||
    row.financial?.status === 'OVER' ||
    row.integrity?.status === 'REVIEW' ||
    row.inventory?.status === 'SHORT' ||
    row.inventory?.status === 'OVER' ||
    row.inventory?.status === 'REVIEW_REQUIRED' ||
    row.lateDataReceived ||
    row.lateData?.flag
  ) {
    return 'NEEDS_ATTENTION'
  }
  return 'INCOMPLETE'
}

export function matchesStatusFilter(row: DayCloseRow, filter: StatusFilter) {
  if (!filter) return true
  return attentionGroup(row) === filter
}

export function filterCounts(rows: DayCloseRow[]) {
  return {
    all: rows.length,
    needsAttention: rows.filter((r) => attentionGroup(r) === 'NEEDS_ATTENTION').length,
    incomplete: rows.filter((r) => attentionGroup(r) === 'INCOMPLETE').length,
    ready: rows.filter((r) => attentionGroup(r) === 'READY_TO_CLOSE').length,
    closed: rows.filter((r) => attentionGroup(r) === 'CLOSED').length,
  }
}

export function closeBlocker(row: DayCloseRow): string | null {
  const wf = workflowStatus(row).toUpperCase()
  if (wf === 'CLOSED' || wf === 'RECONCILED') return 'This reconciliation is already closed.'
  if (row.financial?.status === 'WAITING' || wf === 'AWAITING_REPORTED_SALES') {
    return 'Reported sales must be entered before closing.'
  }
  if (
    row.inventory?.status === 'INCOMPLETE' ||
    wf === 'AWAITING_TANK_READING' ||
    wf === 'INCOMPLETE'
  ) {
    const missingOpening = row.inventory?.tanks?.some((tank) => tank.openingMissing)
    if (missingOpening) return 'Tank inventory must be completed before closing. Opening stock is missing.'
    return 'Tank inventory must be completed before closing.'
  }
  if (wf === 'DRAFT') return 'Confirm pump data before closing.'
  return null
}

export function closeDisabledExplanation(blocker: string | null): string | null {
  if (!blocker) return null
  if (/tank inventory/i.test(blocker)) {
    return 'Tank inventory must be completed before this reconciliation can be closed.'
  }
  return blocker
}

export function inventoryWarning(row: DayCloseRow): string | null {
  const tanks = row.inventory?.tanks || []
  const missingOpening = tanks.filter((tank) => tank.openingMissing)
  const missingClosing = tanks.filter(
    (tank) => !tank.openingMissing && tank.actualClosingLiters == null,
  )
  if (row.inventory?.enterBaselineOpening && missingOpening.length) {
    return 'Enter a baseline opening on Tank Reading.'
  }
  if (missingOpening.length) {
    return missingOpening[0].blocker || 'Opening stock is missing. Use the previous verified closing, or enter a baseline opening.'
  }
  if (missingClosing.length) {
    return missingClosing[0].blocker || 'Closing stock reading is missing.'
  }
  if (row.inventory?.status === 'INCOMPLETE') {
    return tanks.find((tank) => tank.blocker)?.blocker || 'Tank inventory is incomplete.'
  }
  return null
}

export function todayBusinessDate() {
  try {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' })
  } catch {
    return new Date().toISOString().slice(0, 10)
  }
}
