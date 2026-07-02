import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import Layout from './components/layout/Layout'
import LoginPage from './pages/LoginPage'
import OverviewPage from './pages/OverviewPage'
import StationTwinPage from './pages/StationTwinPage'
import ReconciliationPage from './pages/ReconciliationPage'
import AlertsPage from './pages/AlertsPage'

function PrivateRoute({ children }: { children: React.ReactNode }) {
    const { isAuthenticated } = useAuth()
    return isAuthenticated ? <>{children}</> : <Navigate to="/login" replace />
}

function AppRoutes() {
    const { isAuthenticated } = useAuth()
    return (
        <Routes>
            <Route path="/login" element={isAuthenticated ? <Navigate to="/" replace /> : <LoginPage />} />
            <Route path="/" element={<PrivateRoute><Layout /></PrivateRoute>}>
                <Route index element={<OverviewPage />} />
                <Route path="stations/:stationId/twin" element={<StationTwinPage />} />
                <Route path="stations/:stationId/reconciliation" element={<ReconciliationPage />} />
                <Route path="alerts" element={<AlertsPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
    )
}

export default function App() {
    return (
        <AuthProvider>
            <BrowserRouter>
                <AppRoutes />
            </BrowserRouter>
        </AuthProvider>
    )
}
