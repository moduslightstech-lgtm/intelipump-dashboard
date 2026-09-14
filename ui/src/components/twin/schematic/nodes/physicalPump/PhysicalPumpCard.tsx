/** Physical fuel dispenser card with two independent nozzle panels. */

import { memo, useMemo, useRef } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { pumpStatusColor } from '../../../../../lib/pumpIdentity'
import { PUMP_SUPPLY_HANDLE_ID } from '../../constants'
import { displayPumpStatus, pumpStatusLabel } from '../../display'
import { lcdViewFromNozzle } from '../../lcdDisplay'
import type { SchematicNode } from '../../types'
import NozzlePanel from './NozzlePanel'

export type PhysicalPumpCardData = {
  label: string
  dimmed?: boolean
  status?: string
  node?: SchematicNode
  nozzles?: SchematicNode[]
  highlighted?: boolean
  selectedNozzleId?: string | null
  highlightedNozzleIds?: string[]
  unconnectedIds?: string[]
  productMissingIds?: string[]
  warning?: boolean
  onSelectNozzle?: (nozzle: SchematicNode) => void
}

export type IslandNodeData = PhysicalPumpCardData

export function isNozzleDispensing(node: SchematicNode) {
  const view = lcdViewFromNozzle(node.raw || {}, node.status)
  return view.status === 'DISPENSING'
}

export function nozzleLiveSignature(node: SchematicNode) {
  const raw = node.raw || {}
  const view = lcdViewFromNozzle(raw, node.status)
  return [
    node.id,
    view.mode,
    view.status,
    view.amount,
    view.volume,
    raw.livePresentation,
    raw.liveAmount,
    raw.liveVolume,
    raw.livePricePerLitre,
    raw.liveSequence,
    raw.lastCompletedAmount,
    raw.lastCompletedVolume,
    raw.liveTransactionId,
  ].join(':')
}

export function nozzlePanelStableKey(node: SchematicNode, index: number): string {
  const raw = node.raw || {}
  const station = String(raw.stationId || raw.mqttStationId || '').trim()
  const pump = String(
    raw.parentPumpId || raw.pumpId || raw.mqttPumpId || raw.pumpCode || '',
  ).trim()
  const nozzle = String(
    raw.mqttNozzleId ||
      raw.nozzleCode ||
      (raw.nozzleNumber != null ? `nozzle-${raw.nozzleNumber}` : '') ||
      node.id ||
      `nozzle-${index + 1}`,
  ).trim()
  return [station, pump, nozzle].filter(Boolean).join('|') || node.id
}

function PhysicalPumpCard({ data, selected }: NodeProps) {
  const {
    label,
    dimmed,
    status,
    node,
    nozzles = [],
    highlighted,
    selectedNozzleId,
    highlightedNozzleIds = [],
    unconnectedIds = [],
    productMissingIds = [],
    warning,
    onSelectNozzle,
  } = data as PhysicalPumpCardData
  const selectRef = useRef(onSelectNozzle)
  selectRef.current = onSelectNozzle
  const shown = displayPumpStatus(status)
  const reducedMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const raw = node?.raw || {}
  const code = String(raw.pumpCode || raw.mqttPumpId || '').trim()
  const panelNozzles = useMemo(() => {
    const list = [...nozzles]
    while (list.length < 2) {
      list.push({
        id: `${node?.id || label}-placeholder-${list.length + 1}`,
        kind: 'PUMP',
        x: 0,
        y: 0,
        w: 0,
        h: 0,
        label: `Nozzle ${list.length + 1}`,
        status: 'INACTIVE',
        raw: { name: `Nozzle ${list.length + 1}`, product: '', livePresentation: 'INACTIVE' },
      })
    }
    return list.slice(0, 2)
  }, [nozzles, node?.id, label])
  const a11y = `${label}, ${pumpStatusLabel(shown)}, ${panelNozzles.length} nozzles`

  return (
    <div
      data-testid={`island-node-${label}`}
      data-physical-dispenser="true"
      data-physical-pump-card="true"
      data-live-state={shown || ''}
      role="group"
      aria-label={a11y}
      className="relative w-full overflow-visible"
      style={{ opacity: dimmed ? 0.65 : 1, margin: 0, height: 'auto' }}
    >
      <Handle
        type="target"
        position={Position.Top}
        id={PUMP_SUPPLY_HANDLE_ID}
        style={{ left: '50%', top: 0, transform: 'translate(-50%, -50%)' }}
        className="!h-2.5 !w-2.5 !border-slate-200 !bg-slate-100"
      />
      <div
        className={`relative mx-auto w-full rounded-[14px] border px-5 py-5 ${
          selected || highlighted
            ? 'border-cyan-400 shadow-[0_0_0_1px_rgba(34,211,238,0.55)]'
            : 'border-slate-500/70'
        }`}
        style={{
          background: '#0E1A2B',
          boxShadow: '0 10px 24px rgba(0,0,0,0.35)',
          maxWidth: 560,
        }}
        data-testid="physical-pump-cabinet"
      >
        <div className="mb-4 flex items-start justify-between gap-3" data-testid="physical-pump-heading">
          <div className="min-w-0">
            <div className="truncate text-[18px] font-bold text-white">{label}</div>
            {code && code.toLowerCase() !== label.toLowerCase() ? (
              <div className="truncate text-[12px] text-slate-400">{code}</div>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            {warning || Number(raw.activeAlertCount) > 0 ? (
              <span className="rounded bg-amber-900/80 px-1.5 py-0.5 text-[10px] font-semibold text-amber-200">
                Alert
              </span>
            ) : null}
            {shown && shown !== 'UNKNOWN' ? (
              <span
                className="text-[12px] font-semibold"
                style={{ color: pumpStatusColor(shown === 'SALE_COMPLETED' ? 'IDLE' : shown) }}
              >
                {pumpStatusLabel(shown)}
              </span>
            ) : null}
          </div>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {panelNozzles.map((n, i) => (
            <NozzlePanel
              key={nozzlePanelStableKey(n, i)}
              node={n}
              index={i}
              selected={selectedNozzleId === n.id}
              highlighted={highlightedNozzleIds.includes(n.id)}
              unconnected={unconnectedIds.includes(n.id)}
              productMissing={productMissingIds.includes(n.id)}
              reducedMotion={reducedMotion}
              onSelect={() => {
                if (String(n.status || '').toUpperCase() === 'INACTIVE' && !n.raw?.product) return
                selectRef.current?.(n)
              }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

export function islandPropsEqual(prev: NodeProps, next: NodeProps) {
  if (prev.selected !== next.selected) return false
  const a = prev.data as PhysicalPumpCardData
  const b = next.data as PhysicalPumpCardData
  if (a.label !== b.label || a.dimmed !== b.dimmed || a.status !== b.status || a.highlighted !== b.highlighted) {
    return false
  }
  if (a.selectedNozzleId !== b.selectedNozzleId || a.warning !== b.warning) return false
  const aNozzles = a.nozzles || []
  const bNozzles = b.nozzles || []
  if (aNozzles.length !== bNozzles.length) return false
  if (aNozzles.map(nozzleLiveSignature).join('|') !== bNozzles.map(nozzleLiveSignature).join('|')) return false
  if ((a.highlightedNozzleIds || []).join() !== (b.highlightedNozzleIds || []).join()) return false
  if ((a.unconnectedIds || []).join() !== (b.unconnectedIds || []).join()) return false
  if ((a.productMissingIds || []).join() !== (b.productMissingIds || []).join()) return false
  return true
}

export default memo(PhysicalPumpCard, islandPropsEqual)
