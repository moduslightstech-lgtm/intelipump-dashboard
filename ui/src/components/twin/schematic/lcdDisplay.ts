import { displayPumpStatus } from './display'

export type LcdMode = 'THIS SALE' | 'SALE COMPLETE' | 'LAST SALE' | 'READY'

export type LcdView = {
  mode: LcdMode
  amount: number | null
  volume: number | null
  status: string
}

function numOrNull(value?: unknown): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

export function hasMeaningfulSale(amount?: unknown, volume?: unknown): boolean {
  const a = numOrNull(amount)
  const v = numOrNull(volume)
  const amountOk = a != null && Math.abs(a) > 0
  const volumeOk = v != null && Math.abs(v) > 0
  return amountOk || volumeOk
}

export function lcdMode(status?: string | null, amount?: unknown, volume?: unknown): LcdMode {
  return lcdViewFromNozzle(
    {
      livePresentation: status,
      liveAmount: status && displayPumpStatus(status) === 'DISPENSING' ? amount : null,
      liveVolume: status && displayPumpStatus(status) === 'DISPENSING' ? volume : null,
      lastCompletedAmount: amount,
      lastCompletedVolume: volume,
    },
    status,
  ).mode
}

export function lcdViewFromNozzle(raw: Record<string, unknown> = {}, nodeStatus?: string | null): LcdView {
  const presentation = String(raw.livePresentation || nodeStatus || 'IDLE').toUpperCase()
  const shown = displayPumpStatus(presentation)
  const liveAmount = numOrNull(raw.liveAmount)
  const liveVolume = numOrNull(raw.liveVolume)
  const lastAmount =
    numOrNull(raw.lastCompletedAmount) ??
    (shown === 'DISPENSING' || presentation === 'DISPENSING' ? null : numOrNull(raw.lastTransactionAmount))
  const lastVolume =
    numOrNull(raw.lastCompletedVolume) ??
    (shown === 'DISPENSING' || presentation === 'DISPENSING' ? null : numOrNull(raw.lastTransactionVolume))

  if (shown === 'DISPENSING' || presentation === 'DISPENSING') {
    return {
      mode: 'THIS SALE',
      amount: liveAmount,
      volume: liveVolume,
      status: 'DISPENSING',
    }
  }
  if (shown === 'SALE_COMPLETED' || presentation === 'SALE_COMPLETED') {
    return {
      mode: 'SALE COMPLETE',
      amount: liveAmount ?? lastAmount,
      volume: liveVolume ?? lastVolume,
      status: 'SALE_COMPLETED',
    }
  }
  const equipment = displayPumpStatus(
    String(raw.inferredStatus || raw.equipmentStatus || nodeStatus || shown || ''),
  )
  const operational =
    equipment === 'OFFLINE' ||
    equipment === 'POWERED_OFF' ||
    equipment === 'FAULT' ||
    equipment === 'INACTIVE'
      ? equipment
      : shown || 'IDLE'

  if (hasMeaningfulSale(lastAmount, lastVolume)) {
    return {
      mode: 'LAST SALE',
      amount: lastAmount,
      volume: lastVolume,
      status: operational,
    }
  }
  return { mode: 'LAST SALE', amount: null, volume: null, status: operational }
}

export function formatLcdNumber(value?: unknown): string | null {
  const n = numOrNull(value)
  return n == null ? null : n.toFixed(2)
}
