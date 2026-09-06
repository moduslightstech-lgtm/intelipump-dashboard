import React, { createContext, useCallback, useContext, useEffect, useState } from 'react'
import {
  api,
  clearTokens,
  getMe,
  loadStoredTokens,
  login as apiLogin,
  storeTokens,
  type UserMe,
} from '../api/client'

interface AuthContextType {
  user: UserMe | null
  token: string | null
  login: (email: string, password: string) => Promise<void>
  logout: () => void
  isAuthenticated: boolean
  loading: boolean
}

const AuthContext = createContext<AuthContextType | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<UserMe | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const { access } = loadStoredTokens()
    if (!access) {
      setLoading(false)
      return
    }
    setToken(access)
    getMe()
      .then((r) => setUser(r.data))
      .catch(() => {
        clearTokens()
        setToken(null)
        setUser(null)
      })
      .finally(() => setLoading(false))
  }, [])

  const login = useCallback(async (email: string, password: string) => {
    const response = await apiLogin(email, password)
    const { access_token, refresh_token } = response.data
    storeTokens(access_token, refresh_token)
    setToken(access_token)
    const me = await getMe()
    setUser(me.data)
  }, [])

  const logout = useCallback(() => {
    clearTokens()
    setToken(null)
    setUser(null)
    delete api.defaults.headers.common['Authorization']
  }, [])

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        login,
        logout,
        isAuthenticated: !!token && !!user,
        loading,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
