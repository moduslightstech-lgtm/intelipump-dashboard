import { describe, expect, it } from 'vitest'
import { isAdmin, normalizeRole } from '../lib/roles'

describe('layout edit access', () => {
  it('admin can edit and save', () => {
    expect(isAdmin('ADMIN')).toBe(true)
    expect(normalizeRole('ADMIN')).toBe('ADMIN')
  })

  it('super admin is treated as admin', () => {
    expect(isAdmin('SUPER_ADMIN')).toBe(true)
    expect(isAdmin('SUPERADMIN')).toBe(true)
    expect(normalizeRole('SUPERADMIN')).toBe('SUPER_ADMIN')
  })

  it('station manager is read-only for layout', () => {
    expect(isAdmin('STATION_MANAGER')).toBe(false)
    expect(normalizeRole('STATION_MANAGER')).toBe('STATION_MANAGER')
  })
})
