import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  acknowledgeAlert,
  dismissAlert,
  fmtTime,
  getAlertSummary,
  getAlerts,
  reopenAlert,
  resolveAlert,
  type Alert,
  type AlertSummary,
} from '../api/client'

function severityBadge(severity: string) {
  const s = severity.toUpperCase()
  if (s === 'CRITICAL') return 'badge-critical'
  if (s === 'WARN' || s === 'WARNING' || s === 'HIGH') return 'badge-warn'
  return 'badge-ok'
}

export default function AlertsPage() {
  const qc = useQueryClient()
  const [status, setStatus] = useState('')
  const [severity, setSeverity] = useState('')
  const [type, setType] = useState('')
  const [selected, setSelected] = useState<Alert | null>(null)

  const params = useMemo(
    () => ({
      status: status || undefined,
      type: type || undefined,
    }),
    [status, type],
  )

  const alertsQ = useQuery({
    queryKey: ['alerts', params],
    queryFn: async () => (await getAlerts(params)).data,
  })

  const summaryQ = useQuery({
    queryKey: ['alerts', 'summary'],
    queryFn: async () => {
      try {
        return (await getAlertSummary()).data
      } catch (err: any) {
        if (err?.response?.status === 404) return null
        throw err
      }
    },
    retry: false,
  })

  const invalidate = () => qc.invalidateQueries({ queryKey: ['alerts'] })

  const ack = useMutation({
    mutationFn: (id: string) => acknowledgeAlert(id),
    onSuccess: (res) => {
      invalidate()
      setSelected(res.data)
    },
  })
  const resolve = useMutation({
    mutationFn: (id: string) => resolveAlert(id),
    onSuccess: (res) => {
      invalidate()
      setSelected(res.data)
    },
  })
  const dismiss = useMutation({
    mutationFn: (id: string) => dismissAlert(id),
    onSuccess: (res) => {
      invalidate()
      setSelected(res.data)
    },
  })
  const reopen = useMutation({
    mutationFn: (id: string) => reopenAlert(id),
    onSuccess: (res) => {
      invalidate()
      setSelected(res.data)
    },
  })

  const filtered = useMemo(() => {
    const list = alertsQ.data || []
    if (!severity) return list
    return list.filter((a) => a.severity.toUpperCase() === severity.toUpperCase())
  }, [alertsQ.data, severity])

  const summary: AlertSummary | null | undefined = summaryQ.data

  return (
    <div className="p-6 space-y-4">
      <div>
        <h1 className="section-title">Alerts</h1>
        <p className="text-slate-400 text-sm mt-1">
          Filter, acknowledge, resolve, dismiss, or reopen operational alerts
        </p>
      </div>

      {summary && (
        <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
          <SummaryCard label="Total" value={summary.total} />
          <SummaryCard label="Open" value={summary.open} />
          <SummaryCard label="Acknowledged" value={summary.acknowledged} />
          <SummaryCard label="In progress" value={summary.in_progress} />
          <SummaryCard label="Resolved" value={summary.resolved} />
          <SummaryCard label="Dismissed" value={summary.dismissed} />
        </div>
      )}

      <div className="card grid md:grid-cols-3 gap-3">
        <div>
          <label className="label-text block mb-1">Status</label>
          <select className="input w-full" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            <option value="OPEN">OPEN</option>
            <option value="ACKNOWLEDGED">ACKNOWLEDGED</option>
            <option value="IN_PROGRESS">IN_PROGRESS</option>
            <option value="RESOLVED">RESOLVED</option>
            <option value="DISMISSED">DISMISSED</option>
          </select>
        </div>
        <div>
          <label className="label-text block mb-1">Severity</label>
          <select
            className="input w-full"
            value={severity}
            onChange={(e) => setSeverity(e.target.value)}
          >
            <option value="">All severities</option>
            <option value="CRITICAL">CRITICAL</option>
            <option value="WARN">WARN</option>
            <option value="INFO">INFO</option>
          </select>
        </div>
        <div>
          <label className="label-text block mb-1">Type</label>
          <input
            className="input w-full"
            placeholder="e.g. SALES_VARIANCE"
            value={type}
            onChange={(e) => setType(e.target.value)}
          />
        </div>
      </div>

      {alertsQ.isError && (
        <div className="card text-red-300 text-sm" role="alert">
          Failed to load alerts.
        </div>
      )}

      <div className="grid lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-3">
          {filtered.length === 0 && !alertsQ.isLoading ? (
            <div className="card text-slate-500 text-sm text-center py-16">No alerts match these filters</div>
          ) : (
            filtered.map((a) => (
              <button
                key={a.id}
                type="button"
                className={`card w-full text-left flex flex-col md:flex-row md:items-center justify-between gap-3 ${
                  selected?.id === a.id ? 'ring-1 ring-emerald-600' : ''
                }`}
                onClick={() => setSelected(a)}
              >
                <div>
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span className={severityBadge(a.severity)}>{a.severity}</span>
                    <span className="badge-info">{a.status}</span>
                    <span className="text-white font-medium">{a.title}</span>
                  </div>
                  <p className="text-sm text-slate-400">{a.message || a.alert_type}</p>
                  <p className="text-xs text-slate-500 mt-1">{fmtTime(a.detected_at)}</p>
                </div>
              </button>
            ))
          )}
        </div>

        <div className="card space-y-3 h-fit sticky top-4">
          <h2 className="text-white font-semibold">Alert detail</h2>
          {!selected ? (
            <p className="text-slate-500 text-sm">Select an alert to inspect and act</p>
          ) : (
            <>
              <dl className="text-sm space-y-1.5">
                <DetailRow label="Title" value={selected.title} />
                <DetailRow label="Type" value={selected.alert_type} />
                <DetailRow label="Severity" value={selected.severity} />
                <DetailRow label="Status" value={selected.status} />
                <DetailRow label="Station" value={selected.station_id || '—'} />
                <DetailRow label="Device" value={selected.device_id || '—'} />
                <DetailRow label="Detected" value={fmtTime(selected.detected_at)} />
                <DetailRow label="Acknowledged" value={fmtTime(selected.acknowledged_at)} />
                <DetailRow label="Resolved" value={fmtTime(selected.resolved_at)} />
                <DetailRow label="Message" value={selected.message || '—'} />
              </dl>
              <div className="flex flex-wrap gap-2 pt-2">
                {selected.status === 'OPEN' && (
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={ack.isPending}
                    onClick={() => ack.mutate(selected.id)}
                  >
                    Acknowledge
                  </button>
                )}
                {selected.status !== 'RESOLVED' && selected.status !== 'DISMISSED' && (
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={resolve.isPending}
                    onClick={() => resolve.mutate(selected.id)}
                  >
                    Resolve
                  </button>
                )}
                {selected.status !== 'DISMISSED' && selected.status !== 'RESOLVED' && (
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={dismiss.isPending}
                    onClick={() => dismiss.mutate(selected.id)}
                  >
                    Dismiss
                  </button>
                )}
                {(selected.status === 'RESOLVED' || selected.status === 'DISMISSED') && (
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={reopen.isPending}
                    onClick={() => reopen.mutate(selected.id)}
                  >
                    Reopen
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function SummaryCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat-card">
      <div className="label-text">{label}</div>
      <div className="text-xl font-bold text-white">{value}</div>
    </div>
  )
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-slate-200 text-right break-all">{value}</dd>
    </div>
  )
}
