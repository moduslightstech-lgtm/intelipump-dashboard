import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  getStationManagerHistory,
  getStationManagerReconciliation,
  getStationManagerStations,
} from '../../api/client'

export function StationManagerHistoryPage() {
  const stationsQ = useQuery({
    queryKey: ['sm', 'stations'],
    queryFn: async () => (await getStationManagerStations()).data,
  })
  const [stationId, setStationId] = useState('')
  useEffect(() => {
    if (!stationId && stationsQ.data?.[0]?.id) setStationId(stationsQ.data[0].id)
  }, [stationsQ.data, stationId])

  const histQ = useQuery({
    queryKey: ['sm', 'history-page', stationId],
    queryFn: async () =>
      (await getStationManagerHistory({ station_id: stationId || undefined, page_size: 50 })).data,
    enabled: !!stationId,
  })
  const items = histQ.data?.items || []

  return (
    <div className="p-6 space-y-4 max-w-5xl mx-auto">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="section-title">Submission History</h1>
          <p className="text-slate-400 text-sm mt-1">
            Full history. Day-to-day entry lives on{' '}
            <Link className="text-emerald-400 hover:underline" to="/station-manager/tank-readings">
              Nightly Tank Readings
            </Link>
            .
          </p>
        </div>
        <select className="input" value={stationId} onChange={(e) => setStationId(e.target.value)}>
          {(stationsQ.data || []).map((s: any) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-slate-400 border-b border-slate-700">
              <th className="pb-2">Business date</th>
              <th className="pb-2">Status</th>
              <th className="pb-2">Submitted by</th>
              <th className="pb-2 text-right">Total volume</th>
              <th className="pb-2">Tanks</th>
              <th className="pb-2">Submitted</th>
            </tr>
          </thead>
          <tbody>
            {items.map((b: any) => (
              <tr key={b.id} className="border-b border-slate-800">
                <td className="py-2 font-mono">{b.businessDate}</td>
                <td className="py-2">{b.status}</td>
                <td className="py-2 text-xs">{b.submittedBy?.name || '—'}</td>
                <td className="py-2 text-right font-mono">
                  {b.totalClosingVolumeLiters != null
                    ? `${Number(b.totalClosingVolumeLiters).toLocaleString()} L`
                    : '—'}
                </td>
                <td className="py-2">
                  {b.tankCount}/{b.expectedTankCount}
                </td>
                <td className="py-2 text-xs text-slate-400">
                  {b.submittedAt ? new Date(b.submittedAt).toLocaleString() : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function StationManagerReconPage() {
  const stationsQ = useQuery({
    queryKey: ['sm', 'stations'],
    queryFn: async () => (await getStationManagerStations()).data,
  })
  const [stationId, setStationId] = useState('')
  useEffect(() => {
    if (!stationId && stationsQ.data?.[0]?.id) setStationId(stationsQ.data[0].id)
  }, [stationsQ.data, stationId])
  const reconQ = useQuery({
    queryKey: ['sm', 'recon', stationId],
    queryFn: async () => (await getStationManagerReconciliation(stationId)).data,
    enabled: !!stationId,
  })
  const run = reconQ.data?.run

  return (
    <div className="p-6 space-y-4 max-w-3xl mx-auto">
      <h1 className="section-title">Reconciliation Result</h1>
      <select className="input" value={stationId} onChange={(e) => setStationId(e.target.value)}>
        {(stationsQ.data || []).map((s: any) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      <div className="card space-y-2 text-sm">
        <Row label="Business date" value={reconQ.data?.businessDate} />
        <Row label="Status" value={reconQ.data?.status} />
        <Row label="Sales volume" value={run ? `${run.transactionSalesVolume} L` : '—'} />
        <Row label="Sales amount" value={run ? String(run.transactionSalesAmount) : '—'} />
        <Row label="Opening stock" value={run ? `${run.openingStockVolume} L` : '—'} />
        <Row label="Deliveries" value={run ? `${run.deliveryVolume} L` : '—'} />
        <Row label="Expected closing" value={run ? `${run.expectedClosingVolume} L` : '—'} />
        <Row label="Actual closing" value={run ? `${run.actualClosingVolume} L` : '—'} />
        <Row
          label="Tank variance"
          value={run ? `${run.tankVarianceVolume} L (${run.tankVariancePercentage}%)` : '—'}
        />
      </div>
    </div>
  )
}

export function StationManagerProfilePage() {
  return (
    <div className="p-6 max-w-lg mx-auto card text-sm text-slate-300 space-y-2">
      <h1 className="section-title">Profile</h1>
      <p>Use the account menu to log out. Station assignments are managed by Admin.</p>
    </div>
  )
}

function Row({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-slate-500">{label}</span>
      <span className="text-slate-200 text-right">{value || '—'}</span>
    </div>
  )
}
