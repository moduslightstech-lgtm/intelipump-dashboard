/** Shared schematic metrics — keep in sync with backend auto_layout.py */

export const MARGIN = 48
export const TITLE_Y = 16
export const TANK_BAND_Y = 48

export const TANK_W = 228
export const TANK_HEADER_H = 32
export const TANK_CYLINDER_H = 78
export const TANK_FOOTER_H = 38
export const TANK_H = TANK_HEADER_H + TANK_CYLINDER_H + TANK_FOOTER_H
export const TANK_GAP = 28
export const TANK_OUTLET_Y = TANK_HEADER_H + TANK_CYLINDER_H
export const TANK_INNER_X = 14
export const TANK_INNER_Y = 8
export const TANK_INNER_W = 172
export const TANK_INNER_H = 62

/** Authoritative physical dispenser size — CSS, React Flow, and auto-layout. */
export const DISPENSER_WIDTH = 520
/** Content-fitted card height (two nozzle panels). Measured layout may grow. */
export const DISPENSER_HEIGHT = 320
/** @deprecated Hoses removed; kept at 0 so layout math stays stable. */
export const HOSE_OVERHANG = 0
export const DISPENSER_HEADER_H = 36
export const PIPE_PORT_SIZE = 18
export const LCD_EXTRA_ROW_H = 0
export const LAYOUT_SCHEMA_VERSION = 4

/** Single tank→physical-pump supply handle (not per-nozzle). */
export const PUMP_SUPPLY_HANDLE_ID = 'in:supply'

export function physicalPumpNodeId(physicalPumpId: string): string {
  return `shell-${physicalPumpId}`
}

export function physicalPumpIdAliases(
  physicalPumpId: string,
  stationId?: string | null,
): string[] {
  const id = String(physicalPumpId || '').trim()
  if (!id) return []
  const station = String(stationId || '').trim()
  return [
    physicalPumpNodeId(id),
    id,
    station ? `pump:${station}:${id}` : '',
    `island-${id}`,
  ].filter(Boolean)
}
export const PUMP_NODE_WIDTH = DISPENSER_WIDTH
export const PUMP_NODE_HEIGHT = DISPENSER_HEIGHT
export const PUMP_W = PUMP_NODE_WIDTH
export const PUMP_H = PUMP_NODE_HEIGHT
export const PUMPS_PER_ISLAND = 2
/** Visible gap between independent physical pump cabinets. */
export const PUMP_HORIZONTAL_GAP = 64
export const PUMP_INNER_GAP = 40
export const PUMP_VERTICAL_GAP = 100
export const ISLAND_PAD_X = HOSE_OVERHANG
export const ISLAND_PAD_Y = DISPENSER_HEADER_H
export const ISLAND_PAD_BOTTOM = 12
export const ISLAND_W = HOSE_OVERHANG * 2 + DISPENSER_WIDTH
export const ISLAND_H = DISPENSER_HEIGHT
export const ISLAND_GAP_X = 64
export const ISLAND_GAP_Y = PUMP_VERTICAL_GAP

export const OFFICE_W = 148
export const OFFICE_H = 72
export const OFFICE_CLEARANCE = 48
export const MARKER_W = 96
export const MARKER_H = 28

/** Decorative site markers — never rendered on the tank/pump schematic. */
export const DECORATIVE_LAYOUT_KINDS = ['OFFICE', 'ENTRANCE', 'EXIT'] as const
export type DecorativeLayoutKind = (typeof DECORATIVE_LAYOUT_KINDS)[number]

export const DECORATIVE_LAYOUT_IDS = new Set([
  'office',
  'entrance',
  'exit',
  'control-room',
  'control_room',
  'controlroom',
])

export const DECORATIVE_LAYOUT_LABELS = new Set([
  'control room',
  'entrance',
  'exit',
  'office',
])

export const MIN_NODE_GAP = PUMP_HORIZONTAL_GAP
export const LANE_GAP = 20
export const PIPE_BAND_BASE = 80
export const PIPE_CLEARANCE = 24
export const GRID_SIZE = 8
export const MIN_ZOOM = 0.45
export const MAX_ZOOM = 1.75

export const MIN_CANVAS_W = 640
export const MIN_CANVAS_H = 340
export const MAX_CANVAS_H = 1100

export const READING_STALE_MS = 36 * 60 * 60 * 1000
export const DIM_OPACITY = 0.6

export const PMS_LIQUID = {
  base: '#D99A24',
  highlight: '#F4C45E',
  dark: '#A86412',
} as const

export type LayoutMetrics = {
  pumpW: number
  pumpH: number
  tankW: number
  tankH: number
}

export const DEFAULT_METRICS: LayoutMetrics = {
  pumpW: PUMP_NODE_WIDTH,
  pumpH: PUMP_NODE_HEIGHT,
  tankW: TANK_W,
  tankH: TANK_H,
}

export function islandSize(metrics: LayoutMetrics = DEFAULT_METRICS) {
  return {
    w: HOSE_OVERHANG * 2 + metrics.pumpW,
    h: metrics.pumpH,
  }
}

export function nozzleHandleId(nozzleId: string): string {
  return `in:${nozzleId}`
}
