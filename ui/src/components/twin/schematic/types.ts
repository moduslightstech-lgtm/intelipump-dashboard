export type SchematicKind =
  | 'TANK'
  | 'PUMP'
  | 'ISLAND'
  | 'OFFICE'
  | 'ENTRANCE'
  | 'EXIT'
  | 'LABEL'
  | 'FORECOURT'

export type SchematicNode = {
  id: string
  kind: SchematicKind
  x: number
  y: number
  w: number
  h: number
  label: string
  status: string
  product?: string | null
  parentId?: string
  islandId?: string
  assetId?: string
  raw: Record<string, any>
}

export type ConnectionWarningCode =
  | 'UNCONNECTED_PUMP'
  | 'PRODUCT_NOT_MAPPED'
  | 'MISSING_REF'
  | 'DUAL_PRIMARY'
  | 'INACTIVE_CONNECTION'

export type ConnectionWarning = {
  code: ConnectionWarningCode
  message: string
  pumpId?: string
  tankId?: string
  connectionId?: string
}

export type ValidatedConnection = {
  id: string
  tankId: string
  pumpId: string
  tankName?: string
  pumpName?: string
  product?: string | null
  isPrimary: boolean
  active: boolean
  role: 'PRIMARY' | 'BACKUP' | 'INACTIVE'
  lineLabel?: string | null
  source: string
  raw: Record<string, any>
}

export type LayoutPersistItem = {
  asset_type: string
  asset_id: string | null
  label: string | null
  x_position: number
  y_position: number
  width: number
  height: number
  rotation: number
  z_index: number
  configuration_json: Record<string, unknown> | null
}

export type LayoutPersist = {
  name: string
  canvas_width: number
  canvas_height: number
  items: LayoutPersistItem[]
}

export type SchematicSelection =
  | { kind: 'TANK'; node: SchematicNode }
  | { kind: 'PUMP'; node: SchematicNode }
  | { kind: 'ISLAND'; node: SchematicNode }
  | { kind: 'PIPE'; routeId: string }
  | { kind: 'OFFICE' | 'ENTRANCE' | 'EXIT'; node: SchematicNode }
  | null
