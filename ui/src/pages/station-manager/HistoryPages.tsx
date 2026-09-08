import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { getStationManagerCurrentReadings, getStationManagerHistory, getStationManagerStations } from '../../api/client'
import TankReadingSummary from '../../components/tank-readings/TankReadingSummary'

export function StationManagerHistoryPage() {
  const stationsQ = useQuery({
    queryKey: ['sm', 'stations'],
    queryFn: async () => (await getStationManagerStations()).data,
  })
  const [stationId, setStationId] = useState('')
  const [viewDate, setViewDate] = useState<string | null>(null)

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

  const viewQ = useQuery({
    queryKey: ['sm', 'history-view', stationId, viewDate],
    queryFn: async () => (await getStationManagerCurrentReadings(stationId, viewDate || undefined)).data,
    enabled: Boolean(stationId && viewDate),
  })

  return (
    <div className="p-6 space-y-4 max-w-5xl mx-auto">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="section-title">Submission History</h1>
          <p className="text-slate-400 text-sm mt-1">
            Full history. Day-to-day entry lives on{' '}
            <Link className="text-emerald-400 hover:underline" to="/station-manager/tank-readings">
              Tank Reading
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
              <th className="pb-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((b: any) => (
              <tr key={b.id} className="border-b border-slate-800">
                <td className="py-2 font-mono">{b.businessDate}</td>
                <td className="py-2">
                  {b.status}
                  {b.isLate ? <span className="ml-1 text-[10px] text-amber-300">LATE</span> : null}
                </td>
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
                <td className="py-2">
                  <button
                    type="button"
                    className="btn-secondary text-xs px-2 py-1"
                    onClick={() => setViewDate(b.businessDate)}
                  >
                    View
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {viewDate ? (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-slate-950 border border-slate-800 sm:rounded-xl w-full sm:max-w-2xl max-h-[100vh] sm:max-h-[90vh] overflow-auto p-5">
            <div className="flex justify-end mb-2">
              <button type="button" className="btn-secondary text-xs" onClick={() => setViewDate(null)}>
                Close
              </button>
            </div>
            {viewQ.isLoading ? <p className="text-sm text-slate-500">Loading submission…</p> : null}
            {viewQ.isError ? (
              <p className="text-sm text-red-300">Could not load this tank-reading submission.</p>
            ) : null}
            {viewQ.data ? <TankReadingSummary data={viewQ.data} /> : null}
          </div>
        </div>
      ) : null}
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
