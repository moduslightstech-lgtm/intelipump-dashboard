import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import LoginPage from '../pages/LoginPage'
import OverviewPage from '../pages/OverviewPage'
import { AuthProvider } from '../context/AuthContext'
import * as client from '../api/client'

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <MemoryRouter>{ui}</MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>
  )
}

describe('LoginPage', () => {
  it('renders email and password fields', () => {
    render(wrap(<LoginPage />))
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument()
  })
})

describe('OverviewPage', () => {
  it('renders summary cards and empty states', async () => {
    vi.spyOn(client, 'getDashboardSummary').mockResolvedValue({
      data: {
        total_amount_today: 1000,
        total_volume_today: 10,
        transaction_count_today: 2,
        average_transaction_amount: 500,
        active_stations: 1,
        online_devices: 1,
        offline_devices: 0,
        last_transaction_time: null,
        rejected_mqtt_messages_today: 0,
        timezone: 'Africa/Lagos',
      },
    } as any)
    vi.spyOn(client, 'getHourlySales').mockResolvedValue({ data: [] } as any)
    vi.spyOn(client, 'getProductBreakdown').mockResolvedValue({ data: [] } as any)
    vi.spyOn(client, 'getStationPerformance').mockResolvedValue({ data: [] } as any)
    vi.spyOn(client, 'getTransactions').mockResolvedValue({ data: { items: [], total: 0, page: 1, size: 8 } } as any)
    vi.spyOn(client, 'getAlerts').mockResolvedValue({ data: [] } as any)

    render(wrap(<OverviewPage />))
    expect(await screen.findByText(/Overview/i)).toBeInTheDocument()
    expect(await screen.findByText(/Sales today/i)).toBeInTheDocument()
    expect(await screen.findByText(/No transactions yet/i)).toBeInTheDocument()
  })

  it('shows API error state', async () => {
    vi.spyOn(client, 'getDashboardSummary').mockRejectedValue(new Error('network'))
    vi.spyOn(client, 'getHourlySales').mockResolvedValue({ data: [] } as any)
    vi.spyOn(client, 'getProductBreakdown').mockResolvedValue({ data: [] } as any)
    vi.spyOn(client, 'getStationPerformance').mockResolvedValue({ data: [] } as any)
    vi.spyOn(client, 'getTransactions').mockResolvedValue({ data: { items: [], total: 0, page: 1, size: 8 } } as any)
    vi.spyOn(client, 'getAlerts').mockResolvedValue({ data: [] } as any)

    render(wrap(<OverviewPage />))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Failed to load dashboard/i)
  })
})
