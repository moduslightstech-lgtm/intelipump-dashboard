type Props = {
  severity?: string | null
  className?: string
}

export default function SeverityPill({ severity, className = '' }: Props) {
  const s = (severity || 'INFO').toUpperCase()
  const styles =
    s === 'CRITICAL' || s === 'HIGH'
      ? 'bg-red-500/15 text-red-300 border-red-500/30'
      : s === 'WARNING' || s === 'MEDIUM'
        ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
        : s === 'OK' || s === 'RESOLVED' || s === 'LOW'
          ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
          : 'bg-sky-500/15 text-sky-300 border-sky-500/30'
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${styles} ${className}`}
    >
      {s}
    </span>
  )
}
