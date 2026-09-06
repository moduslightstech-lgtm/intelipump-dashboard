import type { TwinLiveState } from '../../api/client'
import { pumpMatchesId } from '../../lib/pumpIdentity'

export type SceneAsset = {
  kind: string
  id: string
  label: string
  x: number
  y: number
  w: number
  h: number
  rotation: number
  status: string
  fillPct?: number | null
  product?: string | null
  source?: string | null
  raw: Record<string, unknown>
}

function pumpColor(status: string) {
  const s = status.toUpperCase()
  // Spec: green = online idle, blue = dispensing, gray = powered off/closed,
  // red = fault/unexpected outage, amber = degraded
  if (s === 'DISPENSING' || s === 'ACTIVE') return '#3b82f6'
  if (s === 'POWERED_OFF' || s === 'CLOSED') return '#64748b'
  if (s === 'COMPLETED') return '#34d399'
  if (s === 'OFFLINE' || s === 'ERROR' || s === 'FAULT') return '#ef4444'
  if (s === 'IDLE' || s === 'ONLINE') return '#10b981'
  if (s === 'WARNING' || s === 'MAINTENANCE' || s === 'DEGRADED') return '#f59e0b'
  return '#64748b'
}

function deviceColor(status: string) {
  const s = status.toUpperCase()
  if (s === 'ONLINE') return '#10b981'
  if (s === 'DEGRADED') return '#f59e0b'
  if (s === 'OFFLINE') return '#ef4444'
  return '#94a3b8'
}

function tankFillPct(tank: Record<string, any>): number | null {
  const capacity = Number(tank.capacityLiters ?? tank.capacity_liters)
  const liters = Number(tank.reportedLiters ?? tank.expectedLiters ?? 0)
  if (!capacity || Number.isNaN(capacity) || capacity <= 0) return null
  if (Number.isNaN(liters)) return null
  return Math.max(0, Math.min(100, (liters / capacity) * 100))
}

export function buildSceneAssets(state: TwinLiveState | undefined): SceneAsset[] {
  if (!state) return []
  const layoutItems: any[] = state.layout?.items || []
  const tanks = state.tanks || []
  const pumps = state.pumps || []
  const devices = state.devices || []
  const nozzles = state.nozzles || []

  const assets: SceneAsset[] = []

  for (const item of layoutItems) {
    const assetType = String(item.assetType || item.asset_type || '').toUpperCase()
    const assetId = String(item.assetId || item.asset_id || item.id || '')
    const x = Number(item.x ?? item.x_position ?? 0)
    const y = Number(item.y ?? item.y_position ?? 0)
    const w = Number(item.width ?? 40)
    const h = Number(item.height ?? 40)
    const rotation = Number(item.rotation ?? 0)
    const label = String(item.label || assetId)

    if (assetType === 'TANK') {
      const tank =
        tanks.find((t) => t.id === assetId || t.tankCode === assetId) || { id: assetId }
      assets.push({
        kind: 'TANK',
        id: String(tank.id || assetId),
        label: String(tank.name || tank.tankCode || label),
        x,
        y,
        w: Math.max(w, 50),
        h: Math.max(h, 50),
        rotation,
        status: String(tank.inferredStatus || tank.status || 'UNKNOWN'),
        fillPct: tankFillPct(tank),
        product: tank.product as string | undefined,
        source: String(
          (tank as any).measurementSource || (tank as any).source || '',
        ) || null,
        raw: tank,
      })
    } else if (assetType === 'PUMP') {
      const pump =
        pumps.find((p) => p.id === assetId || p.pumpCode === assetId) || { id: assetId }
      assets.push({
        kind: 'PUMP',
        id: String(pump.id || assetId),
        label: String(pump.pumpCode || label),
        x,
        y,
        w: Math.max(w, 56),
        h: Math.max(h, 36),
        rotation,
        status: String(pump.inferredStatus || pump.status || 'IDLE'),
        product: (pump.product as string) || null,
        source: (pump.source as string) || null,
        raw: pump,
      })
    } else if (assetType === 'DEVICE') {
      const device =
        devices.find((d) => d.id === assetId || d.deviceCode === assetId) || { id: assetId }
      assets.push({
        kind: 'DEVICE',
        id: String(device.id || assetId),
        label: String(device.name || device.deviceCode || label),
        x,
        y,
        w,
        h,
        rotation,
        status: String(device.inferredStatus || device.status || 'UNKNOWN'),
        source: (device.source as string) || null,
        raw: device,
      })
    } else if (assetType === 'NOZZLE') {
      const nozzle =
        nozzles.find((n) => n.id === assetId || n.nozzleCode === assetId) || { id: assetId }
      assets.push({
        kind: 'NOZZLE',
        id: String(nozzle.id || assetId),
        label: String(nozzle.nozzleCode || label),
        x,
        y,
        w,
        h,
        rotation,
        status: String(nozzle.status || 'UNKNOWN'),
        product: (nozzle.product as string) || null,
        raw: nozzle,
      })
    } else {
      assets.push({
        kind: assetType || 'OTHER',
        id: assetId || label,
        label,
        x,
        y,
        w,
        h,
        rotation,
        status: 'STATIC',
        raw: item,
      })
    }
  }

  return assets
}

type Props = {
  state?: TwinLiveState
  selectedId?: string | null
  onSelect?: (asset: SceneAsset | null) => void
  editMode?: boolean
  onMove?: (id: string, x: number, y: number) => void
  /** MQTT pumpId from payload (may contain slash e.g. PUMP-05/06) */
  highlightPumpId?: string | null
  animationPhase?: 'idle' | 'pulse' | 'completed'
}

export default function StationSceneCanvas({
  state,
  selectedId,
  onSelect,
  editMode = false,
  onMove,
  highlightPumpId = null,
  animationPhase = 'idle',
}: Props) {
  const assets = buildSceneAssets(state)
  const width = Number(state?.layout?.canvasWidth || 1200)
  const height = Number(state?.layout?.canvasHeight || 700)
  const mode = String(state?.layout?.mode || 'AUTO')
  const latest = state?.latestTransactions?.[0]

  const dragRef = { id: null as string | null, ox: 0, oy: 0 }

  return (
    <div className="relative">
      <div className="absolute top-2 left-2 z-10 text-[10px] uppercase tracking-wider text-slate-400 bg-slate-950/70 px-2 py-1 rounded border border-slate-800">
        Layout {mode}
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full h-auto bg-slate-950/90 rounded-lg border border-slate-800"
        aria-label="Station digital twin canvas"
        onClick={() => onSelect?.(null)}
      >
        <defs>
          <filter id="pumpGlow">
            <feGaussianBlur stdDeviation="4" result="coloredBlur" />
            <feMerge>
              <feMergeNode in="coloredBlur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <style>{`
            .flow-pulse { stroke-dasharray: 10 8; animation: flow 0.7s linear infinite; }
            @keyframes flow { to { stroke-dashoffset: -18; } }
          `}</style>
        </defs>

        {assets.map((a) => {
          const selected = selectedId === a.id
          if (a.kind === 'FORECOURT') {
            return (
              <rect
                key={a.id}
                x={a.x}
                y={a.y}
                width={a.w}
                height={a.h}
                rx={12}
                fill="#0f172a"
                stroke="#334155"
                strokeWidth={2}
                strokeDasharray="8 6"
              />
            )
          }
          if (a.kind === 'LABEL') {
            return (
              <text
                key={a.id}
                x={a.x}
                y={a.y + 18}
                fill="#e2e8f0"
                fontSize={18}
                fontWeight="700"
              >
                {a.label}
              </text>
            )
          }
          if (a.kind === 'ENTRANCE' || a.kind === 'EXIT') {
            return (
              <g key={a.id}>
                <rect x={a.x} y={a.y} width={a.w} height={a.h} rx={4} fill="#1e293b" stroke="#475569" />
                <text
                  x={a.x + a.w / 2}
                  y={a.y + a.h / 2 + 4}
                  textAnchor="middle"
                  fill="#94a3b8"
                  fontSize={10}
                  fontWeight="600"
                >
                  {a.label}
                </text>
              </g>
            )
          }
          if (a.kind === 'OFFICE') {
            return (
              <g key={a.id} onClick={(e) => { e.stopPropagation(); onSelect?.(a) }} style={{ cursor: 'pointer' }}>
                <rect
                  x={a.x}
                  y={a.y}
                  width={a.w}
                  height={a.h}
                  rx={6}
                  fill="#1e293b"
                  stroke={selected ? '#38bdf8' : '#64748b'}
                  strokeWidth={2}
                />
                <text x={a.x + 12} y={a.y + 28} fill="#e2e8f0" fontSize={12} fontWeight="600">
                  {a.label}
                </text>
                <text x={a.x + 12} y={a.y + 48} fill="#64748b" fontSize={10}>
                  Station office
                </text>
              </g>
            )
          }
          if (a.kind === 'TANK') {
            const fill = (a.fillPct ?? 0) / 100
            const product = String(a.product || '').toUpperCase()
            const fillColor = product.includes('AGO') || product.includes('DIESEL') ? '#a16207' : '#1d4ed8'
            const src = String(
              (a.raw as any)?.measurementSource || a.source || 'MANUAL',
            ).toUpperCase()
            const live = (a.raw as any)?.isLiveTelemetry === true || src === 'AUTOMATED'
            return (
              <g key={a.id} onClick={(e) => { e.stopPropagation(); onSelect?.(a) }} style={{ cursor: 'pointer' }}>
                <rect x={a.x} y={a.y} width={a.w} height={a.h} rx={6} fill="#1e293b" stroke="#475569" strokeWidth={2} />
                <rect
                  x={a.x}
                  y={a.y + a.h * (1 - fill)}
                  width={a.w}
                  height={a.h * fill}
                  fill={fillColor}
                  opacity={0.55}
                />
                <text x={a.x + 12} y={a.y + 18} fill="#f8fafc" fontSize={11} fontWeight="700">
                  {a.label}
                </text>
                <text x={a.x + 12} y={a.y + 34} fill="#94a3b8" fontSize={10}>
                  {a.fillPct != null ? `${Math.round(a.fillPct)}% · ${a.status}` : a.status}
                </text>
                <text
                  x={a.x + 12}
                  y={a.y + a.h - 8}
                  fill={live ? '#34d399' : '#fbbf24'}
                  fontSize={9}
                  fontWeight="600"
                >
                  {live ? 'Probe' : 'Source: Manual'}
                </text>
              </g>
            )
          }
          if (a.kind === 'PUMP') {
            const color = pumpColor(a.status)
            const highlighted =
              highlightPumpId != null &&
              pumpMatchesId(
                {
                  id: String(a.raw?.id || a.id),
                  pumpCode: a.raw?.pumpCode as string | undefined,
                  mqttPumpId: a.raw?.mqttPumpId as string | undefined,
                },
                highlightPumpId,
              )
            const active =
              a.status.toUpperCase() === 'DISPENSING' ||
              (highlighted && animationPhase === 'pulse')
            const recent =
              latest &&
              pumpMatchesId(
                {
                  id: String(a.raw?.id || a.id),
                  pumpCode: a.raw?.pumpCode as string | undefined,
                  mqttPumpId: a.raw?.mqttPumpId as string | undefined,
                },
                latest.pumpId as string,
              )
            return (
              <g
                key={a.id}
                transform={a.rotation ? `rotate(${a.rotation} ${a.x + a.w / 2} ${a.y + a.h / 2})` : undefined}
                onClick={(e) => { e.stopPropagation(); onSelect?.(a) }}
                onMouseDown={
                  editMode
                    ? (e) => {
                        e.stopPropagation()
                        dragRef.id = a.id
                        dragRef.ox = e.clientX
                        dragRef.oy = e.clientY
                      }
                    : undefined
                }
                onMouseUp={
                  editMode
                    ? (e) => {
                        if (dragRef.id === a.id && onMove) {
                          const dx = (e.clientX - dragRef.ox) * 1.2
                          const dy = (e.clientY - dragRef.oy) * 1.2
                          onMove(a.id, a.x + dx, a.y + dy)
                        }
                        dragRef.id = null
                      }
                    : undefined
                }
                style={{ cursor: editMode ? 'move' : 'pointer' }}
              >
                {(active || highlighted) && (
                  <rect
                    x={a.x - 4}
                    y={a.y - 4}
                    width={a.w + 8}
                    height={a.h + 8}
                    rx={6}
                    fill="none"
                    stroke={highlighted && animationPhase === 'completed' ? '#34d399' : '#60a5fa'}
                    strokeWidth={3}
                    filter="url(#pumpGlow)"
                    className={active ? 'flow-pulse' : undefined}
                  />
                )}
                <rect
                  x={a.x}
                  y={a.y}
                  width={a.w}
                  height={a.h}
                  rx={4}
                  fill={active ? '#1e3a5f' : '#1e293b'}
                  stroke={selected ? '#38bdf8' : '#475569'}
                  strokeWidth={selected ? 2.5 : 2}
                />
                <circle cx={a.x + 12} cy={a.y + 14} r={5} fill={color} />
                <text x={a.x + a.w / 2} y={a.y + 18} textAnchor="middle" fill="#f8fafc" fontSize={11} fontWeight="700">
                  {a.label}
                </text>
                <rect x={a.x + 8} y={a.y + 28} width={a.w - 16} height={16} rx={2} fill="#020617" />
                <text x={a.x + a.w / 2} y={a.y + 40} textAnchor="middle" fill="#38bdf8" fontSize={10}>
                  {highlighted && animationPhase === 'completed' ? 'COMPLETED' : a.status}
                </text>
                {(a.raw?.statusSource === 'INFERRED' || a.raw?.statusSource === 'SCHEDULED') && (
                  <text x={a.x + a.w / 2} y={a.y + (a.product ? 70 : 58)} textAnchor="middle" fill="#94a3b8" fontSize={8}>
                    {String(a.raw.statusSource)}
                  </text>
                )}
                {a.product && (
                  <text x={a.x + a.w / 2} y={a.y + 58} textAnchor="middle" fill="#94a3b8" fontSize={9}>
                    {a.product}
                  </text>
                )}
                {recent && (
                  <text x={a.x + a.w / 2} y={a.y + a.h - 6} textAnchor="middle" fill="#34d399" fontSize={8}>
                    last tx
                  </text>
                )}
                {a.source === 'LEDGER_ONLY' && (
                  <text x={a.x + a.w / 2} y={a.y - 6} textAnchor="middle" fill="#fbbf24" fontSize={8}>
                    unregistered
                  </text>
                )}
              </g>
            )
          }
          if (a.kind === 'DEVICE') {
            const color = deviceColor(a.status)
            return (
              <g key={a.id} onClick={(e) => { e.stopPropagation(); onSelect?.(a) }} style={{ cursor: 'pointer' }}>
                <rect
                  x={a.x}
                  y={a.y}
                  width={a.w}
                  height={a.h}
                  rx={18}
                  fill="#0f172a"
                  stroke={selected ? '#38bdf8' : color}
                  strokeWidth={2}
                />
                <circle cx={a.x + a.w / 2} cy={a.y + a.h / 2} r={6} fill={color} />
                <title>{a.label}</title>
              </g>
            )
          }
          if (a.kind === 'NOZZLE') {
            return (
              <g key={a.id}>
                <rect x={a.x} y={a.y} width={a.w} height={a.h} rx={2} fill="#334155" stroke="#64748b" />
                <title>{a.label}{a.product ? ` · ${a.product}` : ''}</title>
              </g>
            )
          }
          return null
        })}
      </svg>
    </div>
  )
}
