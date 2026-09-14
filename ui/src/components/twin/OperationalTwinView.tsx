import { useEffect, useMemo, useState } from 'react'
import { fmtLiters, fmtNaira, fmtTime, type TwinLiveState } from '../../api/client'
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
} from '../../lib/liveDispensing'
import { findSession, flowingSessions, operationalDisplay } from '../../lib/nozzleSessions'
import { catalogFromPumps } from '../../lib/nozzleIdentity'
import { applyLiveTankDrawdown } from '../../lib/liveTankLevels'
import { getConnections } from './forecourtLayout'
import ForecourtMap, { type ForecourtSelection } from './ForecourtMap'
import { aggregatePhysicalPumpStatus, physicalPumpIsOffline } from './schematic/physicalPump'
import { displayPumpStatus } from './schematic/display'

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
  const [adminAlert, setAdminAlert] = useState<{
    type: string
    message: string
    pumpId?: string
    nozzleId?: string
  } | null>(null)
  const now = useMinuteTick()
  const station = state?.station

  useEffect(() => {
    const onAlert = (ev: Event) => {
      const detail = (ev as CustomEvent).detail || {}
      if (detail.type !== 'POSSIBLE_UNINTENDED_FLOW') return
      setAdminAlert({
        type: String(detail.type),
        message: String(detail.message || 'Possible unintended flow'),
        pumpId: detail.pumpId ? String(detail.pumpId) : undefined,
        nozzleId: detail.nozzleId ? String(detail.nozzleId) : undefined,
      })
    }
    window.addEventListener('intelipump:admin-alert', onAlert)
    return () => window.removeEventListener('intelipump:admin-alert', onAlert)
  }, [])

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

  const nozzleCatalog = useMemo(() => catalogFromPumps(state?.pumps || []), [state?.pumps])

  const liveSales = useStationLiveSales({
    stationId: station?.mqttStationId || null,
    configuredPumpIds,
    nozzleCatalog,
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
      pumps: (base.pumps || []).map((p: Record<string, any>) => {
        const catalogNozzles = p.nozzles || []
        const dispenserOffline = physicalPumpIsOffline(
          p.inferredStatus,
          catalogNozzles.map((n: Record<string, any>) => n.inferredStatus),
        )
        const nozzles = catalogNozzles.map((n: Record<string, any>) => {
          const session = findSession(
            liveSales.nozzleSessions || {},
            String(base.station?.mqttStationId || base.station?.stationCode || _stationId || ''),
            [p.mqttPumpId, p.pumpCode, getConfiguredPumpId(p), p.id],
            [n.nozzleCode, n.mqttNozzleId, n.id, n.nozzleNumber != null ? `nozzle-${n.nozzleNumber}` : null, n.sourceIdentifier],
          )
          if (session) {
            const display = operationalDisplay(session)
            const liveOpen = display === 'DISPENSING' || display === 'SALE_COMPLETED'
            const lastAmount =
              session.lastCompleted?.amount ??
              n.lastCompletedAmount ??
              n.lastTransactionAmount ??
              null
            const lastVolume =
              session.lastCompleted?.volumeLiters ??
              n.lastCompletedVolume ??
              n.lastTransactionVolume ??
              null
            // Keep totals on the nozzle continuously — never flash empty between
            // live ticks or when flipping SALE_COMPLETED → LAST SALE.
            const shownAmount = liveOpen
              ? session.amount
              : lastAmount ?? session.amount
            const shownVolume = liveOpen
              ? session.volumeLiters
              : lastVolume ?? session.volumeLiters
            const equipmentStatus = liveOpen
              ? display === 'SALE_COMPLETED'
                ? 'SALE_COMPLETED'
                : 'DISPENSING'
              : display === 'READY'
                ? 'READY'
                : dispenserOffline || displayPumpStatus(n.inferredStatus) === 'OFFLINE'
                  ? 'OFFLINE'
                  : 'IDLE'
            return {
              ...n,
              liveAmount: liveOpen ? shownAmount : null,
              liveVolume: liveOpen ? shownVolume : null,
              livePricePerLitre: liveOpen ? session.pricePerLiter : null,
              lastCompletedAmount: lastAmount,
              lastCompletedVolume: lastVolume,
              lastTransactionAmount: lastAmount,
              lastTransactionVolume: lastVolume,
              lastTransactionAt:
                session.lastCompleted?.completedAt || session.completedAt || n.lastTransactionAt,
              lastTransactionPrice: session.lastCompleted?.pricePerLiter ?? session.pricePerLiter,
              livePresentation: display === 'LAST_SALE' ? 'IDLE' : display,
              liveTransactionId: session.transactionId,
              liveSequence: session.sequence,
              startedAt: session.startedAt,
              mappingWarning: session.mappingWarning,
              product: session.product || n.product,
              inferredStatus: equipmentStatus,
            }
          }
          // No live session: only this nozzle's twin last-sale fields (never
          // pump-level shared totals that would duplicate across hoses).
          return {
            ...n,
            liveAmount: null,
            liveVolume: null,
            lastCompletedAmount: n.lastTransactionAmount ?? n.lastCompletedAmount ?? null,
            lastCompletedVolume: n.lastTransactionVolume ?? n.lastCompletedVolume ?? null,
            inferredStatus:
              dispenserOffline && displayPumpStatus(n.inferredStatus) !== 'DISPENSING'
                ? 'OFFLINE'
                : displayPumpStatus(n.inferredStatus) === 'DISPENSING'
                  ? 'IDLE'
                  : n.inferredStatus,
          }
        })
        const key = canonicalPumpId(getConfiguredPumpId(p))
        const live = liveSales.pumpLiveState[key]
        // Never infer whole-pump DISPENSING for dual-hose cards — nozzles own live state.
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
          isRecentlyActive: nozzles.some(
            (n: Record<string, any>) => displayPumpStatus(n.inferredStatus) === 'DISPENSING',
          ),
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
    liveSales.nozzleSessions,
    liveSales.sales,
  ])

  const pipeActiveByPump = useMemo(() => {
    // Authoritative source: per-nozzle flowing sessions.
    // Never light branches from pump-scoped playback without a nozzleId
    // (that incorrectly animated both branches when only nozzle-2 dispensed).
    const merged: Record<string, import('./pipe/pipeTypes').ActiveDispensingState> = {}
    const connections = getConnections(displayState) || []

  const live = liveDispensingFromPumpState(
      liveSales.pumpLiveState,
      connections,
      (displayState?.pumps || []) as Record<string, unknown>[],
      0,
    )
    for (const [key, s] of Object.entries(live)) {
      // Ignore pump-scoped rows without a hose id — those incorrectly lit both branches.
      if (!s.nozzleId) continue
      // Prefer station|pump|nozzle session keys; skip bare pump ids that lack nozzle isolation.
      if (!key.includes('|') && !String(s.nozzleId).includes('nozzle') && key === canonicalPumpId(s.pumpId)) {
        continue
      }
      merged[key] = { ...s }
    }

    for (const [key, s] of Object.entries(activeByPump || {})) {
      if (s.phase !== 'DISPENSING') continue
      if (!s.nozzleId) continue
      merged[key] = { ...s }
    }

    for (const session of flowingSessions(liveSales.nozzleSessions || {})) {
      const conn = connections.find((c) => {
        const ids = [
          c.nozzleId,
          c.mqttNozzleId,
          c.nozzleCode,
          c.sourceIdentifier,
          c.destinationNozzleId,
        ]
          .map((v) => String(v || '').trim())
          .filter(Boolean)
        if (ids.includes(String(session.nozzleId || '').trim())) return true
        const source = String(c.sourceIdentifier || '').trim()
        if (!source) return false
        const nozzleNum = String(session.nozzleId || '').replace(/^nozzle-/i, '')
        return source === `pump-${nozzleNum}` || source === session.nozzleId
      })
      const key = session.key || `${session.pumpId}|${session.nozzleId}`
      merged[key] = {
        transactionId: session.transactionId || '',
        pumpId: session.pumpId,
        nozzleId: session.nozzleId,
        stationId: session.stationId,
        tankId: conn ? String(conn.tankId || '') : '',
        finalVolume: Number(session.volumeLiters || 0),
        finalAmount: Number(session.amount || 0),
        currentVolume: Number(session.volumeLiters || 0),
        currentAmount: Number(session.amount || 0),
        phase: 'DISPENSING',
        startedAt: 0,
        durationMs: 1,
        product: session.product || undefined,
        connectionId: conn?.id ? String(conn.id) : undefined,
        mappingWarning: session.mappingWarning,
      }
    }
    for (const [key, s] of Object.entries(merged)) {
      if (s.phase !== 'DISPENSING' || !s.nozzleId || !s.transactionId) delete merged[key]
    }
    if (typeof localStorage !== 'undefined' && localStorage.getItem('INTELIPUMP_DEBUG_LIVE') === '1') {
      // eslint-disable-next-line no-console
      console.debug('[intelipump-pipe]', {
        flowing: Object.values(merged).map((s) => ({
          pumpId: s.pumpId,
          nozzleId: s.nozzleId,
          transactionId: s.transactionId,
          connectionId: s.connectionId,
        })),
      })
    }
    return merged
  }, [activeByPump, displayState, liveSales.pumpLiveState, liveSales.nozzleSessions])

  const displayStation = displayState?.station
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
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
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
        </div>
        {liveSales.restError && (
          <div className="text-xs text-amber-300 bg-amber-950/30 border border-amber-900 rounded px-3 py-2">
            {liveSales.restError} — showing last successful values when available.
          </div>
        )}
        {adminAlert && (
          <div className="text-xs text-amber-100 bg-amber-950/50 border border-amber-700 rounded px-3 py-2 flex items-start justify-between gap-3">
            <div>
              <div className="font-semibold uppercase tracking-wide text-amber-200">
                Admin alert · {adminAlert.type.replace(/_/g, ' ')}
              </div>
              <div className="mt-0.5 opacity-90">{adminAlert.message}</div>
              {(adminAlert.pumpId || adminAlert.nozzleId) && (
                <div className="mt-0.5 opacity-70">
                  {[adminAlert.pumpId, adminAlert.nozzleId].filter(Boolean).join(' / ')}
                </div>
              )}
            </div>
            <button
              type="button"
              className="shrink-0 text-amber-200/80 hover:text-white underline"
              onClick={() => setAdminAlert(null)}
            >
              Dismiss
            </button>
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
    </div>
  )
}
