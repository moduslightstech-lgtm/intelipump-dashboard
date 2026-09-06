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
}

export type ActiveDispensingState = {
  transactionId: string
  pumpId: string
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
