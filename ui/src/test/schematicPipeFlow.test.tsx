import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { productPipeColor } from '../components/twin/pipe/pipeTheme'
import PipeEdge from '../components/twin/schematic/edges/PipeEdge'
import { displayPumpStatus } from '../components/twin/schematic/display'
import { isSchematicPipeFlowing } from '../components/twin/schematic/pipeFlow'
import type { SchematicNode } from '../components/twin/schematic/types'
import { pumpStatusColor } from '../lib/pumpIdentity'

function pump(status: string, extras: Partial<SchematicNode> = {}): SchematicNode {
  return {
    id: 'pump-uuid',
    kind: 'PUMP',
    x: 0,
    y: 0,
    w: 88,
    h: 96,
    label: 'Pump 2',
    status,
    product: 'PMS',
    raw: { id: 'pump-uuid', mqttPumpId: '2', pumpCode: 'P2' },
    ...extras,
  }
}

const route = {
  id: 'c2',
  pumpId: 'pump-uuid',
  connection: { id: 'c2', mqttPumpId: '2', pumpCode: 'P2' },
}

const dummyEdge = {
  id: 'c2',
  source: 't1',
  target: 'pump-uuid',
  sourceX: 0,
  sourceY: 0,
  targetX: 10,
  targetY: 40,
  sourcePosition: 'bottom' as const,
  targetPosition: 'top' as const,
}

describe('schematic pipe flow', () => {
  it('animates the tank-to-pump pipe while the pump is dispensing', () => {
    expect(isSchematicPipeFlowing(route, pump('DISPENSING'))).toBe(true)
    expect(isSchematicPipeFlowing(route, pump('IN_PROGRESS'))).toBe(true)
  })

  it('does not animate idle or completed pipes', () => {
    expect(isSchematicPipeFlowing(route, pump('IDLE'))).toBe(false)
    expect(isSchematicPipeFlowing(route, pump('COMPLETED'))).toBe(false)
    expect(displayPumpStatus('COMPLETED')).toBe('IDLE')
  })

  it('matches live dispensing by MQTT pump id', () => {
    expect(
      isSchematicPipeFlowing(route, pump('IDLE'), {
        '2': {
          transactionId: 'tx-1',
          pumpId: '2',
          tankId: 't1',
          finalVolume: 0.4,
          finalAmount: 470,
          currentVolume: 0.4,
          currentAmount: 470,
          phase: 'DISPENSING',
          startedAt: 0,
          durationMs: 1,
        },
      }),
    ).toBe(true)
  })

  it('keeps product pipe color distinct from pump status green', () => {
    expect(productPipeColor('PMS')).toBe('#2563eb')
    expect(productPipeColor('PMS')).not.toBe(pumpStatusColor('DISPENSING'))
  })

  it('renders flowing overlay only for the active pipe', () => {
    const { rerender, queryByTestId } = render(
      <svg>
        <PipeEdge
          {...dummyEdge}
          data={{ path: 'M 0 0 L 0 40', product: 'PMS', flowing: true }}
        />
      </svg>,
    )
    expect(queryByTestId('pipe-flow-c2')).toBeInTheDocument()
    expect(queryByTestId('pipe-edge-c2')?.getAttribute('data-pipe-flowing')).toBe('true')
    rerender(
      <svg>
        <PipeEdge
          {...dummyEdge}
          data={{ path: 'M 0 0 L 0 40', product: 'PMS', flowing: false }}
        />
      </svg>,
    )
    expect(queryByTestId('pipe-flow-c2')).not.toBeInTheDocument()
  })
})
