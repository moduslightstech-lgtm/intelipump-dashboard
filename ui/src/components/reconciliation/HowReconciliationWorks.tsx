export default function HowReconciliationWorks() {
  return (
    <details className="card py-3">
      <summary className="cursor-pointer text-sm text-slate-300 list-none flex items-center gap-2">
        <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-slate-500 text-xs">
          i
        </span>
        How reconciliation works
      </summary>
      <ol className="mt-3 text-sm text-slate-300 space-y-2 list-decimal list-inside">
        <li>Pump sales come from completed transactions.</li>
        <li>Reported sales represent money collected and determine financial short/over.</li>
        <li>Tank inventory requires valid opening and closing readings.</li>
      </ol>
    </details>
  )
}
