import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  EdgeConnectivityNetworkPanel,
  EdgeDeviceStatusDetailCard,
  StatusDot,
} from '../components/edge/EdgeConnectivity'
import { formatRelativeHeartbeat } from '../lib/relativeTime'
import { DeviceApiError, fetchStationDevices, type StationDevicesSummary } from '../services/deviceApi'
import type { EdgeDeviceStatus } from '../types/edgeDevice'
import { parseEdgeDeviceStatus } from '../types/edgeDevice'

vi.mock('../services/deviceApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/deviceApi')>()
  return {
    ...actual,
    fetchDeviceStatus: vi.fn(),
    fetchStationDevices: vi.fn(),
  }
})

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  })
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
}

function status(partial: Partial<EdgeDeviceStatus> = {}): EdgeDeviceStatus {
  return {
    deviceId: 'InteliPump-Lab-pi-001',
    stationId: 'InteliPump-US-Lab',
    hostname: 'raspberrypi',
    status: 'ONLINE',
    mqttConnectionStatus: 'ONLINE',
    lastSeen: '2026-07-13T19:27:34.292255+00:00',
    secondsSinceLastHeartbeat: 25,
    ...partial,
  }
}

function summary(devices: EdgeDeviceStatus[], stationId = 'InteliPump-US-Lab'): StationDevicesSummary {
  return {
    stationId,
    onlineCount: devices.filter((d) => d.status === 'ONLINE').length,
    delayedCount: devices.filter((d) => d.status === 'DELAYED').length,
    offlineCount: devices.filter((d) => d.status === 'OFFLINE').length,
    totalCount: devices.length,
    lastStationHeartbeat: devices[0]?.lastSeen ?? null,
    devices,
  }
}

const mockedFetchStationDevices = vi.mocked(fetchStationDevices)

describe('relative heartbeat formatting', () => {
  it('formats relative ages', () => {
    expect(formatRelativeHeartbeat(2)).toBe('Just now')
    expect(formatRelativeHeartbeat(25)).toBe('25 seconds ago')
    expect(formatRelativeHeartbeat(60)).toBe('1 minute ago')
    expect(formatRelativeHeartbeat(480)).toBe('8 minutes ago')
    expect(formatRelativeHeartbeat(7200)).toBe('2 hours ago')
    expect(formatRelativeHeartbeat(null, null)).toBe('Never')
  })
})

describe('status dots', () => {
  it('renders ONLINE DELAYED OFFLINE UNKNOWN', () => {
    const { rerender } = render(<StatusDot status="ONLINE" />)
    expect(screen.getByTestId('status-dot-online')).toHaveTextContent(/Online/i)
    rerender(<StatusDot status="DELAYED" />)
    expect(screen.getByTestId('status-dot-delayed')).toHaveTextContent(/Delayed/i)
    rerender(<StatusDot status="OFFLINE" />)
    expect(screen.getByTestId('status-dot-offline')).toHaveTextContent(/Offline/i)
    rerender(<StatusDot status="UNKNOWN" />)
    expect(screen.getByTestId('status-dot-unknown')).toHaveTextContent(/Status unavailable/i)
  })
})

describe('EdgeConnectivityNetworkPanel', () => {
  beforeEach(() => {
    mockedFetchStationDevices.mockReset()
  })
  afterEach(() => cleanup())

  it('shows ONLINE response and online KPI', async () => {
    mockedFetchStationDevices.mockResolvedValue(
      summary([status({ status: 'ONLINE', secondsSinceLastHeartbeat: 25 })]),
    )

    render(
      wrap(
        <EdgeConnectivityNetworkPanel
          stations={[
            { id: '1', name: 'InteliPump US Lab', mqttId: 'InteliPump-US-Lab' },
          ]}
        />,
      ),
    )

    expect(await screen.findByText('Online edge devices')).toBeInTheDocument()
    expect(await screen.findByTestId('status-dot-online')).toBeInTheDocument()
    expect(screen.getByText('InteliPump-Lab-pi-001')).toBeInTheDocument()
  })

  it('renders DELAYED status', async () => {
    mockedFetchStationDevices.mockResolvedValue(
      summary([status({ status: 'DELAYED', secondsSinceLastHeartbeat: 120 })]),
    )
    render(
      wrap(
        <EdgeConnectivityNetworkPanel
          stations={[{ id: '1', name: 'InteliPump US Lab', mqttId: 'InteliPump-US-Lab' }]}
        />,
      ),
    )
    expect(await screen.findByTestId('status-dot-delayed')).toBeInTheDocument()
  })
})

describe('EdgeDeviceStatusDetailCard', () => {
  beforeEach(() => {
    mockedFetchStationDevices.mockReset()
  })
  afterEach(() => cleanup())

  it('shows ONLINE detail with separate pump activity', async () => {
    mockedFetchStationDevices.mockResolvedValue(summary([status({ status: 'ONLINE' })]))
    render(wrap(<EdgeDeviceStatusDetailCard stationId="InteliPump-US-Lab" />))
    expect(await screen.findByTestId('status-dot-online')).toBeInTheDocument()
    expect(screen.getByText(/No recent transaction/i)).toBeInTheDocument()
    expect(screen.getByText('InteliPump-Lab-pi-001')).toBeInTheDocument()
    expect(screen.getByText('raspberrypi')).toBeInTheDocument()
  })

  it('shows 404 not registered', async () => {
    mockedFetchStationDevices.mockRejectedValue(
      new DeviceApiError('Edge device is not registered', 404),
    )
    render(wrap(<EdgeDeviceStatusDetailCard stationId="InteliPump-US-Lab" />))
    expect(await screen.findByText(/Edge device is not registered/i)).toBeInTheDocument()
  })

  it('shows API unavailable on failure', async () => {
    mockedFetchStationDevices.mockRejectedValue(
      new DeviceApiError('Unable to reach device status API'),
    )
    render(wrap(<EdgeDeviceStatusDetailCard stationId="InteliPump-US-Lab" />))
    expect(await screen.findByText(/Device status temporarily unavailable/i)).toBeInTheDocument()
  })

  it('shows no edge device assigned when station has none', async () => {
    mockedFetchStationDevices.mockResolvedValue(summary([], 'Unknown-Station'))
    render(wrap(<EdgeDeviceStatusDetailCard stationId="Unknown-Station" />))
    expect(await screen.findByText(/No edge device assigned/i)).toBeInTheDocument()
  })
})

describe('polling cleanup', () => {
  beforeEach(() => {
    mockedFetchStationDevices.mockReset()
    mockedFetchStationDevices.mockResolvedValue(summary([status({})]))
  })
  afterEach(() => cleanup())

  it('clears interval on unmount', async () => {
    const clearSpy = vi.spyOn(window, 'clearInterval')
    const { unmount } = render(
      wrap(<EdgeDeviceStatusDetailCard stationId="InteliPump-US-Lab" />),
    )
    await screen.findByTestId('status-dot-online')
    unmount()
    expect(clearSpy).toHaveBeenCalled()
    clearSpy.mockRestore()
  })
})

describe('parseEdgeDeviceStatus', () => {
  it('parses live device payload safely', () => {
    const parsed = parseEdgeDeviceStatus({
      deviceId: 'InteliPump-Lab-pi-001',
      stationId: 'InteliPump-US-Lab',
      hostname: 'raspberrypi',
      status: 'ONLINE',
      mqttConnectionStatus: 'ONLINE',
      lastSeen: '2026-07-13T19:27:34.292255+00:00',
      secondsSinceLastHeartbeat: 25,
    })
    expect(parsed.status).toBe('ONLINE')
    expect(parsed.deviceId).toBe('InteliPump-Lab-pi-001')
    expect(parsed.secondsSinceLastHeartbeat).toBe(25)
  })
})
