import { useEffect } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getDayCloseAudit,
  getStationManagerReconciliation,
  getStationManagerStations,
  usePreviousOpening,
} from '../../api/client'
import { apiErrorMessage } from '../../lib/apiError'
import { useAuth } from '../../context/AuthContext'
import { normalizeRole } from '../../lib/roles'
import HowReconciliationWorks from '../../components/reconciliation/HowReconciliationWorks'
import ReconciliationWorkspace from '../../components/reconciliation/ReconciliationWorkspace'

export default function DayClosePage() {
  const qc = useQueryClient()
  const location = useLocation()
  const navigate = useNavigate()
  const { user } = useAuth()
  const isAdmin = normalizeRole(user?.normalizedRole || user?.role) === 'ADMIN'
  const [params, setParams] = useSearchParams()
  const stationFromUrl = params.get('station')?.trim() || ''
  const dateFromUrl = params.get('date')?.trim() || ''

  const stationsQ = useQuery({
    queryKey: ['sm', 'stations'],
    queryFn: async () => (await getStationManagerStations()).data,
  })

  const stationId = stationFromUrl || stationsQ.data?.[0]?.id || ''
  const singleStation = (stationsQ.data?.length ?? 0) <= 1

  useEffect(() => {
    if (stationFromUrl || !stationsQ.data?.[0]?.id) return
    setParams(
      (current) => {
        const next = new URLSearchParams(current)
        next.set('station', stationsQ.data[0].id)
        return next
      },
      { replace: true },
    )
  }, [stationFromUrl, stationsQ.data, setParams])

  const reconQ = useQuery({
    queryKey: ['sm', 'recon', stationId, dateFromUrl],
    queryFn: async () => (await getStationManagerReconciliation(stationId, dateFromUrl || undefined)).data,
    enabled: !!stationId,
  })

  const data = reconQ.data
  const auditQ = useQuery({
    queryKey: ['day-close-audit', data?.stationId, data?.businessDate],
    queryFn: async () => (await getDayCloseAudit(data!.stationId, data!.businessDate)).data,
    enabled: Boolean(isAdmin && data),
  })

  const previousMut = useMutation({
    mutationFn: () => usePreviousOpening({ station_id: stationId, business_date: data?.businessDate }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sm', 'recon', stationId] }),
  })

  const fromAdmin = Boolean((location.state as { from?: string } | null)?.from === 'admin')
  const backHref = fromAdmin
    ? `/reconciliations?station=${encodeURIComponent(stationId)}${data?.businessDate ? `&date=${data.businessDate}` : ''}`
    : '/station-manager/tank-readings'

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-6xl mx-auto">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="section-title">Reconciliation</h1>
          <p className="text-slate-400 text-sm mt-1">
            Financial, transaction integrity and tank inventory
          </p>
        </div>
        {!singleStation ? (
          <select
            className="input max-w-xs"
            value={stationId}
            onChange={(e) => {
              setParams((current) => {
                const next = new URLSearchParams(current)
                next.set('station', e.target.value)
                return next
              })
            }}
            disabled={stationsQ.isLoading}
          >
            {(stationsQ.data || []).map((s: { id: string; name: string }) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      <HowReconciliationWorks />

      {reconQ.isError ? (
        <div className="card border-red-800 text-red-300 text-sm" role="alert">
          {apiErrorMessage(reconQ.error, 'Could not load reconciliation')}
        </div>
      ) : null}

      <ReconciliationWorkspace
        data={data || null}
        loading={reconQ.isLoading}
        backHref={location.key === 'default' ? backHref : undefined}
        onBackToStations={
          location.key === 'default'
            ? undefined
            : () => navigate(-1)
        }
        backLabel={fromAdmin ? 'Back to reconciliation overview' : 'Back'}
        actions={{
          isAdmin,
          canEnterSales: true,
          comment: '',
          setComment: () => undefined,
          onUsePrevious:
            data?.inventory?.usePreviousClosing && !data.inventory?.enterBaselineOpening
              ? () => previousMut.mutate()
              : undefined,
          onSavedSales: async () => {
            await qc.invalidateQueries({ queryKey: ['sm', 'recon', stationId] })
          },
          pending: { previous: previousMut.isPending },
          audit: auditQ.data,
          auditLoading: auditQ.isLoading,
        }}
      />
      {previousMut.isError ? (
        <p className="text-sm text-red-400" role="alert">
          {apiErrorMessage(previousMut.error, 'Could not apply previous closing')}
        </p>
      ) : null}
    </div>
  )
}
