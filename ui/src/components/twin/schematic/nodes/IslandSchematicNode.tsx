import { memo } from 'react'
import type { NodeProps } from '@xyflow/react'

export type IslandNodeData = {
  label: string
  dimmed?: boolean
  status?: string
}

function IslandSchematicNode({ data }: NodeProps) {
  const { label, dimmed } = data as IslandNodeData
  return (
    <div
      data-testid={`island-node-${label}`}
      className="h-full w-full overflow-visible rounded-xl border border-slate-600/70 bg-slate-900/25"
      style={{ opacity: dimmed ? 0.65 : 1, margin: 0, pointerEvents: 'none' }}
    >
      <div
        className="pointer-events-auto cursor-pointer px-3 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-300"
        data-testid="physical-pump-heading"
      >
        {label}
      </div>
    </div>
  )
}

export default memo(IslandSchematicNode)
