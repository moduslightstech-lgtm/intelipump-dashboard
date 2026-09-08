import { fmtLiters, fmtNaira, fmtTime, type TwinLiveState } from '../../api/client'
import { pumpMatchesId } from '../../lib/pumpIdentity'
import {
  buildForecourtNodes,
  getConnections,
  productStroke,
  pumpStatusColor,
  type ForecourtNode,
} from './forecourtLayout'
import PipeLayer from './pipe/PipeLayer'
import type { ActiveDispensingState, PipeRoute } from './pipe/pipeTypes'

export type ForecourtSelection =
  | { kind: 'TANK'; node: ForecourtNode }
  | { kind: 'PUMP'; node: ForecourtNode }
  | { kind: 'PIPE'; route: PipeRoute }
  | null

type Props = {
  state?: TwinLiveState
  activeByPump?: Record<string, ActiveDispensingState>
  /** @deprecated prefer activeByPump */
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
  selection?: ForecourtSelection
  onSelect?: (sel: ForecourtSelection) => void
  restoredPumpIds?: string[]
}

function TankNode({
  node,
  highlighted,
  selected,
  onClick,
}: {
  node: ForecourtNode
  highlighted: boolean
  selected: boolean
  onClick: () => void
}) {
  const fill = Number(node.raw.fillPercent)
  const fillSafe = Number.isFinite(fill) ? Math.max(0, Math.min(100, fill)) / 100 : 0.4
  const src = String(node.raw.measurementSource || 'MANUAL').toUpperCase()
  const live = node.raw.isLiveTelemetry === true || src === 'AUTOMATED'
  const fillColor = productStroke(node.product)
  return (
    <g
      data-testid={`tank-node-${node.id}`}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      style={{ cursor: 'pointer' }}
    >
      {highlighted && (
        <rect
          x={node.x - 4}
          y={node.y - 4}
          width={node.w + 8}
          height={node.h + 8}
          rx={8}
          fill="none"
          stroke={fillColor}
          strokeWidth={3}
          opacity={0.9}
        />
      )}
      <rect
        x={node.x}
        y={node.y}
        width={node.w}
        height={node.h}
        rx={8}
        fill="#0f172a"
        stroke={selected ? '#38bdf8' : highlighted ? fillColor : '#475569'}
        strokeWidth={selected || highlighted ? 2.5 : 1.5}
      />
      <rect
        x={node.x + 2}
        y={node.y + node.h * (1 - fillSafe)}
        width={node.w - 4}
        height={node.h * fillSafe - 2}
        rx={6}
        fill={fillColor}
        opacity={0.45}
      />
      <text x={node.x + 10} y={node.y + 16} fill="#f8fafc" fontSize={11} fontWeight="700">
        {node.label}
      </text>
      <text x={node.x + 10} y={node.y + 30} fill="#94a3b8" fontSize={9}>
        {node.product || '—'} · {node.status}
      </text>
      <text x={node.x + 10} y={node.y + 44} fill="#cbd5e1" fontSize={9}>
        {fmtLiters(node.raw.reportedLiters)}
        {Number.isFinite(fill) ? ` · ${fill.toFixed(0)}%` : ''}
      </text>
      <text
        x={node.x + 10}
        y={node.y + node.h - 8}
        fill={live ? '#34d399' : '#fbbf24'}
        fontSize={9}
        fontWeight="600"
      >
        {live
          ? 'Automated'
          : Number(node.raw.drawnLiters) > 0
            ? 'After sales'
            : 'Source: Manual'}
      </text>
    </g>
  )
}

function pumpDisplayLabels(raw: Record<string, any>, fallbackLabel: string) {
  const mqttId = String(raw.mqttPumpId || raw.pumpCode || fallbackLabel || '').trim()
  const pumpCode = String(raw.pumpCode || '').trim()
  const name = String(raw.name || '').trim()
  const primary =
    (name && name !== mqttId && name !== pumpCode ? name : null) || mqttId || pumpCode || fallbackLabel
  // Only show a second line when it adds information (never repeat the same id).
  const secondary =
    mqttId && primary !== mqttId
      ? mqttId
      : pumpCode && primary !== pumpCode && pumpCode !== mqttId
        ? pumpCode
        : null
  return { primary, secondary, mqttId: mqttId || primary }
}

function PumpNode({
  node,
  highlighted,
  phase,
  selected,
  restored,
  flashAmount,
  flashVolume,
  onClick,
}: {
  node: ForecourtNode
  highlighted: boolean
  phase: 'idle' | 'pulse' | 'completed'
  selected: boolean
  restored: boolean
  flashAmount?: number | null
  flashVolume?: number | null
  onClick: () => void
}) {
  const status = highlighted
    ? phase === 'completed'
      ? 'COMPLETED'
      : phase === 'pulse'
        ? 'DISPENSING'
        : node.status.toUpperCase()
    : node.status.toUpperCase()
  const color = pumpStatusColor(status)
  const dispensing = status === 'DISPENSING'
  const { primary, secondary, mqttId } = pumpDisplayLabels(node.raw, node.label)
  const titleY = secondary ? node.y + 18 : node.y + 22
  const statusY = secondary ? node.y + 48 : node.y + 42
  const productY = secondary ? node.y + 66 : node.y + 60
  const amountY = secondary ? node.y + 80 : node.y + 74
  const volumeY = secondary ? node.y + 92 : node.y + 86

  return (
    <g
      data-testid={`pump-node-${node.id}`}
      data-pump-mqtt={mqttId}
      data-dispensing={dispensing ? 'true' : 'false'}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      style={{ cursor: 'pointer' }}
    >
      {(highlighted || dispensing) && (
        <rect
          x={node.x - 5}
          y={node.y - 5}
          width={node.w + 10}
          height={node.h + 10}
          rx={8}
          fill="none"
          stroke="#22c55e"
          strokeWidth={3}
          className={dispensing ? 'forecourt-green-flash' : undefined}
        />
      )}
      {restored && !highlighted && (
        <rect
          x={node.x - 3}
          y={node.y - 3}
          width={node.w + 6}
          height={node.h + 6}
          rx={7}
          fill="none"
          stroke="#34d399"
          strokeWidth={2}
          opacity={0.7}
        />
      )}
      <rect
        x={node.x}
        y={node.y}
        width={node.w}
        height={node.h}
        rx={6}
        fill={
          status === 'POWERED_OFF'
            ? '#1e293b'
            : dispensing
              ? '#052e16'
              : status === 'COMPLETED'
                ? '#14532d'
                : '#0f172a'
        }
        stroke={selected ? '#38bdf8' : dispensing ? '#22c55e' : '#475569'}
        strokeWidth={selected || dispensing ? 2.5 : 1.5}
        opacity={status === 'POWERED_OFF' ? 0.85 : 1}
      />

      <text x={node.x + 10} y={titleY} textAnchor="start" fill="#f8fafc" fontSize={10} fontWeight="700">
        {primary.length > 16 ? `${primary.slice(0, 14)}…` : primary}
      </text>
      {secondary && (
        <text
          x={node.x + 10}
          y={node.y + 32}
          textAnchor="start"
          fill="#94a3b8"
          fontSize={8}
          fontFamily="ui-monospace, monospace"
        >
          {secondary.length > 18 ? `${secondary.slice(0, 16)}…` : secondary}
        </text>
      )}

      {/* Status row: indicator immediately in front of IDLE / DISPENSING */}
      <rect x={node.x + 8} y={statusY - 10} width={Math.max(48, node.w - 16)} height={14} rx={2} fill="#020617" />
      {dispensing && (
        <circle
          cx={node.x + 18}
          cy={statusY - 3}
          r={7}
          fill="none"
          stroke="#22c55e"
          strokeWidth={1.5}
          className="forecourt-status-ring"
        />
      )}
      <circle
        cx={node.x + 18}
        cy={statusY - 3}
        r={4}
        fill={color}
        stroke="#020617"
        strokeWidth={1}
        className={dispensing ? 'forecourt-status-flash' : undefined}
      />
      <text
        x={node.x + 28}
        y={statusY}
        textAnchor="start"
        fill={color}
        fontSize={9}
        fontWeight="700"
        className={dispensing ? 'forecourt-status-flash' : undefined}
      >
        {status}
      </text>
      <text x={node.x + 10} y={productY} textAnchor="start" fill="#94a3b8" fontSize={8}>
        {node.product || '—'}
      </text>
      <text x={node.x + 10} y={amountY} textAnchor="start" fill="#4ade80" fontSize={9} fontWeight="600">
        {fmtNaira(flashAmount ?? node.raw.lastTransactionAmount)}
      </text>
      <text x={node.x + 10} y={volumeY} textAnchor="start" fill="#86efac" fontSize={8}>
        {fmtLiters(flashVolume ?? node.raw.lastTransactionVolume)}
      </text>
    </g>
  )
}

function DetailPanel({
  selection,
  connections,
}: {
  selection: ForecourtSelection
  connections: Record<string, any>[]
}) {
  if (!selection) return null
  if (selection.kind === 'TANK') {
    const t = selection.node.raw
    const src = String(t.measurementSource || 'MANUAL').toUpperCase()
    const linked = connections.filter((c) => c.tankId === selection.node.id)
    return (
      <div className="card text-xs space-y-1" data-testid="tank-detail">
        <div className="text-white font-semibold text-sm">{selection.node.label}</div>
        <Row label="Product" value={t.product} />
        <Row label="Capacity" value={fmtLiters(t.capacityLiters)} />
        <Row label="Current volume" value={fmtLiters(t.reportedLiters)} />
        <Row label="Fill %" value={t.fillPercent != null ? `${t.fillPercent}%` : '—'} />
        <Row label="Status" value={selection.node.status} />
        <Row label="Source" value={src === 'AUTOMATED' ? 'Automated' : 'Manual'} />
        <Row label="Last entered" value={fmtTime(t.measuredAt)} />
        <Row label="Submitted by" value={t.submittedBy || '—'} />
        <Row label="Connected pumps" value={String(linked.length)} />
        <Row label="Freshness" value={t.isStale ? 'Stale' : 'OK'} />
      </div>
    )
  }
  if (selection.kind === 'PUMP') {
    const p = selection.node.raw
    const conn = connections.find(
      (c) =>
        c.pumpId === p.id ||
        pumpMatchesId({ id: p.id, pumpCode: p.pumpCode, mqttPumpId: p.mqttPumpId }, c.mqttPumpId),
    )
    return (
      <div className="card text-xs space-y-1" data-testid="pump-detail">
        <div className="text-white font-semibold text-sm">
          {p.name && p.name !== (p.mqttPumpId || p.pumpCode)
            ? p.name
            : p.mqttPumpId || p.pumpCode}
        </div>
        {(p.mqttPumpId || p.pumpCode) &&
          p.name &&
          p.name !== (p.mqttPumpId || p.pumpCode) && (
            <Row label="MQTT id" value={p.mqttPumpId || p.pumpCode} mono />
          )}
        {!p.name && p.mqttPumpId && p.pumpCode && p.mqttPumpId !== p.pumpCode && (
          <Row label="Code" value={p.pumpCode} mono />
        )}
        <Row label="Product" value={p.product} />
        <Row label="Status" value={selection.node.status} />
        <Row label="Last amount" value={fmtNaira(p.lastTransactionAmount)} />
        <Row label="Last volume" value={fmtLiters(p.lastTransactionVolume)} />
        <Row label="Last time" value={fmtTime(p.lastTransactionAt)} />
        <Row label="Connected tank" value={conn?.tankName || conn?.tankCode || '—'} />
        <Row label="Alerts" value={String(p.activeAlertCount ?? 0)} />
      </div>
    )
  }
  const route = selection.route
  const c = route.connection as Record<string, any>
  return (
    <div className="card text-xs space-y-1" data-testid="pipe-detail">
      <div className="text-white font-semibold text-sm">Pipe</div>
      <Row label="From tank" value={c.tankName || route.tankId} />
      <Row label="To pump" value={c.mqttPumpId || route.pumpId} />
      <Row label="Product" value={route.product} />
      <Row label="Mapping" value={route.mappingSource} />
      <Row label="Label" value={route.lineLabel || '—'} />
      <Row label="Status" value={route.status} />
    </div>
  )
}

function Row({
  label,
  value,
  mono,
}: {
  label: string
  value?: string | null
  mono?: boolean
}) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-slate-500">{label}</span>
      <span className={`text-slate-200 text-right ${mono ? 'font-mono' : ''}`}>{value || '—'}</span>
    </div>
  )
}

function findActiveForPump(
  node: ForecourtNode,
  activeByPump: Record<string, ActiveDispensingState>,
): ActiveDispensingState | null {
  for (const s of Object.values(activeByPump)) {
    if (
      pumpMatchesId(
        { id: node.id, pumpCode: node.raw.pumpCode, mqttPumpId: node.raw.mqttPumpId },
        s.pumpId,
      )
    ) {
      return s
    }
  }
  return null
}

export default function ForecourtMap({
  state,
  activeByPump = {},
  activePumpId = null,
  activeTankId = null,
  phase = 'idle',
  flashTx = null,
  liveVolume,
  liveAmount,
  selection = null,
  onSelect,
  restoredPumpIds = [],
}: Props) {
  const width = Number(state?.layout?.canvasWidth || 1200)
  const height = Number(state?.layout?.canvasHeight || 700)
  const mode = String(state?.layout?.mode || 'AUTO')
  const connections = getConnections(state)
  const nodes = buildForecourtNodes(state)
  const tanks = nodes.filter((n) => n.kind === 'TANK')
  const pumps = nodes.filter((n) => n.kind === 'PUMP')
  const hasAssets = tanks.length > 0 || pumps.length > 0
  const mappingMsg = state?.connectionMappingMessage as string | undefined
  const mappingConfigured = state?.connectionMappingConfigured === true
  const stationClosed =
    String(state?.station?.operationalStatus || '').toUpperCase() === 'CLOSED'

  // Merge legacy single-active into map if provided
  const dispensingMap: Record<string, ActiveDispensingState> = { ...activeByPump }
  if (!Object.keys(dispensingMap).length && activePumpId && phase !== 'idle') {
    dispensingMap[activePumpId] = {
      transactionId: 'legacy',
      pumpId: activePumpId,
      tankId: activeTankId || '',
      finalVolume: Number(flashTx?.volumeLiters || liveVolume || 0),
      finalAmount: Number(flashTx?.amount || liveAmount || 0),
      currentVolume: Number(liveVolume ?? flashTx?.volumeLiters ?? 0),
      currentAmount: Number(liveAmount ?? flashTx?.amount ?? 0),
      phase: phase === 'completed' ? 'COMPLETED' : 'DISPENSING',
      startedAt: performance.now(),
      durationMs: 3000,
      product: flashTx?.product,
    }
  }

  const activeTankIds = new Set(
    Object.values(dispensingMap)
      .map((s) => s.tankId)
      .filter(Boolean),
  )

  return (
    <div className="space-y-3" data-testid="forecourt-map">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
        <span>
          Forecourt map · Layout <span className="text-slate-200">{mode}</span>
          {stationClosed ? ' · Station CLOSED' : ''}
        </span>
        <span className="flex flex-wrap gap-3">
          <span className="inline-flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-blue-400" /> Idle
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-emerald-400" /> Dispensing
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-slate-500" /> Powered off
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-red-400" /> Fault / offline
          </span>
        </span>
      </div>

      {!hasAssets ? (
        <div className="card text-sm text-slate-400 text-center py-12">
          No forecourt assets configured for this station.
        </div>
      ) : (
        <>
          {tanks.length === 0 && (
            <div className="text-xs text-amber-100 bg-amber-950/70 border border-amber-800 rounded-lg px-3 py-2">
              No tanks configured for this station.
            </div>
          )}
          {pumps.length === 0 && (
            <div className="text-xs text-amber-100 bg-amber-950/70 border border-amber-800 rounded-lg px-3 py-2">
              No pumps configured for this station.
            </div>
          )}
          {!mappingConfigured && mappingMsg && (
            <div className="text-xs text-amber-100 bg-amber-950/70 border border-amber-800 rounded-lg px-3 py-2">
              {mappingMsg}
            </div>
          )}
          <div className="grid lg:grid-cols-4 gap-3">
            <div className="lg:col-span-3 relative">
              <svg
                viewBox={`0 0 ${width} ${height}`}
                className="w-full h-auto bg-slate-950/90 rounded-lg border border-slate-800"
                aria-label="Station forecourt map"
                style={
                  {
                    ['--pipe-inactive']: '#475569',
                    ['--pipe-active']: '#22c55e',
                    ['--pipe-active-glow']: 'rgba(34,197,94,0.45)',
                    ['--pipe-pms']: '#2563eb',
                    ['--pipe-ago']: '#ca8a04',
                  } as Record<string, string>
                }
                onClick={() => onSelect?.(null)}
              >
                <defs>
                  <style>{`
                    .forecourt-green-flash {
                      animation: forecourt-green 0.7s ease-in-out infinite;
                    }
                    .forecourt-status-flash {
                      animation: forecourt-status-pulse 0.65s ease-in-out infinite;
                    }
                    .forecourt-status-ring {
                      animation: forecourt-status-ring 0.65s ease-in-out infinite;
                    }
                    @keyframes forecourt-green {
                      0%, 100% { opacity: 0.45; }
                      50% { opacity: 1; }
                    }
                    @keyframes forecourt-status-pulse {
                      0%, 100% { opacity: 0.55; }
                      50% { opacity: 1; }
                    }
                    @keyframes forecourt-status-ring {
                      0%, 100% { opacity: 0.25; }
                      50% { opacity: 0.95; }
                    }
                  `}</style>
                </defs>

                {/* 1. background */}
                {nodes
                  .filter((n) => n.kind === 'FORECOURT')
                  .map((n) => (
                    <rect
                      key={n.id}
                      x={n.x}
                      y={n.y}
                      width={n.w}
                      height={n.h}
                      rx={12}
                      fill="#0b1220"
                      stroke="#334155"
                      strokeWidth={2}
                      strokeDasharray="8 6"
                    />
                  ))}

                {/* 2–4. pipes (inactive then active + flow) */}
                <PipeLayer
                  nodes={nodes}
                  connections={connections}
                  activeByPump={dispensingMap}
                  stationClosed={stationClosed}
                  selectedPipeId={selection?.kind === 'PIPE' ? selection.route.id : null}
                  onSelectPipe={(route) => onSelect?.({ kind: 'PIPE', route })}
                />

                {nodes
                  .filter((n) => n.kind === 'LABEL')
                  .map((n) => (
                    <text key={n.id} x={n.x} y={n.y + 18} fill="#e2e8f0" fontSize={18} fontWeight="700">
                      {n.label}
                    </text>
                  ))}

                {nodes
                  .filter((n) => n.kind === 'ENTRANCE' || n.kind === 'EXIT')
                  .map((n) => (
                    <g key={n.id}>
                      <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={4} fill="#1e293b" stroke="#475569" />
                      <text
                        x={n.x + n.w / 2}
                        y={n.y + n.h / 2 + 4}
                        textAnchor="middle"
                        fill="#94a3b8"
                        fontSize={10}
                        fontWeight="600"
                      >
                        {n.label}
                      </text>
                    </g>
                  ))}

                {nodes
                  .filter((n) => n.kind === 'OFFICE')
                  .map((n) => (
                    <g key={n.id}>
                      <rect
                        x={n.x}
                        y={n.y}
                        width={n.w}
                        height={n.h}
                        rx={6}
                        fill="#1e293b"
                        stroke="#64748b"
                        strokeWidth={2}
                      />
                      <text x={n.x + 12} y={n.y + 28} fill="#e2e8f0" fontSize={12} fontWeight="600">
                        {n.label || 'Control room'}
                      </text>
                      <text x={n.x + 12} y={n.y + 48} fill="#64748b" fontSize={10}>
                        Control room
                      </text>
                    </g>
                  ))}

                {/* 5. tanks and pumps */}
                {tanks.map((node) => (
                  <TankNode
                    key={node.id}
                    node={node}
                    highlighted={activeTankIds.has(node.id)}
                    selected={selection?.kind === 'TANK' && selection.node.id === node.id}
                    onClick={() => onSelect?.({ kind: 'TANK', node })}
                  />
                ))}

                {pumps.map((node) => {
                  const active = findActiveForPump(node, dispensingMap)
                  const phaseLocal =
                    active?.phase === 'DISPENSING'
                      ? 'pulse'
                      : active?.phase === 'COMPLETED'
                        ? 'completed'
                        : 'idle'
                  return (
                    <PumpNode
                      key={node.id}
                      node={node}
                      highlighted={!!active}
                      phase={phaseLocal}
                      selected={selection?.kind === 'PUMP' && selection.node.id === node.id}
                      restored={restoredPumpIds.includes(node.id)}
                      flashAmount={active ? active.currentAmount : null}
                      flashVolume={active ? active.currentVolume : null}
                      onClick={() => onSelect?.({ kind: 'PUMP', node })}
                    />
                  )
                })}

                {/* 6. transaction overlays */}
                {Object.values(dispensingMap).map((s) => {
                  const pump = pumps.find((p) =>
                    pumpMatchesId(
                      { id: p.id, pumpCode: p.raw.pumpCode, mqttPumpId: p.raw.mqttPumpId },
                      s.pumpId,
                    ),
                  )
                  if (!pump) return null
                  return (
                    <g key={`overlay-${s.transactionId}`} data-testid="transaction-overlay">
                      <rect
                        x={pump.x + pump.w / 2 - 78}
                        y={pump.y - 40}
                        width={156}
                        height={32}
                        rx={6}
                        fill="#052e16"
                        stroke="#22c55e"
                        strokeWidth={1.5}
                      />
                      <text
                        x={pump.x + pump.w / 2}
                        y={pump.y - 20}
                        textAnchor="middle"
                        fill="#ecfdf5"
                        fontSize={11}
                        fontWeight="700"
                      >
                        {fmtNaira(s.currentAmount)} · {fmtLiters(s.currentVolume)}
                      </text>
                    </g>
                  )
                })}
              </svg>
            </div>
            <div className="space-y-3">
              <DetailPanel selection={selection} connections={connections} />
              {!selection && (
                <div className="card text-xs text-slate-500">
                  Click a tank, pump, or pipe for details.
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
