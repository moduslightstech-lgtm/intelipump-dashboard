import { useState } from 'react'
import { Link } from 'react-router-dom'
import { fmtLiters, fmtNaira, fmtSignedNaira, type DayCloseRow } from '../../api/client'
import {
  closeBlocker,
  closeDisabledExplanation,
  financialStatus,
  formatBusinessDate,
  formatFinancialVariance,
  inventoryWarning,
  statusBadge,
  workflowStatus,
  type ReconTab,
} from '../../lib/reconciliationUi'
import ReportedSalesForm from './ReportedSalesForm'
import TransactionIntegrityTab from './transactions/TransactionIntegrityTab'

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-slate-800 pb-2 last:border-0">
      <span className="text-slate-500">{label}</span>
      <span className="font-mono text-slate-200 text-right">{value}</span>
    </div>
  )
}

export type WorkspaceActions = {
  isAdmin?: boolean
  canEnterSales?: boolean
  comment: string
  setComment: (value: string) => void
  onRecalculate?: () => void
  onClose?: () => void
  onReopen?: () => void
  onUsePrevious?: () => void
  onSavedSales?: () => Promise<void> | void
  pending?: { recalc?: boolean; close?: boolean; reopen?: boolean; previous?: boolean }
  audit?: Array<{ id: string; timestamp?: string; action?: string; reason?: string; userId?: string }>
  auditLoading?: boolean
}

export default function ReconciliationWorkspace({
  data,
  loading,
  actions,
  onBackToStations,
  backHref,
  backLabel = 'Back to reconciliation overview',
}: {
  data: DayCloseRow | null
  loading?: boolean
  actions: WorkspaceActions
  onBackToStations?: () => void
  backHref?: string
  backLabel?: string
}) {
  const [tab, setTab] = useState<ReconTab>('summary')
  const [moreOpen, setMoreOpen] = useState(false)
  const [payOpen, setPayOpen] = useState(false)

  if (loading) {
    return (
      <div className="card min-h-[24rem] flex items-center justify-center text-slate-500">
        Loading reconciliation…
      </div>
    )
  }

  if (!data) {
    return (
      <div className="card min-h-[24rem] flex items-center justify-center text-slate-400 text-center px-6">
        Select a station to review its reconciliation.
      </div>
    )
  }

  const financial = data.financial
  const integrity = data.integrity
  const inventory = data.inventory
  const finStatus = financialStatus(data)
  const wf = workflowStatus(data)
  const blocked = closeBlocker(data)
  const warning = inventoryWarning(data)
  const ready = !blocked && wf !== 'CLOSED'
  const closeDisabled = Boolean(blocked) || Boolean(actions.pending?.close)
  const closeHelp = closeDisabledExplanation(blocked)
  const checks = data.readiness?.label || `${data.readiness?.complete ?? 0} of 3 checks complete`
  const noSales = (integrity?.transactionCount ?? data.sales?.transactionCount ?? 0) === 0

  const tabs: { id: ReconTab; label: string }[] = [
    { id: 'summary', label: 'Summary' },
    { id: 'transactions', label: 'Transactions' },
    { id: 'tanks', label: 'Tanks' },
    { id: 'audit', label: 'Audit' },
  ]

  return (
    <div className="flex flex-col gap-4">
      {(onBackToStations || backHref) ? (
        <div className="shrink-0">
          {onBackToStations ? (
            <button type="button" className="btn-secondary text-sm" onClick={onBackToStations}>
              ← {backLabel}
            </button>
          ) : (
            <Link className="text-sky-300 text-sm" to={backHref!}>
              ← {backLabel}
            </Link>
          )}
        </div>
      ) : null}

      <div className="card space-y-2 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-white text-lg font-semibold">{data.stationName}</h2>
            <p className="text-sm text-slate-400">{formatBusinessDate(data.businessDate)}</p>
          </div>
          <div className="flex items-center gap-2">
            <span className={statusBadge(wf).className}>{wf}</span>
            {actions.isAdmin ? (
              <div className="relative">
                <button
                  type="button"
                  className="btn-secondary"
                  aria-expanded={moreOpen}
                  aria-haspopup="menu"
                  onClick={() => setMoreOpen((v) => !v)}
                >
                  ⋯ More
                </button>
                {moreOpen ? (
                  <div
                    role="menu"
                    className="absolute right-0 mt-2 z-20 min-w-[12rem] rounded-xl border border-slate-700 bg-slate-900 p-1 shadow-xl"
                  >
                    {actions.onRecalculate ? (
                      <button
                        type="button"
                        role="menuitem"
                        className="w-full text-left px-3 py-2 rounded-lg text-sm text-slate-200 hover:bg-slate-800"
                        disabled={actions.pending?.recalc}
                        onClick={() => {
                          setMoreOpen(false)
                          actions.onRecalculate?.()
                        }}
                      >
                        {actions.pending?.recalc ? 'Recalculating…' : 'Recalculate'}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      role="menuitem"
                      className="w-full text-left px-3 py-2 rounded-lg text-sm text-slate-200 hover:bg-slate-800"
                      onClick={() => {
                        setMoreOpen(false)
                        setTab('audit')
                      }}
                    >
                      View audit history
                    </button>
                    {wf === 'CLOSED' && actions.onReopen ? (
                      <button
                        type="button"
                        role="menuitem"
                        className="w-full text-left px-3 py-2 rounded-lg text-sm text-slate-200 hover:bg-slate-800"
                        disabled={actions.pending?.reopen}
                        onClick={() => {
                          setMoreOpen(false)
                          actions.onReopen?.()
                        }}
                      >
                        Reopen
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
        <p className="text-sm text-slate-300">Reconciliation readiness · {checks}</p>
        <div className="grid sm:grid-cols-3 gap-2 text-sm">
          <div>
            {finStatus === 'MATCH' ? '✓' : '!'} Financial{' '}
            <span className={statusBadge(finStatus).className}>{finStatus}</span>
          </div>
          <div>
            {integrity?.status === 'MATCH' ? '✓' : '!'} Transaction Integrity{' '}
            <span className={statusBadge(integrity?.status).className}>{integrity?.status || 'WAITING'}</span>
          </div>
          <div>
            {inventory?.status === 'MATCH' ? '✓' : '!'} Tank Inventory{' '}
            <span className={statusBadge(inventory?.status).className}>{inventory?.status || 'INCOMPLETE'}</span>
          </div>
        </div>
        {data.lateData?.flag || data.lateDataReceived ? (
          <p className="text-sm text-amber-300">
            {data.lateData?.summary || 'Late transactions arrived after this reconciliation was closed.'}
          </p>
        ) : null}
      </div>

      <div
        className="flex flex-wrap gap-1 rounded-full bg-slate-800 border border-slate-700 p-1"
        role="tablist"
        aria-label="Reconciliation sections"
      >
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={`px-3 py-1.5 rounded-full text-sm ${
              tab === item.id ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'
            }`}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="space-y-4">
        {tab === 'summary' ? (
          <>
            {noSales ? (
              <p className="text-sm text-slate-400">No completed pump transactions for this business date.</p>
            ) : null}
            <div className="grid xl:grid-cols-2 gap-4">
              <div className="card space-y-3">
                <h3 className="text-white font-semibold">Financial</h3>
                <p className="text-xs text-slate-500">
                  Reported collections versus completed pump sales. Litres × price is not a financial short.
                </p>
                <Row label="Pump sales" value={fmtNaira(financial?.pumpSales ?? data.sales?.amount)} />
                <Row
                  label="Reported collections"
                  value={fmtNaira(financial?.reportedSales ?? (data.till?.captured ? data.till.total : null))}
                />
                <Row label="Variance" value={formatFinancialVariance(data)} />
                <Row label="Status" value={finStatus} />
                <button type="button" className="text-sky-300 text-sm underline" onClick={() => setPayOpen((v) => !v)}>
                  {payOpen ? 'Hide payment methods' : 'Show payment methods'}
                </button>
                {payOpen
                  ? Object.entries(data.till?.methods || financial?.methods || {}).map(([method, amount]) => (
                      <Row key={method} label={method.replace(/_/g, ' ')} value={fmtNaira(amount as number)} />
                    ))
                  : null}
              </div>

              <div className="card space-y-3">
                <h3 className="text-white font-semibold">Transaction integrity</h3>
                <p className="text-xs text-slate-500">
                  Each completed sale is checked as litres × that sale’s price. This is not financial short/over.
                </p>
                <Row
                  label="Transactions"
                  value={String(integrity?.transactionCount ?? data.sales?.transactionCount ?? 0)}
                />
                <Row label="Pump litres" value={fmtLiters(integrity?.pumpLiters ?? data.sales?.volumeLiters)} />
                <Row label="Recorded pump value" value={fmtNaira(integrity?.recordedAmount ?? data.sales?.amount)} />
                <Row label="Calculated litres × price" value={fmtNaira(integrity?.calculatedAmount)} />
                <Row
                  label="Difference"
                  value={integrity?.difference == null ? '—' : fmtSignedNaira(integrity.difference)}
                />
                <Row label="Anomalies" value={String(integrity?.anomalyCount ?? 0)} />
                <Row label="Status" value={integrity?.status || 'WAITING'} />
                <button type="button" className="btn-secondary" onClick={() => setTab('transactions')}>
                  Review transactions
                </button>
              </div>
            </div>

            <TankInventoryCard
              data={data}
              warning={warning}
              onUsePrevious={actions.onUsePrevious}
              usingPrevious={actions.pending?.previous}
            />

            {data.completeness ? <CompletenessCard data={data} /> : null}
            {actions.canEnterSales ? <ReportedSalesForm data={data} onSaved={actions.onSavedSales} /> : null}
          </>
        ) : null}

        {tab === 'transactions' ? <TransactionIntegrityTab data={data} /> : null}

        {tab === 'tanks' ? (
          <TankInventoryCard
            data={data}
            warning={warning}
            onUsePrevious={actions.onUsePrevious}
            usingPrevious={actions.pending?.previous}
            detailed
          />
        ) : null}

        {tab === 'audit' ? (
          <div className="card space-y-3">
            <h3 className="text-white font-semibold">Audit history</h3>
            {actions.auditLoading ? <p className="text-sm text-slate-500">Loading audit…</p> : null}
            {(actions.audit || []).map((row) => (
              <div key={row.id} className="border-b border-slate-800 pb-2 text-sm">
                <div className="text-slate-200">{row.action}</div>
                <div className="text-slate-500">
                  {row.timestamp || '—'}
                  {row.reason ? ` · ${row.reason}` : ''}
                </div>
              </div>
            ))}
            {!actions.auditLoading && !(actions.audit || []).length ? (
              <p className="text-sm text-slate-500">No audit events yet.</p>
            ) : null}
          </div>
        ) : null}
      </div>

      {actions.isAdmin && wf !== 'CLOSED' ? (
        <div className="card flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-sm text-slate-300">{checks}</p>
            <p id="recon-close-status" className={`text-sm ${ready ? 'text-emerald-400' : 'text-amber-300'}`}>
              {ready ? '✓ Reconciliation is ready to close' : blocked}
            </p>
            {closeHelp ? (
              <p id="recon-close-help" className="sr-only">
                {closeHelp}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="block">
              <span className="text-xs text-slate-500">Add comment</span>
              <input
                className="input mt-1 min-w-[12rem]"
                value={actions.comment}
                onChange={(e) => actions.setComment(e.target.value)}
                placeholder={wf === 'REVIEW_REQUIRED' ? 'Required to approve a variance' : 'Optional comment'}
              />
            </label>
            <button
              type="button"
              className="btn-primary"
              disabled={closeDisabled}
              aria-disabled={closeDisabled}
              aria-describedby={
                closeDisabled
                  ? closeHelp
                    ? 'recon-close-status recon-close-help'
                    : 'recon-close-status'
                  : undefined
              }
              onClick={closeDisabled ? undefined : actions.onClose}
            >
              {actions.pending?.close ? 'Closing…' : 'Close reconciliation'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function TankInventoryCard({
  data,
  warning,
  onUsePrevious,
  usingPrevious,
  detailed,
}: {
  data: DayCloseRow
  warning: string | null
  onUsePrevious?: () => void
  usingPrevious?: boolean
  detailed?: boolean
}) {
  const inventory = data.inventory
  return (
    <div className="card space-y-3">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-white font-semibold">Tank inventory</h3>
        <Link className="btn-secondary text-xs px-2 py-1" to="/station-manager/tank-readings">
          Tank Reading
        </Link>
      </div>
      {warning ? <p className="text-sm text-amber-300">{warning}</p> : null}
      {onUsePrevious && inventory?.usePreviousClosing && !inventory.enterBaselineOpening ? (
        <button type="button" className="btn-secondary" disabled={usingPrevious} onClick={onUsePrevious}>
          {usingPrevious ? 'Applying…' : 'Use previous verified closing'}
        </button>
      ) : null}
      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[48rem]">
          <thead>
            <tr className="text-left text-slate-500">
              <th className="pb-2 pr-3">Tank</th>
              <th className="pb-2 pr-3">Product</th>
              <th className="pb-2 pr-3">Opening</th>
              <th className="pb-2 pr-3">Deliveries</th>
              <th className="pb-2 pr-3">Pump litres</th>
              <th className="pb-2 pr-3">Expected closing</th>
              <th className="pb-2 pr-3">Actual closing</th>
              <th className="pb-2 pr-3">Variance</th>
              <th className="pb-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {(inventory?.tanks || []).map((tank) => (
              <tr key={tank.tankId} className="border-t border-slate-800">
                <td className="py-2 pr-3 text-white">{tank.tankCode}</td>
                <td className="pr-3">{tank.product || '—'}</td>
                <td className="pr-3">{tank.openingMissing ? 'Missing' : fmtLiters(tank.openingLiters)}</td>
                <td className="pr-3">{fmtLiters(tank.deliveryLiters)}</td>
                <td className="pr-3">{fmtLiters(tank.dispensedLiters)}</td>
                <td className="pr-3">{tank.expectedClosingLiters == null ? '—' : fmtLiters(tank.expectedClosingLiters)}</td>
                <td className="pr-3">{tank.actualClosingLiters == null ? '—' : fmtLiters(tank.actualClosingLiters)}</td>
                <td className="pr-3">{tank.varianceLiters == null ? '—' : fmtLiters(tank.varianceLiters)}</td>
                <td>
                  <span className={statusBadge(tank.status).className}>{tank.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!inventory?.tanks?.length ? <p className="text-sm text-slate-500">No tanks on this station yet.</p> : null}
      {detailed && inventory?.tanks?.some((tank) => tank.blocker) ? (
        <ul className="text-sm text-slate-400 list-disc list-inside">
          {inventory.tanks
            .filter((tank) => tank.blocker)
            .map((tank) => (
              <li key={`${tank.tankId}-blocker`}>
                {tank.tankCode}: {tank.blocker}
              </li>
            ))}
        </ul>
      ) : null}
    </div>
  )
}

function CompletenessCard({ data }: { data: DayCloseRow }) {
  return (
    <div className="card space-y-2 text-sm">
      <h3 className="text-white font-semibold">Data completeness</h3>
      <Row label="Pump transactions" value={String(data.completeness?.pumpTransactions ?? 0)} />
      <Row label="Last pump transaction" value={String(data.completeness?.lastPumpTransaction || '—')} />
      <Row
        label="Gateway"
        value={String((data.completeness?.gateway as { status?: string } | undefined)?.status || '—')}
      />
      <Row
        label="Closing readings"
        value={`${data.completeness?.closingReadingsReceived ?? 0} / ${data.completeness?.tanks ?? 0}`}
      />
      <Row
        label="Opening readings"
        value={`${data.completeness?.openingReadingsAvailable ?? 0} / ${data.completeness?.tanks ?? 0}`}
      />
      <Row label="Deliveries" value={fmtLiters(data.completeness?.deliveriesRecorded as number)} />
      <Row label="Missing mappings" value={String(data.completeness?.missingMappings ?? 0)} />
      <Row label="Late transactions" value={String(data.completeness?.lateTransactions ?? 0)} />
      <Row label="Anomalies" value={String(data.completeness?.dataAnomalies ?? 0)} />
    </div>
  )
}
