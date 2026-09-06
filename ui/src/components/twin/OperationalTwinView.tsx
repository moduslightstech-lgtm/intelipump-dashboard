import { useEffect, useMemo, useState } from 'react'
import { fmtLiters, fmtNaira, fmtTime, type TwinLiveState } from '../../api/client'
import { pumpGridClass, pumpMatchesId } from '../../lib/pumpIdentity'
import {
  deriveOperationalStatus,
  mapEdgeToConnectivityStatus,
} from '../../lib/stationSchedule'
import { applyLiveStationStatus } from '../../lib/twinLiveStatus'
import { useStationEdgeDevices } from '../../hooks/useDeviceStatus'
import { useStationLiveSales } from '../../hooks/useStationLiveSales'
import { canonicalPumpId, getConfiguredPumpId } from '../../utils/pumpMatching'
import { formatSaleAmount } from '../../types/sales'
import ForecourtMap, { type ForecourtSelection } from './ForecourtMap'
import PumpCard from './PumpCard'
import TankCard from './TankCard'
import DeviceCard from './DeviceCard'

type Props = {
  state?: TwinLiveState
  stationId: string
  activeByPump?: Record<string, import('./pipe/pipeTypes').ActiveDispensingState>
  activePumpId?: string | null
  activeTankId?: string | null
  activeConnectionId?: string | null
  phase?: 'idle' | 'pulse' | 'completed'
  flashTx?: {
    pumpId?: string
    amount?: number
    volumeLiters?: number
    product?: string
  } | null
  liveVolume?: number
  liveAmount?: number
  restoredPumpIds?: string[]
  editMode?: boolean
  onMoveLayoutItem?: (id: string, x: number, y: number) => void
}

function StatusPill({
  label,
  value,
  tone,
  hint,
}: {
  label: string
  value?: string | null
  tone: 'green' | 'gray' | 'red' | 'amber' | 'neutral'
  hint?: string
}) {
  const tones = {
    green: 'border-emerald-700 text-emerald-300 bg-emerald-950/40',
    gray: 'border-slate-600 text-slate-300 bg-slate-900',
    red: 'border-red-800 text-red-300 bg-red-950/40',
    amber: 'border-amber-700 text-amber-200 bg-amber-950/40',
    neutral: 'border-slate-700 text-slate-300 bg-slate-900',
  }
  return (
    <div className={`rounded-lg border px-3 py-2 ${tones[tone]}`}>
      <div className="text-[10px] uppercase tracking-wide opacity-70">{label}</div>
      <div className="text-sm font-semibold">{value || '—'}</div>
      {hint ? <div className="text-[10px] mt-0.5 opacity-60">{hint}</div> : null}
    </div>
  )
}

function opTone(op?: string) {
  const s = (op || '').toUpperCase()
  if (s === 'OPEN') return 'green' as const
  if (s === 'CLOSED' || s === 'CLOSING') return 'gray' as const
  if (s === 'OPENING') return 'amber' as const
  return 'neutral' as const
}

function connTone(c?: string) {
  const s = (c || '').toUpperCase()
  if (s === 'ONLINE') return 'green' as const
  if (s === 'DELAYED' || s === 'DEGRADED' || s === 'STALE') return 'amber' as const
  if (s === 'OFFLINE' || s === 'NEVER_CONNECTED') return 'red' as const
  return 'neutral' as const
}

function useMinuteTick() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30_000)
    return () => window.clearInterval(id)
  }, [])
  return now
}

export default function OperationalTwinView({
  state,
  stationId: _stationId,
  activePumpId,
  activeTankId,
  activeConnectionId,
  phase = 'idle',
  flashTx,
  liveVolume,
  liveAmount,
  activeByPump,
  restoredPumpIds = [],
}: Props) {
  const [selection, setSelection] = useState<ForecourtSelection>(null)
  const now = useMinuteTick()
  const station = state?.station

  const stationKey =
    station?.mqttStationId || station?.stationCode || station?.name || null
  const edgeQ = useStationEdgeDevices(stationKey)

  const configuredPumpIds = useMemo(
    () =>
      (state?.pumps || [])
        .map((p) => getConfiguredPumpId(p))
        .filter(Boolean),
    [state?.pumps],
  )

  const liveSales = useStationLiveSales({
    stationId: station?.mqttStationId || null,
    configuredPumpIds,
    enabled: Boolean(station?.mqttStationId),
  })

  const liveOperational = useMemo(
    () =>
      deriveOperationalStatus(
        {
          opensAt: station?.opensAt,
          closesAt: station?.closesAt,
          operatingDays: station?.operatingDays,
          timezone: station?.timezone || 'Africa/Lagos',
        },
        now,
      ),
    [station?.opensAt, station?.closesAt, station?.operatingDays, station?.timezone, now],
  )

  const edgeStatus = edgeQ.hasMapping
    ? edgeQ.primary?.status || (edgeQ.isError ? 'UNKNOWN' : undefined)
    : undefined
  const liveConnectivityLabel = edgeQ.hasMapping
    ? (edgeStatus || (edgeQ.isLoading ? '…' : 'UNKNOWN'))
    : station?.connectivityStatus || 'UNKNOWN'
  const liveConnectivityStored = mapEdgeToConnectivityStatus(edgeStatus)

  const displayState = useMemo(() => {
    const base = applyLiveStationStatus(
      state,
      liveOperational,
      liveConnectivityStored,
      edgeStatus,
    )
    if (!base) return base
    return {
      ...base,
      salesToday: liveSales.summary?.totalAmount ?? base.salesToday,
      volumeToday: liveSales.summary?.totalVolumeLiters ?? base.volumeToday,
      transactionCountToday:
        liveSales.summary?.transactionCount ?? base.transactionCountToday,
      pumps: (base.pumps || []).map((p) => {
        const key = canonicalPumpId(getConfiguredPumpId(p))
        const live = liveSales.pumpLiveState[key]
        if (!live?.latestSale) return p
        return {
          ...p,
          lastTransactionAmount: live.latestSale.amount,
          lastTransactionVolume: live.latestSale.volumeLiters,
          lastTransactionAt: live.lastSaleAt,
          product: live.latestSale.product || p.product,
          recentSaleCount: live.todayTransactionCount,
          isRecentlyActive: live.isRecentlyActive,
          inferredStatus:
            live.isRecentlyActive && liveOperational === 'OPEN'
              ? 'DISPENSING'
              : p.inferredStatus,
        }
      }),
    }
  }, [
    state,
    liveOperational,
    liveConnectivityStored,
    edgeStatus,
    liveSales.summary,
    liveSales.pumpLiveState,
  ])

  const displayStation = displayState?.station
  const tanks = displayState?.tanks || []
  const pumps = displayState?.pumps || []
  const devices = displayState?.devices || []
  const alerts = displayState?.activeAlerts || []
  const txs =
    liveSales.sales.length > 0
      ? liveSales.sales.map((s) => ({
          id: s.transactionId,
          stationId: s.stationId,
          pumpId: s.pumpId,
          nozzleId: s.nozzleId,
          product: s.product,
          volumeLiters: s.volumeLiters,
          amount: s.amount,
          status: s.status,
          receivedAt: s.receivedAt,
          unmapped: liveSales.unmappedPumpIds.includes(s.pumpId),
        }))
      : displayState?.latestTransactions || []
  const reconStatus = String(displayState?.reconciliationStatus || 'NONE')

  const salesToday = liveSales.summary?.totalAmount ?? displayState?.salesToday
  const volumeToday = liveSales.summary?.totalVolumeLiters ?? displayState?.volumeToday
  const txToday = liveSales.summary?.transactionCount ?? displayState?.transactionCountToday

  return (
    <div className="space-y-4" data-testid="operational-twin">
      <div className="card space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-white font-semibold text-lg">{displayStation?.name || 'Station'}</h2>
            <p className="text-xs text-slate-400 font-mono mt-0.5">
              {displayStation?.stationCode}
              {displayStation?.mqttStationId ? ` · MQTT ${displayStation.mqttStationId}` : ''}
            </p>
          </div>
          <div className="text-xs text-slate-500 text-right">
            <div>
              Updated {fmtTime(displayState?.lastUpdatedAt)} · Layout{' '}
              <span className="text-slate-300">{displayState?.layout?.mode || 'AUTO'}</span>
            </div>
            <div className="mt-0.5">
              Live sales stream:{' '}
              <span
                className={
                  liveSales.streamStatus === 'LIVE'
                    ? 'text-emerald-400'
                    : liveSales.streamStatus === 'RECONNECTING' ||
                        liveSales.streamStatus === 'CONNECTING'
                      ? 'text-amber-300'
                      : 'text-slate-400'
                }
              >
                {liveSales.streamStatus}
              </span>
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          <StatusPill
            label="Operational"
            value={liveOperational}
            tone={opTone(liveOperational)}
            hint={
              station?.opensAt && station?.closesAt
                ? `${station.opensAt}–${station.closesAt}`
                : 'From schedule'
            }
          />
          <StatusPill
            label="Connectivity"
            value={
              !edgeQ.hasMapping
                ? 'No edge device'
                : edgeQ.isLoading && !edgeQ.primary
                  ? 'Checking…'
                  : String(liveConnectivityLabel).replace(/_/g, ' ')
            }
            tone={connTone(
              edgeQ.hasMapping ? edgeStatus || liveConnectivityLabel : 'UNKNOWN',
            )}
            hint="Raspberry Pi heartbeat"
          />
          <StatusPill label="Sales today" value={fmtNaira(salesToday)} tone="green" />
          <StatusPill label="Volume today" value={fmtLiters(volumeToday)} tone="neutral" />
          <StatusPill label="Tx today" value={String(txToday ?? 0)} tone="neutral" />
          <StatusPill
            label="Reconciliation"
            value={reconStatus}
            tone={
              reconStatus === 'APPROVED' || reconStatus === 'BALANCED'
                ? 'green'
                : reconStatus === 'VARIANCE' || reconStatus === 'FAILED'
                  ? 'amber'
                  : 'neutral'
            }
          />
        </div>
        {liveSales.restError && (
          <div className="text-xs text-amber-300 bg-amber-950/30 border border-amber-900 rounded px-3 py-2">
            {liveSales.restError} — showing last successful values when available.
          </div>
        )}
        {liveOperational === 'CLOSED' && (
          <div className="text-xs text-slate-300 bg-slate-800/60 border border-slate-700 rounded px-3 py-2">
            Station is CLOSED — pumps show as POWERED_OFF (gray). No fuel-flow animation during
            expected closure.
          </div>
        )}
      </div>

      <ForecourtMap
        state={displayState}
        activeByPump={activeByPump}
        activePumpId={activePumpId}
        activeTankId={activeTankId}
        activeConnectionId={activeConnectionId}
        phase={phase}
        flashTx={flashTx}
        liveVolume={liveVolume}
        liveAmount={liveAmount}
        selection={selection}
        onSelect={setSelection}
        restoredPumpIds={restoredPumpIds}
      />

      <div className="grid lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4">
          <details className="card">
            <summary className="text-sm font-semibold text-slate-300 cursor-pointer">
              Tank list ({tanks.length})
            </summary>
            <div className="mt-3 grid sm:grid-cols-2 gap-3">
              {tanks.map((t) => (
                <TankCard key={String(t.id)} tank={t} />
              ))}
            </div>
          </details>

          <details className="card" open={pumps.length <= 8}>
            <summary className="text-sm font-semibold text-slate-300 cursor-pointer">
              Pump cards ({pumps.length})
            </summary>
            <div className={`mt-3 grid gap-3 ${pumpGridClass(pumps.length)}`}>
              {pumps.map((p) => {
                const active = activePumpId != null && pumpMatchesId(p, activePumpId)
                const key = canonicalPumpId(getConfiguredPumpId(p))
                const live = liveSales.pumpLiveState[key]
                return (
                  <PumpCard
                    key={String(p.id)}
                    pump={p}
                    animating={active || Boolean(live?.isRecentlyActive)}
                    phase={active ? phase : live?.isRecentlyActive ? 'pulse' : 'idle'}
                    flashAmount={active ? flashTx?.amount : live?.latestSale?.amount}
                    flashVolume={active ? flashTx?.volumeLiters : live?.latestSale?.volumeLiters}
                    activePumpId={activePumpId}
                    recentCount={live?.todayTransactionCount}
                  />
                )
              })}
            </div>
          </details>

          <div>
            <h3 className="text-sm font-semibold text-slate-300 mb-2">
              Edge devices ({devices.length})
            </h3>
            {devices.length === 0 ? (
              <div className="card text-sm text-slate-500">No devices</div>
            ) : (
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {devices.map((d) => (
                  <DeviceCard key={String(d.id)} device={d} />
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="space-y-4">
          <div className="card space-y-2">
            <h3 className="text-white font-semibold text-sm">Active alerts</h3>
            {alerts.length === 0 ? (
              <p className="text-slate-500 text-sm">None</p>
            ) : (
              <ul className="space-y-2 max-h-64 overflow-auto">
                {alerts.slice(0, 12).map((a: any) => (
                  <li key={a.id} className="text-xs border-b border-slate-800 pb-2">
                    <div className="text-amber-300 font-medium">{a.title}</div>
                    <div className="text-slate-500">
                      {a.severity}
                      {a.pumpId ? ` · ${a.pumpId}` : ''} · {fmtTime(a.detectedAt)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="card space-y-2">
            <h3 className="text-white font-semibold text-sm">Latest transactions</h3>
            {txs.length === 0 ? (
              <p className="text-slate-500 text-sm">No sales have been received for this station yet.</p>
            ) : (
              <ul className="space-y-2 max-h-80 overflow-auto">
                {txs.slice(0, 15).map((tx: any) => (
                  <li
                    key={tx.id}
                    className={`text-xs border-b border-slate-800 pb-2 ${
                      activePumpId && pumpMatchesId({ mqttPumpId: tx.pumpId }, activePumpId)
                        ? 'bg-sky-950/40 -mx-2 px-2 rounded'
                        : ''
                    }`}
                  >
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-200 font-mono break-all">
                        {tx.pumpId}
                        {tx.unmapped ? (
                          <span className="ml-1 text-amber-400">(unmapped)</span>
                        ) : null}
                      </span>
                      <span className="text-emerald-400 shrink-0">
                        {formatSaleAmount(tx.amount, 'NGN')}
                      </span>
                    </div>
                    <div className="text-slate-500">
                      {tx.product || '—'} · {fmtLiters(tx.volumeLiters)} ·{' '}
                      {fmtTime(tx.receivedAt || tx.deviceTimestamp || tx.transactionCompletedAt)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
