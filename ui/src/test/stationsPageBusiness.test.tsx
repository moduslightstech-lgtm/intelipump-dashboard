import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { formatStatusLabel } from '../lib/enumPresentation'

vi.mock('../api/client', () => ({
  fmtNaira: (n: number) => `₦${n}`,
  fmtLiters: (n: number) => `${n} L`,
  getStations: async () => ({
    data: [
      {
        id: 's1',
        station_code: 'US-LAB-001',
        mqtt_station_id: 'InteliPump-US-Lab',
        name: 'InteliPump Lab',
        operational_status: 'OPEN',
        connectivity_status: 'ONLINE',
      },
    ],
  }),
  getStationPerformance: async () => ({
    data: [{ station_id: 'US-LAB-001', amount: 1000, volume: 1, count: 2 }],
  }),
  getPumps: async () => ({
    data: [
      { id: 'p1', station_id: 's1', pump_code: 'pump-1', active: true },
      { id: 'p2', station_id: 's1', pump_code: 'pump-2', active: false },
    ],
  }),
  getAlerts: async () => ({ data: [] }),
}))

import StationsPage from '../pages/StationsPage'

describe('StationsPage business view', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('omits Chicago / edge Pi subtitle and counts only active physical pumps', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <StationsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(await screen.findByText('Monitor sales and station activity')).toBeInTheDocument()
    expect(screen.queryByText(/America\/Chicago/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Raspberry Pi/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Operational vs edge/i)).not.toBeInTheDocument()
    expect(await screen.findByTestId('station-pump-count')).toHaveTextContent('1')
  })
})

describe('status labels used by stations', () => {
  it('formats operating status without raw enums', () => {
    expect(formatStatusLabel('OPEN')).toBe('Open')
  })
})
