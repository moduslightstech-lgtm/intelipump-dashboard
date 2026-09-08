import { useEffect, useMemo, useState } from 'react'
import { fmtLiters, fmtNaira, fmtSignedNaira, type DayCloseRow } from '../../../api/client'
import {
  ANOMALY_PAGE_SIZES,
  DEFAULT_ANOMALY_PAGE_SIZE,
  ISSUE_FILTERS,
  getAnomalyLabel,
  matchesIssueFilter,
  pageWindow,
  paginateReviewRows,
  reviewTransactions,
  shortTransactionId,
  sortReviewRows,
  type AnomalyIssueFilter,
  type IntegrityTransaction,
  type ReviewSortKey,
} from '../../../lib/anomalyPresentation'
import TransactionDetailDrawer from './TransactionDetailDrawer'
import TransactionIssueBadges from './TransactionIssueBadges'

export default function TransactionIntegrityTab({ data }: { data: DayCloseRow }) {
  const [filter, setFilter] = useState<AnomalyIssueFilter>('ALL')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(DEFAULT_ANOMALY_PAGE_SIZE)
  const [sortKey, setSortKey] = useState<ReviewSortKey | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const allRows = useMemo(
    () => reviewTransactions({ transactions: data.integrity?.transactions, anomalies: data.integrity?.anomalies }),
    [data.integrity?.transactions, data.integrity?.anomalies],
  )

  useEffect(() => {
    setPage(1)
    setFilter('ALL')
    setSelectedId(null)
  }, [data.stationId, data.businessDate])

  const filtered = useMemo(
    () => allRows.filter((row) => matchesIssueFilter(row.flags, filter)),
    [allRows, filter],
  )
  const sorted = useMemo(() => sortReviewRows(filtered, sortKey, sortDir), [filtered, sortKey, sortDir])
  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize))
  const safePage = Math.min(page, pageCount)
  const visible = paginateReviewRows(sorted, safePage, pageSize)
  const selected = allRows.find((row) => row.transactionId === selectedId) || null
  const issueCount = data.integrity?.anomalyCount ?? data.integrity?.anomalies?.length ?? 0
  const start = sorted.length ? (safePage - 1) * pageSize + 1 : 0
  const end = Math.min(safePage * pageSize, sorted.length)

  function changeFilter(next: AnomalyIssueFilter) {
    setFilter(next)
    setPage(1)
  }

  function toggleSort(key: ReviewSortKey) {
    if (sortKey === key) {
      setSortDir((dir) => (dir === 'desc' ? 'asc' : 'desc'))
      return
    }
    setSortKey(key)
    setSortDir('desc')
  }

  return (
    <div className="card space-y-4">
      <TransactionIntegritySummary
        reviewCount={allRows.length}
        issueCount={issueCount}
        difference={data.integrity?.difference ?? null}
      />

      {allRows.length ? (
        <TransactionIssueFilters value={filter} onChange={changeFilter} />
      ) : null}

      {!allRows.length ? (
        <p className="text-sm text-emerald-400" role="status">
          No transaction integrity issues found for this business date.
        </p>
      ) : null}

      {allRows.length && !filtered.length ? (
        <div className="space-y-2">
          <p className="text-sm text-slate-400" role="status">
            No transactions match this issue filter.
          </p>
          <button type="button" className="btn-secondary text-xs" onClick={() => changeFilter('ALL')}>
            Clear filter
          </button>
        </div>
      ) : null}

      {filtered.length ? (
        <>
          <TransactionAnomalyTable
            rows={visible}
            selectedId={selectedId}
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={toggleSort}
            onOpen={setSelectedId}
          />
          <Pagination
            page={safePage}
            pageCount={pageCount}
            pageSize={pageSize}
            total={sorted.length}
            start={start}
            end={end}
            onPage={setPage}
            onPageSize={(size) => {
              setPageSize(size)
              setPage(1)
            }}
          />
        </>
      ) : null}

      {selected ? (
        <TransactionDetailDrawer transaction={selected} onClose={() => setSelectedId(null)} />
      ) : null}
    </div>
  )
}

export function TransactionIntegritySummary({
  reviewCount,
  issueCount,
  difference,
}: {
  reviewCount: number
  issueCount: number
  difference: number | null
}) {
  const parts = [
    `${reviewCount} ${reviewCount === 1 ? 'transaction needs' : 'transactions need'} review`,
    `${issueCount} ${issueCount === 1 ? 'issue' : 'issues'} detected`,
  ]
  if (difference != null) {
    parts.push(`Difference ${fmtSignedNaira(difference)}`)
  }
  return (
    <div>
      <h3 className="text-white font-semibold">Transaction integrity</h3>
      <p className="text-sm text-slate-400 mt-1">{parts.join(' · ')}</p>
      <p className="text-xs text-slate-500 mt-1">
        Volume × this sale’s price is a data check, not a financial short or over.
      </p>
    </div>
  )
}

export function TransactionIssueFilters({
  value,
  onChange,
}: {
  value: AnomalyIssueFilter
  onChange: (value: AnomalyIssueFilter) => void
}) {
  return (
    <div className="flex flex-wrap gap-1" role="group" aria-label="Issue filters">
      {ISSUE_FILTERS.map((item) => {
        const selected = value === item.id
        return (
          <button
            key={item.id}
            type="button"
            aria-pressed={selected}
            className={`px-3 py-1.5 rounded-full text-xs font-medium border ${
              selected
                ? 'bg-emerald-600/20 border-emerald-500/50 text-emerald-200'
                : 'bg-slate-900/40 border-slate-700 text-slate-400 hover:text-white'
            }`}
            onClick={() => onChange(item.id)}
          >
            {item.label}
          </button>
        )
      })}
    </div>
  )
}

export function TransactionAnomalyTable({
  rows,
  selectedId,
  sortKey,
  sortDir,
  onSort,
  onOpen,
}: {
  rows: IntegrityTransaction[]
  selectedId: string | null
  sortKey: ReviewSortKey | null
  sortDir: 'asc' | 'desc'
  onSort: (key: ReviewSortKey) => void
  onOpen: (id: string) => void
}) {
  function sortLabel(key: ReviewSortKey, label: string) {
    const active = sortKey === key
    return `${label}${active ? (sortDir === 'desc' ? ' ↓' : ' ↑') : ''}`
  }

  function activate(row: IntegrityTransaction) {
    onOpen(row.transactionId)
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm table-fixed min-w-[40rem]">
        <colgroup>
          <col className="w-[18%]" />
          <col className="w-[12%]" />
          <col className="w-[16%]" />
          <col className="w-[16%]" />
          <col className="w-[26%]" />
          <col className="w-[12%]" />
        </colgroup>
        <thead>
          <tr className="text-left text-slate-500">
            <th className="pb-2 pr-3 font-medium">Transaction</th>
            <th className="pb-2 pr-3 font-medium">
              <button type="button" className="hover:text-slate-200" onClick={() => onSort('volume')}>
                {sortLabel('volume', 'Volume')}
              </button>
            </th>
            <th className="pb-2 pr-3 font-medium">
              <button type="button" className="hover:text-slate-200" onClick={() => onSort('recorded')}>
                {sortLabel('recorded', 'Recorded')}
              </button>
            </th>
            <th className="pb-2 pr-3 font-medium">
              <button type="button" className="hover:text-slate-200" onClick={() => onSort('difference')}>
                {sortLabel('difference', 'Difference')}
              </button>
            </th>
            <th className="pb-2 pr-3 font-medium">Issues</th>
            <th className="pb-2 font-medium">Action</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const selected = selectedId === row.transactionId
            const remaining = (row.flags || []).slice(2).map((flag) => getAnomalyLabel(flag)).join(', ')
            return (
              <tr
                key={row.transactionId}
                tabIndex={0}
                aria-label={`Review transaction ${shortTransactionId(row.transactionId)}`}
                className={`border-t border-slate-800 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
                  selected ? 'bg-slate-800/90' : 'hover:bg-slate-800/60'
                }`}
                onClick={() => activate(row)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    activate(row)
                  }
                }}
              >
                <td className="py-2 pr-3 font-mono text-slate-200 whitespace-nowrap" title={row.transactionId}>
                  {shortTransactionId(row.transactionId)}
                </td>
                <td className="pr-3 font-mono whitespace-nowrap">{fmtLiters(row.volumeLiters)}</td>
                <td className="pr-3 font-mono whitespace-nowrap">{fmtNaira(row.recordedAmount)}</td>
                <td className="pr-3 font-mono text-slate-200 whitespace-nowrap">
                  {row.difference == null ? '—' : fmtSignedNaira(row.difference)}
                </td>
                <td className="pr-3 whitespace-nowrap">
                  <TransactionIssueBadges flags={row.flags || []} />
                  {remaining ? <span className="sr-only">More issues: {remaining}</span> : null}
                </td>
                <td>
                  <button
                    type="button"
                    className="btn-secondary text-xs px-2 py-1"
                    aria-label={`View transaction ${shortTransactionId(row.transactionId)}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      activate(row)
                    }}
                  >
                    View
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export function Pagination({
  page,
  pageCount,
  pageSize,
  total,
  start,
  end,
  onPage,
  onPageSize,
}: {
  page: number
  pageCount: number
  pageSize: number
  total: number
  start: number
  end: number
  onPage: (page: number) => void
  onPageSize: (size: number) => void
}) {
  const pages = pageWindow(page, pageCount)
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-slate-400">
      <p>
        Showing {start}-{end} of {total} transactions
      </p>
      <label className="flex items-center gap-2">
        Rows per page
        <select
          className="input w-auto py-1"
          value={pageSize}
          onChange={(event) => onPageSize(Number(event.target.value))}
        >
          {ANOMALY_PAGE_SIZES.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </label>
      <div className="flex items-center gap-1" role="navigation" aria-label="Transaction pages">
        <button
          type="button"
          className="btn-secondary text-xs px-2 py-1"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          Previous
        </button>
        {pages.map((n) => (
          <button
            key={n}
            type="button"
            className={`min-w-[1.75rem] px-2 py-1 rounded-lg text-xs ${
              n === page ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'
            }`}
            aria-current={n === page ? 'page' : undefined}
            onClick={() => onPage(n)}
          >
            {n}
          </button>
        ))}
        <button
          type="button"
          className="btn-secondary text-xs px-2 py-1"
          disabled={page >= pageCount}
          onClick={() => onPage(page + 1)}
        >
          Next
        </button>
      </div>
    </div>
  )
}
