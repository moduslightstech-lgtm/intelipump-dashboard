export type Rect = { x: number; y: number; w: number; h: number }

export function inflate(r: Rect, pad: number): Rect {
  return { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 }
}

export function rectsOverlap(a: Rect, b: Rect, gap = 0): boolean {
  return !(
    a.x + a.w + gap <= b.x ||
    b.x + b.w + gap <= a.x ||
    a.y + a.h + gap <= b.y ||
    b.y + b.h + gap <= a.y
  )
}

export function assertNoNodeOverlap(nodes: Rect[], gap = 0): boolean {
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (rectsOverlap(nodes[i], nodes[j], gap)) return false
    }
  }
  return true
}

export function snapToGrid(value: number, grid = 8): number {
  return Math.round(value / grid) * grid
}

/** Horizontal or vertical segment vs AABB. */
export function segmentHitsRect(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  r: Rect,
): boolean {
  const minX = Math.min(x1, x2)
  const maxX = Math.max(x1, x2)
  const minY = Math.min(y1, y2)
  const maxY = Math.max(y1, y2)
  return !(maxX < r.x || minX > r.x + r.w || maxY < r.y || minY > r.y + r.h)
}

export type PolyPoint = { x: number; y: number }

/** Parse M/L/Q path into polyline vertices (Q control treated as corner). */
export function pathToPoints(d: string): PolyPoint[] {
  const tokens = d.match(/[MLQ][^MLQ]*/g) || []
  const pts: PolyPoint[] = []
  for (const token of tokens) {
    const cmd = token[0]
    const nums = token
      .slice(1)
      .trim()
      .split(/[\s,]+/)
      .map(Number)
      .filter((n) => Number.isFinite(n))
    if (cmd === 'M' || cmd === 'L') {
      for (let i = 0; i + 1 < nums.length; i += 2) pts.push({ x: nums[i], y: nums[i + 1] })
    } else if (cmd === 'Q') {
      // skip control point, keep destination
      if (nums.length >= 4) pts.push({ x: nums[2], y: nums[3] })
    }
  }
  return pts
}

export function pathHitsUnrelatedNodes(
  d: string,
  obstacles: Rect[],
): boolean {
  const pts = pathToPoints(d)
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    if (obstacles.some((r) => segmentHitsRect(a.x, a.y, b.x, b.y, r))) return true
  }
  return false
}
