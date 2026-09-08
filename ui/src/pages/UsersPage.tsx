import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import {
  assignUserRole,
  assignUserStations,
  createAdminUser,
  getAdminUsers,
  getStations,
} from '../api/client'
import { apiErrorMessage } from '../lib/apiError'

const MIN_PASSWORD_LENGTH = 8

export default function UsersPage() {
  const qc = useQueryClient()
  const usersQ = useQuery({ queryKey: ['admin', 'users'], queryFn: async () => (await getAdminUsers()).data })
  const stationsQ = useQuery({ queryKey: ['stations'], queryFn: async () => (await getStations()).data })
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState('STATION_MANAGER')
  const [assignUserId, setAssignUserId] = useState('')
  const [selectedStations, setSelectedStations] = useState<string[]>([])
  const [formError, setFormError] = useState<string | null>(null)

  const createMut = useMutation({
    mutationFn: async () =>
      (await createAdminUser({ email, password, role })).data,
    onSuccess: () => {
      setEmail('')
      setPassword('')
      setFormError(null)
      qc.invalidateQueries({ queryKey: ['admin', 'users'] })
    },
    onError: (err) => {
      setFormError(apiErrorMessage(err, 'Password must be at least 8 characters.'))
    },
  })

  const submitCreate = () => {
    if (!email.trim()) {
      setFormError('Email is required.')
      return
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setFormError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`)
      return
    }
    setFormError(null)
    createMut.mutate()
  }

  const createError = formError

  const roleMut = useMutation({
    mutationFn: async ({ id, role }: { id: string; role: string }) =>
      (await assignUserRole(id, role)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'users'] }),
  })

  const assignMut = useMutation({
    mutationFn: async () =>
      (await assignUserStations(assignUserId, selectedStations)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'users'] }),
  })

  return (
    <div className="p-6 space-y-4">
      <h1 className="section-title">Users & roles</h1>

      <div className="card space-y-3 max-w-xl">
        <h2 className="text-white text-sm font-semibold">Create user</h2>
        <input
          className="input w-full"
          placeholder="Email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value)
            if (formError) setFormError(null)
          }}
        />
        <div>
          <input
            className="input w-full"
            type="password"
            placeholder="Password (min. 8 characters)"
            value={password}
            minLength={MIN_PASSWORD_LENGTH}
            autoComplete="new-password"
            aria-invalid={Boolean(createError)}
            aria-describedby={createError ? 'create-user-error' : 'password-hint'}
            onChange={(e) => {
              setPassword(e.target.value)
              if (formError) setFormError(null)
            }}
          />
          <p id="password-hint" className="mt-1 text-xs text-slate-500">
            Must be at least {MIN_PASSWORD_LENGTH} characters.
          </p>
        </div>
        <select className="input w-full" value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="ADMIN">ADMIN</option>
          <option value="EXECUTIVE">EXECUTIVE</option>
          <option value="STATION_MANAGER">STATION_MANAGER</option>
        </select>
        {createError ? (
          <p id="create-user-error" className="text-sm text-red-400" role="alert">
            {createError}
          </p>
        ) : null}
        <button type="button" className="btn-primary" onClick={submitCreate} disabled={createMut.isPending}>
          Create
        </button>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-slate-400 border-b border-slate-700">
              <th className="pb-2">Email</th>
              <th className="pb-2">Role</th>
              <th className="pb-2">Stations</th>
              <th className="pb-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(usersQ.data || []).map((u: any) => (
              <tr key={u.id} className="border-b border-slate-800">
                <td className="py-2">{u.email}</td>
                <td className="py-2">
                  <select
                    className="input text-xs"
                    value={u.normalizedRole || u.role}
                    onChange={(e) => roleMut.mutate({ id: u.id, role: e.target.value })}
                  >
                    <option value="ADMIN">ADMIN</option>
                    <option value="EXECUTIVE">EXECUTIVE</option>
                    <option value="STATION_MANAGER">STATION_MANAGER</option>
                  </select>
                </td>
                <td className="py-2 text-xs font-mono text-slate-400">
                  {(u.stationIds || []).length} assigned
                </td>
                <td className="py-2">
                  <button
                    type="button"
                    className="btn-secondary text-xs"
                    onClick={() => {
                      setAssignUserId(u.id)
                      setSelectedStations(u.stationIds || [])
                    }}
                  >
                    Assign stations
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {assignUserId && (
        <div className="card space-y-3 max-w-xl">
          <h2 className="text-white text-sm font-semibold">Station assignments</h2>
          <div className="space-y-1 max-h-48 overflow-auto">
            {(stationsQ.data || []).map((s) => (
              <label key={s.id} className="flex items-center gap-2 text-sm text-slate-300">
                <input
                  type="checkbox"
                  checked={selectedStations.includes(s.id)}
                  onChange={(e) => {
                    setSelectedStations((prev) =>
                      e.target.checked ? [...prev, s.id] : prev.filter((id) => id !== s.id),
                    )
                  }}
                />
                {s.name} ({s.station_code})
              </label>
            ))}
          </div>
          <div className="flex gap-2">
            <button type="button" className="btn-primary" onClick={() => assignMut.mutate()}>
              Save assignments
            </button>
            <button type="button" className="btn-secondary" onClick={() => setAssignUserId('')}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
