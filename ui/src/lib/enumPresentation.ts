/**
 * Shared presentation labels for machine-readable enum / status codes.
 * Backend keeps stable SCREAMING_SNAKE values; UI never shows them raw.
 */

const STATUS_LABELS: Record<string, string> = {
  // Reconciliation workflow
  AWAITING_REPORTED_SALES: 'Awaiting reported sales',
  AWAITING_TANK_READING: 'Awaiting tank reading',
  READY_TO_CLOSE: 'Ready to close',
  READY_FOR_REVIEW: 'Ready for review',
  NEEDS_ATTENTION: 'Needs attention',
  INCOMPLETE: 'Incomplete',
  WAITING: 'Waiting',
  REVIEW: 'Needs review',
  REVIEW_REQUIRED: 'Needs review',
  COMPLETED: 'Completed',
  CLOSED: 'Closed',
  RECONCILED: 'Reconciled',
  DRAFT: 'Draft',
  VOIDED: 'Voided',
  REOPENED: 'Reopened',
  SUBMITTED: 'Submitted',
  ACCEPTED: 'Accepted',
  CORRECTED: 'Amended',
  NOT_STARTED: 'Not started',
  LATE: 'Late submission',
  LATE_SUBMISSION: 'Late submission',
  LATE_DATA_RECEIVED: 'Reconciliation changed after closing',
  ON_TIME: 'On time',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  FAILED: 'Failed',
  PENDING: 'Pending',
  MATCH: 'Reconciled',
  MATCHED: 'Reconciled',
  TILL_MATCHES: 'Till matches',
  STOCK_MATCHES: 'Stock matches',
  WITHIN_TOLERANCE: 'Small variance',
  SHORT: 'Needs review',
  OVER: 'Needs review',
  VARIANCE: 'Needs review',
  NOT_ENTERED: 'Not entered',
  MISSING_DATA: 'Missing information',
  MISSING_OPENING_READING: 'Missing opening reading',
  MISSING_CLOSING_READING: 'Missing closing reading',
  MISSING_TANK_READING: 'Missing tank reading',
  MISSING_PRODUCT_MAPPING: 'Product not mapped',
  MISSING_NOZZLE_MAPPING: 'Nozzle not mapped',
  MISSING_PUMP_MAPPING: 'Pump not mapped',
  MISSING_TANK_MAPPING: 'Tank not mapped',
  METER_VALUE_MISMATCH: 'Meter values do not match',
  SUSPICIOUS_UNIT_PRICE: 'Unusual unit price',
  // Transactions / pumps
  DISPENSING: 'Dispensing',
  IN_PROGRESS: 'In progress',
  SALE_COMPLETED: 'Sale complete',
  // Station operational / connectivity
  OPEN: 'Open',
  CLOSED_OP: 'Closed',
  OPENING: 'Opening',
  CLOSING: 'Closing',
  ONLINE: 'Online',
  OFFLINE: 'Offline',
  DEGRADED: 'Degraded',
  UNKNOWN: 'Unknown',
  ACTIVE: 'Active',
  INACTIVE: 'Inactive',
  NEVER_CONNECTED: 'Never connected',
  CURRENT: 'Current',
  DELAYED: 'Delayed',
  INFERRED: 'Inferred',
  MANUAL: 'Manual',
}

function sentenceCaseFallback(value: string): string {
  const words = value
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  if (!words.length) return '—'
  return words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ')
}

/** User-facing label for any dashboard status / enum code. */
export function formatStatusLabel(value?: string | null): string {
  if (value == null || String(value).trim() === '') return '—'
  const key = String(value).trim().toUpperCase()
  if (STATUS_LABELS[key]) return STATUS_LABELS[key]
  return sentenceCaseFallback(String(value))
}

export function hasStatusLabel(value?: string | null): boolean {
  if (!value) return false
  return Boolean(STATUS_LABELS[String(value).trim().toUpperCase()])
}

/** @deprecated Prefer formatStatusLabel — kept for callers still importing humanizeEnum style. */
export function humanizeEnumLabel(value?: string | null): string {
  return formatStatusLabel(value)
}
