import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { fmtLiters, fmtNaira, fmtTime } from '../../../../api/client'
import { pumpStatusColor } from '../../../../lib/pumpIdentity'
import { PUMP_NODE_HEIGHT, PUMP_NODE_WIDTH } from '../constants'
import { friendlyNozzleName } from '../physicalPump'
import { displayPumpStatus, pumpStatusLabel } from '../display'
import type { SchematicNode } from '../types'

export type PumpNodeData = {
  node: SchematicNode
  dimmed?: boolean
  highlighted?: boolean
  unconnected?: boolean
  productMissing?: boolean
}

function nozzleTitle(node: SchematicNode) {
  const raw = node.raw || {}
  const index = Math.max(0, Number(raw.nozzleNumber ?? raw.displayOrder ?? 1) - 1)
  return friendlyNozzleName({ ...raw, name: raw.name || node.label }, Number.isFinite(index) ? index : 0)
}

function PumpSchematicNode({ data, selected }: NodeProps) {
  const { node, dimmed, highlighted, unconnected, productMissing } = data as PumpNodeData
  const raw = node.raw || {}
  const presentation = String(raw.livePresentation || displayPumpStatus(node.status) || 'IDLE')
  const status = presentation === 'SALE_COMPLETED' ? 'SALE_COMPLETED' : displayPumpStatus(presentation)
  const color = pumpStatusColor(status === 'SALE_COMPLETED' ? 'IDLE' : status)
  const name = nozzleTitle(node)
  const product = String(raw.product || node.product || '').trim()
  const amount = raw.lastTransactionAmount
  const volume = raw.lastTransactionVolume
  const hasTotals = amount != null || volume != null
  const dispensing = status === 'DISPENSING'
  const completed = status === 'SALE_COMPLETED'
  const lastSale = !dispensing && !completed && hasTotals
  const elapsed =
    dispensing && raw.startedAt
      ? Math.max(0, Date.now() - Date.parse(String(raw.startedAt)))
      : null
  const elapsedLabel =
    elapsed != null && Number.isFinite(elapsed)
      ? elapsed >= 60_000
        ? `${Math.floor(elapsed / 60_000)}m`
        : `${Math.max(1, Math.floor(elapsed / 1000))}s`
      : null
  const label = `${name}, ${completed ? 'Sale completed' : pumpStatusLabel(status)}`

  return (
    <div
      data-testid={`pump-node-${node.id}`}
      data-pump-mqtt={raw.sourceIdentifier || raw.mqttPumpId || raw.pumpCode || ''}
      data-live-state={status}
      tabIndex={0}
      role="button"
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') e.currentTarget.click()
      }}
      className={`relative rounded-lg border bg-slate-950 px-2 py-1.5 outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-cyan-400 ${
        selected || highlighted
          ? 'border-cyan-400 shadow-[inset_0_0_0_1px_rgba(34,211,238,0.75)]'
          : dispensing
            ? 'border-emerald-400/80 nozzle-dispensing-pulse'
            : completed
              ? 'border-emerald-700'
              : 'border-slate-600'
      }`}
      style={{
        boxSizing: 'border-box',
        width: PUMP_NODE_WIDTH,
        minWidth: PUMP_NODE_WIDTH,
        height: node.h || PUMP_NODE_HEIGHT,
        margin: 0,
        opacity: dimmed ? 0.6 : 1,
      }}
    >
      <Handle
        type="target"
        position={Position.Top}
        id="in"
        style={{ left: '50%', top: 0, transform: 'translate(-50%, -50%)' }}
        className="!h-2.5 !w-2.5 !border-slate-200 !bg-slate-100"
      />
      <div className="flex items-start justify-between gap-1">
        <div className="min-w-0">
          <div className="truncate text-[12px] font-semibold text-white">{name}</div>
        </div>
        {Number(raw.activeAlertCount) > 0 ? (
          <span className="rounded bg-amber-900/80 px-1 text-[9px] font-semibold text-amber-200">Alert</span>
        ) : null}
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-[10px] font-semibold" style={{ color: completed ? '#86efac' : color }}>
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full ${dispensing ? 'nozzle-status-dot' : ''}`}
          style={{ background: completed ? '#86efac' : color }}
          aria-hidden
        />
        {completed ? 'Sale completed' : pumpStatusLabel(status)}
      </div>
      <div className="mt-0.5 text-[10px] text-slate-400">
        {productMissing || !product ? (
          <span className="text-amber-300">Product not mapped</span>
        ) : (
          product
        )}
      </div>
      {unconnected ? <div className="text-[10px] text-amber-300">Unconnected</div> : null}
      {raw.mappingWarning ? <div className="text-[10px] text-amber-300">Mapping warning</div> : null}
      {dispensing && hasTotals ? (
        <div className="text-[10px] text-emerald-300">
          {fmtNaira(amount)} · {fmtLiters(volume)}
          {elapsedLabel ? <span className="text-slate-500"> · {elapsedLabel}</span> : null}
        </div>
      ) : completed && hasTotals ? (
        <div className="text-[10px] text-emerald-200">
          {fmtNaira(amount)} · {fmtLiters(volume)}
          {raw.lastTransactionAt ? <div className="text-slate-500">Completed {fmtTime(raw.lastTransactionAt)}</div> : null}
        </div>
      ) : lastSale ? (
        <div className="text-[10px] text-slate-400">
          Last sale {fmtNaira(amount)} · {fmtLiters(volume)}
        </div>
      ) : raw.lastTransactionAt ? (
        <div className="text-[10px] text-slate-500">Last {fmtTime(raw.lastTransactionAt)}</div>
      ) : (
        <div className="text-[10px] text-slate-600">No recent activity</div>
      )}
    </div>
  )
}

export default memo(PumpSchematicNode)
