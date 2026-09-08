import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { fmtLiters, fmtNaira, fmtSignedNaira, type DayCloseRow } from '../api/client'
import ReconciliationWorkspace from '../components/reconciliation/ReconciliationWorkspace'
import TransactionIssueBadges from '../components/reconciliation/transactions/TransactionIssueBadges'
import {
  DEFAULT_ANOMALY_PAGE_SIZE,
  getAnomalyDescription,
  getAnomalyLabel,
  matchesIssueFilter,
  paginateReviewRows,
  reviewTransactions,
} from '../lib/anomalyPresentation'

const FOUR_FLAGS = [
  'SUSPICIOUS_UNIT_PRICE',
  'METER_VALUE_MISMATCH',
  'MISSING_NOZZLE_MAPPING',
  'MISSING_PRODUCT_MAPPING',
]

function tx(partial: Partial<NonNullable<DayCloseRow['integrity']>['transactions']>[number] & { transactionId: string }) {
  return {
    volumeLiters: 0.02,
    pricePerLiter: 11764.71,
    recordedAmount: 200,
    calculatedAmount: 235.29,
    difference: 35.29,
    flags: ['SUSPICIOUS_UNIT_PRICE'],
    ...partial,
  }
}

function integrityData(overrides?: Partial<DayCloseRow>): DayCloseRow {
  const transactions = Array.from({ length: 12 }, (_, i) =>
    tx({
      transactionId: `906a99c${i.toString(16)}-extra`,
      recordedAmount: 200 + i,
      difference: 35.29 - i,
      flags:
        i === 0
          ? FOUR_FLAGS
          : i < 4
            ? ['SUSPICIOUS_UNIT_PRICE']
            : i < 8
              ? ['METER_VALUE_MISMATCH']
              : ['MISSING_NOZZLE_MAPPING'],
    }),
  )
  return {
    stationId: 'st-1',
    stationName: 'Boluwaji',
    stationCode: 'BLJ-IB001',
    businessDate: '2026-09-07',
    status: 'REVIEW_REQUIRED',
    workflowStatus: 'REVIEW_REQUIRED',
    till: { cash: 0, pos: 0, transfer: 0, total: 0, captured: false, currency: 'NGN' },
    tillVariance: null,
    financial: {
      pumpSales: 700,
      reportedSales: 700,
      variance: 0,
      status: 'MATCH',
    },
    integrity: {
      transactionCount: 40,
      pumpLiters: 12,
      recordedAmount: 700,
      calculatedAmount: 758.13,
      difference: 58.13,
      status: 'REVIEW',
      anomalyCount: 97,
      transactions,
      anomalies: transactions.flatMap((row) =>
        (row.flags || []).map((code) => ({ code, transactionId: row.transactionId })),
      ),
    },
    inventory: { status: 'MATCH', tanks: [], varianceLiters: 0 },
    ...overrides,
  }
}

function wrap(data: DayCloseRow) {
  return (
    <MemoryRouter>
      <ReconciliationWorkspace
        data={data}
        actions={{ comment: '', setComment: () => undefined, canEnterSales: false }}
      />
    </MemoryRouter>
  )
}

function openTransactions(data: DayCloseRow = integrityData()) {
  render(wrap(data))
  fireEvent.click(screen.getByRole('tab', { name: 'Transactions' }))
  return data
}

describe('anomaly presentation helpers', () => {
  it('translates raw enum strings to friendly labels', () => {
    expect(getAnomalyLabel('SUSPICIOUS_UNIT_PRICE')).toBe('Price issue')
    expect(getAnomalyLabel('METER_VALUE_MISMATCH')).toBe('Value mismatch')
    expect(getAnomalyLabel('MISSING_NOZZLE_MAPPING')).toBe('No nozzle mapping')
    expect(getAnomalyLabel('MISSING_PRODUCT_MAPPING')).toBe('No product mapping')
    expect(getAnomalyDescription('SUSPICIOUS_UNIT_PRICE')).toContain('expected range')
    expect(getAnomalyLabel('SUSPICIOUS_UNIT_PRICE, METER_VALUE_MISMATCH')).not.toBe(
      'SUSPICIOUS_UNIT_PRICE, METER_VALUE_MISMATCH',
    )
  })

  it('formats differences as signed currency', () => {
    expect(fmtSignedNaira(35.29)).toMatch(/^\+/)
    expect(fmtSignedNaira(-23.81)).toMatch(/^-/)
    expect(fmtSignedNaira(0)).toBe(fmtNaira(0))
  })

  it('paginates with a default page size of 10', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ id: i }))
    expect(DEFAULT_ANOMALY_PAGE_SIZE).toBe(10)
    expect(paginateReviewRows(rows, 1, DEFAULT_ANOMALY_PAGE_SIZE)).toHaveLength(10)
    expect(paginateReviewRows(rows, 2, DEFAULT_ANOMALY_PAGE_SIZE)).toHaveLength(2)
  })

  it('does not treat flattened flags as extra table rows', () => {
    const rows = reviewTransactions({
      transactions: [tx({ transactionId: 'a', flags: FOUR_FLAGS })],
      anomalies: FOUR_FLAGS.map((code) => ({ code, transactionId: 'a' })),
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].flags).toEqual(FOUR_FLAGS)
  })
})

describe('Transaction integrity tab', () => {
  it('shows friendly badges and +N for four flags, not raw enums', () => {
    openTransactions()
    expect(screen.getAllByText('Price issue').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Value mismatch').length).toBeGreaterThan(0)
    expect(screen.getByText('+2')).toBeInTheDocument()
    expect(screen.queryByText('SUSPICIOUS_UNIT_PRICE')).not.toBeInTheDocument()
    expect(screen.queryByText(/MISSING_NOZZLE_MAPPING/)).not.toBeInTheDocument()
  })

  it('opens detail with all flags and diagnostic fields', () => {
    openTransactions()
    fireEvent.click(screen.getAllByRole('button', { name: /View transaction/i })[0])
    const dialog = screen.getByRole('dialog', { name: 'Transaction details' })
    expect(dialog).toBeInTheDocument()
    expect(within(dialog).getByText('No nozzle mapping')).toBeInTheDocument()
    expect(within(dialog).getByText('No product mapping')).toBeInTheDocument()
    expect(within(dialog).getByText('The transaction unit price is outside the expected range.')).toBeInTheDocument()
    expect(within(dialog).getByText('The recorded amount differs from volume × transaction unit price.')).toBeInTheDocument()
    expect(within(dialog).getByText('Unit price')).toBeInTheDocument()
    expect(within(dialog).getByText('Calculated amount')).toBeInTheDocument()
    expect(within(dialog).getByText(`${fmtNaira(11764.71)}/L`)).toBeInTheDocument()
    expect(within(dialog).getByText(fmtNaira(235.29))).toBeInTheDocument()
    expect(within(dialog).getByText(fmtSignedNaira(35.29))).toBeInTheDocument()
    expect(within(dialog).queryByText('SUSPICIOUS_UNIT_PRICE')).not.toBeInTheDocument()
  })

  it('paginates 12 rows at 10 per page and distinguishes transactions from issues', () => {
    openTransactions()
    expect(screen.getByText(/12 transactions need review/)).toBeInTheDocument()
    expect(screen.getByText(/97 issues detected/)).toBeInTheDocument()
    expect(screen.getByText(/issues detected · Difference/)).toBeInTheDocument()
    expect(screen.getByText('Showing 1-10 of 12 transactions')).toBeInTheDocument()
    expect(screen.getByDisplayValue('10')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /View transaction/i })).toHaveLength(10)
    const table = screen.getByRole('table')
    expect(table.parentElement?.className).toContain('overflow-x-auto')
    expect(table.parentElement?.className).not.toMatch(/overflow-y|overflow-auto|overflow-hidden/)
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText('Showing 11-12 of 12 transactions')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /View transaction/i })).toHaveLength(2)
  })

  it('resets pagination to page 1 when the issue filter changes', () => {
    openTransactions()
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText('Showing 11-12 of 12 transactions')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Price issues' }))
    expect(screen.getByText('Showing 1-4 of 4 transactions')).toBeInTheDocument()
    expect(screen.queryByText('Showing 11-12 of 12 transactions')).not.toBeInTheDocument()
  })

  it('renders a positive empty state when there are no issues', () => {
    openTransactions(
      integrityData({
        integrity: {
          transactionCount: 5,
          pumpLiters: 1,
          recordedAmount: 100,
          calculatedAmount: 100,
          difference: 0,
          status: 'MATCH',
          anomalyCount: 0,
          transactions: [],
          anomalies: [],
        },
      }),
    )
    expect(
      screen.getByText('No transaction integrity issues found for this business date.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('columnheader', { name: 'Transaction' })).not.toBeInTheDocument()
  })

  it('shows a clear-filter empty state', () => {
    openTransactions(
      integrityData({
        integrity: {
          transactionCount: 1,
          pumpLiters: 1,
          recordedAmount: 100,
          calculatedAmount: 100,
          difference: 0,
          status: 'REVIEW',
          anomalyCount: 1,
          transactions: [tx({ transactionId: 'only-price', flags: ['SUSPICIOUS_UNIT_PRICE'] })],
          anomalies: [{ code: 'SUSPICIOUS_UNIT_PRICE', transactionId: 'only-price' }],
        },
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Missing mappings' }))
    expect(screen.getByText('No transactions match this issue filter.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }))
    expect(screen.getByRole('button', { name: /View transaction/i })).toBeInTheDocument()
  })
})

describe('TransactionIssueBadges', () => {
  it('renders two labels plus +2 for four flags', () => {
    render(<TransactionIssueBadges flags={FOUR_FLAGS} />)
    expect(screen.getByText('Price issue')).toBeInTheDocument()
    expect(screen.getByText('Value mismatch')).toBeInTheDocument()
    expect(screen.getByText('+2')).toBeInTheDocument()
    expect(screen.queryByText('No nozzle mapping')).not.toBeInTheDocument()
    expect(matchesIssueFilter(FOUR_FLAGS, 'PRICE')).toBe(true)
    expect(fmtLiters(0.02)).toBe('0.02 L')
  })
})
