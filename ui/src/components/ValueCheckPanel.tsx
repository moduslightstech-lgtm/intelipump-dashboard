import { fmtLiters, fmtNaira } from '../api/client'
import { valueDiffLabel, type ValueCheck } from '../lib/valueCheck'

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-slate-800 pb-2 last:border-0">
      <span className="text-slate-500">
        {label}
        {hint ? <span className="block text-xs text-slate-600 font-normal">{hint}</span> : null}
      </span>
      <span className="font-mono text-slate-200 text-right">{value}</span>
    </div>
  )
}

export default function ValueCheckPanel({
  value,
  compact,
}: {
  value?: ValueCheck | null
  compact?: boolean
}) {
  if (!value || value.pumpLiters <= 0) {
    return (
      <p className="text-sm text-slate-500">
        Expected amount appears after there are pump litres to multiply by price per litre.
      </p>
    )
  }

  const price = value.priceMixed
    ? `${fmtNaira(value.pricePerLiter)} avg (${fmtNaira(value.priceMin)}–${fmtNaira(value.priceMax)})`
    : fmtNaira(value.pricePerLiter)

  return (
    <div className="space-y-2 text-sm">
      {!compact ? (
        <p className="text-xs text-slate-500">
          Expected amount = pump litres × price per litre. That should match pump sales and reported
          sales. Tank litres sold = opening + deliveries − closing dip, then × the same price.
        </p>
      ) : null}
      <Row label="Price per litre" value={price} />
      <Row label="Pump litres" value={fmtLiters(value.pumpLiters)} />
      <Row label="Expected amount" value={fmtNaira(value.expectedAmount)} hint="Litres × price" />
      <Row
        label="vs Pump sales"
        value={`${fmtNaira(value.pumpAmount)} · ${valueDiffLabel(fmtNaira, value.ticketVerdict, value.pumpAmountVariance)}`}
      />
      <Row
        label="vs Reported sales"
        value={
          value.reportedAmount == null
            ? 'Not entered'
            : `${fmtNaira(value.reportedAmount)} · ${valueDiffLabel(fmtNaira, value.reportedVerdict, value.reportedAmountVariance)}`
        }
      />
      {value.tankLitersSold != null ? (
        <>
          <Row
            label="Tank litres sold"
            value={fmtLiters(value.tankLitersSold)}
            hint="Opening + deliveries − closing"
          />
          <Row
            label="Expected from tank"
            value={fmtNaira(value.tankExpectedAmount)}
            hint="Tank litres sold × price"
          />
          <Row
            label="Tank vs pump litres"
            value={valueDiffLabel(fmtLiters, value.tankLitreVerdict, value.tankLiterVariance)}
          />
          <Row
            label="Tank vs pump sales"
            value={valueDiffLabel(fmtNaira, value.tankAmountVerdict, value.tankAmountVariance)}
          />
          {value.openingMissing ? (
            <p className="text-xs text-amber-300 pt-1">
              Opening stock is missing, so tank litres sold is not reliable yet. Enter yesterday’s
              closing as today’s opening (or submit a prior tank reading).
            </p>
          ) : null}
        </>
      ) : (
        <p className="text-xs text-slate-500 pt-1">
          Submit a tank reading to compare tank litres sold × price to these amounts.
        </p>
      )}
    </div>
  )
}
