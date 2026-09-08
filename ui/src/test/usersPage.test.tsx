import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../api/client', () => ({
  getAdminUsers: vi.fn(async () => ({ data: [] })),
  getStations: vi.fn(async () => ({ data: [] })),
  createAdminUser: vi.fn(),
  assignUserRole: vi.fn(),
  assignUserStations: vi.fn(),
}))

import UsersPage from '../pages/UsersPage'
import { createAdminUser } from '../api/client'

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  )
}

describe('UsersPage create user', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows an error when the password is shorter than 8 characters', async () => {
    render(wrap(<UsersPage />))
    fireEvent.change(screen.getByPlaceholderText('Email'), {
      target: { value: 'manager@station.ng' },
    })
    fireEvent.change(screen.getByPlaceholderText(/Password/), {
      target: { value: 'short' },
    })
    fireEvent.click(screen.getByRole('button', { name: /create/i }))
    expect(
      await screen.findByRole('alert'),
    ).toHaveTextContent('Password must be at least 8 characters.')
    expect(createAdminUser).not.toHaveBeenCalled()
  })
})
