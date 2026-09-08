export function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}

/** Fill as a liquid level 0–100 from volume/capacity, with fillPercent fallback. */
export function tankFillPercent(tank: Record<string, any> | null | undefined): number {
  if (!tank) return 0
  const vol = Number(tank.reportedLiters ?? tank.currentVolume ?? tank.volumeLiters)
  const cap = Number(tank.capacityLiters ?? tank.capacity)
  if (Number.isFinite(vol) && Number.isFinite(cap) && cap > 0) {
    return clamp((vol / cap) * 100, 0, 100)
  }
  const fp = Number(tank.fillPercent)
  return Number.isFinite(fp) ? clamp(fp, 0, 100) : 0
}

/** Liquid column height inside a cylinder of innerHeight. */
export function liquidHeight(fillPercent: number, innerHeight: number): number {
  return (clamp(fillPercent, 0, 100) / 100) * innerHeight
}

export function tankLevelKind(
  fill: number,
  status?: string | null,
): 'NORMAL' | 'LOW' | 'CRITICAL' | 'EMPTY' {
  const s = (status || '').toUpperCase()
  if (s.includes('CRITICAL')) return 'CRITICAL'
  if (s.includes('LOW')) return 'LOW'
  if (fill <= 0) return 'EMPTY'
  if (fill <= 15) return 'CRITICAL'
  if (fill <= 30) return 'LOW'
  return 'NORMAL'
}
