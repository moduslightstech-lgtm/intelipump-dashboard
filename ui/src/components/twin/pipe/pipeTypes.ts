export type Point = {
  x: number
  y: number
}

export type Rect = {
  x: number
  y: number
  width: number
  height: number
}

export type PipeStatus = 'IDLE' | 'ACTIVE' | 'WARNING' | 'FAULT'

export type PipeSegmentType = 'TANK_TRUNK' | 'NOZZLE_BRANCH' | 'PUMP_SUPPLY'

export type PipeRoute = {
  id: string
  tankId: string
  pumpId: string
  product: string
  path: string
  source: Point
  target: Point
  manifoldY: number
  status: PipeStatus
  connection: Record<string, unknown>
  lineLabel?: string | null
  mappingSource: string
  segmentType?: PipeSegmentType
  stationId?: string
  nozzleId?: string
  connectionId?: string
  physicalPumpId?: string
  nozzleIds?: string[]
  connectionIds?: string[]
  active?: boolean
  primary?: boolean
  targetNodeId?: string
}

export type PipeTrunkSegment = {
  id: string
  tankId: string
  product: string
  y: number
  path: string
  stationId?: string
  segmentType: 'TANK_TRUNK'
  nozzleIds: string[]
  connectionIds: string[]
  source: Point
  target: Point
  split: Point
  targetNodeId: string
  active: boolean
}

export type ActiveDispensingState = {
  transactionId: string
  pumpId: string
  nozzleId?: string
  stationId?: string
  tankId: string
  finalVolume: number
  finalAmount: number
  currentVolume: number
  currentAmount: number
  phase: 'DISPENSING' | 'COMPLETED'
  startedAt: number
  durationMs: number
  product?: string
  connectionId?: string
  mappingWarning?: string
}

export type LayoutNodeBox = {
  id?: string
  x: number
  y: number
  w: number
  h: number
  product?: string | null
  raw?: Record<string, any>
}
