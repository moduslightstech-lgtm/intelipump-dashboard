import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { fmtLiters, fmtNaira, fmtTime } from '../../../../api/client'
import { pumpStatusColor } from '../../../../lib/pumpIdentity'
import { PUMP_NODE_HEIGHT, PUMP_NODE_WIDTH } from '../constants'
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
  const name = String(raw.name || node.label || '').trim()
  if (name && !/^pump-\d+$/i.test(name)) return name
  return String(node.label || 'Nozzle')
}

function PumpSchematicNode({ data, selected }: NodeProps) {
  const { node, dimmed, highlighted, unconnected, productMissing } = data as PumpNodeData
  const raw = node.raw || {}
  const status = displayPumpStatus(node.status)
  const color = pumpStatusColor(status)
  const name = nozzleTitle(node)
  const product = String(raw.product || node.product || '').trim()
  const showSale = status === 'DISPENSING' && (raw.lastTransactionAmount != null || raw.lastTransactionVolume != null)
  const label = `${name}, ${pumpStatusLabel(status)}`

  return (
    <div
      data-testid={`pump-node-${node.id}`}
      data-pump-mqtt={raw.sourceIdentifier || raw.mqttPumpId || raw.pumpCode || ''}
      tabIndex={0}
      role="button"
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') e.currentTarget.click()
      }}
      className={`relative rounded-lg border bg-slate-950 px-2 py-1.5 outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-cyan-400 ${
        selected || highlighted
          ? 'border-cyan-400 shadow-[inset_0_0_0_1px_rgba(34,211,238,0.75)]'
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
      <div className="mt-1 flex items-center gap-1.5 text-[10px] font-semibold" style={{ color }}>
        <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: color }} aria-hidden />
        {pumpStatusLabel(status)}
      </div>
      <div className="mt-0.5 text-[10px] text-slate-400">
        {productMissing || !product ? (
          <span className="text-amber-300">Product not mapped</span>
        ) : (
          product
        )}
      </div>
      {unconnected ? <div className="text-[10px] text-amber-300">Unconnected</div> : null}
      {showSale ? (
        <div className="text-[10px] text-emerald-300">
          {fmtNaira(raw.lastTransactionAmount)} · {fmtLiters(raw.lastTransactionVolume)}
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
