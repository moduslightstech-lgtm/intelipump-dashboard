import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { role: 'STATION_MANAGER', normalizedRole: 'STATION_MANAGER' },
  }),
}))

vi.mock('../api/client', () => ({
  getStationManagerStations: vi.fn(async () => ({
    data: [{ id: 'st-1', name: 'Boluwaji', stationCode: 'BLJ-IB001' }],
  })),
  getStationManagerCurrentReadings: vi.fn(async () => ({
    data: {
      businessDate: '2026-07-15',
      deadlineLocal: '22:30',
      uiStatus: 'NOT_STARTED',
      batch: { status: 'NOT_STARTED', id: null },
      tanks: [
        {
          tankId: 't1',
          tankCode: 'T1',
          name: 'PMS',
          product: 'PMS',
          capacityLiters: 30000,
        },
      ],
      station: { name: 'Boluwaji' },
    },
  })),
  getStationManagerHistory: vi.fn(async () => ({
    data: {
      items: [
        {
          id: 'b1',
          businessDate: '2026-07-14',
          stationName: 'Boluwaji',
          status: 'SUBMITTED',
          totalClosingVolumeLiters: 58420,
          submittedBy: { name: 'Manager A' },
          submittedAt: '2026-07-14T21:21:00Z',
          tankCount: 3,
          expectedTankCount: 3,
        },
      ],
      page: 1,
      pageSize: 15,
      total: 1,
      hasMore: false,
    },
  })),
  getTankReadingAudit: vi.fn(async () => ({ data: [] })),
  saveTankReadingDraft: vi.fn(),
  submitTankReadings: vi.fn(),
  correctTankReadingBatch: vi.fn(),
}))

import TankReadingsPage from '../pages/station-manager/TankReadingsPage'

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  )
}

describe('Tank Reading page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders history-first layout and Add New Entry', async () => {
    render(wrap(<TankReadingsPage />))
    expect(await screen.findByText('Tank Reading')).toBeInTheDocument()
    expect(await screen.findByText('Previous submissions')).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: /Add New Entry/i })).toBeInTheDocument()
    expect(await screen.findByText('2026-07-14')).toBeInTheDocument()
    expect(screen.getByText(/58,420 L/)).toBeInTheDocument()
  })

  it('shows only closing volume and optional notes', async () => {
    render(wrap(<TankReadingsPage />))
    await screen.findByText('2026-07-14')
    fireEvent.click(screen.getByRole('button', { name: 'Add New Entry' }))
    expect(await screen.findByText(/Closing volume \(L\)/)).toBeInTheDocument()
    expect(screen.getByText('Notes')).toBeInTheDocument()
    expect(screen.queryByText('Measured level (mm)')).not.toBeInTheDocument()
    expect(screen.queryByText('Water level (mm)')).not.toBeInTheDocument()
    expect(screen.queryByText(/Temperature/)).not.toBeInTheDocument()
  })
})
