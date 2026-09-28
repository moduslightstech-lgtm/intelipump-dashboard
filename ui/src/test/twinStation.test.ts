import { describe, expect, it } from 'vitest'
import type { Station } from '../api/client'
import { canonicalTwinStationId, resolveAccessibleStation } from '../lib/twinStation'

const lab: Station = {
  id: 'lab-uuid',
  station_code: 'US-LAB-001',
  mqtt_station_id: 'InteliPump-US-Lab',
  name: 'InteliPump US Lab',
  address: null,
  city: null,
  state: null,
  timezone: 'America/Chicago',
  status: 'ACTIVE',
}

const sao: Station = {
  id: 'sao-uuid',
  station_code: 'SAO-RS-001',
  mqtt_station_id: 'SAO-Redeemed-Station-1',
  name: 'SAO Redeemed Station 1',
  address: null,
  city: null,
  state: null,
  timezone: 'Africa/Lagos',
  status: 'ACTIVE',
}

describe('resolveAccessibleStation', () => {
  it('maps stale LAB-001 onto US-LAB-001 when Lab is visible', () => {
    expect(resolveAccessibleStation([lab, sao], 'LAB-001')?.station_code).toBe('US-LAB-001')
    expect(canonicalTwinStationId(lab)).toBe('US-LAB-001')
  })

  it('falls back to the company station when Lab is not visible', () => {
    expect(resolveAccessibleStation([sao], 'LAB-001')?.station_code).toBe('SAO-RS-001')
  })

  it('keeps an exact catalog match', () => {
    expect(resolveAccessibleStation([lab, sao], 'SAO-RS-001')?.id).toBe('sao-uuid')
  })
})
