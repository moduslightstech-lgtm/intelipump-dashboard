import { useEffect, useMemo, useState } from 'react'
import { useStationEdgeDevices, useEdgeNetworkSummary } from '../../hooks/useDeviceStatus'
import {
  availabilityLabel,
  availabilityTone,
  formatExactTimestamp,
  formatRelativeHeartbeat,
  type AvailabilityTone,
} from '../../lib/relativeTime'
import { getDeviceStatus } from '../../services/edgeDeviceApi'

function toneDot(tone: AvailabilityTone) {
  if (tone === 'green') return 'bg-emerald-400'
  if (tone === 'amber') return 'bg-amber-400'
  if (tone === 'red') return 'bg-red-400'
  return 'bg-slate-500'
}

function toneText(tone: AvailabilityTone) {
  if (tone === 'green') return 'text-emerald-400'
  if (tone === 'amber') return 'text-amber-400'
  if (tone === 'red') return 'text-red-400'
  return 'text-slate-400'
}

function useNowTick(enabled = true) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [enabled])
  return now
}

export function StatusDot({ status, label }: { status?: string | null; label?: string }) {
  const tone = availabilityTone(status)
  const text = label || availabilityLabel(status)
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-sm font-medium ${toneText(tone)}`}
      data-testid={`status-dot-${(status || 'unknown').toLowerCase()}`}
      title={
        status === 'ONLINE'
          ? 'Online means a heartbeat was received recently.'
          : status === 'OFFLINE'
            ? 'Offline means no recent heartbeat from the Pi. This does not necessarily mean the pump itself has no power.'
            : status === 'DELAYED'
              ? 'Heartbeat is delayed — the Pi may be struggling to reach the broker.'
              : undefined
      }
    >
      <span className={`h-2 w-2 rounded-full ${toneDot(tone)}`} aria-hidden />
      {text}
    </span>
  )
}

export function StatusBadge({ value }: { value?: string | null }) {
  const tone = availabilityTone(value)
  const border =
    tone === 'green'
      ? 'border-emerald-800 bg-emerald-950 text-emerald-400'
      : tone === 'amber'
        ? 'border-amber-800 bg-amber-950 text-amber-400'
        : tone === 'red'
          ? 'border-red-800 bg-red-950 text-red-400'
          : 'border-slate-700 bg-slate-800 text-slate-400'
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${border}`}
      data-testid={`badge-${(value || 'unknown').toLowerCase()}`}
    >
      {(value || 'UNKNOWN').replace(/_/g, ' ')}
    </span>
  )
}

function liveSeconds(
  secondsSince: number | null | undefined,
  lastSeen: string | null | undefined,
  nowMs: number,
): number | null {
  if (lastSeen) {
    const then = new Date(lastSeen).getTime()
    if (!Number.isNaN(then)) {
      return Math.max(0, Math.floor((nowMs - then) / 1000))
    }
  }
  if (typeof secondsSince === 'number' && Number.isFinite(secondsSince)) {
    return Math.max(0, secondsSince)
  }
  return null
}

export function StationEdgeStatusCard({
  stationName,
  mqttStationId,
}: {
  stationName: string
  mqttStationId: string
}) {
  const now = useNowTick()
  const q = useStationEdgeDevices(mqttStationId)
  const device = q.primary
  const seconds = liveSeconds(device?.secondsSinceLastHeartbeat, device?.lastSeen, now)

  return (
    <div
      className="rounded-xl border border-slate-800 bg-slate-900/50 p-4"
      data-testid="station-edge-card"
      title="Pump transaction activity is separate from edge-device connectivity."
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="font-medium text-white">{stationName}</h3>
          <p className="text-[10px] font-mono text-slate-600">{mqttStationId}</p>
        </div>
        {q.isError && q.data && (
          <span className="text-[10px] text-amber-400">Device status temporarily unavailable</span>
        )}
      </div>

      {!q.hasMapping ? (
        <p className="mt-3 text-sm text-slate-500">No edge device assigned</p>
      ) : q.isLoading && !device ? (
        <p className="mt-3 text-sm text-slate-500" data-testid="edge-loading">
          Checking device status...
        </p>
      ) : q.notFound ? (
        <p className="mt-3 text-sm text-slate-500">Edge device is not registered</p>
      ) : q.isError && !device ? (
        <p className="mt-3 text-sm text-amber-400">Device status temporarily unavailable</p>
      ) : device ? (
        <div className="mt-3 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-slate-500">Edge Device</span>
            <StatusDot status={device.status} />
          </div>
          <div className="flex items-center justify-between gap-2 text-xs text-slate-400">
            <span>Last Heartbeat</span>
            <span title={formatExactTimestamp(device.lastSeen)}>
              {device.status === 'NEVER_CONNECTED'
                ? 'Waiting for first heartbeat'
                : formatRelativeHeartbeat(seconds, device.lastSeen, { nowMs: now })}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2 text-xs text-slate-400">
            <span>Device</span>
            <span className="font-mono text-[11px] text-slate-300">{device.deviceId}</span>
          </div>
          {q.totalCount > 1 && (
            <p className="text-[11px] text-slate-500">
              {q.onlineCount} of {q.totalCount} devices online
            </p>
          )}
        </div>
      ) : null}
    </div>
  )
}

export function EdgeConnectivityNetworkPanel({
  stations,
}: {
  stations: Array<{ id: string; name: string; mqttId: string }>
}) {
  const stationKeys = useMemo(
    () => [...new Set(stations.map((s) => s.mqttId).filter(Boolean))],
    [stations],
  )

  const networkQ = useEdgeNetworkSummary(stationKeys)

  const cards = useMemo(
    () =>
      stations
        .filter((s) => s.mqttId)
        .map((s) => ({
          id: s.id,
          name: s.name,
          mqttId: s.mqttId,
        })),
    [stations],
  )

  return (
    <section className="card space-y-4" data-testid="edge-connectivity-section">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold text-white">Edge Connectivity</h2>
          <p
            className="mt-1 text-xs text-slate-500"
            title="Online means a heartbeat was received recently. Offline does not necessarily mean the pump itself has no power."
          >
            Raspberry Pi online/offline from heartbeats — not from pump sales.
          </p>
        </div>
        {networkQ.isError && networkQ.data && (
          <span className="text-xs text-amber-400">Device status temporarily unavailable</span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric
          label="Online edge devices"
          value={networkQ.data?.online}
          tone="green"
          loading={networkQ.isLoading && !networkQ.data}
        />
        <Metric
          label="Delayed edge devices"
          value={networkQ.data?.delayed}
          tone="amber"
          loading={networkQ.isLoading && !networkQ.data}
        />
        <Metric
          label="Offline edge devices"
          value={networkQ.data?.offline}
          tone="red"
          loading={networkQ.isLoading && !networkQ.data}
        />
        <Metric
          label="Devices unavailable"
          value={networkQ.data?.unavailable}
          tone="gray"
          loading={networkQ.isLoading && !networkQ.data}
        />
      </div>

      {cards.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-500">No edge devices configured</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {cards.map((s) => (
            <StationEdgeStatusCard key={s.id} stationName={s.name} mqttStationId={s.mqttId} />
          ))}
        </div>
      )}
    </section>
  )
}

function Metric({
  label,
  value,
  tone,
  loading,
}: {
  label: string
  value?: number
  tone: AvailabilityTone
  loading?: boolean
}) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 text-xl font-semibold ${toneText(tone)}`}>
        {loading ? '…' : value ?? '—'}
      </div>
    </div>
  )
}

export function EdgeDeviceStatusDetailCard({ stationId }: { stationId: string }) {
  const now = useNowTick()
  const q = useStationEdgeDevices(stationId)
  const device = q.primary
  const seconds = liveSeconds(device?.secondsSinceLastHeartbeat, device?.lastSeen, now)

  const cloudHeartbeat =
    device?.status === 'ONLINE'
      ? 'Receiving'
      : device?.status === 'DELAYED'
        ? 'Delayed'
        : device?.status === 'NEVER_CONNECTED'
          ? 'Waiting for first heartbeat'
          : device
            ? 'Not receiving'
            : '—'

  return (
    <section className="card" data-testid="edge-device-status-card">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold text-white">Edge Device Status</h2>
          <p className="mt-1 text-xs text-slate-500">
            Raspberry Pi status comes from heartbeats. Pump activity is reported separately and does
            not control online/offline.
          </p>
        </div>
        {q.isError && device && (
          <span className="text-xs text-amber-400">Device status temporarily unavailable</span>
        )}
      </div>

      {!q.hasMapping && (
        <p className="py-6 text-center text-sm text-slate-500">No edge device assigned</p>
      )}

      {q.hasMapping && q.isLoading && !device && (
        <p className="py-6 text-center text-sm text-slate-500" data-testid="edge-loading">
          Checking device status...
        </p>
      )}

      {q.hasMapping && q.notFound && (
        <p className="py-6 text-center text-sm text-slate-500">Edge device is not registered</p>
      )}

      {q.hasMapping && q.isError && !device && !q.notFound && (
        <p className="py-6 text-center text-sm text-amber-400">
          Device status temporarily unavailable
        </p>
      )}

      {device && (
        <dl className="space-y-3 text-sm">
          <DetailRow label="Raspberry Pi" value={<StatusDot status={device.status} />} />
          <DetailRow label="Cloud heartbeat" value={cloudHeartbeat} />
          <DetailRow
            label="MQTT status"
            value={availabilityLabel(device.mqttConnectionStatus)}
          />
          <DetailRow
            label="Pump activity"
            value="No recent transaction"
            hint="Pump sales are separate from Pi connectivity. Absence of sales does not mean the Pi is offline."
          />
          <DetailRow
            label="Last heartbeat"
            value={
              device.status === 'NEVER_CONNECTED'
                ? 'Waiting for first heartbeat'
                : formatRelativeHeartbeat(seconds, device.lastSeen, { nowMs: now })
            }
            hint={formatExactTimestamp(device.lastSeen)}
          />
          <DetailRow label="Device ID" value={device.deviceId} mono />
          <DetailRow label="Hostname" value={device.hostname || '—'} mono />
          <DetailRow label="Station ID" value={device.stationId} mono />
        </dl>
      )}
    </section>
  )
}

function DetailRow({
  label,
  value,
  mono,
  hint,
}: {
  label: string
  value: React.ReactNode
  mono?: boolean
  hint?: string
}) {
  return (
    <div className="grid grid-cols-[160px_1fr] gap-2 border-b border-slate-900 pb-2">
      <dt className="text-slate-500">{label}</dt>
      <dd className={`text-slate-200 ${mono ? 'font-mono text-xs' : ''}`} title={hint}>
        {value}
        {hint && hint !== 'Never' ? (
          <div className="mt-0.5 text-[10px] text-slate-600">{hint}</div>
        ) : null}
      </dd>
    </div>
  )
}

export { formatRelativeHeartbeat, getDeviceStatus }
