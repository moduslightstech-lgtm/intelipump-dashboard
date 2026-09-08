import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { role: 'ADMIN', normalizedRole: 'ADMIN' },
  }),
}))

const reconPayload = {
  stationId: 'st-1',
  stationName: 'Boluwaji',
  stationCode: 'BLJ-IB001',
  businessDate: '2026-09-06',
  status: 'AWAITING_TANK_READING',
  workflowStatus: 'AWAITING_TANK_READING',
  verdict: 'INCOMPLETE',
  stockVerdict: 'INCOMPLETE',
  tillVerdict: 'WAITING_ON_TILL',
  readiness: { complete: 1, total: 3, label: '1 of 3 checks complete' },
  sales: {
    amount: 700,
    volumeLiters: 0.6,
    transactionCount: 1,
    currency: 'NGN',
    source: 'pump_transactions',
  },
  till: {
    cash: 0,
    pos: 0,
    transfer: 0,
    total: 0,
    captured: false,
    currency: 'NGN',
    methods: {},
  },
  tillVariance: null,
  financial: {
    pumpSales: 700,
    reportedSales: null,
    variance: null,
    status: 'WAITING',
    captured: false,
    methods: {},
  },
  integrity: {
    transactionCount: 1,
    pumpLiters: 0.6,
    recordedAmount: 700,
    calculatedAmount: 700,
    difference: 0,
    status: 'MATCH',
    anomalyCount: 0,
    transactions: [],
  },
  inventory: {
    status: 'INCOMPLETE',
    tanks: [],
    varianceLiters: null,
    usePreviousClosing: false,
    enterBaselineOpening: true,
  },
  completeness: { pumpTransactions: 1, lateTransactions: 0, dataAnomalies: 0 },
  stock: null,
  run: null,
  runId: null,
}

const listRow = {
  ...reconPayload,
  till: { cash: 400, pos: 200, transfer: 0, total: 600, captured: true, currency: 'NGN', methods: { CASH: 400, POS: 200 } },
  tillVariance: -100,
  tillVerdict: 'TILL_SHORT',
  financial: {
    pumpSales: 700,
    reportedSales: 600,
    variance: -100,
    status: 'SHORT',
    captured: true,
    methods: { CASH: 400, POS: 200 },
  },
}

const overRow = {
  ...listRow,
  financial: {
    pumpSales: 31202.75,
    reportedSales: 33602.75,
    variance: 2400,
    status: 'OVER',
    captured: true,
    methods: { CASH: 33602.75 },
  },
  sales: { ...listRow.sales, amount: 31202.75 },
}

vi.mock('../api/client', () => ({
  getStationManagerStations: vi.fn(async () => ({
    data: [{ id: 'st-1', name: 'Boluwaji', stationCode: 'BLJ-IB001' }],
  })),
  getStationManagerReconciliation: vi.fn(async () => ({
    data: reconPayload,
  })),
  putStationManagerTill: vi.fn(async () => ({ data: {} })),
  getStations: vi.fn(async () => ({
    data: [{ id: 'st-1', name: 'Boluwaji', station_code: 'BLJ-IB001' }],
  })),
  getDayCloses: vi.fn(async () => ({
    data: [listRow],
  })),
  recalculateDayClose: vi.fn(),
  closeDayClose: vi.fn(),
  reopenDayClose: vi.fn(),
  getDayCloseAudit: vi.fn(async () => ({ data: [] })),
  usePreviousOpening: vi.fn(),
  fmtNaira: (n: number | null | undefined) => (n == null ? '—' : `₦${n}`),
  fmtSignedNaira: (n: number | null | undefined) => {
    if (n == null) return '—'
    if (n > 0) return `+₦${n}`
    if (n < 0) return `-₦${Math.abs(n)}`
    return `₦${n}`
  },
  fmtLiters: (n: number | null | undefined) => (n == null ? '—' : `${n} L`),
}))

import ReconciliationsPage from '../pages/ReconciliationsPage'
import ReconciliationWorkspace from '../components/reconciliation/ReconciliationWorkspace'
import { putStationManagerTill } from '../api/client'

function wrap(ui: React.ReactNode, path = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
    </QueryClientProvider>
  )
}

describe('Admin reported sales', () => {
  it('saves a single reported-sales total against pump sales', async () => {
    render(
      wrap(
        <ReconciliationWorkspace
          data={reconPayload}
          actions={{
            comment: '',
            setComment: () => undefined,
            canEnterSales: true,
            isAdmin: true,
          }}
        />,
      ),
    )
    expect((await screen.findAllByText('₦700')).length).toBeGreaterThan(0)
    expect(screen.getByText('Enter reported sales')).toBeInTheDocument()
    const save = await screen.findByRole('button', { name: 'Save reported sales' })
    await waitFor(() => expect(save).not.toBeDisabled())
    fireEvent.change(screen.getByLabelText('Reported sales (₦)'), { target: { value: '700' } })
    fireEvent.submit(save.closest('form') as HTMLFormElement)
    await waitFor(() =>
      expect(putStationManagerTill).toHaveBeenCalledWith({
        station_id: 'st-1',
        business_date: '2026-09-06',
        cash: 700,
        pos: 0,
        transfer: 0,
        mobile_money: 0,
        fleet_or_credit: 0,
        other: 0,
      }),
    )
  })
})

describe('Admin day close list', () => {
  it('selects a station on the same page instead of navigating away', async () => {
    render(wrap(<ReconciliationsPage />, '/reconciliations'))
    expect(await screen.findByRole('heading', { name: 'Reconciliation' })).toBeInTheDocument()
    expect((await screen.findAllByText('Boluwaji')).length).toBeGreaterThan(0)
    expect((await screen.findAllByText('₦700')).length).toBeGreaterThan(0)
    expect(screen.getAllByText('Incomplete').length).toBeGreaterThan(0)
    expect(screen.queryByText('Create run')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Reconcile/i })).not.toBeInTheDocument()
    expect(screen.getAllByText('Financial').length).toBeGreaterThan(0)
    expect(screen.getByText('How reconciliation works')).toBeInTheDocument()
  })
})

describe('Financial display', () => {
  it('shows numeric variance and OVER status instead of MATCH', () => {
    render(
      wrap(
        <ReconciliationWorkspace
          data={overRow}
          actions={{ comment: '', setComment: () => undefined, canEnterSales: false }}
        />,
      ),
    )
    expect(screen.getByText('₦31202.75')).toBeInTheDocument()
    expect(screen.getByText('₦33602.75')).toBeInTheDocument()
    expect(screen.getByText('+₦2400')).toBeInTheDocument()
    expect(screen.getAllByText('OVER').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Variance').length).toBeGreaterThan(0)
  })
})

describe('Tank warning', () => {
  it('does not claim opening is missing when opening exists and closing is missing', () => {
    render(
      wrap(
        <ReconciliationWorkspace
          data={{
            ...overRow,
            inventory: {
              status: 'INCOMPLETE',
              varianceLiters: null,
              usePreviousClosing: false,
              enterBaselineOpening: false,
              tanks: [
                {
                  tankId: 't1',
                  tankCode: 'T1',
                  product: 'PMS',
                  openingLiters: 25,
                  openingMissing: false,
                  deliveryLiters: 0,
                  dispensedLiters: 18.22,
                  expectedClosingLiters: 6.78,
                  actualClosingLiters: null,
                  varianceLiters: null,
                  status: 'INCOMPLETE',
                  blocker: 'Closing stock reading is missing.',
                },
              ],
            },
          }}
          actions={{ comment: '', setComment: () => undefined, canEnterSales: false }}
        />,
      ),
    )
    expect(screen.getByText('25 L')).toBeInTheDocument()
    expect(screen.getByText('Closing stock reading is missing.')).toBeInTheDocument()
    expect(screen.queryByText(/Opening stock is missing/)).not.toBeInTheDocument()
  })
})

describe('Close reconciliation', () => {
  it('disables close when tank inventory is incomplete', () => {
    render(
      wrap(
        <ReconciliationWorkspace
          data={{
            ...overRow,
            readiness: { complete: 2, total: 3, label: '2 of 3 checks complete' },
            inventory: {
              status: 'INCOMPLETE',
              varianceLiters: null,
              usePreviousClosing: false,
              enterBaselineOpening: true,
              tanks: [
                {
                  tankId: 't1',
                  tankCode: 'T1',
                  product: 'PMS',
                  openingLiters: null,
                  openingMissing: true,
                  deliveryLiters: 0,
                  dispensedLiters: 18.22,
                  expectedClosingLiters: null,
                  actualClosingLiters: null,
                  varianceLiters: null,
                  status: 'INCOMPLETE',
                  blocker: 'Opening stock is missing.',
                },
              ],
            },
          }}
          actions={{ comment: '', setComment: () => undefined, canEnterSales: false, isAdmin: true }}
        />,
      ),
    )
    const close = screen.getByRole('button', { name: 'Close reconciliation' })
    expect(close).toBeDisabled()
    expect(close).toHaveAttribute('aria-disabled', 'true')
    expect(close).toHaveAccessibleDescription(
      /Tank inventory must be completed before this reconciliation can be closed/,
    )
    expect(screen.getByText(/Opening stock is missing/)).toBeInTheDocument()
  })
})
