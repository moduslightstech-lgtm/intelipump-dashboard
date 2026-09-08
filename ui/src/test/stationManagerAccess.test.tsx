import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { canAccessPath, landingPath, normalizeRole, type AppRole } from '../lib/roles'

const authState = {
  user: {
    email: 'sm@example.com',
    role: 'STATION_MANAGER',
    normalizedRole: 'STATION_MANAGER' as AppRole,
  },
  logout: () => undefined,
}

vi.mock('../context/AuthContext', () => ({
  useAuth: () => authState,
}))

vi.mock('../hooks/useLiveEvents', () => ({
  useLiveEvents: () => undefined,
}))

vi.mock('../api/client', () => ({
  getStationManagerStations: vi.fn(async () => ({
    data: [{ id: 'st-1', name: 'IntelliPump US Lab', stationCode: 'US-LAB-001' }],
  })),
  getStationManagerCurrentReadings: vi.fn(async () => ({
    data: {
      businessDate: '2026-09-07',
      deadlineLocal: '22:30',
      uiStatus: 'SUBMITTED',
      station: { name: 'IntelliPump US Lab', stationCode: 'US-LAB-001' },
      batch: {
        status: 'SUBMITTED',
        submittedAt: '2026-09-07T10:13:00Z',
        submittedByUser: { name: 'Bala' },
        isLate: false,
        correctedByAdministrator: false,
      },
      tanks: [
        {
          tankId: 't1',
          tankCode: 'PMS-Lab',
          name: 'PMS-Lab',
          product: 'PMS',
          closingVolumeLiters: 84025,
        },
      ],
    },
  })),
  getStationManagerHistory: vi.fn(async () => ({
    data: {
      items: [
        {
          id: 'b1',
          businessDate: '2026-09-07',
          stationName: 'IntelliPump US Lab',
          status: 'SUBMITTED',
          totalClosingVolumeLiters: 84025,
          submittedBy: { name: 'Bala' },
          submittedAt: '2026-09-07T10:13:00Z',
          tankCount: 1,
          expectedTankCount: 1,
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

import Layout from '../components/layout/Layout'
import TankReadingsPage from '../pages/station-manager/TankReadingsPage'
import { StationManagerHistoryPage } from '../pages/station-manager/HistoryPages'

function RoleGuard({ children }: { children: React.ReactNode }) {
  const location = useLocation()
  const role = normalizeRole(authState.user.normalizedRole || authState.user.role)
  if (!canAccessPath(role, location.pathname)) {
    return <Navigate to={landingPath(role)} replace />
  }
  return <>{children}</>
}

function wrap(ui: React.ReactNode, path = '/station-manager/tank-readings') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
    </QueryClientProvider>
  )
}

describe('Station Manager authorization', () => {
  beforeEach(() => {
    authState.user.role = 'STATION_MANAGER'
    authState.user.normalizedRole = 'STATION_MANAGER'
  })

  it('blocks reconciliation paths and lands on tank readings', () => {
    expect(canAccessPath('STATION_MANAGER', '/station-manager/reconciliation')).toBe(false)
    expect(canAccessPath('STATION_MANAGER', '/reconciliations')).toBe(false)
    expect(canAccessPath('STATION_MANAGER', '/')).toBe(true)
    expect(canAccessPath('STATION_MANAGER', '/executive')).toBe(true)
    expect(canAccessPath('STATION_MANAGER', '/station-manager/tank-readings')).toBe(true)
    expect(canAccessPath('STATION_MANAGER', '/station-manager/history')).toBe(true)
    expect(canAccessPath('STATION_MANAGER', '/station-manager/profile')).toBe(true)
    expect(landingPath('STATION_MANAGER')).toBe('/station-manager/tank-readings')
    expect(canAccessPath('ADMIN', '/reconciliations')).toBe(true)
    expect(canAccessPath('ADMIN', '/station-manager/reconciliation')).toBe(true)
  })

  it('omits Reconciliation from the Station Manager sidebar', () => {
    render(
      wrap(
        <Routes>
          <Route path="/" element={<Layout />}>
            <Route path="station-manager/tank-readings" element={<div>readings</div>} />
          </Route>
        </Routes>,
        '/station-manager/tank-readings',
      ),
    )
    expect(screen.getByText('Tank Reading')).toBeInTheDocument()
    expect(screen.getByText('Submission History')).toBeInTheDocument()
    expect(screen.getByText('Profile')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Reconciliation' })).not.toBeInTheDocument()
  })

  it('keeps Reconciliation in the Admin sidebar', () => {
    authState.user.role = 'ADMIN'
    authState.user.normalizedRole = 'ADMIN'
    render(
      wrap(
        <Routes>
          <Route path="/" element={<Layout />}>
            <Route path="reconciliations" element={<div>admin recon</div>} />
          </Route>
        </Routes>,
        '/reconciliations',
      ),
    )
    expect(screen.getByRole('link', { name: 'Reconciliation' })).toBeInTheDocument()
    expect(screen.getByText('Tank Reading')).toBeInTheDocument()
    const main = document.querySelector('main')
    expect(main).toBeTruthy()
    const mainClasses = main?.className.split(/\s+/) || []
    const shellClasses = main?.parentElement?.className.split(/\s+/) || []
    expect(mainClasses).not.toContain('overflow-y-auto')
    expect(mainClasses).not.toContain('overflow-hidden')
    expect(shellClasses).not.toContain('h-screen')
    expect(shellClasses).not.toContain('overflow-hidden')
  })

  it('redirects a Station Manager who opens the reconciliation URL', () => {
    render(
      wrap(
        <Routes>
          <Route
            path="/"
            element={
              <RoleGuard>
                <Layout />
              </RoleGuard>
            }
          >
            <Route path="station-manager/tank-readings" element={<div>Tank readings land</div>} />
            <Route
              path="station-manager/reconciliation"
              element={<Navigate to="/station-manager/tank-readings" replace />}
            />
          </Route>
        </Routes>,
        '/station-manager/reconciliation',
      ),
    )
    expect(screen.getByText('Tank readings land')).toBeInTheDocument()
    expect(screen.queryByText('Pump sales')).not.toBeInTheDocument()
    expect(screen.queryByText('Financial')).not.toBeInTheDocument()
  })
})

describe('Station Manager tank reading surfaces', () => {
  beforeEach(() => {
    authState.user.role = 'STATION_MANAGER'
    authState.user.normalizedRole = 'STATION_MANAGER'
  })

  it('shows Tank Reading and a read-only submission summary without reconciliation fields', async () => {
    render(wrap(<TankReadingsPage />))
    expect(await screen.findByText('Tank Reading')).toBeInTheDocument()
    expect(await screen.findByText("Today's Tank Reading")).toBeInTheDocument()
    expect(screen.getAllByText('IntelliPump US Lab').length).toBeGreaterThan(0)
    expect(screen.getAllByText('SUBMITTED').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/84,025 L|84025 L/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/Pump sales/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Reported collections/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Transaction integrity/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Close reconciliation/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'View' }))
    expect(await screen.findByText('Tank Reading Summary')).toBeInTheDocument()
    expect(screen.getAllByText('Closing stock').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Total closing stock').length).toBeGreaterThan(0)
    expect(screen.queryByText(/Financial/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Integrity/)).not.toBeInTheDocument()
  })

  it('opens a tank-reading-only summary from Submission History', async () => {
    render(wrap(<StationManagerHistoryPage />, '/station-manager/history'))
    expect(await screen.findByText('Submission History')).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: 'View' }))
    expect(await screen.findByText('Tank Reading Summary')).toBeInTheDocument()
    expect(screen.getByText('PMS-Lab')).toBeInTheDocument()
    expect(screen.getAllByText(/84,025 L|84025 L/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/Pump sales/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/MATCH/)).not.toBeInTheDocument()
  })
})
