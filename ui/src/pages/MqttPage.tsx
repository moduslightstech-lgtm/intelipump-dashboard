import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  fmtTime,
  getEdgeDevices,
  getMqttMessages,
  getRejectedMessages,
} from '../api/client'
import { edgeConnectivityLabel, edgeConnectivityTone } from '../types/edgeDevice'

export default function MqttPage() {
  const messagesQ = useQuery({
    queryKey: ['mqtt', 'messages'],
    queryFn: async () => (await getMqttMessages()).data,
    refetchInterval: 10_000,
  })
  // Heartbeat Online/Offline must come from edge_devices — catalog /devices
  // only gets last_seen on sales, which falsely showed Pis Offline when idle.
  const devicesQ = useQuery({
    queryKey: ['edge-devices', 'mqtt-monitor'],
    queryFn: async () => (await getEdgeDevices()).data,
    refetchInterval: 15_000,
  })
  const rejectedQ = useQuery({
    queryKey: ['mqtt', 'rejected'],
    queryFn: async () => (await getRejectedMessages()).data,
    refetchInterval: 10_000,
  })

  const stats = useMemo(() => {
    const msgs = messagesQ.data || []
    return {
      received: msgs.length,
      processed: msgs.filter((m) => m.processing_status === 'processed').length,
      rejected:
        (rejectedQ.data || []).length +
        msgs.filter((m) => m.processing_status === 'rejected').length,
      errors: msgs.filter((m) => m.processing_status === 'error').length,
    }
  }, [messagesQ.data, rejectedQ.data])

  return (
    <div className="p-6 space-y-4">
      <div>
        <h1 className="section-title">MQTT monitor</h1>
        <p className="text-slate-400 text-sm mt-1">
          Consumer processing audit — browser never connects to Mosquitto. Online =
          heartbeat within 90s. RS485 down = Pi reachable but pump serial not open.
        </p>
      </div>

      <div className="card overflow-x-auto">
        <h2 className="text-white font-semibold text-sm mb-3">
          Edge device connectivity (heartbeat + RS485)
        </h2>
        {(devicesQ.data?.length ?? 0) === 0 ? (
          <p className="text-slate-500 text-sm">No edge device heartbeats yet.</p>
        ) : (
          <ul className="flex flex-wrap gap-2 text-sm">
            {devicesQ.data?.map((d) => {
              const age =
                d.secondsSinceLastHeartbeat != null
                  ? `${d.secondsSinceLastHeartbeat}s ago`
                  : d.statusReason || 'no heartbeat'
              const label = edgeConnectivityLabel(d)
              const tone = edgeConnectivityTone(d)
              const toneClass =
                tone === 'green'
                  ? 'text-emerald-300'
                  : tone === 'amber'
                    ? 'text-amber-300'
                    : tone === 'red'
                      ? 'text-red-300'
                      : 'text-slate-400'
              const title = [
                d.statusReason,
                d.pumpCommunicationLabel || d.pumpCommunicationStatus,
                d.serialPortOpen === false ? 'serialPortOpen=false' : null,
              ]
                .filter(Boolean)
                .join(' · ')
              return (
                <li
                  key={d.deviceId}
                  className="rounded-lg border border-slate-700 px-3 py-2"
                  title={title || undefined}
                >
                  <span className="font-mono text-xs text-slate-300">{d.deviceId}</span>{' '}
                  <span className={toneClass}>{label}</span>
                  <span className="ml-1 text-xs text-slate-500">{age}</span>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat label="Recent messages" value={stats.received} />
        <Stat label="Processed" value={stats.processed} />
        <Stat label="Rejected" value={stats.rejected} />
        <Stat label="Errors" value={stats.errors} />
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <div className="card overflow-x-auto">
          <h2 className="text-white font-semibold mb-3">Recent messages</h2>
          {(messagesQ.data?.length ?? 0) === 0 ? (
            <p className="text-slate-500 text-sm py-10 text-center">No mqtt_messages yet</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-400 border-b border-slate-700">
                  <th className="pb-2">Received</th>
                  <th className="pb-2">Topic</th>
                  <th className="pb-2">Status</th>
                  <th className="pb-2">Duration</th>
                </tr>
              </thead>
              <tbody>
                {messagesQ.data?.slice(0, 50).map((m) => {
                  const ms =
                    m.processed_at && m.received_at
                      ? Math.max(
                          0,
                          new Date(m.processed_at).getTime() - new Date(m.received_at).getTime(),
                        )
                      : null
                  return (
                    <tr key={m.id} className="border-b border-slate-800 align-top">
                      <td className="py-2 text-slate-400 whitespace-nowrap">
                        {fmtTime(m.received_at)}
                      </td>
                      <td className="py-2 font-mono text-xs text-slate-300 max-w-[180px] truncate">
                        {m.topic}
                      </td>
                      <td className="py-2">
                        <span
                          className={
                            m.processing_status === 'processed'
                              ? 'badge-ok'
                              : m.processing_status === 'rejected'
                                ? 'badge-warn'
                                : 'badge-critical'
                          }
                        >
                          {m.processing_status}
                        </span>
                        {m.error_message && (
                          <div className="text-xs text-red-300 mt-1 max-w-[160px] truncate">
                            {m.error_message}
                          </div>
                        )}
                      </td>
                      <td className="py-2 font-mono text-xs">{ms != null ? `${ms} ms` : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="card overflow-x-auto">
          <h2 className="text-white font-semibold mb-3">Rejected messages</h2>
          {(rejectedQ.data?.length ?? 0) === 0 ? (
            <p className="text-slate-500 text-sm py-10 text-center">No rejected messages</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-400 border-b border-slate-700">
                  <th className="pb-2">Received</th>
                  <th className="pb-2">Type</th>
                  <th className="pb-2">Error</th>
                </tr>
              </thead>
              <tbody>
                {rejectedQ.data?.slice(0, 50).map((m) => (
                  <tr key={m.id} className="border-b border-slate-800 align-top">
                    <td className="py-2 text-slate-400 whitespace-nowrap">
                      {fmtTime(m.received_at)}
                    </td>
                    <td className="py-2 font-mono text-xs">{m.error_type}</td>
                    <td className="py-2 text-red-300 text-xs">{m.error_message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat-card">
      <div className="label-text">{label}</div>
      <div className="text-2xl font-bold text-white">{value}</div>
    </div>
  )
}
