import { useState } from 'react'
import { fmtLiters, fmtNaira, fmtTime } from '../../../api/client'
import { displayPumpStatus, pumpStatusLabel, readingSourceLabel } from './display'
import type { SchematicNode, SchematicSelection, ValidatedConnection } from './types'

type Props = {
  selection: SchematicSelection
  connections: ValidatedConnection[]
  nodes?: SchematicNode[]
  onClose: () => void
}

export default function EquipmentDrawer({ selection, connections, nodes = [], onClose }: Props) {
  if (!selection) return null
  return (
    <aside
      className="pointer-events-auto absolute right-2 top-2 z-20 w-[min(100%,19rem)] max-h-[min(36rem,calc(100%-1rem))] overflow-y-auto rounded-xl border border-slate-700 bg-slate-900/95 shadow-xl"
      aria-label="Equipment details"
    >
      <div className="flex items-center justify-between px-3 pt-3">
        <span className="text-xs uppercase tracking-wide text-slate-500">Details</span>
        <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="space-y-2 p-3 pt-2 text-sm">
        {selection.kind === 'TANK' && <TankDetails node={selection.node} connections={connections} nodes={nodes} />}
        {selection.kind === 'PUMP' && <PumpDetails node={selection.node} connections={connections} />}
        {selection.kind === 'PIPE' && <PipeDetails routeId={selection.routeId} connections={connections} />}
        {(selection.kind === 'OFFICE' ||
          selection.kind === 'ENTRANCE' ||
          selection.kind === 'EXIT') && (
          <p className="text-slate-300">{selection.node.label}</p>
        )}
      </div>
    </aside>
  )
}

function TankDetails({
  node,
  connections,
  nodes,
}: {
  node: SchematicNode
  connections: ValidatedConnection[]
  nodes: SchematicNode[]
}) {
  const t = node.raw
  const linked = connections.filter((c) => c.tankId === node.id)
  return (
    <>
      <h3 className="font-semibold text-white">{node.label}</h3>
      <Row label="Product" value={node.product || '—'} />
      <Row label="Volume" value={fmtLiters(t.reportedLiters)} />
      <Row label="Capacity" value={fmtLiters(t.capacityLiters)} />
      <Row label="Fill" value={t.fillPercent != null ? `${Number(t.fillPercent).toFixed(1)}%` : '—'} />
      <Row label="Reading" value={readingSourceLabel(t)} />
      <Row label="Last reading" value={fmtTime(t.measuredAt)} />
      <Row label="Status" value={String(t.inferredStatus || t.status || '—')} />
      <p className="pt-1 text-xs text-slate-400">
        Connected pumps:{' '}
        {linked.length
          ? linked.map((c) => c.pumpName || nodes.find((n) => n.id === c.pumpId)?.label || 'Pump').join(', ')
          : 'none'}
      </p>
      <TechnicalIds id={node.id} extra={`code ${t.tankCode || '—'}`} />
    </>
  )
}

function PumpDetails({
  node,
  connections,
}: {
  node: SchematicNode
  connections: ValidatedConnection[]
}) {
  const p = node.raw
  const isPhysical = p.assetRole === 'PHYSICAL_PUMP'
  const linked = connections.filter(
    (c) =>
      c.pumpId === node.id ||
      String(c.raw?.physicalPumpId || '') === String(p.id) ||
      String(c.raw?.nozzleId || '') === node.id,
  )
  const lastStatus = String(p.lastTransactionStatus || '')
  const nozzles = Array.isArray(p.nozzles) ? p.nozzles : []
  return (
    <>
      <h3 className="font-semibold text-white">{p.name || node.label}</h3>
      <Row label={isPhysical ? 'Pump code' : 'Nozzle'} value={isPhysical ? p.pumpCode : p.name || node.label} />
      <Row label="State" value={pumpStatusLabel(displayPumpStatus(node.status))} />
      <Row label="Product" value={node.product || p.product || 'Product not mapped'} />
      <Row label="Last activity" value={fmtTime(p.lastTransactionAt)} />
      {lastStatus.toUpperCase() === 'COMPLETED' ? (
        <p className="text-xs text-slate-400">Last sale completed</p>
      ) : null}
      {p.lastTransactionAmount != null ? (
        <Row
          label="Last sale"
          value={`${fmtNaira(p.lastTransactionAmount)} · ${fmtLiters(p.lastTransactionVolume)}`}
        />
      ) : null}
      {isPhysical && nozzles.length > 0 ? (
        <p className="text-xs text-slate-400">{nozzles.length} nozzles</p>
      ) : null}
      <div className="pt-1 text-xs text-slate-300">
        {linked.length === 0 ? (
          <span className="text-amber-300">Unconnected</span>
        ) : (
          linked.map((c) => (
            <div key={c.id} data-testid="pump-tank-link">
              {c.role === 'BACKUP' ? 'Backup tank' : 'Primary tank'}: {c.tankName || 'Tank'}
              {c.product ? ` · ${c.product}` : ''}
            </div>
          ))
        )}
      </div>
      <TechnicalIds
        id={node.id}
        extra={[p.pumpCode || p.mqttPumpId, p.nozzleCode, p.sourceIdentifier].filter(Boolean).join(' · ')}
      />
    </>
  )
}

function PipeDetails({
  routeId,
  connections,
}: {
  routeId: string
  connections: ValidatedConnection[]
}) {
  const c = connections.find((x) => x.id === routeId)
  if (!c) return <p className="text-slate-400">Connection not found.</p>
  return (
    <>
      <h3 className="font-semibold text-white">{c.lineLabel || 'Fuel pipe'}</h3>
      <Row label="Tank" value={c.tankName || 'Tank'} />
      <Row label="Pump" value={c.pumpName || 'Pump'} />
      <Row label="Product" value={c.product || '—'} />
      <Row label="Role" value={c.role === 'BACKUP' ? 'Backup' : 'Primary'} />
      <Row label="Status" value={c.active ? 'Active' : 'Inactive'} />
      <TechnicalIds id={c.id} extra={`${c.tankId} → ${c.pumpId}`} />
    </>
  )
}

function TechnicalIds({ id, extra }: { id: string; extra?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <details
      className="mt-2 rounded border border-slate-800 px-2 py-1 text-[11px] text-slate-500"
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer text-slate-400">Technical details</summary>
      <div className="mt-1 break-all font-mono">
        <div>id: {id}</div>
        {extra ? <div>{extra}</div> : null}
      </div>
    </details>
  )
}

function Row({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="flex justify-between gap-2 text-xs">
      <span className="text-slate-500">{label}</span>
      <span className="text-right text-slate-200">{value || '—'}</span>
    </div>
  )
}
