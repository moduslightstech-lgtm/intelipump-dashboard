export type TankReadingSummaryTank = {
  tankId?: string
  tankCode?: string
  name?: string
  product?: string | null
  closingVolumeLiters?: number | null
  notes?: string | null
}

export type TankReadingSummaryData = {
  station?: {
    name?: string
    stationCode?: string
  } | null
  stationName?: string
  stationCode?: string
  businessDate?: string
  uiStatus?: string
  batch?: {
    status?: string
    submittedAt?: string | null
    submittedByUser?: { name?: string | null } | null
    isLate?: boolean
    correctedByAdministrator?: boolean
    correctedAt?: string | null
    notes?: string | null
  } | null
  tanks?: TankReadingSummaryTank[]
  notes?: string | null
}

function formatLiters(value: number | null | undefined) {
  if (value == null || Number.isNaN(Number(value))) return '—'
  return `${Number(value).toLocaleString()} L`
}

function formatDate(iso?: string | null) {
  if (!iso) return '—'
  const [year, month, day] = iso.split('-').map(Number)
  if (!year || !month || !day) return iso
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

function formatDateTime(iso?: string | null) {
  if (!iso) return '—'
  const dt = new Date(iso)
  if (Number.isNaN(dt.getTime())) return iso
  return dt.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export default function TankReadingSummary({
  data,
  title = 'Tank Reading Summary',
  success = false,
}: {
  data: TankReadingSummaryData
  title?: string
  success?: boolean
}) {
  const stationName = data.station?.name || data.stationName || 'Station'
  const stationCode = data.station?.stationCode || data.stationCode
  const status = data.uiStatus || data.batch?.status || '—'
  const tanks = data.tanks || []
  const total = tanks.reduce((sum, tank) => {
    const value = tank.closingVolumeLiters
    return value == null || Number.isNaN(Number(value)) ? sum : sum + Number(value)
  }, 0)
  const notes = tanks.map((tank) => tank.notes).filter(Boolean)
  const batchNotes = data.notes || data.batch?.notes
  const submittedBy = data.batch?.submittedByUser?.name || '—'
  const corrected = Boolean(data.batch?.correctedByAdministrator || status === 'CORRECTED')

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-white font-semibold">{title}</h2>
        <p className="text-slate-300 mt-1">{stationName}</p>
        {stationCode ? <p className="text-xs text-slate-500 font-mono">{stationCode}</p> : null}
        <p className="text-sm text-slate-400">{formatDate(data.businessDate)}</p>
      </div>

      <dl className="space-y-2 text-sm border-y border-dashed border-slate-700 py-3">
        <div className="flex justify-between gap-3">
          <dt className="text-slate-500">Status</dt>
          <dd className="text-emerald-300 font-medium">
            {status}
            {data.batch?.isLate ? <span className="ml-2 text-amber-300 text-xs">LATE</span> : null}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-slate-500">Submitted</dt>
          <dd className="text-slate-200">{formatDateTime(data.batch?.submittedAt)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-slate-500">Submitted by</dt>
          <dd className="text-slate-200">{submittedBy}</dd>
        </div>
        {corrected ? (
          <div className="flex justify-between gap-3">
            <dt className="text-slate-500">Correction</dt>
            <dd className="text-slate-200 text-right">
              Corrected by administrator
              {data.batch?.correctedAt ? (
                <div className="text-xs text-slate-500">{formatDateTime(data.batch.correctedAt)}</div>
              ) : null}
            </dd>
          </div>
        ) : null}
      </dl>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-slate-500">
              <th className="pb-2 pr-3">Tank</th>
              <th className="pb-2 pr-3">Product</th>
              <th className="pb-2 text-right">Closing stock</th>
            </tr>
          </thead>
          <tbody>
            {tanks.map((tank) => (
              <tr key={tank.tankId || tank.tankCode || tank.name} className="border-t border-slate-800">
                <td className="py-2 pr-3 text-white">{tank.name || tank.tankCode || 'Tank'}</td>
                <td className="pr-3 text-slate-300">{tank.product || '—'}</td>
                <td className="text-right font-mono text-slate-200">
                  {formatLiters(tank.closingVolumeLiters)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!tanks.length ? <p className="text-sm text-slate-500">No tank readings on this submission.</p> : null}
      </div>

      <div className="flex justify-between gap-3 border-t border-dashed border-slate-700 pt-3 text-sm">
        <span className="text-slate-500">Total closing stock</span>
        <span className="font-mono text-white">{formatLiters(tanks.length ? total : null)}</span>
      </div>

      {batchNotes ? <p className="text-sm text-slate-400">Notes: {batchNotes}</p> : null}
      {notes.length ? (
        <ul className="text-sm text-slate-400 space-y-1">
          {tanks
            .filter((tank) => tank.notes)
            .map((tank) => (
              <li key={`${tank.tankId}-note`}>
                {tank.name || tank.tankCode}: {tank.notes}
              </li>
            ))}
        </ul>
      ) : null}

      {success ? (
        <p className="text-sm text-emerald-400" role="status">
          ✓ Reading submitted successfully
        </p>
      ) : null}
    </div>
  )
}
