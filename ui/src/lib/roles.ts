export type AppRole = 'ADMIN' | 'EXECUTIVE' | 'STATION_MANAGER'

const ADMIN_ALIASES = new Set(['ADMIN', 'SUPERADMIN', 'OPS', 'SUPER_ADMIN', 'ORGANIZATION_ADMIN'])
const EXEC_ALIASES = new Set(['EXECUTIVE', 'VIEWER', 'FINANCE', 'OWNER'])
const MGR_ALIASES = new Set(['STATION_MANAGER'])

export function normalizeRole(role?: string | null): AppRole {
  const text = (role || '').trim().toUpperCase()
  if (ADMIN_ALIASES.has(text) || text === 'ADMIN') return 'ADMIN'
  if (MGR_ALIASES.has(text)) return 'STATION_MANAGER'
  if (EXEC_ALIASES.has(text) || text === 'EXECUTIVE') return 'EXECUTIVE'
  return 'EXECUTIVE'
}

export function landingPath(role?: string | null): string {
  const r = normalizeRole(role)
  if (r === 'STATION_MANAGER') return '/station-manager/tank-readings'
  if (r === 'EXECUTIVE') return '/executive'
  return '/'
}

export function canAccessPath(role: AppRole, path: string): boolean {
  if (role === 'ADMIN') return true
  if (role === 'EXECUTIVE') {
    if (path.startsWith('/settings') || path.startsWith('/users') || path.startsWith('/mqtt')) return false
    if (path.startsWith('/devices') || path.startsWith('/tanks')) return false
    if (path.startsWith('/admin')) return false
    if (path.startsWith('/station-manager')) return false
    return true
  }
  // Station manager
  return path.startsWith('/station-manager') || path === '/login'
}
