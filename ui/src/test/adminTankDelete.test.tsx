import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import AdminStationTanksPage from '../pages/admin/AdminStationTanksPage'
import TransactionsPage from '../pages/TransactionsPage'
import Layout from '../components/layout/Layout'
import { humanizeEnum, fmtTime } from '../api/client'
import { stationDayStartIso } from '../lib/salesDateFilter'
import * as client from '../api/client'

const authState = {
  user: { email: 'admin@example.com', role: 'ADMIN', normalizedRole: 'ADMIN' as const },
  token: 't',
  logout: () => undefined,
}

vi.mock('../context/AuthContext', () => ({
  useAuth: () => authState,
}))

vi.mock('../hooks/useLiveEvents', () => ({
  useLiveEvents: () => undefined,
}))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return {
    ...actual,
    useOutletContext: () => ({
      stationId: 'st1',
      station: { id: 'st1', name: 'Lab', station_code: 'US-LAB-001' },
      refreshStation: () => undefined,
    }),
  }
})

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
}

describe('humanizeEnum and dates', () => {
  it('title-cases underscored enums', () => {
    expect(humanizeEnum('heartbeat_timeout_during_operating_hours')).toBe(
      'Heartbeat Timeout During Operating Hours',
    )
  })

  it('formats timestamps as Sep 7, 2026, 6:14 PM style', () => {
    const text = fmtTime('2026-09-07T17:14:00.000Z')
    expect(text).toMatch(/Sep 7, 2026/)
    expect(text).toMatch(/PM|AM/)
  })

  it('uses Africa/Lagos for day bounds', () => {
    const start = stationDayStartIso('2026-09-07', 'Africa/Lagos')
    expect(start).toBe('2026-09-06T23:00:00.000Z')
  })
})

describe('Transactions table', () => {
  beforeEach(() => {
    vi.spyOn(client, 'getStations').mockResolvedValue({
      data: [
        {
          id: 'st1',
          station_code: 'US-LAB-001',
          name: 'InteliPump US Lab',
          timezone: 'Africa/Lagos',
        },
      ],
    } as any)
    vi.spyOn(client, 'getTransactions').mockResolvedValue({
      data: {
        items: [
          {
            id: 'tx-1',
            station_id: 'InteliPump-US-Lab',
            pump_id: 'PUMP-01',
            nozzle_id: null,
            product: null,
            volume_liters: 10,
            price_per_liter: 800,
            amount: 8000,
            status: 'COMPLETED',
            received_at: '2026-09-07T17:14:00.000Z',
          },
        ],
        total: 1,
        page: 1,
        size: 20,
        total_amount: 8000,
        total_volume: 10,
        average_amount: 8000,
      },
    } as any)
  })

  it('renders Amount and Status in separate cells', async () => {
    render(wrap(<MemoryRouter><TransactionsPage /></MemoryRouter>))
    expect(await screen.findByTestId('tx-amount')).toBeInTheDocument()
    expect(screen.getByTestId('tx-status')).toBeInTheDocument()
    expect(screen.getByTestId('tx-amount').textContent).not.toEqual(screen.getByTestId('tx-status').textContent)
    expect(screen.getByTestId('tx-status')).toHaveTextContent('Completed')
    expect(screen.getAllByText('Not mapped').length).toBeGreaterThan(0)
  })
})

describe('Admin tank delete', () => {
  beforeEach(() => {
    vi.spyOn(client, 'getTanks').mockResolvedValue({
      data: [
        {
          id: 'tank-1',
          tankCode: 'PMS-01',
          name: 'PMS tank',
          product: 'PMS',
          capacityLiters: 45000,
          status: 'ACTIVE',
        },
      ],
    } as any)
    vi.spyOn(client, 'getTankDeletionPreview').mockResolvedValue({
      data: {
        tankId: 'tank-1',
        tankCode: 'PMS-01',
        name: 'PMS tank',
        product: 'PMS',
        capacityLiters: 45000,
        status: 'ACTIVE',
        stationId: 'st1',
        stationName: 'Lab',
        mode: 'HARD_DELETE',
        alreadyDeleted: false,
        requiresDisconnect: false,
        requiresCodeConfirm: false,
        explanation: 'This tank has no connections or historical records and will be permanently deleted.',
        connections: [],
        history: {
          readings: 0,
          measurements: 0,
          deliveries: 0,
          reconciliationItems: 0,
          alerts: 0,
          layoutItems: 0,
          expectedState: 0,
          total: 0,
        },
      },
    } as any)
  })

  it('shows Delete for admins and keeps the row after a failed delete', async () => {
    vi.spyOn(client, 'deleteAdminTank').mockRejectedValue({
      response: { data: { detail: { message: 'Could not delete tank' } } },
    })
    render(
      wrap(
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route
              path="/"
              element={<AdminStationTanksPage />}
            />
          </Routes>
        </MemoryRouter>,
      ),
    )
    expect(await screen.findByRole('button', { name: 'Delete' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(await screen.findByText('Delete tank?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Delete tank' }))
    expect(await screen.findByText(/Could not delete tank/i)).toBeInTheDocument()
    expect(screen.getAllByText('PMS-01').length).toBeGreaterThan(0)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})

describe('layout scroll ownership', () => {
  it('does not give main an independent vertical scrollbar', () => {
    render(
      wrap(
        <MemoryRouter>
          <Layout />
        </MemoryRouter>,
      ),
    )
    const main = document.querySelector('main')
    expect(main?.className).not.toContain('overflow-y-auto')
  })
})
