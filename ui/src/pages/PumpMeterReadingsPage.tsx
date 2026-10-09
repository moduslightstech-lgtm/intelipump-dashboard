import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getMeterCapability,
  getMeterReadingWindow,
  getMeterSchedules,
  getStations,
  listMeterReadings,
  postManualMeterReading,
  postMeterReadNow,
  putMeterSchedule,
} from '../api/client'

function todayLagos(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Lagos',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

function fmtTs(iso?: string | null) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('en-GB', { timeZone: 'Africa/Lagos' })
  } catch {
    return iso
  }
}

export default function PumpMeterReadingsPage() {
  const qc = useQueryClient()
  const stationsQ = useQuery({
    queryKey: ['stations'],
    queryFn: async () => (await getStations()).data,
  })
  const [stationId, setStationId] = useState('')
  const [pumpId, setPumpId] = useState('pump-1')
  const [businessDate, setBusinessDate] = useState(todayLagos())
  const [manualNozzle, setManualNozzle] = useState('nozzle-1')
  const [manualLiters, setManualLiters] = useState('')
  const [manualSlot, setManualSlot] = useState('OPENING')
  const [manualNote, setManualNote] = useState('')
  const [openTime, setOpenTime] = useState('05:00')
  const [closeTime, setCloseTime] = useState('22:00')
  const [closeNextDay, setCloseNextDay] = useState(false)

  const mqttStation = useMemo(() => {
    const rows = stationsQ.data || []
    const st = rows.find((s: any) => s.id === stationId || s.mqtt_station_id === stationId)
    return st?.mqtt_station_id || st?.station_code || stationId
  }, [stationsQ.data, stationId])

  const capQ = useQuery({
    queryKey: ['meter-cap'],
    queryFn: async () => (await getMeterCapability()).data,
  })

  const windowQ = useQuery({
    queryKey: ['meter-window', mqttStation, pumpId, businessDate],
    enabled: Boolean(mqttStation && pumpId && businessDate),
    queryFn: async () =>
      (
        await getMeterReadingWindow({
          station_id: mqttStation,
          pump_id: pumpId,
          business_date: businessDate,
          include_sales_variance: true,
        })
      ).data,
  })

  const readingsQ = useQuery({
    queryKey: ['meter-readings', mqttStation, pumpId],
    enabled: Boolean(mqttStation),
    queryFn: async () =>
      (await listMeterReadings({ station_id: mqttStation, pump_id: pumpId, limit: 50 })).data,
  })

  const scheduleQ = useQuery({
    queryKey: ['meter-schedules', mqttStation],
    enabled: Boolean(mqttStation),
    queryFn: async () => (await getMeterSchedules(mqttStation)).data,
  })

  const manualM = useMutation({
    mutationFn: async () =>
      postManualMeterReading({
        station_id: mqttStation,
        pump_id: pumpId,
        nozzle_id: manualNozzle,
        cumulative_volume_liters: Number(manualLiters),
        captured_at: new Date().toISOString(),
        slot: manualSlot,
        evidence_note: manualNote || 'Manual face/totalizer observation',
        notes: manualNote || undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['meter-window'] })
      qc.invalidateQueries({ queryKey: ['meter-readings'] })
      setManualLiters('')
    },
  })

  const readNowM = useMutation({
    mutationFn: async (nozzle: string) =>
      postMeterReadNow({
        station_id: mqttStation,
        pump_id: pumpId,
        nozzle_id: nozzle,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['meter-readings'] })
    },
  })

  const scheduleM = useMutation({
    mutationFn: async () =>
      putMeterSchedule({
        station_id: mqttStation,
        timezone: 'Africa/Lagos',
        opening_local_time: openTime.length === 5 ? `${openTime}:00` : openTime,
        closing_local_time: closeTime.length === 5 ? `${closeTime}:00` : closeTime,
        closing_next_day: closeNextDay,
        enabled: true,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['meter-schedules'] }),
  })

  const nozzles = windowQ.data?.nozzles || []

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-100">Pump Meter Readings</h1>
        <p className="mt-1 text-sm text-slate-400">
          Independent cumulative volume reconciliation. Does not change sales totals.
        </p>
      </div>

      <div className="rounded-lg border border-amber-700/40 bg-amber-950/30 p-3 text-sm text-amber-100">
        <strong>Capability:</strong> {capQ.data?.detail || 'Loading…'}
        <div className="mt-1 text-xs text-amber-200/80">
          Automatic CD101: {capQ.data?.automatic_cd101 || '—'} · Manual supported:{' '}
          {String(capQ.data?.manual_supported ?? '—')}
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <label className="text-sm text-slate-300">
          Station
          <select
            className="mt-1 w-full rounded border border-slate-700 bg-slate-900 px-2 py-2"
            value={stationId}
            onChange={(e) => setStationId(e.target.value)}
          >
            <option value="">Select…</option>
            {(stationsQ.data || []).map((s: any) => (
              <option key={s.id} value={s.id}>
                {s.name || s.station_code || s.mqtt_station_id}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm text-slate-300">
          Pump
          <input
            className="mt-1 w-full rounded border border-slate-700 bg-slate-900 px-2 py-2"
            value={pumpId}
            onChange={(e) => setPumpId(e.target.value)}
            placeholder="pump-1"
          />
        </label>
        <label className="text-sm text-slate-300">
          Business date (Lagos)
          <input
            type="date"
            className="mt-1 w-full rounded border border-slate-700 bg-slate-900 px-2 py-2"
            value={businessDate}
            onChange={(e) => setBusinessDate(e.target.value)}
          />
        </label>
        <div className="flex items-end gap-2">
          <button
            type="button"
            className="rounded bg-slate-700 px-3 py-2 text-sm text-white"
            onClick={() => windowQ.refetch()}
            disabled={!mqttStation}
          >
            Refresh window
          </button>
        </div>
      </div>

      <section className="space-y-3">
        <h2 className="text-lg text-slate-200">Opening / closing (nozzle 1 & 2)</h2>
        <p className="text-xs text-slate-500">
          Window {fmtTs(windowQ.data?.window_start)} → {fmtTs(windowQ.data?.window_end)} (
          {windowQ.data?.timezone || 'Africa/Lagos'})
        </p>
        <div className="grid gap-4 md:grid-cols-2">
          {nozzles.map((n: any) => (
            <div key={n.nozzle_id} className="rounded-lg border border-slate-700 bg-slate-900/60 p-4">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="font-medium text-slate-100">{n.nozzle_id}</h3>
                <button
                  type="button"
                  className="rounded border border-slate-600 px-2 py-1 text-xs text-slate-200"
                  disabled={!mqttStation || readNowM.isPending}
                  onClick={() => readNowM.mutate(n.nozzle_id)}
                >
                  Read now
                </button>
              </div>
              <dl className="space-y-1 text-sm text-slate-300">
                <div>
                  Opening:{' '}
                  {n.opening?.volume_liters != null ? `${n.opening.volume_liters} L` : '—'}{' '}
                  <span className="text-xs text-slate-500">
                    ({fmtTs(n.opening?.captured_at)}; src={n.opening?.source || '—'}; status=
                    {n.opening?.status || '—'}
                    {n.opening?.nearby_offset_seconds
                      ? `; nearby offset ${n.opening.nearby_offset_seconds}s`
                      : ''}
                    )
                  </span>
                </div>
                <div>
                  Closing:{' '}
                  {n.closing?.volume_liters != null ? `${n.closing.volume_liters} L` : '—'}{' '}
                  <span className="text-xs text-slate-500">
                    ({fmtTs(n.closing?.captured_at)}; src={n.closing?.source || '—'}; status=
                    {n.closing?.status || '—'}
                    {n.closing?.nearby_offset_seconds
                      ? `; nearby offset ${n.closing.nearby_offset_seconds}s`
                      : ''}
                    )
                  </span>
                </div>
                <div>
                  Delta:{' '}
                  <strong className="text-slate-100">
                    {n.delta_liters != null ? `${n.delta_liters} L` : '—'}
                  </strong>
                </div>
                <div className="text-xs text-slate-500">
                  Optional sales compare (does not change sales totals): completed{' '}
                  {n.completed_sale_liters ?? '—'} L · variance {n.variance_liters ?? '—'} L
                </div>
                {n.note ? <div className="text-xs text-amber-300">{n.note}</div> : null}
                {n.flags && Object.keys(n.flags).length > 0 ? (
                  <div className="text-xs text-rose-300">Flags: {JSON.stringify(n.flags)}</div>
                ) : null}
              </dl>
            </div>
          ))}
          {!nozzles.length && (
            <p className="text-sm text-slate-500">Select a station/pump/date to load nozzle windows.</p>
          )}
        </div>
        {readNowM.data ? (
          <p className="text-sm text-slate-400">
            Read now: {readNowM.data.data?.status} — {readNowM.data.data?.message}
          </p>
        ) : null}
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-slate-700 p-4">
          <h2 className="mb-3 text-lg text-slate-200">Manual cumulative reading</h2>
          <div className="space-y-2 text-sm">
            <label className="block text-slate-300">
              Nozzle
              <select
                className="mt-1 w-full rounded border border-slate-700 bg-slate-900 px-2 py-2"
                value={manualNozzle}
                onChange={(e) => setManualNozzle(e.target.value)}
              >
                <option value="nozzle-1">nozzle-1</option>
                <option value="nozzle-2">nozzle-2</option>
              </select>
            </label>
            <label className="block text-slate-300">
              Slot
              <select
                className="mt-1 w-full rounded border border-slate-700 bg-slate-900 px-2 py-2"
                value={manualSlot}
                onChange={(e) => setManualSlot(e.target.value)}
              >
                <option value="OPENING">OPENING</option>
                <option value="CLOSING">CLOSING</option>
                <option value="AD_HOC">AD_HOC</option>
              </select>
            </label>
            <label className="block text-slate-300">
              Cumulative liters (from pump face / totalizer)
              <input
                className="mt-1 w-full rounded border border-slate-700 bg-slate-900 px-2 py-2"
                value={manualLiters}
                onChange={(e) => setManualLiters(e.target.value)}
                inputMode="decimal"
              />
            </label>
            <label className="block text-slate-300">
              Evidence note
              <input
                className="mt-1 w-full rounded border border-slate-700 bg-slate-900 px-2 py-2"
                value={manualNote}
                onChange={(e) => setManualNote(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="rounded bg-emerald-700 px-3 py-2 text-white disabled:opacity-40"
              disabled={!mqttStation || !manualLiters || manualM.isPending}
              onClick={() => manualM.mutate()}
            >
              Save manual reading
            </button>
            <p className="text-xs text-slate-500">
              Never implies the pump can retrospectively invent an uncaptured reading.
            </p>
          </div>
        </div>

        <div className="rounded-lg border border-slate-700 p-4">
          <h2 className="mb-3 text-lg text-slate-200">Schedule (Africa/Lagos)</h2>
          <p className="mb-2 text-xs text-slate-500">
            Defaults 05:00 / 22:00. Closing may be next calendar day.
            {scheduleQ.data?.[0]
              ? ` Current open ${String(scheduleQ.data[0].opening_local_time).slice(0, 5)} / close ${String(scheduleQ.data[0].closing_local_time).slice(0, 5)}${scheduleQ.data[0].closing_next_day ? ' (+1 day)' : ''}.`
              : ''}
          </p>
          <div className="space-y-2 text-sm">
            <label className="block text-slate-300">
              Opening local time
              <input
                type="time"
                className="mt-1 w-full rounded border border-slate-700 bg-slate-900 px-2 py-2"
                value={openTime}
                onChange={(e) => setOpenTime(e.target.value)}
              />
            </label>
            <label className="block text-slate-300">
              Closing local time
              <input
                type="time"
                className="mt-1 w-full rounded border border-slate-700 bg-slate-900 px-2 py-2"
                value={closeTime}
                onChange={(e) => setCloseTime(e.target.value)}
              />
            </label>
            <label className="flex items-center gap-2 text-slate-300">
              <input
                type="checkbox"
                checked={closeNextDay}
                onChange={(e) => setCloseNextDay(e.target.checked)}
              />
              Closing is next calendar day
            </label>
            <button
              type="button"
              className="rounded bg-slate-700 px-3 py-2 text-white"
              disabled={!mqttStation || scheduleM.isPending}
              onClick={() => scheduleM.mutate()}
            >
              Save schedule
            </button>
          </div>
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-lg text-slate-200">Recent stored readings</h2>
        <div className="overflow-x-auto rounded border border-slate-800">
          <table className="min-w-full text-left text-sm text-slate-300">
            <thead className="bg-slate-900 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-3 py-2">Captured</th>
                <th className="px-3 py-2">Nozzle</th>
                <th className="px-3 py-2">Liters</th>
                <th className="px-3 py-2">Slot</th>
                <th className="px-3 py-2">Source</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Offset</th>
              </tr>
            </thead>
            <tbody>
              {(readingsQ.data || []).map((r: any) => (
                <tr key={r.id} className="border-t border-slate-800">
                  <td className="px-3 py-2">{fmtTs(r.captured_at || r.requested_at)}</td>
                  <td className="px-3 py-2">{r.nozzle_id}</td>
                  <td className="px-3 py-2">{r.volume_liters ?? '—'}</td>
                  <td className="px-3 py-2">{r.slot || '—'}</td>
                  <td className="px-3 py-2">{r.source}</td>
                  <td className="px-3 py-2">{r.status}</td>
                  <td className="px-3 py-2">
                    {r.nearby_offset_seconds != null ? `${r.nearby_offset_seconds}s` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
