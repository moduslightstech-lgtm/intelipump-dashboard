/** Status indicator for a single nozzle panel. */

import { pumpStatusLabel } from '../../display'

export type NozzleStatusKind =
  | 'IDLE'
  | 'DISPENSING'
  | 'SALE_COMPLETED'
  | 'OFFLINE'
  | 'FAULT'
  | 'POWERED_OFF'
  | 'INACTIVE'
  | 'UNKNOWN'

const STATUS_COLOR: Record<string, string> = {
  IDLE: '#3B82F6',
  READY: '#38BDF8',
  DISPENSING: '#22C55E',
  SALE_COMPLETED: '#34D399',
  OFFLINE: '#EF4444',
  FAULT: '#F97316',
  POWERED_OFF: '#94A3B8',
  INACTIVE: '#64748B',
  UNKNOWN: '#94A3B8',
}

export type NozzleStatusProps = {
  status: NozzleStatusKind | string
  reducedMotion?: boolean
}

export function nozzleStatusColor(status: string): string {
  const key = String(status || 'UNKNOWN').toUpperCase()
  return STATUS_COLOR[key] || STATUS_COLOR.UNKNOWN
}

export function NozzleStatus({ status, reducedMotion = false }: NozzleStatusProps) {
  const normalized = String(status || 'UNKNOWN').toUpperCase()
  const color = nozzleStatusColor(normalized)
  const completed = normalized === 'SALE_COMPLETED'
  const dispensing = normalized === 'DISPENSING'
  const label =
    completed ? 'Sale completed' : pumpStatusLabel(normalized === 'SALE_COMPLETED' ? 'SALE_COMPLETED' : normalized)

  return (
    <div
      className="mt-2 flex items-center gap-2 text-[15px] font-semibold"
      style={{ color }}
      data-testid="nozzle-status"
      data-status={normalized}
      aria-label={`Status: ${label}`}
    >
      {completed ? (
        <span
          className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[11px] font-bold text-slate-950"
          style={{ background: color }}
          aria-hidden
        >
          ✓
        </span>
      ) : (
        <span
          className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${
            dispensing && !reducedMotion ? 'nozzle-status-pulse' : ''
          }`}
          style={{ background: color }}
          aria-hidden
        />
      )}
      <span>{label}</span>
      {dispensing && !reducedMotion ? (
        <span className="sr-only" aria-live="polite">
          Dispensing in progress
        </span>
      ) : null}
    </div>
  )
}

export default NozzleStatus
