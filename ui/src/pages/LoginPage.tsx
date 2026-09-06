import { useState } from 'react'
import { useAuth } from '../context/AuthContext'

export default function LoginPage() {
  const { login } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      await login(email.trim(), password)
    } catch {
      setError('Invalid email or password')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-emerald-600 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg shadow-emerald-900/40">
            <span className="text-white font-bold text-xl">IP</span>
          </div>
          <h1 className="text-2xl font-bold text-white">InteliPump</h1>
          <p className="text-slate-400 text-sm mt-1">Sign in to the cloud dashboard</p>
        </div>

        <div className="card space-y-5">
          <form onSubmit={handleLogin} className="space-y-4" id="login-form">
            <div>
              <label className="label-text block mb-1.5" htmlFor="email-input">Email</label>
              <input
                id="email-input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="input"
                autoComplete="username"
                required
              />
            </div>
            <div>
              <label className="label-text block mb-1.5" htmlFor="password-input">Password</label>
              <input
                id="password-input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input"
                autoComplete="current-password"
                required
              />
            </div>
            {error && <p className="text-red-400 text-sm" role="alert">{error}</p>}
            <button id="login-btn" type="submit" disabled={loading} className="btn-primary w-full text-center disabled:opacity-50">
              {loading ? 'Signing in…' : 'Sign In'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
