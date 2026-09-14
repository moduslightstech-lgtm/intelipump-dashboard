import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { formatStatusLabel } from '../lib/enumPresentation'
import { canAccessPath } from '../lib/roles'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { role: 'STATION_MANAGER', normalizedRole: 'STATION_MANAGER' },
    logout: vi.fn(),
  }),
}))

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>()
  return {
    ...actual,
    getStationManagerStations: vi.fn(async () => ({
      data: [{ id: 'st1', name: 'US Lab', stationCode: 'US-LAB-001' }],
    })),
    getFuelDeliveryTanks: vi.fn(async () => ({
      data: [{ id: 't1', name: 'PMS Tank 1', tankCode: 'T1', product: 'PMS', capacityLiters: 45000 }],
    })),
    listFuelDeliveries: vi.fn(async () => ({
      data: {
        items: [
          {
            id: 'd1',
            stationId: 'st1',
            stationName: 'US Lab',
            tankId: 't1',
            tankName: 'PMS Tank 1',
            product: 'PMS',
            businessDate: '2026-09-10',
            deliveredAt: '2026-09-10T10:00:00Z',
            quantityLitres: 20,
            supplierName: 'NNPC',
            waybillNumber: 'WB-1',
            status: 'COMPLETED',
            version: 2,
            createdByName: 'Manager',
          },
        ],
        page: 1,
        pageSize: 25,
        total: 1,
        hasMore: false,
      },
    })),
    getFuelDeliveryStockPreview: vi.fn(async () => ({
      data: {
        lastRecordedStockLiters: 5,
        deliveryQuantityLiters: 20,
        projectedStockLiters: 25,
        tankCapacityLiters: 45000,
        projectedFillPercent: 0.06,
        possibleOverfill: false,
      },
    })),
    createFuelDelivery: vi.fn(),
    completeFuelDelivery: vi.fn(),
    voidFuelDelivery: vi.fn(),
  }
})

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return import('../pages/FuelDeliveriesPage').then(({ default: Page }) =>
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <Page />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  )
}

describe('Fuel Deliveries UI', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows human-readable statuses and never raw COMPLETED enum in labels helper', () => {
    expect(formatStatusLabel('COMPLETED')).toBe('Completed')
    expect(formatStatusLabel('DRAFT')).toBe('Draft')
    expect(formatStatusLabel('VOIDED')).toBe('Voided')
    expect(formatStatusLabel('LATE_DATA_RECEIVED')).toBe('Reconciliation changed after closing')
  })

  it('allows station managers and admins to open fuel deliveries', () => {
    expect(canAccessPath('STATION_MANAGER', '/fuel-deliveries')).toBe(true)
    expect(canAccessPath('ADMIN', '/fuel-deliveries')).toBe(true)
    expect(canAccessPath('EXECUTIVE', '/fuel-deliveries')).toBe(true)
  })

  it('renders list with completed label and record button', async () => {
    await renderPage()
    expect(await screen.findByTestId('fuel-deliveries-page')).toBeInTheDocument()
    expect(screen.getByTestId('record-delivery')).toBeInTheDocument()
    expect(screen.getByText('Completed')).toBeInTheDocument()
    expect(screen.queryByText('COMPLETED')).not.toBeInTheDocument()
  })
})
