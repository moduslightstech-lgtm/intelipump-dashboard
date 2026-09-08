import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ReactFlowProvider } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import CylindricalTank from '../components/twin/schematic/nodes/CylindricalTank'
import TankSchematicNode from '../components/twin/schematic/nodes/TankSchematicNode'
import EquipmentDrawer from '../components/twin/schematic/EquipmentDrawer'
import { TANK_INNER_H } from '../components/twin/schematic/constants'
import { liquidHeight } from '../components/twin/schematic/tankFill'
import type { SchematicNode } from '../components/twin/schematic/types'

function tankNode(overrides: Record<string, any> = {}): SchematicNode {
  return {
    id: 'tank-pms',
    kind: 'TANK',
    x: 0,
    y: 0,
    w: 228,
    h: 148,
    label: 'PMS Lab Tank',
    status: 'NORMAL',
    product: 'PMS',
    raw: {
      id: '5a247af6',
      tankCode: 'TANK-PMS-LAB',
      name: 'PMS Lab Tank',
      reportedLiters: 10.39,
      capacityLiters: 25,
      measurementSource: 'MANUAL',
      measuredAt: '2026-09-07T18:00:00Z',
      inferredStatus: 'NORMAL',
      ...overrides,
    },
  }
}

function renderTank(raw: Record<string, any> = {}) {
  const node = tankNode(raw)
  return render(
    <ReactFlowProvider>
      <TankSchematicNode
        {...({
          id: node.id,
          data: { node, dimmed: false },
          selected: false,
          type: 'tank',
          dragging: false,
          zIndex: 1,
          selectable: true,
          deletable: false,
          draggable: false,
          isConnectable: false,
          positionAbsoluteX: 0,
          positionAbsoluteY: 0,
        } as unknown as NodeProps)}
      />
    </ReactFlowProvider>,
  )
}

describe('cylindrical tank visuals', () => {
  it('fills ~41.6% of internal height for 10.39 / 25.00 L', () => {
    const { container } = render(
      <CylindricalTank
        tank={{ id: 'pms', reportedLiters: 10.39, capacityLiters: 25 }}
        product="PMS"
      />,
    )
    const liquid = container.querySelector('[data-testid="tank-liquid"]')
    expect(liquid).toBeTruthy()
    expect(liquid?.getAttribute('data-liquid-height')).toBe(liquidHeight(41.56, TANK_INNER_H).toFixed(2))
    expect(container.querySelector('[data-testid="tank-outlet"]')).toBeTruthy()
    expect(container.textContent || '').not.toMatch(/%/)
  })

  it('empty / half / full / clamped', () => {
    const empty = render(<CylindricalTank tank={{ id: 'a', reportedLiters: 0, capacityLiters: 25 }} />)
    expect(empty.container.querySelector('[data-testid="tank-liquid"]')?.getAttribute('data-liquid-height')).toBe('0.00')
    empty.unmount()
    const half = render(<CylindricalTank tank={{ id: 'b', reportedLiters: 12.5, capacityLiters: 25 }} />)
    expect(Number(half.container.querySelector('[data-testid="tank-liquid"]')?.getAttribute('data-liquid-height'))).toBeCloseTo(
      TANK_INNER_H / 2,
      1,
    )
    half.unmount()
    const full = render(<CylindricalTank tank={{ id: 'c', reportedLiters: 25, capacityLiters: 25 }} />)
    expect(full.container.querySelector('[data-testid="tank-liquid"]')?.getAttribute('data-liquid-height')).toBe(
      TANK_INNER_H.toFixed(2),
    )
    full.unmount()
    const over = render(<CylindricalTank tank={{ id: 'd', reportedLiters: 80, capacityLiters: 25 }} />)
    expect(over.container.querySelector('[data-testid="tank-liquid"]')?.getAttribute('data-liquid-height')).toBe(
      TANK_INNER_H.toFixed(2),
    )
  })

  it('does not use a rectangular progress bar', () => {
    const { container } = render(
      <CylindricalTank tank={{ id: 'pms', reportedLiters: 10.39, capacityLiters: 25 }} product="PMS" />,
    )
    expect(container.querySelector('[role="progressbar"]')).toBeNull()
    expect(container.querySelector('.bg-white')).toBeNull()
  })

  it('respects reduced motion by dropping the wave', () => {
    const motion = render(
      <CylindricalTank tank={{ id: 'pms', reportedLiters: 10.39, capacityLiters: 25 }} product="PMS" reducedMotion={false} />,
    )
    expect(motion.container.querySelector('[data-testid="tank-liquid-wave"]')).toBeTruthy()
    motion.unmount()
    const reduced = render(
      <CylindricalTank tank={{ id: 'pms', reportedLiters: 10.39, capacityLiters: 25 }} product="PMS" reducedMotion />,
    )
    expect(reduced.container.querySelector('[data-testid="tank-liquid-wave"]')).toBeNull()
    expect(reduced.container.querySelector('[data-testid="tank-liquid-surface"]')).toBeTruthy()
  })
})

describe('tank operational states', () => {
  function mockReduce(reduce: boolean) {
    vi.stubGlobal(
      'matchMedia',
      (query: string) => ({
        matches: reduce && query.includes('prefers-reduced-motion'),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
      }),
    )
  }

  it('renders estimated, stale, inactive, missing, low, and fault badges', () => {
    mockReduce(true)
    const cases: Array<{ raw: Record<string, any>; text: string }> = [
      { raw: { measurementSource: 'ESTIMATED', reportedLiters: 10, capacityLiters: 25 }, text: 'Estimated' },
      { raw: { isStale: true, reportedLiters: 10, capacityLiters: 25, measuredAt: '2026-09-01T00:00:00Z' }, text: 'Reading stale' },
      { raw: { inactive: true, reportedLiters: 10, capacityLiters: 25 }, text: 'Inactive' },
      { raw: { reportedLiters: null, fillPercent: null, measurementSource: '', measuredAt: null }, text: 'No reading' },
      { raw: { reportedLiters: 4, capacityLiters: 25, inferredStatus: 'LOW' }, text: 'Low level' },
      { raw: { reportedLiters: 2, capacityLiters: 25, inferredStatus: 'CRITICAL' }, text: 'Critically low' },
      { raw: { reportedLiters: 10, capacityLiters: 25, inferredStatus: 'SENSOR_FAULT' }, text: 'Sensor fault' },
    ]
    for (const c of cases) {
      const { unmount } = renderTank(c.raw)
      expect(screen.getAllByText(new RegExp(c.text, 'i')).length).toBeGreaterThan(0)
      unmount()
    }
  })
})

describe('equipment drawer names', () => {
  it('shows Primary tank: PMS Lab Tank · PMS instead of a raw id', () => {
    const pump: SchematicNode = {
      id: 'pump-2',
      kind: 'PUMP',
      x: 0,
      y: 0,
      w: 196,
      h: 136,
      label: 'Pump 2',
      status: 'IDLE',
      product: 'PMS',
      raw: { name: 'Pump 2', mqttPumpId: 'PUMP-02' },
    }
    render(
      <EquipmentDrawer
        selection={{ kind: 'PUMP', node: pump }}
        connections={[
          {
            id: 'c1',
            tankId: '5a247af6',
            pumpId: 'pump-2',
            tankName: 'PMS Lab Tank',
            pumpName: 'Pump 2',
            product: 'PMS',
            isPrimary: true,
            active: true,
            role: 'PRIMARY',
            source: 'CONFIGURED',
            raw: {},
          },
        ]}
        onClose={() => {}}
      />,
    )
    expect(screen.getByTestId('pump-tank-link').textContent).toBe('Primary tank: PMS Lab Tank · PMS')
    expect(screen.getByTestId('pump-tank-link').textContent).not.toMatch(/5a247af6/)
    expect(screen.getByText('Technical details')).toBeTruthy()
  })
})
