import { useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { runSeed } from '../api/client'

export default function LoginPage() {
    const { login } = useAuth()
    const [username, setUsername] = useState('admin')
    const [password, setPassword] = useState('admin123')
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState('')
    const [seeding, setSeeding] = useState(false)
    const [seedMsg, setSeedMsg] = useState('')

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault()
        setLoading(true)
        setError('')
        try {
            await login(username, password)
        } catch {
            setError('Invalid credentials. Try admin / admin123')
        } finally {
            setLoading(false)
        }
    }

    const handleSeed = async () => {
        setSeeding(true)
        setSeedMsg('')
        try {
            const r = await runSeed()
            setSeedMsg(r.data.status === 'seeded' ? `✓ Seeded! ${r.data.totalEvents} events created` : '✓ Already seeded')
        } catch {
            setSeedMsg('Seed failed – API may not be ready')
        } finally {
            setSeeding(false)
        }
    }

    const demoUsers = [
        { user: 'admin', pass: 'admin123', role: 'OWNER' },
        { user: 'finance', pass: 'finance123', role: 'FINANCE' },
        { user: 'ops', pass: 'ops123', role: 'OPS' },
        { user: 'manager1', pass: 'manager123', role: 'STATION_MANAGER' },
    ]

    return (
        <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
            <div className="w-full max-w-md">
                {/* Header */}
                <div className="text-center mb-8">
                    <div className="w-16 h-16 bg-gradient-to-br from-blue-600 to-blue-800 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-xl shadow-blue-900/50">
                        <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                        </svg>
                    </div>
                    <h1 className="text-2xl font-bold text-white">FuelOps Intelligence</h1>
                    <p className="text-slate-400 text-sm mt-1">Multi-station fuel retail platform</p>
                </div>

                {/* Login card */}
                <div className="card space-y-5">
                    <form onSubmit={handleLogin} className="space-y-4" id="login-form">
                        <div>
                            <label className="label-text block mb-1.5">Username</label>
                            <input id="username-input" type="text" value={username} onChange={e => setUsername(e.target.value)}
                                className="input" required />
                        </div>
                        <div>
                            <label className="label-text block mb-1.5">Password</label>
                            <input id="password-input" type="password" value={password} onChange={e => setPassword(e.target.value)}
                                className="input" required />
                        </div>
                        {error && <p className="text-red-400 text-sm">{error}</p>}
                        <button id="login-btn" type="submit" disabled={loading} className="btn-primary w-full text-center disabled:opacity-50">
                            {loading ? 'Signing in…' : 'Sign In'}
                        </button>
                    </form>

                    {/* Seed demo data */}
                    <div className="border-t border-slate-700 pt-4">
                        <p className="text-xs text-slate-400 mb-3 text-center">First time? Load demo data before logging in</p>
                        <button id="seed-btn" onClick={handleSeed} disabled={seeding} className="btn-secondary w-full disabled:opacity-50">
                            {seeding ? 'Loading demo data…' : '🌱 Load Demo Data'}
                        </button>
                        {seedMsg && <p className="text-green-400 text-xs mt-2 text-center">{seedMsg}</p>}
                    </div>
                </div>

                {/* Demo users quick-fill */}
                <div className="mt-4 card">
                    <p className="text-xs text-slate-400 mb-3 font-semibold uppercase tracking-wider">Demo Accounts</p>
                    <div className="grid grid-cols-2 gap-2">
                        {demoUsers.map(u => (
                            <button key={u.user} onClick={() => { setUsername(u.user); setPassword(u.pass) }}
                                className="bg-slate-700 hover:bg-slate-600 rounded-lg p-2 text-left transition-colors">
                                <div className="text-xs font-semibold text-white">{u.user}</div>
                                <div className="text-xs text-slate-400">{u.role}</div>
                            </button>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    )
}
