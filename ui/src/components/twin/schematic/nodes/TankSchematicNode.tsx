import { memo, useEffect, useState } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { fmtLiters } from '../../../../api/client'
import { TANK_HEADER_H, TANK_OUTLET_Y } from '../constants'
import { formatAge, isReadingStale, readingSourceLabel } from '../display'
import { tankFillPercent, tankLevelKind } from '../tankFill'
import type { SchematicNode } from '../types'
import CylindricalTank from './CylindricalTank'

export type TankNodeData = {
  node: SchematicNode
  dimmed?: boolean
  highlighted?: boolean
}

function TankSchematicNode({ data, selected }: NodeProps) {
  const { node, dimmed, highlighted } = data as TankNodeData
  const tank = node.raw || {}
  const fill = tankFillPercent(tank)
  const src = readingSourceLabel(tank)
  const missing = src === 'Missing' && tank.reportedLiters == null && tank.fillPercent == null
  const stale = isReadingStale(tank)
  const status = String(tank.inferredStatus || tank.status || 'UNKNOWN')
  const level = tankLevelKind(fill, status)
  const fault = status.includes('FAULT') || status.includes('SENSOR') || status.includes('ERROR')
  const label = `${node.label}, ${node.product || 'unmapped'}, ${Math.round(fill)} percent full, ${status}`
  const [reducedMotion, setReducedMotion] = useState(false)

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const apply = () => setReducedMotion(mq.matches)
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])

  return (
    <div
      data-testid={`tank-node-${node.id}`}
      data-fill-percent={fill.toFixed(1)}
      tabIndex={0}
      role="button"
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') e.currentTarget.click()
      }}
      className="box-border h-full w-full outline-none"
      style={{ opacity: dimmed ? 0.6 : 1 }}
    >
      <div
        className={`rounded-lg border bg-slate-950/90 px-2 pt-1 outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 ${
          selected || highlighted
            ? 'border-cyan-400 shadow-[0_0_0_2px_rgba(34,211,238,0.45)]'
            : 'border-slate-600'
        } ${tank.inactive ? 'saturate-50' : ''}`}
        style={{ height: TANK_OUTLET_Y }}
      >
        <div className="flex items-start justify-between gap-1" style={{ height: TANK_HEADER_H }}>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-1">
              <div className="truncate text-[12px] font-semibold text-white">{node.label}</div>
              <div className="shrink-0 text-[10px] text-slate-400">{node.product || '—'}</div>
            </div>
            <div className="flex max-h-[14px] flex-wrap gap-0.5 overflow-hidden">
              {level === 'LOW' ? <Badge tone="amber" text="Low level" /> : null}
              {level === 'CRITICAL' ? <Badge tone="red" text="Critically low" /> : null}
              {stale && !missing ? (
                <Badge
                  tone="amber"
                  text={`Reading stale${tank.measuredAt ? ` · ${formatAge(Date.now() - Date.parse(tank.measuredAt))}` : ''}`}
                />
              ) : null}
              {src === 'Estimated' ? <Badge tone="slate" text="Estimated" /> : null}
              {tank.inactive ? <Badge tone="slate" text="Inactive" /> : null}
              {missing ? <Badge tone="slate" text="No reading" /> : null}
              {fault ? <Badge tone="red" text="Sensor fault" /> : null}
            </div>
          </div>
          <span className="shrink-0 rounded border border-slate-700 px-1 py-0.5 text-[9px] uppercase text-slate-300">
            {src}
          </span>
        </div>
        <CylindricalTank
          tank={tank}
          product={node.product}
          inactive={Boolean(tank.inactive)}
          missing={missing}
          reducedMotion={reducedMotion}
        />
      </div>
      <div className="flex items-start justify-between gap-6 px-2 pt-1 text-[10px] text-slate-300">
        <span data-testid="tank-volume-label">
          {missing ? 'No reading' : `${fmtLiters(tank.reportedLiters)} / ${fmtLiters(tank.capacityLiters)}`}
        </span>
        <span>{missing ? '' : `${fill.toFixed(0)}% full`}</span>
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        id="out"
        style={{ top: TANK_OUTLET_Y, left: '50%', bottom: 'auto', transform: 'translate(-50%, -40%)' }}
        className="!h-2.5 !w-2.5 !border-slate-200 !bg-slate-100"
      />
    </div>
  )
}

function Badge({ tone, text }: { tone: 'amber' | 'red' | 'slate'; text: string }) {
  const cls =
    tone === 'red'
      ? 'border-red-800 text-red-200 bg-red-950/50'
      : tone === 'amber'
        ? 'border-amber-800 text-amber-200 bg-amber-950/40'
        : 'border-slate-600 text-slate-300 bg-slate-900'
  return <span className={`rounded border px-1 py-px text-[9px] ${cls}`}>{text}</span>
}

export default memo(TankSchematicNode)
