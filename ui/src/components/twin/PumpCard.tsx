import { fmtLiters, fmtNaira, fmtTime } from '../../api/client'
import { pumpMatchesId, pumpStatusColor } from '../../lib/pumpIdentity'
import { displayPumpStatus, pumpStatusLabel } from './schematic/display'
import { friendlyNozzleName } from './schematic/physicalPump'

type Props = {
  pump: Record<string, any>
  animating?: boolean
  phase?: 'idle' | 'pulse' | 'completed'
  flashAmount?: number | null
  flashVolume?: number | null
  activePumpId?: string | null
  recentCount?: number
}

function pumpTitle(pump: Record<string, any>) {
  const mqttId = String(pump.mqttPumpId || pump.pumpCode || '').trim()
  const pumpCode = String(pump.pumpCode || '').trim()
  const name = String(pump.name || '').trim()
  const primary =
    (name && name !== mqttId && name !== pumpCode ? name : null) || mqttId || pumpCode || 'Pump'
  const secondary = mqttId && primary !== mqttId ? mqttId : null
  return { primary, secondary, mqttId: mqttId || primary }
}

export default function PumpCard({
  pump,
  animating,
  phase = 'idle',
  flashAmount,
  flashVolume,
  activePumpId,
  recentCount,
}: Props) {
  const status = displayPumpStatus(pump.inferredStatus || pump.status)
  const color = pumpStatusColor(status)
  const { primary, secondary, mqttId } = pumpTitle(pump)
  const isActive = animating || (activePumpId != null && pumpMatchesId(pump, activePumpId))
  const dispensing = status === 'DISPENSING' || (isActive && phase === 'pulse')
  const nozzles = Array.isArray(pump.nozzles) ? pump.nozzles : []

  return (
    <article
      className={`relative rounded-lg border p-3 transition-shadow ${
        dispensing
          ? 'border-emerald-500 bg-emerald-950/40 shadow-[0_0_0_1px_rgba(34,197,94,0.35)]'
          : status === 'POWERED_OFF'
            ? 'border-slate-700 bg-slate-900/60 opacity-90'
            : status === 'FAULT' || status === 'OFFLINE'
              ? 'border-red-800/80 bg-red-950/20'
              : 'border-slate-800 bg-slate-900/80'
      }`}
      aria-label={`Pump ${mqttId} ${status}`}
      data-pump-id={mqttId}
      data-status={status}
    >
      {isActive && phase === 'completed' && (
        <span className="absolute -top-2 right-2 text-[10px] font-semibold uppercase tracking-wide bg-emerald-600 text-white px-2 py-0.5 rounded">
          Completed
        </span>
      )}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 pr-1">
          <div className="text-sm font-semibold text-white truncate">{primary}</div>
          {secondary && (
            <div className="text-[11px] font-mono text-slate-400 break-all">{secondary}</div>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0 pt-0.5">
          <span className="relative inline-flex h-3 w-3 items-center justify-center" aria-hidden>
            {dispensing && (
              <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60 animate-ping" />
            )}
            <span
              className={`relative inline-flex h-2.5 w-2.5 rounded-full ring-2 ring-slate-950 ${
                dispensing ? 'animate-pulse' : ''
              }`}
              style={{ backgroundColor: color }}
            />
          </span>
          <span className="text-[11px] font-semibold" style={{ color }}>
            {pumpStatusLabel(status)}
          </span>
        </div>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1 text-[11px]">
        <span className="text-slate-500">Product</span>
        <span className="text-slate-200 text-right">{pump.product || '—'}</span>
        <span className="text-slate-500">Last amount</span>
        <span className="text-emerald-400 text-right font-medium">
          {fmtNaira(flashAmount ?? pump.lastTransactionAmount)}
        </span>
        <span className="text-slate-500">Last volume</span>
        <span className="text-slate-200 text-right">
          {fmtLiters(flashVolume ?? pump.lastTransactionVolume)}
        </span>
        <span className="text-slate-500">Last time</span>
        <span className="text-slate-400 text-right">{fmtTime(pump.lastTransactionAt)}</span>
        <span className="text-slate-500">Recent activity</span>
        <span className="text-slate-300 text-right">
          {typeof recentCount === 'number' ? recentCount : Number(pump.recentSaleCount || 0)} tx
        </span>
        <span className="text-slate-500">Nozzles</span>
        <span className="text-slate-300 text-right">{nozzles.length || pump.nozzleCount || 0}</span>
        <span className="text-slate-500">Device</span>
        <span className="text-slate-300 text-right truncate">
          {pump.deviceName || pump.deviceCode || '—'}
        </span>
        <span className="text-slate-500">Alerts</span>
        <span
          className={`text-right ${
            Number(pump.activeAlertCount || 0) > 0 ? 'text-amber-300' : 'text-slate-400'
          }`}
        >
          {Number(pump.activeAlertCount || 0)}
        </span>
      </div>

      {nozzles.length > 0 ? (
        <div className="mt-3 space-y-2">
          {nozzles.map((n: Record<string, any>, i: number) => {
            const ns = displayPumpStatus(n.inferredStatus || n.status)
            return (
              <div
                key={String(n.id || i)}
                className="rounded-md border border-slate-700 bg-slate-950/70 px-2 py-1.5"
                data-testid={`pump-list-nozzle-${n.id || i}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-semibold text-white">{friendlyNozzleName(n, i)}</span>
                  <span className="text-[10px] font-semibold" style={{ color: pumpStatusColor(ns) }}>
                    {pumpStatusLabel(ns)}
                  </span>
                </div>
                <div className="mt-1 grid grid-cols-2 gap-x-2 text-[10px] text-slate-400">
                  <span>{n.product || 'Product not mapped'}</span>
                  <span className="text-right">{fmtNaira(n.lastTransactionAmount)}</span>
                  <span>{fmtLiters(n.lastTransactionVolume)}</span>
                  <span className="text-right">{fmtTime(n.lastTransactionAt)}</span>
                </div>
              </div>
            )
          })}
        </div>
      ) : null}

      {dispensing && (
        <div className="mt-2 h-1 rounded-full overflow-hidden bg-slate-800" aria-hidden>
          <div className="h-full w-1/2 bg-emerald-400 animate-[pulse_0.8s_ease-in-out_infinite]" />
        </div>
      )}
    </article>
  )
}
