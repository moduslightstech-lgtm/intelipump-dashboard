import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AuthProvider, useAuth } from './context/AuthContext'
import Layout from './components/layout/Layout'
import LoginPage from './pages/LoginPage'
import OverviewPage from './pages/OverviewPage'
import TransactionsPage from './pages/TransactionsPage'
import StationsPage from './pages/StationsPage'
import StationDetailPage from './pages/StationDetailPage'
import DevicesPage from './pages/DevicesPage'
import MqttPage from './pages/MqttPage'
import AlertsPage from './pages/AlertsPage'
import SettingsPage from './pages/SettingsPage'
import ReconciliationsPage from './pages/ReconciliationsPage'
import DigitalTwinPage from './pages/DigitalTwinPage'
import ExecutiveOverviewPage from './pages/ExecutiveOverviewPage'
import UsersPage from './pages/UsersPage'
import TanksPage from './pages/TanksPage'
import TankReadingsPage from './pages/station-manager/TankReadingsPage'
import {
  StationManagerHistoryPage,
  StationManagerProfilePage,
} from './pages/station-manager/HistoryPages'
import AdminStationsPage from './pages/admin/AdminStationsPage'
import AdminStationLayout from './pages/admin/AdminStationLayout'
import AdminStationHubPage from './pages/admin/AdminStationHubPage'
import AdminStationEditPage from './pages/admin/AdminStationEditPage'
import AdminStationPumpsPage from './pages/admin/AdminStationPumpsPage'
import AdminStationTanksPage from './pages/admin/AdminStationTanksPage'
import AdminStationConnectionsPage from './pages/admin/AdminStationConnectionsPage'
import { canAccessPath, landingPath, normalizeRole } from './lib/roles'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: false },
  },
})

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, loading } = useAuth()
  if (loading) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center text-slate-400">
        Loading…
      </div>
    )
  }
  return isAuthenticated ? <>{children}</> : <Navigate to="/login" replace />
}

function RoleGuard({ children }: { children: React.ReactNode }) {
  const { user } = useAuth()
  const location = useLocation()
  const role = normalizeRole(user?.normalizedRole || user?.role)
  if (!canAccessPath(role, location.pathname)) {
    return <Navigate to={landingPath(role)} replace />
  }
  return <>{children}</>
}

function AppRoutes() {
  const { isAuthenticated, loading, user } = useAuth()
  if (loading) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center text-slate-400">
        Loading…
      </div>
    )
  }
  const dest = user?.landingPath || landingPath(user?.normalizedRole || user?.role)

  return (
    <Routes>
      <Route
        path="/login"
        element={isAuthenticated ? <Navigate to={dest} replace /> : <LoginPage />}
      />
      <Route
        path="/"
        element={
          <PrivateRoute>
            <RoleGuard>
              <Layout />
            </RoleGuard>
          </PrivateRoute>
        }
      >
        <Route index element={<OverviewPage />} />
        <Route path="executive" element={<ExecutiveOverviewPage />} />
        <Route path="digital-twin" element={<DigitalTwinPage />} />
        <Route path="digital-twin/:stationId" element={<DigitalTwinPage />} />
        <Route path="transactions" element={<TransactionsPage />} />
        <Route path="reconciliations" element={<ReconciliationsPage />} />
        <Route path="stations" element={<StationsPage />} />
        <Route path="stations/:stationId" element={<StationDetailPage />} />
        <Route path="devices" element={<DevicesPage />} />
        <Route path="tanks" element={<TanksPage />} />
        <Route path="mqtt" element={<MqttPage />} />
        <Route path="alerts" element={<AlertsPage />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="admin/stations" element={<AdminStationsPage />} />
        <Route path="admin/stations/:stationId" element={<AdminStationLayout />}>
          <Route index element={<AdminStationHubPage />} />
          <Route path="edit" element={<AdminStationEditPage />} />
          <Route path="pumps" element={<AdminStationPumpsPage />} />
          <Route path="tanks" element={<AdminStationTanksPage />} />
          <Route path="connections" element={<AdminStationConnectionsPage />} />
        </Route>
        <Route path="station-manager/tank-readings" element={<TankReadingsPage />} />
        <Route path="station-manager/history" element={<StationManagerHistoryPage />} />
        <Route
          path="station-manager/reconciliation"
          element={<Navigate to="/station-manager/tank-readings" replace />}
        />
        <Route path="station-manager/profile" element={<StationManagerProfilePage />} />
      </Route>
      <Route path="*" element={<Navigate to={isAuthenticated ? dest : '/login'} replace />} />
    </Routes>
  )
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  )
}
