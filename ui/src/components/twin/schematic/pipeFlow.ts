import type { ActiveDispensingState } from '../pipe/pipeTypes'
import { pumpMatchesId } from '../../../lib/pumpIdentity'
import { displayPumpStatus } from './display'
import type { SchematicNode } from './types'

type FlowRoute = {
  id: string
  pumpId: string
  connection?: Record<string, any> | null
}

/** True while fuel is moving tank → pump. Idle / completed / hang-up stay still. */
export function isSchematicPipeFlowing(
  route: FlowRoute,
  pump: SchematicNode | undefined,
  activeByPump: Record<string, ActiveDispensingState> = {},
): boolean {
  if (displayPumpStatus(pump?.status) === 'DISPENSING') return true
  for (const state of Object.values(activeByPump)) {
    if (state.phase !== 'DISPENSING') continue
    if (
      state.connectionId &&
      (state.connectionId === route.id || state.connectionId === String(route.connection?.id || ''))
    ) {
      return true
    }
    const routeIds = {
      id: route.pumpId,
      mqttPumpId: route.connection?.mqttPumpId || route.connection?.mqtt_pump_id,
      pumpCode: route.connection?.pumpCode || route.connection?.pump_code,
    }
    if (pumpMatchesId(routeIds, state.pumpId)) return true
    if (
      pump &&
      pumpMatchesId(
        {
          id: pump.id,
          mqttPumpId: pump.raw?.mqttPumpId || pump.raw?.mqtt_pump_id,
          pumpCode: pump.raw?.pumpCode || pump.raw?.pump_code,
        },
        state.pumpId,
      )
    ) {
      return true
    }
  }
  return false
}
