/**
 * Forecourt pump grid — 4 columns max, centered rows, deterministic spacing.
 * Used by AUTO layout and CUSTOM missing-pump staging.
 */

export const PUMP_CARD_W = 100
export const PUMP_CARD_H = 108
export const PUMP_MAX_COLS = 4
export const PUMP_H_GAP = 28
export const PUMP_V_GAP = 40
export const MANIFOLD_ZONE_H = 56
export const TANK_TO_MANIFOLD_GAP = 24

export type GridBounds = {
  left: number
  top: number
  width: number
  height: number
}

export type GridRect = {
  x: number
  y: number
  w: number
  h: number
}

export function groupPumpsIntoRows<T>(pumps: T[], maxColumns = PUMP_MAX_COLS): T[][] {
  if (!pumps.length) return []
  const rows: T[][] = []
  for (let i = 0; i < pumps.length; i += maxColumns) {
    rows.push(pumps.slice(i, i + maxColumns))
  }
  return rows
}

/** Full 4-column row footprint width (for centering incomplete rows). */
export function fullRowWidth(maxColumns = PUMP_MAX_COLS, cardW = PUMP_CARD_W, gap = PUMP_H_GAP): number {
  return maxColumns * cardW + (maxColumns - 1) * gap
}

/**
 * X positions for cards in a row, centered within the 4-column footprint
 * (so 1–3 pumps sit in the middle, not left-aligned awkwardly).
 */
export function computeRowCenteredXPositions(
  countInRow: number,
  bounds: GridBounds,
  maxColumns = PUMP_MAX_COLS,
  cardW = PUMP_CARD_W,
  gap = PUMP_H_GAP,
): number[] {
  if (countInRow <= 0) return []
  const footprint = fullRowWidth(maxColumns, cardW, gap)
  const rowWidth = countInRow * cardW + Math.max(0, countInRow - 1) * gap
  const startFull = bounds.left + Math.max(0, (bounds.width - footprint) / 2)
  const startX = startFull + Math.max(0, (footprint - rowWidth) / 2)
  return Array.from({ length: countInRow }, (_, i) => startX + i * (cardW + gap))
}

export function computePumpYPositions(
  rowIndex: number,
  pumpZoneTop: number,
  cardH = PUMP_CARD_H,
  vGap = PUMP_V_GAP,
): number {
  return pumpZoneTop + rowIndex * (cardH + vGap)
}

export function computePipeManifoldY(tankBottom: number, pumpZoneTop: number, index = 0, step = 18): number {
  const zoneTop = tankBottom + TANK_TO_MANIFOLD_GAP
  const zoneBottom = pumpZoneTop - 12
  const mid = (zoneTop + zoneBottom) / 2
  const y = mid + index * step
  return Math.min(zoneBottom - 4, Math.max(zoneTop + 4, y))
}

export function computePumpZoneTop(tankBottom: number): number {
  return tankBottom + TANK_TO_MANIFOLD_GAP + MANIFOLD_ZONE_H
}

/** Sort pumps for stable display order. */
export function sortPumpsForLayout<T extends Record<string, any>>(pumps: T[]): T[] {
  return [...pumps].sort((a, b) => {
    const ao = Number(a.displayOrder ?? a.display_order ?? a.pumpNumber ?? a.pump_number ?? 9999)
    const bo = Number(b.displayOrder ?? b.display_order ?? b.pumpNumber ?? b.pump_number ?? 9999)
    if (ao !== bo) return ao - bo
    const ac = String(a.mqttPumpId || a.mqtt_pump_id || a.pumpCode || a.pump_code || a.id)
    const bc = String(b.mqttPumpId || b.mqtt_pump_id || b.pumpCode || b.pump_code || b.id)
    return ac.localeCompare(bc)
  })
}

export function computePumpGridLayout<T extends Record<string, any>>(
  pumps: T[],
  bounds: GridBounds,
  opts?: { maxColumns?: number; cardW?: number; cardH?: number; hGap?: number; vGap?: number },
): Array<GridRect & { pump: T; row: number; col: number }> {
  const maxColumns = opts?.maxColumns ?? PUMP_MAX_COLS
  const cardW = opts?.cardW ?? PUMP_CARD_W
  const cardH = opts?.cardH ?? PUMP_CARD_H
  const hGap = opts?.hGap ?? PUMP_H_GAP
  const vGap = opts?.vGap ?? PUMP_V_GAP
  const ordered = sortPumpsForLayout(pumps)
  const rows = groupPumpsIntoRows(ordered, maxColumns)
  const out: Array<GridRect & { pump: T; row: number; col: number }> = []

  rows.forEach((rowItems, rowIndex) => {
    const xs = computeRowCenteredXPositions(rowItems.length, bounds, maxColumns, cardW, hGap)
    const y = computePumpYPositions(rowIndex, bounds.top, cardH, vGap)
    rowItems.forEach((pump, col) => {
      out.push({
        pump,
        row: rowIndex,
        col,
        x: xs[col],
        y,
        w: cardW,
        h: cardH,
      })
    })
  })
  return out
}

function rectsOverlap(a: GridRect, b: GridRect, pad = 8): boolean {
  return !(
    a.x + a.w + pad <= b.x ||
    b.x + b.w + pad <= a.x ||
    a.y + a.h + pad <= b.y ||
    b.y + b.h + pad <= a.y
  )
}

/**
 * Next free grid slot for a newly added pump in CUSTOM mode.
 * Walks the 4-col grid in display order and skips occupied cells.
 */
export function findNextFreePumpSlots(
  count: number,
  occupied: GridRect[],
  bounds: GridBounds,
): GridRect[] {
  const slots: GridRect[] = []
  // Precompute enough rows for up to 20 pumps
  const fake = Array.from({ length: 20 }, (_, i) => ({ id: `slot-${i}`, displayOrder: i }))
  const all = computePumpGridLayout(fake, bounds)
  for (const cell of all) {
    if (slots.length >= count) break
    const candidate = { x: cell.x, y: cell.y, w: cell.w, h: cell.h }
    const blocked =
      occupied.some((o) => rectsOverlap(o, candidate)) ||
      slots.some((o) => rectsOverlap(o, candidate))
    if (!blocked) slots.push(candidate)
  }
  // Fallback: stack below occupied with clear offset if grid exhausted
  while (slots.length < count) {
    const last = slots[slots.length - 1] || occupied[occupied.length - 1]
    const y = (last?.y ?? bounds.top) + PUMP_CARD_H + PUMP_V_GAP
    const xs = computeRowCenteredXPositions(1, bounds)
    slots.push({ x: xs[0], y, w: PUMP_CARD_W, h: PUMP_CARD_H })
  }
  return slots
}

export function assertNoPumpOverlaps(rects: GridRect[]): boolean {
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      if (rectsOverlap(rects[i], rects[j], 0)) return false
    }
  }
  return true
}
