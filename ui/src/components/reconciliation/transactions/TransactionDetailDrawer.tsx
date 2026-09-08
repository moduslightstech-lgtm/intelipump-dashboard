import { fmtLiters, fmtNaira, fmtSignedNaira, fmtTime } from '../../../api/client'
import {
  getAnomalyDescription,
  getAnomalyLabel,
  type IntegrityTransaction,
} from '../../../lib/anomalyPresentation'

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 border-b border-slate-800 py-2">
      <dt className="text-slate-500">{label}</dt>
      <dd className="font-mono text-slate-200 text-right break-all">{value}</dd>
    </div>
  )
}

export default function TransactionDetailDrawer({
  transaction,
  onClose,
}: {
  transaction: IntegrityTransaction
  onClose: () => void
}) {
  const flags = transaction.flags || []
  const mappingMissing = flags.includes('MISSING_TANK_MAPPING')
  const productMissing = flags.includes('MISSING_PRODUCT_MAPPING') || !transaction.product
  const timestamp = transaction.completedAt || transaction.receivedAt

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="tx-detail-title"
        className="bg-slate-950 border border-slate-800 sm:rounded-xl w-full sm:max-w-lg max-h-[100vh] sm:max-h-[90vh] overflow-auto"
      >
        <div className="sticky top-0 bg-slate-950 border-b border-slate-800 px-4 py-3 flex items-start justify-between gap-3">
          <div>
            <h2 id="tx-detail-title" className="text-white font-semibold">
              Transaction details
            </h2>
            <p className="text-xs text-slate-500 font-mono mt-1">{transaction.transactionId}</p>
          </div>
          <button type="button" className="btn-secondary text-xs" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="p-4 space-y-4">
          <dl className="text-sm">
            <DetailRow label="Transaction ID" value={transaction.transactionId} />
            {timestamp ? <DetailRow label="Timestamp" value={fmtTime(timestamp)} /> : null}
            <DetailRow label="Pump" value={transaction.pumpId || '—'} />
            <DetailRow label="Nozzle" value={transaction.nozzleId || '—'} />
            <DetailRow label="Product" value={transaction.product || '—'} />
            <DetailRow label="Volume" value={fmtLiters(transaction.volumeLiters)} />
            <DetailRow
              label="Unit price"
              value={
                transaction.pricePerLiter == null ? '—' : `${fmtNaira(transaction.pricePerLiter)}/L`
              }
            />
            <DetailRow label="Recorded amount" value={fmtNaira(transaction.recordedAmount)} />
            <DetailRow label="Calculated amount" value={fmtNaira(transaction.calculatedAmount)} />
            <DetailRow
              label="Difference"
              value={transaction.difference == null ? '—' : fmtSignedNaira(transaction.difference)}
            />
            <DetailRow label="Tank mapping" value={mappingMissing ? 'Missing' : 'Available'} />
            <DetailRow label="Product mapping" value={productMissing ? 'Missing' : 'Available'} />
          </dl>

          <div>
            <h3 className="text-white font-semibold text-sm mb-2">Issues</h3>
            {flags.length ? (
              <ul className="space-y-3">
                {flags.map((flag) => (
                  <li key={flag} className="rounded-lg border border-slate-800 p-3">
                    <div className="text-amber-300 text-sm font-medium">{getAnomalyLabel(flag)}</div>
                    <p className="text-sm text-slate-400 mt-1">{getAnomalyDescription(flag)}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-slate-500">No issues recorded for this transaction.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
