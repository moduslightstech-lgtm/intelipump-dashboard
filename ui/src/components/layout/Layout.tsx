import type { ReactNode } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { useLiveEvents } from '../../hooks/useLiveEvents'
import { normalizeRole, type AppRole } from '../../lib/roles'

type NavItem = {
  to: string
  label: string
  end?: boolean
  icon: (props: { className?: string }) => ReactNode
}

function NavIcon({
  children,
  className = 'h-5 w-5',
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  )
}

const Icons = {
  overview: (p: { className?: string }) => (
    <NavIcon className={p.className}>
      <path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" />
    </NavIcon>
  ),
  twin: (p: { className?: string }) => (
    <NavIcon className={p.className}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
    </NavIcon>
  ),
  transactions: (p: { className?: string }) => (
    <NavIcon className={p.className}>
      <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
    </NavIcon>
  ),
  recon: (p: { className?: string }) => (
    <NavIcon className={p.className}>
      <path d="M16 3l4 4-4 4" />
      <path d="M20 7H8a4 4 0 0 0 0 8h1" />
      <path d="M8 21l-4-4 4-4" />
      <path d="M4 17h12a4 4 0 0 0 0-8h-1" />
    </NavIcon>
  ),
  stations: (p: { className?: string }) => (
    <NavIcon className={p.className}>
      <path d="M4 21V7l8-4 8 4v14" />
      <path d="M9 21v-6h6v6M9 10h.01M15 10h.01M9 14h.01M15 14h.01" />
    </NavIcon>
  ),
  admin: (p: { className?: string }) => (
    <NavIcon className={p.className}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </NavIcon>
  ),
  devices: (p: { className?: string }) => (
    <NavIcon className={p.className}>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M9 7h6M9 11h6M9 15h3" />
    </NavIcon>
  ),
  tanks: (p: { className?: string }) => (
    <NavIcon className={p.className}>
      <path d="M8 4h8v4a6 6 0 0 1-8 0V4Z" />
      <path d="M7 8v11a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V8" />
      <path d="M10 14h4" />
    </NavIcon>
  ),
  alerts: (p: { className?: string }) => (
    <NavIcon className={p.className}>
      <path d="M12 9v4M12 17h.01" />
      <path d="M10.3 4.3 2.5 18a2 2 0 0 0 1.7 3h16a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z" />
    </NavIcon>
  ),
  mqtt: (p: { className?: string }) => (
    <NavIcon className={p.className}>
      <path d="M5 12.5a9 9 0 0 1 14 0" />
      <path d="M8.5 16a5 5 0 0 1 7 0" />
      <circle cx="12" cy="20" r="1" fill="currentColor" stroke="none" />
    </NavIcon>
  ),
  users: (p: { className?: string }) => (
    <NavIcon className={p.className}>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20a6 6 0 0 1 12 0" />
      <circle cx="17" cy="9" r="2.5" />
      <path d="M16 20a4.5 4.5 0 0 1 5 0" />
    </NavIcon>
  ),
  settings: (p: { className?: string }) => (
    <NavIcon className={p.className}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9c.3.6.9 1 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </NavIcon>
  ),
  profile: (p: { className?: string }) => (
    <NavIcon className={p.className}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </NavIcon>
  ),
}

const ADMIN_NAV: NavItem[] = [
  { to: '/', label: 'Overview', end: true, icon: Icons.overview },
  { to: '/digital-twin', label: 'Digital Twin', icon: Icons.twin },
  { to: '/transactions', label: 'Transactions', icon: Icons.transactions },
  { to: '/reconciliations', label: 'Reconciliations', icon: Icons.recon },
  { to: '/stations', label: 'Stations', icon: Icons.stations },
  { to: '/admin/stations', label: 'Admin Stations', icon: Icons.admin },
  { to: '/station-manager/tank-readings', label: 'Nightly Tank Readings', icon: Icons.tanks },
  { to: '/devices', label: 'Devices', icon: Icons.devices },
  { to: '/tanks', label: 'Tanks', icon: Icons.tanks },
  { to: '/alerts', label: 'Alerts', icon: Icons.alerts },
  { to: '/mqtt', label: 'MQTT Monitoring', icon: Icons.mqtt },
  { to: '/users', label: 'Users', icon: Icons.users },
  { to: '/settings', label: 'Settings', icon: Icons.settings },
]

const EXEC_NAV: NavItem[] = [
  { to: '/executive', label: 'Executive Overview', end: true, icon: Icons.overview },
  { to: '/transactions', label: 'Sales', icon: Icons.transactions },
  { to: '/reconciliations', label: 'Reconciliations', icon: Icons.recon },
  { to: '/stations', label: 'Stations', icon: Icons.stations },
  { to: '/digital-twin', label: 'Digital Twin', icon: Icons.twin },
  { to: '/alerts', label: 'Alerts', icon: Icons.alerts },
]

const MANAGER_NAV: NavItem[] = [
  { to: '/station-manager/tank-readings', label: 'Nightly Tank Readings', end: true, icon: Icons.tanks },
  { to: '/station-manager/history', label: 'Submission History', icon: Icons.transactions },
  { to: '/station-manager/reconciliation', label: 'Reconciliation Result', icon: Icons.recon },
  { to: '/station-manager/profile', label: 'Profile', icon: Icons.profile },
]

function navForRole(role: AppRole): NavItem[] {
  if (role === 'STATION_MANAGER') return MANAGER_NAV
  if (role === 'EXECUTIVE') return EXEC_NAV
  return ADMIN_NAV
}

export default function Layout() {
  const { user, logout } = useAuth()
  const role = normalizeRole(user?.normalizedRole || user?.role)
  useLiveEvents(role !== 'STATION_MANAGER')
  const nav = navForRole(role)

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="flex w-64 flex-shrink-0 flex-col border-r border-slate-800/90 bg-gradient-to-b from-slate-950 via-slate-950 to-slate-900">
        <div className="border-b border-slate-800 p-5">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 shadow-[0_0_20px_rgba(16,185,129,0.35)]">
              <span className="text-sm font-bold text-white">IP</span>
            </div>
            <div>
              <div className="text-sm font-bold leading-tight text-white">InteliPump</div>
              <div className="text-xs text-slate-400">
                {role === 'STATION_MANAGER'
                  ? 'Station Manager'
                  : role === 'EXECUTIVE'
                    ? 'Executive'
                    : 'Cloud Dashboard'}
              </div>
            </div>
          </div>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto p-3">
          <p className="mb-2 px-4 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
            {role === 'STATION_MANAGER' ? 'Nightly workflow' : 'Operations'}
          </p>
          {nav.map((item) => {
            const Icon = item.icon
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
              >
                <span className="nav-icon">
                  <Icon className="h-5 w-5" />
                </span>
                <span>{item.label}</span>
              </NavLink>
            )
          })}
        </nav>

        <div className="flex items-center justify-between gap-2 border-t border-slate-800 p-4">
          <div className="min-w-0">
            <div className="truncate text-xs font-medium text-white">{user?.email}</div>
            <div className="text-xs text-slate-400">{role}</div>
          </div>
          <button onClick={logout} className="btn-secondary px-3 py-1.5 text-xs" type="button">
            Logout
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto bg-[#0b1220]">
        <Outlet />
      </main>
    </div>
  )
}
