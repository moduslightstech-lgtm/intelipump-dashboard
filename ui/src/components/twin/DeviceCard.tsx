import { fmtTime } from '../../api/client'

type Props = { device: Record<string, any> }

function statusTone(status: string) {
  const s = status.toUpperCase()
  if (s === 'ONLINE') return 'text-emerald-400 border-emerald-800'
  if (s === 'DEGRADED') return 'text-amber-300 border-amber-800'
  if (s === 'OFFLINE') return 'text-red-400 border-red-900'
  return 'text-slate-400 border-slate-700'
}

export default function DeviceCard({ device }: Props) {
  const status = String(device.inferredStatus || device.status || 'UNKNOWN').toUpperCase()
  return (
    <article
      className={`rounded-lg border bg-slate-900/80 p-3 ${statusTone(status)}`}
      data-device-id={device.id}
    >
      <div className="flex justify-between gap-2">
        <div className="text-sm font-semibold text-white">
          {device.name || device.deviceCode}
        </div>
        <span className="text-[11px] font-semibold">{status}</span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1 text-[11px] text-slate-400">
        <span>Code</span>
        <span className="text-right font-mono text-slate-300">{device.deviceCode}</span>
        <span>MQTT</span>
        <span className="text-right">
          {device.mqttConnected == null ? '—' : device.mqttConnected ? 'Connected' : 'Down'}
        </span>
        <span>Serial</span>
        <span className="text-right">
          {device.serialConnected == null ? '—' : device.serialConnected ? 'OK' : 'Down'}
        </span>
        <span>Heartbeat</span>
        <span className="text-right">{fmtTime(device.lastSeenAt)}</span>
        <span>Last tx</span>
        <span className="text-right">{fmtTime(device.lastTransactionAt)}</span>
        <span>Agent</span>
        <span className="text-right font-mono">{device.agentVersion || '—'}</span>
        <span>Pending</span>
        <span className="text-right">{device.pendingTransactions ?? '—'}</span>
        <span>Alerts</span>
        <span className="text-right">{device.activeAlertCount ?? 0}</span>
      </div>
    </article>
  )
}
