import { memo } from 'react'
import type { NodeProps } from '@xyflow/react'
import type { SchematicKind } from '../types'

export type MarkerNodeData = {
  kind: SchematicKind
  label: string
  dimmed?: boolean
}

function MarkerSchematicNode({ data, selected }: NodeProps) {
  const { kind, label, dimmed } = data as MarkerNodeData
  const isOffice = kind === 'OFFICE'
  return (
    <div
      data-testid={`marker-node-${kind.toLowerCase()}`}
      tabIndex={0}
      role="button"
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') e.currentTarget.click()
      }}
      className={`flex h-full w-full items-center justify-center rounded-md border px-2 text-center outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 ${
        isOffice
          ? 'border-slate-500 bg-slate-900 text-[12px] font-semibold text-slate-100'
          : 'border-slate-600 bg-slate-800 text-[10px] font-semibold uppercase tracking-wide text-slate-300'
      } ${selected ? 'border-cyan-400 shadow-[0_0_0_2px_rgba(34,211,238,0.4)]' : ''}`}
      style={{ opacity: dimmed ? 0.65 : 1 }}
    >
      {label}
    </div>
  )
}

export default memo(MarkerSchematicNode)
