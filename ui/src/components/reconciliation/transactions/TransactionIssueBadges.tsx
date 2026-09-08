import { getAnomalyLabel } from '../../../lib/anomalyPresentation'

export default function TransactionIssueBadges({
  flags,
  maxVisible = 2,
}: {
  flags: string[]
  maxVisible?: number
}) {
  if (!flags.length) {
    return <span className="text-slate-500">—</span>
  }
  const visible = flags.slice(0, maxVisible)
  const hidden = flags.slice(maxVisible)
  const hiddenLabels = hidden.map((flag) => getAnomalyLabel(flag)).join(', ')

  return (
    <div className="flex flex-nowrap items-center gap-1 min-w-0">
      {visible.map((flag) => (
        <span key={flag} className="badge-warn whitespace-nowrap">
          {getAnomalyLabel(flag)}
        </span>
      ))}
      {hidden.length ? (
        <span
          className="badge-info whitespace-nowrap"
          title={hiddenLabels}
          aria-label={`${hidden.length} more issues: ${hiddenLabels}`}
        >
          +{hidden.length}
        </span>
      ) : null}
    </div>
  )
}
