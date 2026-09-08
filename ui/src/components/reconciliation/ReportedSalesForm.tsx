import { useEffect, useState } from 'react'
import { fmtNaira, putStationManagerTill, type DayCloseRow } from '../../api/client'
import { apiErrorMessage } from '../../lib/apiError'

const METHOD_FIELDS = [
  { key: 'cash', label: 'Cash' },
  { key: 'pos', label: 'POS' },
  { key: 'transfer', label: 'Bank transfer' },
  { key: 'mobile_money', label: 'Mobile money' },
  { key: 'fleet_or_credit', label: 'Fleet / credit' },
  { key: 'other', label: 'Other' },
] as const

type MethodKey = (typeof METHOD_FIELDS)[number]['key']

function moneyInput(raw: string): number {
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

function emptyMethods(): Record<MethodKey, string> {
  return {
    cash: '',
    pos: '',
    transfer: '',
    mobile_money: '',
    fleet_or_credit: '',
    other: '',
  }
}

export default function ReportedSalesForm({
  data,
  onSaved,
}: {
  data: DayCloseRow
  onSaved?: () => Promise<void> | void
}) {
  const till = data.till
  const [reported, setReported] = useState('')
  const [methods, setMethods] = useState(emptyMethods)
  const [showMethods, setShowMethods] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    if (!till) return
    if (till.captured) {
      const total =
        Number(till.total ?? 0) || Number(till.cash ?? 0) + Number(till.pos ?? 0) + Number(till.transfer ?? 0)
      setReported(String(total))
      const next = emptyMethods()
      next.cash = till.cash ? String(till.cash) : ''
      next.pos = till.pos ? String(till.pos) : ''
      next.transfer = till.transfer ? String(till.transfer) : ''
      const extra = till.methods || {}
      if (extra.MOBILE_MONEY) next.mobile_money = String(extra.MOBILE_MONEY)
      if (extra.FLEET_OR_CREDIT) next.fleet_or_credit = String(extra.FLEET_OR_CREDIT)
      if (extra.OTHER) next.other = String(extra.OTHER)
      setMethods(next)
      setShowMethods(Boolean(till.pos || till.transfer || extra.MOBILE_MONEY || extra.FLEET_OR_CREDIT || extra.OTHER))
    } else {
      setReported('')
      setMethods(emptyMethods())
    }
  }, [till?.captured, till?.total, till?.cash, till?.pos, till?.transfer, data.businessDate])

  const reportedTotal = showMethods
    ? METHOD_FIELDS.reduce((sum, field) => sum + moneyInput(methods[field.key]), 0)
    : moneyInput(reported)
  const pump = data.financial?.pumpSales ?? data.sales?.amount
  const previewVariance = pump != null ? reportedTotal - Number(pump) : null
  const savedOk = message === 'Reported sales saved.'

  async function saveReported() {
    setSaving(true)
    setMessage(null)
    try {
      const breakdown = showMethods
        ? {
            cash: moneyInput(methods.cash),
            pos: moneyInput(methods.pos),
            transfer: moneyInput(methods.transfer),
            mobile_money: moneyInput(methods.mobile_money),
            fleet_or_credit: moneyInput(methods.fleet_or_credit),
            other: moneyInput(methods.other),
          }
        : {
            cash: moneyInput(reported),
            pos: 0,
            transfer: 0,
            mobile_money: 0,
            fleet_or_credit: 0,
            other: 0,
          }
      await putStationManagerTill({
        station_id: data.stationId,
        business_date: data.businessDate,
        ...breakdown,
      })
      setMessage('Reported sales saved.')
      await onSaved?.()
    } catch (err) {
      setMessage(apiErrorMessage(err, 'Could not save reported sales'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      className="card space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        void saveReported()
      }}
    >
      <h3 className="text-white text-sm font-semibold">Enter reported sales</h3>
      <p className="text-xs text-slate-500">
        Enter the money collected for this business date. That is the only financial short/over.
      </p>
      {!showMethods ? (
        <label className="block max-w-sm">
          <span className="text-xs text-slate-500">Reported sales (₦)</span>
          <input
            className="input w-full mt-1"
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            value={reported}
            onChange={(e) => setReported(e.target.value)}
          />
        </label>
      ) : (
        <div className="grid sm:grid-cols-2 gap-3">
          {METHOD_FIELDS.map((field) => (
            <label key={field.key} className="block">
              <span className="text-xs text-slate-500">{field.label} (₦)</span>
              <input
                className="input w-full mt-1"
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                value={methods[field.key]}
                onChange={(e) => setMethods((prev) => ({ ...prev, [field.key]: e.target.value }))}
              />
            </label>
          ))}
        </div>
      )}
      <button type="button" className="text-sky-300 text-sm underline" onClick={() => setShowMethods((v) => !v)}>
        {showMethods ? 'Use a single total' : 'Enter payment-method breakdown'}
      </button>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          {previewVariance != null && reportedTotal > 0 ? (
            <div className="text-sm text-slate-400">
              {previewVariance === 0
                ? 'Matches pump sales'
                : previewVariance < 0
                  ? `Short ${fmtNaira(Math.abs(previewVariance))}`
                  : `Over ${fmtNaira(previewVariance)}`}
            </div>
          ) : (
            <div className="text-xs text-slate-500">Compared to pump sales after you type an amount.</div>
          )}
        </div>
        <button type="submit" className="btn-primary" disabled={saving}>
          {saving ? 'Saving…' : 'Save reported sales'}
        </button>
      </div>
      {message ? (
        <p className={`text-sm ${savedOk ? 'text-emerald-400' : 'text-red-400'}`} role={savedOk ? 'status' : 'alert'}>
          {message}
        </p>
      ) : null}
    </form>
  )
}
