import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { useState, useEffect } from 'react'
import { getStations, runAllReconciliation } from '../../api/client'

interface Station { id: string; name: string; location: string }

export default function Layout() {
    const { user, logout } = useAuth()
    const navigate = useNavigate()
    const [stations, setStations] = useState<Station[]>([])

    useEffect(() => {
        getStations().then(r => setStations(r.data)).catch(() => { })
    }, [])

    const handleRunRecon = async () => {
        try { await runAllReconciliation(); alert('Reconciliation complete!') } catch { alert('Reconciliation failed') }
    }

    return (
        <div className="flex h-screen overflow-hidden">
            {/* Sidebar */}
            <aside className="w-64 bg-slate-900 border-r border-slate-800 flex flex-col flex-shrink-0">
                {/* Logo */}
                <div className="p-5 border-b border-slate-800">
                    <div className="flex items-center gap-3">
                        <div className="w-9 h-9 bg-blue-600 rounded-lg flex items-center justify-center">
                            <span className="text-white font-bold text-sm">F</span>
                        </div>
                        <div>
                            <div className="text-white font-bold text-sm leading-tight">FuelOps</div>
                            <div className="text-slate-400 text-xs">Intelligence Platform</div>
                        </div>
                    </div>
                </div>

                {/* Nav */}
                <nav className="flex-1 p-3 overflow-y-auto">
                    <div className="mb-4">
                        <p className="text-xs text-slate-500 uppercase tracking-wider px-4 mb-2 font-semibold">Overview</p>
                        <NavLink to="/" end className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" /></svg>
                            Executive Overview
                        </NavLink>
                        <NavLink to="/alerts" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" /></svg>
                            Alerts
                        </NavLink>
                    </div>

                    <div>
                        <p className="text-xs text-slate-500 uppercase tracking-wider px-4 mb-2 font-semibold">Stations</p>
                        {stations.map(s => (
                            <div key={s.id} className="mb-1">
                                <NavLink
                                    to={`/stations/${s.id}/twin`}
                                    className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
                                >
                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" /></svg>
                                    <span className="truncate">{s.name}</span>
                                </NavLink>
                            </div>
                        ))}
                    </div>
                </nav>

                {/* Footer */}
                <div className="p-3 border-t border-slate-800 space-y-2">
                    <button onClick={handleRunRecon} className="w-full btn-secondary text-left flex items-center gap-2 text-xs">
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                        Run Reconciliation
                    </button>
                    <div className="flex items-center justify-between px-2">
                        <div>
                            <div className="text-xs font-medium text-white">{user?.username}</div>
                            <div className="text-xs text-slate-400">{user?.roles?.[0]}</div>
                        </div>
                        <button onClick={logout} className="text-slate-400 hover:text-white transition-colors">
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>
                        </button>
                    </div>
                </div>
            </aside>

            {/* Main content */}
            <main className="flex-1 overflow-y-auto bg-slate-900">
                <Outlet />
            </main>
        </div>
    )
}
