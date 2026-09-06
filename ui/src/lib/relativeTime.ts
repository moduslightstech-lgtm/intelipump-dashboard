/** Relative time helpers for edge-device heartbeats (no extra deps). */

export function formatRelativeHeartbeat(
  seconds?: number | null,
  iso?: string | null,
  opts?: { nowMs?: number },
): string {
  if (typeof seconds === 'number' && Number.isFinite(seconds)) {
    if (seconds < 5) return 'Just now'
    if (seconds < 60) return `${seconds} seconds ago`
    if (seconds < 120) return '1 minute ago'
    if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes ago`
    if (seconds < 7200) return '1 hour ago'
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`
    return `${Math.floor(seconds / 86400)} days ago`
  }
  if (!iso) return 'Never'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return 'Never'
  const age = Math.max(0, Math.floor(((opts?.nowMs ?? Date.now()) - then) / 1000))
  return formatRelativeHeartbeat(age, null, opts)
}

export function formatExactTimestamp(iso?: string | null): string {
  if (!iso) return 'Never'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'Never'
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' })
}

export function availabilityLabel(status?: string | null): string {
  const v = (status || 'UNKNOWN').toUpperCase()
  if (v === 'ONLINE') return 'Online'
  if (v === 'DELAYED' || v === 'STALE') return 'Delayed'
  if (v === 'OFFLINE') return 'Offline'
  if (v === 'NEVER_CONNECTED') return 'Never connected'
  return 'Status unavailable'
}

export type AvailabilityTone = 'green' | 'amber' | 'red' | 'gray'

export function availabilityTone(status?: string | null): AvailabilityTone {
  const v = (status || 'UNKNOWN').toUpperCase()
  if (v === 'ONLINE') return 'green'
  if (v === 'DELAYED' || v === 'STALE') return 'amber'
  if (v === 'OFFLINE') return 'red'
  return 'gray'
}
