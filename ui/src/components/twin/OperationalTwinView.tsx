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
import {
  liveDispensingFromPumpState,
  livePumpInferredStatus,
  inProgressSaleStatus,
  completedSaleStatus,
} from '../../lib/liveDispensing'
import { applyLiveTankDrawdown } from '../../lib/liveTankLevels'
import { getConnections } from './forecourtLayout'
import ForecourtMap, { type ForecourtSelection } from './ForecourtMap'
import PumpCard from './PumpCard'
import TankCard from './TankCard'
import { aggregatePhysicalPumpStatus } from './schematic/physicalPump'

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
  canEdit?: boolean
  includeInactive?: boolean
  onDraftChange?: (
    draft: import('./schematic/types').LayoutPersist,
    dirty: boolean,
  ) => void
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
  editMode = false,
  canEdit = false,
  includeInactive = false,
  onDraftChange,
}: Props) {
  const [selection, setSelection] = useState<ForecourtSelection>(null)
  const now = useMinuteTick()
  const station = state?.station

  const stationKey =
    station?.mqttStationId || station?.stationCode || station?.name || null
  const edgeQ = useStationEdgeDevices(stationKey)

  const configuredPumpIds = useMemo(() => {
    const ids: string[] = []
    for (const p of state?.pumps || []) {
      const id = getConfiguredPumpId(p)
      if (id) ids.push(id)
      for (const n of p.nozzles || []) {
        for (const k of [n.sourceIdentifier, n.mqttNozzleId, n.mqttPumpId, n.nozzleCode]) {
          if (k) ids.push(String(k))
        }
      }
    }
    return ids.filter(Boolean)
  }, [state?.pumps])

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
    const connections = getConnections(base)
    const catalogPumps = (base.pumps || []) as Record<string, unknown>[]
    return {
      ...base,
      salesToday: liveSales.summary?.totalAmount ?? base.salesToday,
      volumeToday: liveSales.summary?.totalVolumeLiters ?? base.volumeToday,
      transactionCountToday:
        liveSales.summary?.transactionCount ?? base.transactionCountToday,
      tanks: applyLiveTankDrawdown(
        (base.tanks || []) as Record<string, unknown>[],
        liveSales.sales,
        connections,
        catalogPumps,
      ),
      pumps: (base.pumps || []).map((p) => {
        const nozzles = (p.nozzles || []).map((n: Record<string, any>) => {
          const keys = [n.sourceIdentifier, n.mqttNozzleId, n.mqttPumpId, n.nozzleCode]
          const live = keys.map((k) => liveSales.pumpLiveState[canonicalPumpId(String(k || ''))]).find(Boolean)
          if (!live?.latestSale) return n
          return {
            ...n,
            lastTransactionAmount: live.latestSale.amount,
            lastTransactionVolume: live.latestSale.volumeLiters,
            lastTransactionAt: live.lastSaleAt,
            product: live.latestSale.product || n.product,
            inferredStatus: livePumpInferredStatus(liveOperational, live, n.inferredStatus),
          }
        })
        const key = canonicalPumpId(getConfiguredPumpId(p))
        const live = liveSales.pumpLiveState[key]
        const inferred = nozzles.length
          ? undefined
          : live?.latestSale
            ? livePumpInferredStatus(liveOperational, live, p.inferredStatus)
            : p.inferredStatus
        return {
          ...p,
          id: p.id,
          nozzles,
          lastTransactionAmount: live?.latestSale?.amount ?? p.lastTransactionAmount,
          lastTransactionVolume: live?.latestSale?.volumeLiters ?? p.lastTransactionVolume,
          lastTransactionAt: live?.lastSaleAt ?? p.lastTransactionAt,
          product: live?.latestSale?.product || p.product,
          recentSaleCount: live?.todayTransactionCount,
          isRecentlyActive: live?.isRecentlyActive,
          inferredStatus:
            nozzles.length > 0
              ? aggregatePhysicalPumpStatus(nozzles.map((n: Record<string, any>) => n.inferredStatus))
              : inferred || p.inferredStatus,
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
    liveSales.sales,
  ])

  const pipeActiveByPump = useMemo(() => {
    const live = liveDispensingFromPumpState(
      liveSales.pumpLiveState,
      getConnections(displayState),
      (displayState?.pumps || []) as Record<string, unknown>[],
      0,
    )
    const merged = { ...(activeByPump || {}) }
    for (const [key, s] of Object.entries(live)) {
      merged[key] = s
    }
    for (const [key, s] of Object.entries(merged)) {
      const row = liveSales.pumpLiveState[key]
      if (s.phase !== 'DISPENSING') delete merged[key]
      else if (row && !row.isRecentlyActive) delete merged[key]
      else if (completedSaleStatus(row?.latestSale?.status)) delete merged[key]
    }
    return merged
  }, [activeByPump, displayState, liveSales.pumpLiveState])

  const displayStation = displayState?.station
  const tanks = displayState?.tanks || []
  const pumps = displayState?.pumps || []
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
        activeByPump={pipeActiveByPump}
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
        editMode={editMode}
        canEdit={canEdit}
        includeInactive={includeInactive}
        viewportWidth={typeof window === 'undefined' ? 1440 : window.innerWidth}
        onDraftChange={onDraftChange}
      />

      <div className="space-y-4">
        <details className="card">
          <summary className="text-sm font-semibold text-slate-300 cursor-pointer">
            Tank list ({tanks.length})
          </summary>
          <div className="mt-3 grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {tanks.map((t) => (
              <TankCard key={String(t.id)} tank={t} />
            ))}
          </div>
        </details>

        <details className="card" open={pumps.length <= 8} data-testid="pump-list">
          <summary className="text-sm font-semibold text-slate-300 cursor-pointer">
            Pump list ({pumps.length})
          </summary>
          <div className={`mt-3 grid gap-3 ${pumpGridClass(pumps.length)}`}>
            {pumps.map((p) => {
              const nozzles = p.nozzles || []
              const nozzleLive = nozzles.some((n: Record<string, any>) => {
                const keys = [n.sourceIdentifier, n.mqttNozzleId, n.mqttPumpId]
                return keys.some((k) => {
                  const live = liveSales.pumpLiveState[canonicalPumpId(String(k || ''))]
                  return live?.isRecentlyActive && inProgressSaleStatus(live.latestSale?.status)
                })
              })
              const key = canonicalPumpId(getConfiguredPumpId(p))
              const live = liveSales.pumpLiveState[key]
              const liveDispensing =
                nozzleLive ||
                Boolean(live?.isRecentlyActive && inProgressSaleStatus(live.latestSale?.status))
              const active = activePumpId != null && pumpMatchesId(p, activePumpId)
              const playbackPulse = active && phase === 'pulse'
              return (
                <PumpCard
                  key={String(p.id)}
                  pump={p}
                  animating={liveDispensing || playbackPulse}
                  phase={
                    liveDispensing || playbackPulse
                      ? 'pulse'
                      : active && phase === 'completed'
                        ? 'completed'
                        : 'idle'
                  }
                  flashAmount={active ? flashTx?.amount : live?.latestSale?.amount}
                  flashVolume={active ? flashTx?.volumeLiters : live?.latestSale?.volumeLiters}
                  activePumpId={activePumpId}
                  recentCount={live?.todayTransactionCount}
                />
              )
            })}
          </div>
        </details>
      </div>
    </div>
  )
}
