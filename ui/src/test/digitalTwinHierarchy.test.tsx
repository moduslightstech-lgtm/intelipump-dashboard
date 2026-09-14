import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TwinLiveState } from '../api/client'
import PumpCard from '../components/twin/PumpCard'
import { schematicViewportHeight } from '../components/twin/schematic/autoLayout'
import { aggregatePhysicalPumpStatus, friendlyNozzleName } from '../components/twin/schematic/physicalPump'

vi.mock('../hooks/useDeviceStatus', () => ({
  useStationEdgeDevices: () => ({
    hasMapping: false,
    primary: null,
    isError: false,
    isLoading: false,
  }),
}))

vi.mock('../hooks/useStationLiveSales', () => ({
  useStationLiveSales: () => ({
    summary: null,
    pumpLiveState: {},
    sales: [],
    streamStatus: 'IDLE',
    restError: null,
  }),
}))

vi.mock('../components/twin/ForecourtMap', () => ({
  default: () => (
    <div data-testid="forecourt-map">
      <span>Tank and pump schematic</span>
      <span>Pump 1 · Nozzle 1</span>
      <span>Pump 1 · Nozzle 2</span>
    </div>
  ),
}))

const onePumpTwoNozzles: TwinLiveState = {
  station: {
    name: 'US Lab',
    stationCode: 'US-LAB-001',
    mqttStationId: 'InteliPump-US-Lab',
    operationalStatus: 'OPEN',
    connectivityStatus: 'ONLINE',
  },
  layout: { mode: 'AUTO', items: [] },
  tanks: [
    {
      id: 't1',
      name: 'PMS',
      tankCode: 'T1',
      product: 'PMS',
      connectedPumpCount: 1,
      connectedNozzleCount: 2,
      connections: [
        { label: 'Pump 1 · Nozzle 1', pumpId: 'p1', nozzleId: 'n1' },
        { label: 'Pump 1 · Nozzle 2', pumpId: 'p1', nozzleId: 'n2' },
      ],
    },
  ],
  pumps: [
    {
      id: 'p1',
      name: 'Pump 1',
      pumpCode: 'P1',
      mqttPumpId: 'pump-1',
      inferredStatus: 'IDLE',
      nozzles: [
        { id: 'n1', name: 'Nozzle 1', product: 'PMS', inferredStatus: 'IDLE' },
        { id: 'n2', name: 'Nozzle 2', product: 'PMS', inferredStatus: 'IDLE' },
      ],
    },
  ],
}

describe('physical pump list', () => {
  it('renders one physical pump with two nozzle rows', () => {
    render(<PumpCard pump={onePumpTwoNozzles.pumps![0]} />)
    expect(screen.getByText('Pump 1')).toBeInTheDocument()
    expect(screen.getByText('Nozzle 1')).toBeInTheDocument()
    expect(screen.getByText('Nozzle 2')).toBeInTheDocument()
  })
})

describe('physical pump aggregate status', () => {
  it('is dispensing when any nozzle is dispensing', () => {
    expect(aggregatePhysicalPumpStatus(['DISPENSING', 'IDLE'])).toBe('DISPENSING')
  })
})

describe('nozzle display names', () => {
  it('does not keep Pump 1 / pump-1 as a nozzle title', () => {
    expect(friendlyNozzleName({ name: 'Pump 1' }, 0)).toBe('Nozzle 1')
    expect(friendlyNozzleName({ name: 'pump-2', nozzleNumber: 2 }, 1)).toBe('Nozzle 2')
    expect(friendlyNozzleName({ name: 'Nozzle 1' }, 0)).toBe('Nozzle 1')
  })
})

describe('schematic viewport height', () => {
  it('uses a tall viewport for 1–2 physical pumps', () => {
    const h = schematicViewportHeight({ physicalPumpCount: 1, canvasHeight: 400, viewportHeight: 900 })
    expect(h).toBeGreaterThanOrEqual(640)
    expect(h).toBeLessThanOrEqual(720)
  })

  it('expands for twelve physical pumps without a second page scrollbar height', () => {
    const h = schematicViewportHeight({ physicalPumpCount: 12, canvasHeight: 900, viewportHeight: 900 })
    expect(h).toBeGreaterThanOrEqual(720)
    expect(h).toBeLessThanOrEqual(1100)
  })
})

describe('Digital Twin page sections', () => {
  beforeEach(async () => {
    const { default: OperationalTwinView } = await import('../components/twin/OperationalTwinView')
    render(
      <OperationalTwinView
        state={onePumpTwoNozzles}
        stationId="US-LAB-001"
      />,
    )
  })

  it('shows the tank and pump schematic without list widgets', () => {
    expect(screen.queryByText(/Tank list/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Pump list/i)).not.toBeInTheDocument()
    expect(screen.queryByTestId('pump-list')).not.toBeInTheDocument()
    expect(screen.getByText(/Tank and pump schematic/i)).toBeInTheDocument()
    expect(screen.getByText('Pump 1 · Nozzle 1')).toBeInTheDocument()
    expect(screen.getByText('Pump 1 · Nozzle 2')).toBeInTheDocument()
  })

  it('does not render edge devices, latest transactions, or active alerts', () => {
    expect(screen.queryByText(/Edge devices/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Latest transactions/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Active alerts/i)).not.toBeInTheDocument()
  })
})
