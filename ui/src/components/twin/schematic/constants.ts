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

/** Authoritative pump card size — used by CSS, React Flow, and auto-layout. */
export const PUMP_NODE_WIDTH = 196
export const PUMP_NODE_HEIGHT = 136
export const PUMP_W = PUMP_NODE_WIDTH
export const PUMP_H = PUMP_NODE_HEIGHT
export const PUMPS_PER_ISLAND = 2
/** Visible gap between independent pump cards (borders must not touch). */
export const PUMP_HORIZONTAL_GAP = 40
export const PUMP_INNER_GAP = PUMP_HORIZONTAL_GAP
export const PUMP_VERTICAL_GAP = 80
export const ISLAND_PAD_X = 20
export const ISLAND_PAD_Y = 36
export const ISLAND_PAD_BOTTOM = 16
export const ISLAND_W = ISLAND_PAD_X * 2 + PUMP_NODE_WIDTH * 2 + PUMP_HORIZONTAL_GAP
export const ISLAND_H = ISLAND_PAD_Y + PUMP_NODE_HEIGHT + ISLAND_PAD_BOTTOM
export const ISLAND_GAP_X = 64
export const ISLAND_GAP_Y = PUMP_VERTICAL_GAP

export const OFFICE_W = 148
export const OFFICE_H = 72
export const OFFICE_CLEARANCE = 48
export const MARKER_W = 96
export const MARKER_H = 28

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
    w: ISLAND_PAD_X * 2 + metrics.pumpW * 2 + PUMP_HORIZONTAL_GAP,
    h: ISLAND_PAD_Y + metrics.pumpH + ISLAND_PAD_BOTTOM,
  }
}
