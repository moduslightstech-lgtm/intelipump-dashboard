import React, { createContext, useContext, useState, useEffect } from 'react'
import { api } from '../api/client'

interface AuthUser {
    username: string
    tenantId: string
    roles: string[]
}

interface AuthContextType {
    user: AuthUser | null
    token: string | null
    login: (username: string, password: string) => Promise<void>
    logout: () => void
    isAuthenticated: boolean
    hasRole: (role: string) => boolean
}

const AuthContext = createContext<AuthContextType | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
    const [user, setUser] = useState<AuthUser | null>(null)
    const [token, setToken] = useState<string | null>(null)

    useEffect(() => {
        const savedToken = localStorage.getItem('fuelops_token')
        const savedUser = localStorage.getItem('fuelops_user')
        if (savedToken && savedUser) {
            setToken(savedToken)
            setUser(JSON.parse(savedUser))
            api.defaults.headers.common['Authorization'] = `Bearer ${savedToken}`
        }
    }, [])

    const login = async (username: string, password: string) => {
        const response = await api.post('/api/auth/login', { username, password })
        const { token: newToken, username: uname, tenantId, roles } = response.data
        const userData = { username: uname, tenantId, roles }
        setToken(newToken)
        setUser(userData)
        localStorage.setItem('fuelops_token', newToken)
        localStorage.setItem('fuelops_user', JSON.stringify(userData))
        api.defaults.headers.common['Authorization'] = `Bearer ${newToken}`
        api.defaults.headers.common['X-Tenant-Id'] = tenantId
    }

    const logout = () => {
        setToken(null)
        setUser(null)
        localStorage.removeItem('fuelops_token')
        localStorage.removeItem('fuelops_user')
        delete api.defaults.headers.common['Authorization']
        delete api.defaults.headers.common['X-Tenant-Id']
    }

    const hasRole = (role: string) => user?.roles?.includes(role) ?? false

    return (
        <AuthContext.Provider value={{ user, token, login, logout, isAuthenticated: !!token, hasRole }}>
            {children}
        </AuthContext.Provider>
    )
}

export function useAuth() {
    const ctx = useContext(AuthContext)
    if (!ctx) throw new Error('useAuth must be used within AuthProvider')
    return ctx
}
