import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import LoginPage from '../pages/LoginPage'
import OverviewPage from '../pages/OverviewPage'
import { AuthProvider } from '../context/AuthContext'
import * as client from '../api/client'
import type { ExecutiveOverview } from '../api/client'

function wrap(ui: React.ReactNode, path = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>
  )
}

function emptyOverview(overrides: Partial<ExecutiveOverview> = {}): ExecutiveOverview {
  return {
    period: {
      key: 'today',
      label: 'Today',
      start: '2026-09-08T00:00:00+01:00',
      end: '2026-09-08T14:00:00+01:00',
      timezone: 'Africa/Lagos',
      timezone_note: "Today is calculated using each station's local time.",
      granularity: 'hour',
      partial: true,
      station_id: null,
      station_name: null,
      product: null,
      comparison_key: 'previous_period',
      comparison_label: 'Previous period',
      comparison_start: '2026-09-07T00:00:00+01:00',
      comparison_end: '2026-09-07T14:00:00+01:00',
    },
    kpis: {
      revenue: { current: 0, previous: 0, delta: 0, delta_pct: null },
      volume: { current: 0, previous: 0, delta: 0, delta_pct: null },
      transactions: { current: 0, previous: 0, delta: 0, delta_pct: null },
      average_sale: { current: 0, previous: 0, delta: 0, delta_pct: null },
      performance_label: 'Comparison unavailable',
      performance_pct: null,
      variance: {
        available: false,
        status: 'AWAITING',
        label: 'Awaiting reported sales',
        reported: null,
        pump_sales: null,
        amount: null,
        pct: null,
        stations_reporting: 0,
        stations_total: 1,
      },
      stations_reporting: { current: 0, previous: 0, delta: 0, delta_pct: null },
    },
    series: [],
    annotations: {
      peak_label: null,
      peak_amount: null,
      lowest_active_label: null,
      change_label: null,
      best_day_label: null,
    },
    insights: [],
    products: [],
    unmapped: null,
    stations: [],
    exceptions: [],
    activity: {
      last_sale_at: null,
      historical_last_sale_at: '2026-09-07T18:14:00+01:00',
      sales_last_hour_amount: 0,
      stations_recording_sales: 0,
      largest_sale_amount: null,
      largest_sale_station: null,
      empty_period: true,
      empty_title: 'No sales recorded today',
      empty_detail: 'Last recorded sale: Sep 7, 2026 at 6:14 PM',
    },
    reconciliation: {
      available: false,
      status: 'AWAITING',
      label: 'Awaiting reported sales',
      reported: null,
      pump_sales: null,
      variance: null,
      variance_pct: null,
      awaiting_count: 1,
      shortage_count: 0,
      overage_count: 0,
      href: '/reconciliations',
    },
    filters: {
      stations: [{ id: 'st-1', name: 'Ibadan Boluwaji' }],
      products: [
        { id: 'all', name: 'All products' },
        { id: 'PMS', name: 'PMS' },
        { id: 'AGO', name: 'AGO/Diesel' },
      ],
      has_region_groups: false,
    },
    generated_at: '2026-09-08T13:00:00Z',
    inclusion_policy: 'Completed sales only',
    ...overrides,
  }
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
  it('renders executive chrome, filters, compact empty state, and no technical widgets', async () => {
    vi.spyOn(client, 'getExecutiveOverview').mockResolvedValue({ data: emptyOverview() } as any)

    render(wrap(<OverviewPage />))
    expect(await screen.findByRole('heading', { name: 'Executive Overview' })).toBeInTheDocument()
    expect(screen.getByText('Sales performance across your stations')).toBeInTheDocument()
    expect(await screen.findByText(/Today · All stations/)).toBeInTheDocument()
    expect(screen.getByLabelText('Date period')).toBeInTheDocument()
    expect(screen.getByLabelText('Comparison')).toBeInTheDocument()
    expect(screen.getByLabelText('Station')).toBeInTheDocument()
    expect(screen.getByLabelText('Product')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument()
    expect(screen.getByText('Total sales')).toBeInTheDocument()
    expect(screen.getByText('Volume sold')).toBeInTheDocument()
    expect(screen.getByText('Sales performance')).toBeInTheDocument()
    expect(screen.getByText('Sales variance')).toBeInTheDocument()
    expect(screen.getAllByText('No sales recorded today').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Last recorded sale: Sep 7, 2026 at 6:14 PM/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/Online devices/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Offline devices/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Rejected MQTT/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/API events/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/heartbeat/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Recent transactions/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/America\/Chicago/)).not.toBeInTheDocument()
    const empty = screen.getAllByText('No sales recorded today')[0].parentElement
    expect(empty?.className).toContain('min-h-[4.5rem]')
    const page = screen.getByRole('heading', { name: 'Executive Overview' }).closest('.space-y-8')
    expect(page?.className).not.toContain('overflow-y-auto')
    expect(page?.className).toContain('space-y-8')
    expect(document.querySelector('.grid.grid-cols-2')).toBeTruthy()
  })

  it('shows sales KPIs, product mix, station ranking, and insights when data exists', async () => {
    vi.spyOn(client, 'getExecutiveOverview').mockResolvedValue({
      data: emptyOverview({
        kpis: {
          ...emptyOverview().kpis,
          revenue: { current: 150000, previous: 138376, delta: 11624, delta_pct: 8.4 },
          volume: { current: 120, previous: 110, delta: 10, delta_pct: 9.1 },
          transactions: { current: 12, previous: 10, delta: 2, delta_pct: 20 },
          average_sale: { current: 12500, previous: 13837, delta: -1337, delta_pct: -9.7 },
          performance_label: 'Up 8.4%',
          performance_pct: 8.4,
          variance: {
            available: true,
            status: 'SHORT',
            label: 'Short',
            reported: 25000,
            pump_sales: 150000,
            amount: -125000,
            pct: -83.3,
            stations_reporting: 1,
            stations_total: 1,
          },
        },
        series: [
          {
            bucket: '2026-09-08T10:00:00+01:00',
            label: '10 AM',
            current_amount: 150000,
            current_volume: 120,
            current_count: 12,
            previous_amount: 138376,
            previous_volume: 110,
            previous_count: 10,
          },
        ],
        insights: ['Sales are 8.4% higher than the same time yesterday.'],
        products: [
          {
            product: 'PMS',
            mapped: true,
            amount: 117000,
            volume: 94,
            count: 9,
            share_amount: 78,
            share_volume: 78.3,
            avg_price_per_litre: 1244.68,
          },
        ],
        unmapped: { amount: 400, volume: 2, count: 1, review_href: '/admin/stations' },
        stations: [
          {
            rank: 1,
            station_id: 'st-1',
            station_name: 'Ibadan Boluwaji',
            amount: 150000,
            volume: 120,
            count: 12,
            average_sale: 12500,
            delta_pct: 8.4,
            variance_amount: -125000,
            variance_status: 'SHORT',
            last_sale_at: '2026-09-08T13:40:00+01:00',
            business_status: 'Performing well',
          },
        ],
        exceptions: [
          {
            id: 'recon-variance',
            severity: 'attention',
            title: 'Large reconciliation shortage',
            station_id: 'st-1',
            station_name: 'Ibadan Boluwaji',
            impact: 'Reported collections are ₦125,000 below recorded pump sales.',
            occurred_at: '2026-09-08T13:00:00Z',
            action: 'Review reconciliation',
            href: '/reconciliations',
          },
        ],
        activity: {
          last_sale_at: '2026-09-08T13:40:00+01:00',
          historical_last_sale_at: '2026-09-08T13:40:00+01:00',
          sales_last_hour_amount: 20000,
          stations_recording_sales: 1,
          largest_sale_amount: 18000,
          largest_sale_station: 'Ibadan Boluwaji',
          empty_period: false,
          empty_title: '',
          empty_detail: null,
        },
        reconciliation: {
          available: true,
          status: 'SHORT',
          label: 'Short',
          reported: 25000,
          pump_sales: 150000,
          variance: -125000,
          variance_pct: -83.3,
          awaiting_count: 0,
          shortage_count: 1,
          overage_count: 0,
          href: '/reconciliations',
        },
      }),
    } as any)

    render(wrap(<OverviewPage />))
    expect((await screen.findAllByText('Up 8.4%')).length).toBeGreaterThan(0)
    expect(screen.getByText('Sales are 8.4% higher than the same time yesterday.')).toBeInTheDocument()
    expect(screen.getAllByText('PMS').length).toBeGreaterThan(0)
    expect(screen.getByText('Unmapped sales')).toBeInTheDocument()
    expect(screen.getByText('Review product mappings')).toBeInTheDocument()
    expect(screen.getAllByText('Ibadan Boluwaji').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Needs attention').length).toBeGreaterThan(0)
    expect(screen.getByText('Large reconciliation shortage')).toBeInTheDocument()
    expect(screen.getByText('Reconciliation summary')).toBeInTheDocument()
    expect(screen.getByText('View data table')).toBeInTheDocument()
  })

  it('persists filters in the URL', async () => {
    const spy = vi.spyOn(client, 'getExecutiveOverview').mockResolvedValue({ data: emptyOverview() } as any)
    render(wrap(<OverviewPage />, '/?period=last_7_days&station=st-1&product=PMS'))
    expect(await screen.findByRole('heading', { name: 'Executive Overview' })).toBeInTheDocument()
    expect(spy).toHaveBeenCalled()
    const args = spy.mock.calls[0]?.[0] as Record<string, string | undefined>
    expect(args.period).toBe('last_7_days')
    expect(args.station_id).toBe('st-1')
    expect(args.product).toBe('PMS')
    fireEvent.change(screen.getByLabelText('Date period'), { target: { value: 'yesterday' } })
  })

  it('shows API error state', async () => {
    vi.spyOn(client, 'getExecutiveOverview').mockRejectedValue(new Error('network'))
    render(wrap(<OverviewPage />))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Failed to load dashboard/i)
  })
})
