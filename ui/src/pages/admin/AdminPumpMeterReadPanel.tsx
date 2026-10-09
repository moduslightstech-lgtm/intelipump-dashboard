import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getAdminPumpNozzles,
  listMeterReadings,
  postMeterReadNow,
  type Pump,
  type Station,
} from '../../api/client'

function fmtTs(iso?: string | null) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('en-GB', { timeZone: 'Africa/Lagos' })
  } catch {
    return iso
  }
}

function mqttStationKey(station?: Station | null, stationId?: string) {
  return (
    station?.mqtt_station_id ||
    station?.station_code ||
    stationId ||
    ''
  ).trim()
}

function mqttPumpId(p: Pump) {
  return (p.mqtt_pump_id || p.pump_code || '').trim()
}

function mqttNozzleId(n: {
  mqtt_nozzle_id?: string | null
  nozzle_code?: string
  source_identifier?: string | null
}) {
  // Catalog often stores nozzle-1-pump-6; Pi channel map uses nozzle-1 / nozzle-2.
  const raw = (n.mqtt_nozzle_id || n.nozzle_code || '').trim()
  const m = raw.match(/^(nozzle-\d+)/i)
  if (m) return m[1].toLowerCase()
  const src = (n.source_identifier || '').trim()
  const sm = src.match(/n(\d+)$/i)
  if (sm) return `nozzle-${sm[1]}`
  return raw
}

type Props = {
  stationId: string
  station?: Station
  pumps: Pump[]
  /** Prefill when user clicks Meter on a table row */
  focusPumpNumber?: number | null
  onFocusConsumed?: () => void
}

export default function AdminPumpMeterReadPanel({
  stationId,
  station,
  pumps,
  focusPumpNumber,
  onFocusConsumed,
}: Props) {
  const qc = useQueryClient()
  const mqttStation = mqttStationKey(station, stationId)
  const [pumpNumberInput, setPumpNumberInput] = useState('')
  const [selectedNumber, setSelectedNumber] = useState<number | null>(null)
  const [statusLine, setStatusLine] = useState('')
  const [polling, setPolling] = useState(false)

  useEffect(() => {
    if (focusPumpNumber == null) return
    setPumpNumberInput(String(focusPumpNumber))
    setSelectedNumber(focusPumpNumber)
    onFocusConsumed?.()
  }, [focusPumpNumber, onFocusConsumed])

  useEffect(() => {
    if (!polling) return
    const t = window.setTimeout(() => setPolling(false), 20_000)
    return () => window.clearTimeout(t)
  }, [polling])

  const selectedPump = useMemo(() => {
    if (selectedNumber == null) return null
    return (
      pumps.find((p) => p.pump_number === selectedNumber) ||
      pumps.find((p) => Number(p.pump_code?.replace(/\D/g, '')) === selectedNumber) ||
      null
    )
  }, [pumps, selectedNumber])

  const pumpMqtt = selectedPump ? mqttPumpId(selectedPump) : ''

  const nozzlesQ = useQuery({
    queryKey: ['admin-nozzles', selectedPump?.id],
    enabled: Boolean(selectedPump?.id),
    queryFn: async () => (await getAdminPumpNozzles(selectedPump!.id, true)).data,
  })

  const readingsQ = useQuery({
    queryKey: ['admin-meter-readings', mqttStation, pumpMqtt],
    enabled: Boolean(mqttStation && pumpMqtt),
    refetchInterval: polling ? 2000 : false,
    queryFn: async () =>
      (
        await listMeterReadings({
          station_id: mqttStation,
          pump_id: pumpMqtt,
          limit: 40,
        })
      ).data,
  })

  const latestByNozzle = useMemo(() => {
    const effectiveNozzle = (row: any) => {
      const cm = row?.raw_evidence?.channelMap
      const fromMap = (cm?.nozzle_id || cm?.nozzleId || '').toString().trim()
      return String(fromMap || row?.nozzle_id || '')
    }
    const rank = (row: any) => {
      const s = String(row?.status || '').toUpperCase()
      if (s === 'CAPTURED' || s === 'CAPTURED_AMBIGUOUS') return 0
      if (s === 'PENDING' || s === 'PENDING_CONTROLLER') return 1
      if (s === 'DEFERRED' || s === 'RATE_LIMITED') return 2
      if (s === 'UNSUPPORTED' || s === 'ERROR') return 3
      return 4
    }
    const prefer = (a: any, b: any) => {
      const ra = rank(a)
      const rb = rank(b)
      if (ra !== rb) return ra < rb ? a : b
      // Morning auto-read over ad-hoc when both CAPTURED
      const sa = String(a?.source || '')
      const sb = String(b?.source || '')
      if (sa === 'STARTUP_OPENING' && sb !== 'STARTUP_OPENING') return a
      if (sb === 'STARTUP_OPENING' && sa !== 'STARTUP_OPENING') return b
      // Prefer a real litre value over empty UNSUPPORTED/DEFERRED noise
      const hasA = a?.volume_liters != null && a?.volume_liters !== ''
      const hasB = b?.volume_liters != null && b?.volume_liters !== ''
      if (hasA && !hasB) return a
      if (hasB && !hasA) return b
      // Prefer dart_address match when channel map is present on one side
      return a // API list is newest-first; keep first seen
    }
    const map = new Map<string, any>()
    for (const row of readingsQ.data || []) {
      const nid = effectiveNozzle(row)
      if (!nid) continue
      const prev = map.get(nid)
      map.set(nid, prev ? prefer(prev, row) : row)
    }
    return map
  }, [readingsQ.data])

  const readNowM = useMutation({
    mutationFn: async (nozzleId: string) => {
      const res = await postMeterReadNow({
        station_id: mqttStation,
        pump_id: pumpMqtt,
        nozzle_id: nozzleId,
      })
      return res.data
    },
    onSuccess: (data) => {
      setStatusLine(
        `Read now: ${data?.status || '—'} · corr ${data?.correlation_id || '—'} — ${data?.message || ''}`,
      )
      setPolling(true)
      qc.invalidateQueries({ queryKey: ['admin-meter-readings', mqttStation, pumpMqtt] })
    },
    onError: (err: any) => {
      const status = err?.response?.status
      const detail = err?.response?.data?.detail
      let msg: string
      if (typeof detail === 'string') {
        msg = detail
      } else if (Array.isArray(detail)) {
        msg = detail
          .map((d: any) => d?.msg || JSON.stringify(d))
          .join('; ')
      } else if (detail && typeof detail === 'object') {
        msg = JSON.stringify(detail)
      } else {
        msg = err?.message || 'Read now failed'
      }
      setStatusLine(
        status
          ? `Read now HTTP ${status}: ${msg}`
          : `Read now failed (network): ${msg}`,
      )
    },
  })

  const resolvePump = () => {
    const n = Number(pumpNumberInput)
    if (!Number.isFinite(n) || n <= 0) {
      setStatusLine('Enter a valid pump number (e.g. 6).')
      setSelectedNumber(null)
      return
    }
    const found =
      pumps.find((p) => p.pump_number === n) ||
      pumps.find((p) => Number(p.pump_code?.replace(/\D/g, '')) === n)
    if (!found) {
      setStatusLine(`No pump with number ${n} at this station.`)
      setSelectedNumber(null)
      return
    }
    setSelectedNumber(n)
    setStatusLine(`Selected ${found.name || found.pump_code} (${mqttPumpId(found)}).`)
  }

  const activeNozzles = (nozzlesQ.data || []).filter((n) => n.active !== false)

  return (
    <div className="card space-y-3 border border-slate-700/80">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-white font-medium">Meter reading</h3>
          <p className="text-xs text-slate-400 mt-1 max-w-xl">
            Enter a pump number, then Read now per nozzle. Uses hardware CD101 when the Pi gate is
            on; never invents a zero. Pump must be idle (nozzles hung).
          </p>
        </div>
        <Link
          className="btn-secondary text-xs px-2 py-1"
          to={`/pump-meter-readings`}
        >
          Full meter page
        </Link>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="space-y-1">
          <span className="label-text">Pump number</span>
          <input
            className="input w-28"
            type="number"
            min={1}
            placeholder="e.g. 6"
            value={pumpNumberInput}
            onChange={(e) => setPumpNumberInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                resolvePump()
              }
            }}
          />
        </label>
        <button type="button" className="btn-primary text-sm" onClick={resolvePump}>
          Load pump
        </button>
        <label className="space-y-1">
          <span className="label-text">Or pick</span>
          <select
            className="input min-w-[12rem]"
            value={selectedNumber ?? ''}
            onChange={(e) => {
              const v = e.target.value
              if (!v) {
                setSelectedNumber(null)
                setPumpNumberInput('')
                return
              }
              setPumpNumberInput(v)
              setSelectedNumber(Number(v))
            }}
          >
            <option value="">Select pump…</option>
            {pumps
              .filter((p) => p.pump_number != null)
              .sort((a, b) => (a.pump_number ?? 0) - (b.pump_number ?? 0))
              .map((p) => (
                <option key={p.id} value={p.pump_number!}>
                  #{p.pump_number} — {p.name || p.pump_code} ({mqttPumpId(p)})
                </option>
              ))}
          </select>
        </label>
      </div>

      {selectedPump && (
        <div className="rounded border border-slate-800 bg-slate-950/50 p-3 space-y-3">
          <div className="text-sm text-slate-300">
            <span className="text-white font-medium">{selectedPump.name || selectedPump.pump_code}</span>
            <span className="text-slate-500"> · </span>
            <span className="font-mono text-emerald-300 text-xs">{pumpMqtt}</span>
            <span className="text-slate-500"> · MQTT station </span>
            <span className="font-mono text-xs">{mqttStation || '—'}</span>
          </div>

          {nozzlesQ.isLoading && <p className="text-xs text-slate-500">Loading nozzles…</p>}
          {!nozzlesQ.isLoading && !activeNozzles.length && (
            <p className="text-xs text-amber-300">No active nozzles on this pump.</p>
          )}

          <div className="grid gap-2 md:grid-cols-2">
            {activeNozzles.map((n) => {
              const nid = mqttNozzleId(n)
              const latest = latestByNozzle.get(nid)
              const liters = latest?.volume_liters ?? null
              return (
                <div
                  key={n.id}
                  className="rounded border border-slate-700/70 bg-slate-900/40 p-3 space-y-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="text-sm text-slate-100 font-medium">
                        {n.name || nid}
                      </div>
                      <div className="font-mono text-[11px] text-slate-500">{nid}</div>
                    </div>
                    <button
                      type="button"
                      className="btn-secondary text-xs px-2 py-1"
                      disabled={!mqttStation || !pumpMqtt || !nid || readNowM.isPending}
                      onClick={() => readNowM.mutate(nid)}
                    >
                      Read now
                    </button>
                  </div>
                  <dl className="text-xs text-slate-400 space-y-1">
                    <div>
                      Latest:{' '}
                      <strong className="text-slate-100">
                        {liters != null ? `${liters} L` : '—'}
                      </strong>
                    </div>
                    <div>
                      Status: {latest?.status || '—'}
                      {latest?.source ? ` · ${latest.source}` : ''}
                    </div>
                    <div>Captured: {fmtTs(latest?.captured_at || latest?.requested_at)}</div>
                    {latest?.error_code ? (
                      <div className="text-rose-300">
                        {latest.error_code}
                        {latest.error_message ? `: ${latest.error_message}` : ''}
                      </div>
                    ) : null}
                  </dl>
                </div>
              )
            })}
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-secondary text-xs px-2 py-1"
              disabled={
                !mqttStation ||
                !pumpMqtt ||
                !activeNozzles.length ||
                readNowM.isPending
              }
              onClick={async () => {
                for (const n of activeNozzles) {
                  const nid = mqttNozzleId(n)
                  if (nid) await readNowM.mutateAsync(nid)
                }
              }}
            >
              Read all nozzles
            </button>
            <button
              type="button"
              className="btn-secondary text-xs px-2 py-1"
              onClick={() => readingsQ.refetch()}
            >
              Refresh results
            </button>
          </div>
        </div>
      )}

      {statusLine ? <p className="text-xs text-slate-400">{statusLine}</p> : null}
      {polling ? (
        <p className="text-[11px] text-slate-500">Polling for Pi result (~20s)…</p>
      ) : null}
    </div>
  )
}
