import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { role: 'STATION_MANAGER', normalizedRole: 'STATION_MANAGER' },
  }),
}))

const currentPayload = {
  businessDate: '2026-09-10',
  todayBusinessDate: '2026-09-10',
  deadlineLocal: '22:30',
  uiStatus: 'NOT_STARTED',
  isLatePreview: false,
  alreadySubmitted: false,
  managerBackentryDays: 7,
  minSelectableDate: '2026-09-03',
  maxSelectableDate: '2026-09-10',
  timezoneUsed: 'Africa/Lagos',
  batch: { status: 'NOT_STARTED', id: null, isLate: false },
  tanks: [
    {
      tankId: 't1',
      tankCode: 'T1',
      name: 'PMS',
      product: 'PMS',
      capacityLiters: 30000,
      previousClosingVolumeLiters: 9.34,
      previousBusinessDate: '2026-09-09',
      previousClosingGapDays: 1,
    },
  ],
  station: { name: 'InteliPump Lab', timezone: 'Africa/Lagos' },
}

vi.mock('../api/client', () => ({
  getStationManagerStations: vi.fn(async () => ({
    data: [{ id: 'st-1', name: 'InteliPump Lab', stationCode: 'IP-LAB' }],
  })),
  getStationManagerCurrentReadings: vi.fn(async (_stationId: string, businessDate?: string) => ({
    data: {
      ...currentPayload,
      businessDate: businessDate || currentPayload.businessDate,
      isLatePreview: businessDate === '2026-09-09',
      tanks: currentPayload.tanks.map((t) =>
        businessDate === '2026-09-09'
          ? {
              ...t,
              previousClosingVolumeLiters: 8.1,
              previousBusinessDate: '2026-09-08',
              previousClosingGapDays: 1,
            }
          : t,
      ),
    },
  })),
  getStationManagerHistory: vi.fn(async () => ({
    data: {
      items: [
        {
          id: 'b1',
          businessDate: '2026-09-09',
          stationName: 'InteliPump Lab',
          status: 'SUBMITTED',
          isLate: true,
          totalClosingVolumeLiters: 58420,
          submittedBy: { name: 'Manager A' },
          submittedAt: '2026-09-10T08:25:00Z',
          timezoneUsed: 'Africa/Lagos',
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
  fmtLiters: (n: number | null | undefined) =>
    n == null || Number.isNaN(Number(n)) ? '—' : `${Number(n).toFixed(2)} L`,
}))

import TankReadingsPage from '../pages/station-manager/TankReadingsPage'
import { getStationManagerCurrentReadings } from '../api/client'

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

  it('renders history-first layout and Add tank readings', async () => {
    render(wrap(<TankReadingsPage />))
    expect(await screen.findByText('Tank Reading')).toBeInTheDocument()
    expect(await screen.findByText('Submission history')).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: /Add tank readings/i })).toBeInTheDocument()
    expect(await screen.findByText('Sep 9, 2026')).toBeInTheDocument()
    expect(screen.getByText(/58,420 L/)).toBeInTheDocument()
    expect(screen.getAllByText(/Late submission/i).length).toBeGreaterThan(0)
  })

  it('shows business date picker and only closing volume plus notes', async () => {
    render(wrap(<TankReadingsPage />))
    const addBtn = await screen.findByRole('button', { name: /Add tank readings/i })
    await waitFor(() => expect(addBtn).toBeEnabled())
    fireEvent.click(addBtn)
    expect(await screen.findByText(/Closing volume \(L\)/)).toBeInTheDocument()
    expect(screen.getByText('Notes')).toBeInTheDocument()
    expect(screen.queryByText('Measured level (mm)')).not.toBeInTheDocument()
  })

  it('loads previous-day workspace when business date changes in modal', async () => {
    render(wrap(<TankReadingsPage />))
    const addBtn = await screen.findByRole('button', { name: /Add tank readings/i })
    await waitFor(() => expect(addBtn).toBeEnabled())
    fireEvent.click(addBtn)
    expect(await screen.findByText(/Closing volume \(L\)/)).toBeInTheDocument()
    const dateInputs = screen.getAllByDisplayValue('2026-09-10')
    const modalDate = dateInputs[dateInputs.length - 1]
    fireEvent.change(modalDate, { target: { value: '2026-09-09' } })
    await waitFor(() => {
      expect(getStationManagerCurrentReadings).toHaveBeenCalledWith('st-1', '2026-09-09')
    })
    await waitFor(() => {
      expect(
        screen.getByPlaceholderText(/Explain why the reading was submitted after the deadline/i),
      ).toBeInTheDocument()
    })
    expect(await screen.findByText(/From Sep 8, 2026/i)).toBeInTheDocument()
  })
})
