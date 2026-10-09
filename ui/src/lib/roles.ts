export type AppRole = 'SUPER_ADMIN' | 'ADMIN' | 'EXECUTIVE' | 'STATION_MANAGER'

const SUPER_ADMIN_ALIASES = new Set(['SUPER_ADMIN', 'SUPERADMIN', 'PLATFORM_ADMIN'])
const ADMIN_ALIASES = new Set(['ADMIN', 'OPS', 'ORGANIZATION_ADMIN'])
const EXEC_ALIASES = new Set(['EXECUTIVE', 'VIEWER', 'FINANCE', 'OWNER'])
const MGR_ALIASES = new Set(['STATION_MANAGER'])

export function normalizeRole(role?: string | null): AppRole {
  const text = (role || '').trim().toUpperCase().replace(/[-\s]/g, '_')
  if (SUPER_ADMIN_ALIASES.has(text)) return 'SUPER_ADMIN'
  if (ADMIN_ALIASES.has(text) || text === 'ADMIN') return 'ADMIN'
  if (MGR_ALIASES.has(text)) return 'STATION_MANAGER'
  if (EXEC_ALIASES.has(text) || text === 'EXECUTIVE') return 'EXECUTIVE'
  return 'EXECUTIVE'
}

export function isSuperAdmin(role?: string | null): boolean {
  return normalizeRole(role) === 'SUPER_ADMIN'
}

export function isAdmin(role?: string | null): boolean {
  const r = normalizeRole(role)
  return r === 'ADMIN' || r === 'SUPER_ADMIN'
}

export function landingPath(role?: string | null): string {
  const r = normalizeRole(role)
  if (r === 'STATION_MANAGER') return '/station-manager/tank-readings'
  if (r === 'EXECUTIVE') return '/executive'
  return '/'
}

export function canAccessPath(role: AppRole, path: string): boolean {
  if (role === 'ADMIN' || role === 'SUPER_ADMIN') return true
  if (role === 'EXECUTIVE') {
    if (path.startsWith('/settings') || path.startsWith('/users') || path.startsWith('/mqtt')) return false
    if (path.startsWith('/devices') || path.startsWith('/tanks')) return false
    if (path.startsWith('/admin')) return false
    if (path.startsWith('/station-manager')) return false
    return true
  }
  // Station manager: assigned-station summary, tank readings, fuel deliveries, history, and profile.
  if (path === '/login') return true
  if (path.startsWith('/station-manager/reconciliation')) return false
  if (path.startsWith('/reconciliations')) return false
  if (path.startsWith('/pump-meter-readings')) return false
  return (
    path === '/' ||
    path.startsWith('/executive') ||
    path.startsWith('/station-manager/tank-readings') ||
    path.startsWith('/station-manager/fuel-deliveries') ||
    path.startsWith('/fuel-deliveries') ||
    path.startsWith('/station-manager/history') ||
    path.startsWith('/station-manager/profile') ||
    path === '/station-manager'
  )
}
