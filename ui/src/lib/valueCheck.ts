export type ValueVerdict = 'MATCH' | 'SHORT' | 'OVER' | 'WAITING'

export type ValueCheck = {
  pricePerLiter: number | null
  priceMixed: boolean
  priceMin: number | null
  priceMax: number | null
  pumpLiters: number
  expectedAmount: number | null
  pumpAmount: number
  pumpAmountVariance: number | null
  ticketVerdict: ValueVerdict
  reportedAmount: number | null
  reportedAmountVariance: number | null
  reportedVerdict: ValueVerdict
  tankLitersSold: number | null
  tankExpectedAmount: number | null
  tankLiterVariance: number | null
  tankLitreVerdict: ValueVerdict
  tankAmountVariance: number | null
  tankAmountVerdict: ValueVerdict
  tankReportedVariance: number | null
  tankReportedVerdict: ValueVerdict
  openingMissing: boolean
  currency?: string
}

export function valueDiffLabel(
  fmtMoney: (n: number | null | undefined) => string,
  verdict?: string | null,
  variance?: number | null,
): string {
  if (!verdict || verdict === 'WAITING' || variance == null) return '—'
  if (verdict === 'MATCH') return 'Match'
  if (variance < 0) return `Short ${fmtMoney(Math.abs(variance))}`
  return `Over ${fmtMoney(variance)}`
}

export function valueBadge(verdict?: string | null): { text: string; className: string } {
  if (verdict === 'MATCH') return { text: 'Value matches', className: 'badge-ok' }
  if (verdict === 'SHORT' || verdict === 'OVER') return { text: 'Value variance', className: 'badge-critical' }
  return { text: 'Waiting on sales', className: 'badge-warn' }
}
