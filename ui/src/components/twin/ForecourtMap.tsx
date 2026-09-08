import type { TwinLiveState } from '../../api/client'
import type { ActiveDispensingState } from './pipe/pipeTypes'
import ForecourtSchematic from './schematic/ForecourtSchematic'
import type { LayoutPersist, SchematicSelection } from './schematic/types'

export type ForecourtSelection = SchematicSelection

type Props = {
  state?: TwinLiveState
  activeByPump?: Record<string, ActiveDispensingState>
  activePumpId?: string | null
  activeTankId?: string | null
  activeConnectionId?: string | null
  phase?: 'idle' | 'pulse' | 'completed'
  flashTx?: {
    pumpId?: string
    amount?: number
    volumeLiters?: number
    product?: string
  } | null
  liveVolume?: number
  liveAmount?: number
  selection?: ForecourtSelection
  onSelect?: (sel: ForecourtSelection) => void
  restoredPumpIds?: string[]
  editMode?: boolean
  canEdit?: boolean
  includeInactive?: boolean
  viewportWidth?: number
  onDraftChange?: (draft: LayoutPersist, dirty: boolean) => void
}

export default function ForecourtMap({
  state,
  activeByPump,
  activePumpId,
  activeTankId,
  phase = 'idle',
  flashTx,
  liveVolume,
  liveAmount,
  selection = null,
  onSelect,
  editMode,
  canEdit,
  includeInactive,
  viewportWidth,
  onDraftChange,
}: Props) {
  const dispensing = { ...(activeByPump || {}) }
  if (!Object.keys(dispensing).length && activePumpId && phase === 'pulse') {
    dispensing[activePumpId] = {
      transactionId: 'legacy',
      pumpId: activePumpId,
      tankId: activeTankId || '',
      finalVolume: Number(flashTx?.volumeLiters || liveVolume || 0),
      finalAmount: Number(flashTx?.amount || liveAmount || 0),
      currentVolume: Number(liveVolume ?? flashTx?.volumeLiters ?? 0),
      currentAmount: Number(liveAmount ?? flashTx?.amount ?? 0),
      phase: 'DISPENSING',
      startedAt: 0,
      durationMs: 3000,
      product: flashTx?.product,
    }
  }

  return (
    <ForecourtSchematic
      state={state}
      activeByPump={dispensing}
      selection={selection}
      onSelect={onSelect}
      editMode={editMode}
      canEdit={canEdit}
      includeInactive={includeInactive}
      viewportWidth={viewportWidth}
      onDraftChange={onDraftChange}
    />
  )
}
