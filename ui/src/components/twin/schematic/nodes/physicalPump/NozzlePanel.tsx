/** Independent nozzle column inside a physical pump card. */

import { displayPumpStatus } from '../../display'
import { lcdViewFromNozzle, hasMeaningfulSale } from '../../lcdDisplay'
import { friendlyNozzleName } from '../../physicalPump'
import type { SchematicNode } from '../../types'
import NozzleStatus, { nozzleStatusColor } from './NozzleStatus'
import SaleValueDisplay from './SaleValueDisplay'

export type NozzlePanelProps = {
  node: SchematicNode
  index: number
  selected?: boolean
  highlighted?: boolean
  unconnected?: boolean
  productMissing?: boolean
  reducedMotion?: boolean
  onSelect?: () => void
}

export function nozzlePanelView(node: SchematicNode) {
  const raw = node.raw || {}
  const view = lcdViewFromNozzle(raw, node.status)
  const price =
    view.status === 'DISPENSING'
      ? Number(raw.livePricePerLitre ?? raw.livePricePerLiter ?? raw.pricePerLitre ?? raw.pricePerLiter)
      : null
  return {
    ...view,
    pricePerLitre: Number.isFinite(price) && (price as number) > 0 ? (price as number) : null,
    product: String(raw.product || node.product || '').trim(),
    equipmentStatus: displayPumpStatus(
      String(raw.inferredStatus || raw.equipmentStatus || view.status || node.status || ''),
    ),
  }
}

function saleLabel(mode: string): string {
  if (mode === 'THIS SALE') return 'THIS SALE'
  if (mode === 'SALE COMPLETE') return 'SALE COMPLETED'
  return 'LAST SALE'
}

export function NozzlePanel({
  node,
  index,
  selected,
  highlighted,
  unconnected,
  productMissing,
  reducedMotion = false,
  onSelect,
}: NozzlePanelProps) {
  const raw = node.raw || {}
  const view = nozzlePanelView(node)
  const name = friendlyNozzleName({ ...raw, name: raw.name || node.label }, index)
  const dispensing = view.status === 'DISPENSING'
  const completed = view.status === 'SALE_COMPLETED'
  const inactive = view.status === 'INACTIVE' || view.equipmentStatus === 'INACTIVE'
  const borderColor = dispensing || completed ? '#22C55E' : 'rgba(100, 116, 139, 0.55)'
  const tint =
    dispensing || completed
      ? 'rgba(34, 197, 94, 0.08)'
      : 'transparent'
  const amountLabel = hasMeaningfulSale(view.amount, view.volume)
    ? `${view.amount ?? 0} naira, ${view.volume ?? 0} litres`
    : 'no completed sale'
  const a11y = `${name}, ${view.product || 'unmapped product'}, ${view.status}, ${amountLabel}`

  return (
    <section
      data-testid={`nozzle-panel-${node.id}`}
      data-live-state={view.status}
      data-sale-label={saleLabel(view.mode)}
      tabIndex={0}
      role="button"
      aria-label={a11y}
      onClick={(e) => {
        e.stopPropagation()
        onSelect?.()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          e.stopPropagation()
          onSelect?.()
        }
      }}
      className={`flex min-h-[200px] min-w-0 flex-1 flex-col rounded-[10px] border px-3 py-3 outline-none transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400 ${
        selected || highlighted ? 'ring-1 ring-cyan-400' : ''
      } ${inactive ? 'opacity-60' : ''}`}
      style={{
        background: `#0B1726 linear-gradient(180deg, ${tint}, transparent 48%)`,
        borderColor,
        boxShadow: dispensing || completed ? `0 0 0 1px ${nozzleStatusColor(view.status)}33` : undefined,
      }}
    >
      <div className="text-[14px] font-semibold uppercase tracking-wide text-slate-200">{name}</div>
      <div className="mt-0.5 text-[14px] text-white">
        {productMissing || !view.product ? (
          <span className="text-amber-300">Product not mapped</span>
        ) : (
          view.product
        )}
      </div>
      <NozzleStatus status={view.status} reducedMotion={reducedMotion} />
      {unconnected ? <div className="mt-1 text-[12px] text-amber-300">Unconnected</div> : null}
      <div className="my-3 h-px w-full bg-slate-600/70" aria-hidden />
      <SaleValueDisplay
        label={saleLabel(view.mode)}
        amount={view.amount}
        volume={view.volume}
        pricePerLitre={view.pricePerLitre}
        showPrice={dispensing}
        emptyMessage={view.mode === 'THIS SALE' ? 'Waiting for live totals' : 'No completed sale'}
      />
    </section>
  )
}

export default NozzlePanel
