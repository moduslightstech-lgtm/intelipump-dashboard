import { displayPumpStatus, pumpStatusLabel } from './display'
import type { SchematicNode, SchematicSelection } from './types'

type Props = {
  nodes: SchematicNode[]
  selection: SchematicSelection
  onSelect: (sel: SchematicSelection) => void
}

export default function MobileSchematicList({ nodes, selection, onSelect }: Props) {
  const tanks = nodes.filter((n) => n.kind === 'TANK')
  const pumps = nodes.filter((n) => n.kind === 'PUMP')
  return (
    <div className="space-y-3 md:hidden" data-testid="schematic-mobile-list">
      <p className="text-xs text-slate-400">
        Simplified list on small screens. Select a tank or pump to inspect its path.
      </p>
      <div>
        <h3 className="mb-1 text-xs font-semibold uppercase text-slate-500">Tanks</h3>
        <ul className="space-y-1">
          {tanks.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                className={`w-full rounded-lg border px-3 py-2 text-left text-sm ${
                  selection?.kind === 'TANK' && selection.node.id === n.id
                    ? 'border-sky-500 bg-slate-800'
                    : 'border-slate-800 bg-slate-900'
                }`}
                onClick={() => onSelect({ kind: 'TANK', node: n })}
              >
                {n.label} · {n.product || '—'}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h3 className="mb-1 text-xs font-semibold uppercase text-slate-500">Pumps</h3>
        <ul className="space-y-1">
          {pumps.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                className={`w-full rounded-lg border px-3 py-2 text-left text-sm ${
                  selection?.kind === 'PUMP' && selection.node.id === n.id
                    ? 'border-sky-500 bg-slate-800'
                    : 'border-slate-800 bg-slate-900'
                }`}
                onClick={() => onSelect({ kind: 'PUMP', node: n })}
              >
                {n.label} · {pumpStatusLabel(displayPumpStatus(n.status))}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
