/** Sale amount / volume / optional unit price for a nozzle panel. */

import { fmtLiters, fmtNaira } from '../../../../../api/client'

export type SaleValueDisplayProps = {
  label: string
  amount: number | null
  volume: number | null
  pricePerLitre?: number | null
  emptyMessage?: string
  showPrice?: boolean
}

function hasMeaningfulSale(amount: number | null, volume: number | null): boolean {
  const amountOk = amount != null && Number.isFinite(amount) && Math.abs(amount) > 0
  const volumeOk = volume != null && Number.isFinite(volume) && Math.abs(volume) > 0
  return amountOk || volumeOk
}

/**
 * Stable LCD totals. Amount and volume nodes stay continuously mounted so
 * numeric text can change without blank frames, fallback swaps, or remounts.
 * Only the status dot may pulse — never these values.
 */
export function SaleValueDisplay({
  label,
  amount,
  volume,
  pricePerLitre,
  emptyMessage = 'No completed sale',
  showPrice = false,
}: SaleValueDisplayProps) {
  const meaningful = hasMeaningfulSale(amount, volume)
  return (
    <div className="mt-auto min-w-0" data-testid="sale-value-display">
      <div className="text-[12px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
      <div
        className="mt-1 text-[26px] font-bold leading-tight text-white tabular-nums"
        data-testid="sale-amount"
        data-empty={meaningful ? '0' : '1'}
        aria-hidden={!meaningful}
      >
        {meaningful ? fmtNaira(Number(amount ?? 0)) : '\u00a0'}
      </div>
      <div
        className="mt-0.5 text-[20px] font-semibold leading-tight text-slate-100 tabular-nums"
        data-testid="sale-volume"
        data-empty={meaningful ? '0' : '1'}
        aria-hidden={!meaningful}
      >
        {meaningful ? fmtLiters(Number(volume ?? 0)) : '\u00a0'}
      </div>
      {showPrice && pricePerLitre != null && Number.isFinite(pricePerLitre) && pricePerLitre > 0 ? (
        <div className="mt-1 text-[13px] text-slate-400 tabular-nums" data-testid="sale-price">
          {fmtNaira(Number(pricePerLitre))}/L
        </div>
      ) : null}
      {!meaningful ? (
        <div className="mt-1 text-[14px] text-slate-400" data-testid="sale-empty">
          {emptyMessage}
        </div>
      ) : null}
    </div>
  )
}

export default SaleValueDisplay
