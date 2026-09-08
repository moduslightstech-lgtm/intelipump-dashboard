import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  fmtTime,
  getTwinLiveState,
  putTwinLayout,
  resetTwinLayout,
  type StationSearchItem,
} from '../api/client'
import { useAuth } from '../context/AuthContext'
import StationSearchCombobox from '../components/StationSearchCombobox'
import ConfirmDialog from '../components/ConfirmDialog'
import OperationalTwinView from '../components/twin/OperationalTwinView'
import {
  FIXTURE_STATION_ID,
  fourTankTwelvePumpState,
} from '../components/twin/schematic/fourByTwelveFixture'
import type { LayoutPersist } from '../components/twin/schematic/types'
import {
  getTwinViewPreference,
  setTwinViewPreference,
  type TwinViewMode,
} from '../lib/twinViewPreference'
import { useDispensingPlayback } from '../hooks/useDispensingPlayback'
import { normalizeRole } from '../lib/roles'

const BabylonStationTwin = lazy(() => import('../components/BabylonStationTwin'))

const LAST_TWIN_KEY = 'intelipump.lastTwinStation'
const IS_DEV = import.meta.env.DEV

function isStale(iso?: string | null) {
  if (!iso) return true
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return true
  return Date.now() - t > 60_000
}

export default function DigitalTwinPage() {
  const { stationId: routeStationId } = useParams<{ stationId?: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { user } = useAuth()
  const role = normalizeRole(user?.role)
  const canEdit = role === 'ADMIN'

  const [stationId, setStationId] = useState(
    () => routeStationId || localStorage.getItem(LAST_TWIN_KEY) || '',
  )
  const [selectedLabel, setSelectedLabel] = useState('')
  const [viewMode, setViewMode] = useState<TwinViewMode>(() => getTwinViewPreference())
  const [forceDemo, setForceDemo] = useState(false)
  const [editLayout, setEditLayout] = useState(false)
  const [includeInactive, setIncludeInactive] = useState(false)
  const [sceneDiag, setSceneDiag] = useState<Record<string, unknown> | null>(null)
  const [layoutDraft, setLayoutDraft] = useState<LayoutPersist | null>(null)
  const [layoutDirty, setLayoutDirty] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)

  useEffect(() => {
    if (routeStationId) {
      setStationId(routeStationId)
      localStorage.setItem(LAST_TWIN_KEY, routeStationId)
    }
  }, [routeStationId])

  const isFixture = stationId === FIXTURE_STATION_ID

  const twinQ = useQuery({
    queryKey: ['twin', 'live-state', stationId, includeInactive],
    queryFn: async () => {
      if (isFixture) return fourTankTwelvePumpState()
      return (await getTwinLiveState(stationId, { touch: true, includeInactive })).data
    },
    enabled: !!stationId,
    refetchInterval: viewMode === 'operational' && !isFixture ? 45_000 : false,
  })

  useEffect(() => {
    const onLeave = (e: BeforeUnloadEvent) => {
      if (!layoutDirty || !editLayout) return
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onLeave)
    return () => window.removeEventListener('beforeunload', onLeave)
  }, [layoutDirty, editLayout])

  const anim = useDispensingPlayback({
    stationId,
    mqttStationId: twinQ.data?.station?.mqttStationId,
    stationCode: twinQ.data?.station?.stationCode,
    enabled: !!stationId && viewMode === 'operational',
  })

  useEffect(() => {
    if (twinQ.data?.station) {
      const s = twinQ.data.station
      setSelectedLabel(`${s.name} (${s.stationCode})`)
    }
  }, [twinQ.data?.station])

  const onStationChange = (value: string, item?: StationSearchItem) => {
    setStationId(value)
    setForceDemo(false)
    if (item) setSelectedLabel(`${item.name} (${item.stationCode})`)
    if (value) {
      localStorage.setItem(LAST_TWIN_KEY, value)
      navigate(`/digital-twin/${encodeURIComponent(value)}`, { replace: true })
    } else {
      localStorage.removeItem(LAST_TWIN_KEY)
      navigate('/digital-twin', { replace: true })
    }
  }

  const setMode = (mode: TwinViewMode) => {
    setViewMode(mode)
    setTwinViewPreference(mode)
  }

  const saveLayout = useMutation({
    mutationFn: async () => {
      if (!stationId || isFixture) return
      const draft = layoutDraft
      if (!draft?.items?.length) return
      await putTwinLayout(stationId, draft)
    },
    onSuccess: () => {
      setLayoutDirty(false)
      setEditLayout(false)
      qc.invalidateQueries({ queryKey: ['twin'] })
    },
  })

  const resetLayout = useMutation({
    mutationFn: async () => {
      if (!stationId) return
      await resetTwinLayout(stationId)
    },
    onSuccess: () => {
      setLayoutDirty(false)
      setEditLayout(false)
      qc.invalidateQueries({ queryKey: ['twin'] })
    },
  })

  const onDraftChange = useCallback((draft: LayoutPersist, dirty: boolean) => {
    setLayoutDraft(draft)
    if (dirty) setLayoutDirty(true)
  }, [])

  const onMoveLayoutItem = useCallback(
    (id: string, x: number, y: number) => {
      qc.setQueryData(['twin', 'live-state', stationId], (old: any) => {
        if (!old?.layout?.items) return old
        return {
          ...old,
          layout: {
            ...old.layout,
            items: old.layout.items.map((it: any) =>
              it.id === id ? { ...it, x, y } : it,
            ),
          },
        }
      })
    },
    [qc, stationId],
  )

  const onDiagnostics = useCallback((info: Record<string, unknown>) => {
    setSceneDiag(info)
  }, [])

  const live = !!twinQ.data && !isStale(twinQ.data.lastUpdatedAt) && !twinQ.isError
  const diagnostics = twinQ.data?.diagnostics as Record<string, any> | undefined
  const pumps = twinQ.data?.pumps || []
  const tanks = twinQ.data?.tanks || []
  const devices = twinQ.data?.devices || []
  const hasCatalogAssets = !!(pumps.length || tanks.length || devices.length)

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="section-title">Digital Twin</h1>
          <p className="text-slate-400 text-sm mt-1">
            Scalable operational view by default · optional 3D demonstration
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <div
            className="inline-flex rounded-lg border border-slate-700 overflow-hidden text-xs"
            role="tablist"
            aria-label="Twin view mode"
          >
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === 'operational'}
              className={`px-3 py-1.5 ${
                viewMode === 'operational'
                  ? 'bg-slate-100 text-slate-900 font-semibold'
                  : 'bg-slate-900 text-slate-300'
              }`}
              onClick={() => setMode('operational')}
            >
              Operational View
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === '3d'}
              className={`px-3 py-1.5 ${
                viewMode === '3d'
                  ? 'bg-slate-100 text-slate-900 font-semibold'
                  : 'bg-slate-900 text-slate-300'
              }`}
              onClick={() => setMode('3d')}
              data-testid="twin-view-3d"
            >
              3D View
            </button>
          </div>
          <span
            className={`inline-flex items-center gap-2 text-xs px-2.5 py-1 rounded-full border ${
              live
                ? 'border-emerald-700 text-emerald-400 bg-emerald-950/40'
                : 'border-amber-700 text-amber-400 bg-amber-950/40'
            }`}
          >
            <span className={`w-2 h-2 rounded-full ${live ? 'bg-emerald-400' : 'bg-amber-400'}`} />
            {live ? 'Live' : stationId ? 'Stale / loading' : 'Select station'}
          </span>
          <span className="text-xs text-slate-500">Updated {fmtTime(twinQ.data?.lastUpdatedAt)}</span>
        </div>
      </div>

      <div className="card flex flex-wrap items-end gap-3">
        <StationSearchCombobox
          value={stationId}
          selectedLabel={selectedLabel}
          onChange={onStationChange}
        />
        {canEdit && (
          <label className="flex items-center gap-2 text-xs text-slate-300 mb-1">
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(e) => setIncludeInactive(e.target.checked)}
            />
            Include inactive equipment
          </label>
        )}
        {viewMode === '3d' && (
          <button
            type="button"
            className="btn-secondary text-xs mb-1"
            onClick={() => setForceDemo((v) => !v)}
          >
            {forceDemo ? 'Use GLB model' : 'Show demo scene'}
          </button>
        )}
        {IS_DEV && (
          <button
            type="button"
            className="btn-secondary text-xs mb-1"
            data-testid="open-4x12-fixture"
            onClick={() => onStationChange(FIXTURE_STATION_ID)}
          >
            Open 4×12 fixture
          </button>
        )}
        {canEdit && stationId && hasCatalogAssets && viewMode === 'operational' && (
          <div className="flex flex-wrap gap-2 ml-auto pb-1">
            <button
              type="button"
              className="btn-secondary text-xs"
              onClick={() => {
                if (editLayout && layoutDirty && !window.confirm('Discard unsaved layout changes?')) return
                setEditLayout((v) => !v)
              }}
            >
              {editLayout ? 'Done editing' : 'Edit layout'}
            </button>
            <button
              type="button"
              className="btn-secondary text-xs"
              data-testid="reset-layout"
              onClick={() => setConfirmReset(true)}
              disabled={resetLayout.isPending || isFixture}
            >
              Reset layout
            </button>
            <button
              type="button"
              className="btn-primary text-xs"
              data-testid="save-layout"
              onClick={() => saveLayout.mutate()}
              disabled={saveLayout.isPending || isFixture}
            >
              Save layout
            </button>
          </div>
        )}
      </div>

      {!stationId ? (
        <div className="card text-slate-400 text-sm text-center py-16">
          Search for a station to open its Operational Twin. Works for hundreds of stations without
          a custom 3D scene.
        </div>
      ) : twinQ.isError ? (
        <div className="card border-red-800 text-red-300 text-sm space-y-3" role="alert">
          <p>Unable to load station twin API data.</p>
          <button type="button" className="btn-secondary text-xs" onClick={() => twinQ.refetch()}>
            Retry API
          </button>
        </div>
      ) : viewMode === 'operational' ? (
        <div className="space-y-3">
          {!hasCatalogAssets && (
            <div className="text-xs text-amber-100 bg-amber-950/80 border border-amber-700 rounded-lg px-3 py-2">
              No catalog assets yet — map pumps/tanks/devices in Settings.
              {diagnostics?.message ? (
                <span className="block text-amber-300/90 mt-1">{diagnostics.message}</span>
              ) : null}
              <Link to="/settings" className="text-sky-400 hover:underline ml-1">
                Open Settings
              </Link>
            </div>
          )}
          <OperationalTwinView
            state={twinQ.data}
            stationId={stationId}
            activeByPump={anim.activeByPump}
            activePumpId={anim.activePumpId}
            activeTankId={anim.activeTankId}
            activeConnectionId={anim.activeConnectionId}
            phase={anim.phase}
            flashTx={anim.flashTx}
            liveVolume={anim.liveVolume}
            liveAmount={anim.liveAmount}
            restoredPumpIds={anim.restoredPumpIds}
            editMode={editLayout}
            canEdit={canEdit}
            includeInactive={includeInactive}
            onDraftChange={onDraftChange}
            onMoveLayoutItem={onMoveLayoutItem}
          />
        </div>
      ) : (
        <div className="grid lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 space-y-2">
            <div className="text-xs text-slate-400 bg-slate-900 border border-slate-800 rounded-lg px-3 py-2">
              3D View is optional (demo / training). It uses a generic station template — not a
              custom model per site.
            </div>
            <Suspense
              fallback={
                <div className="card text-sm text-slate-400 py-24 text-center">
                  Loading 3D engine…
                </div>
              }
            >
              <BabylonStationTwin
                stationId={stationId}
                forceDemo={forceDemo || !hasCatalogAssets}
                onDiagnostics={onDiagnostics}
              />
            </Suspense>
          </div>
          <div className="card space-y-2 text-sm">
            <h2 className="text-white font-semibold text-sm">3D notes</h2>
            <p className="text-slate-400 text-xs leading-relaxed">
              Prefer Operational View for day-to-day monitoring across many stations. Use 3D for
              stakeholder demos when WebGL is available.
            </p>
            <Row label="Pumps" value={String(pumps.length)} />
            <Row label="Tanks" value={String(tanks.length)} />
            <Row label="Devices" value={String(devices.length)} />
            {IS_DEV && (
              <>
                <Row label="WebGL" value={String(sceneDiag?.webgl ?? '—')} />
                <Row label="Load mode" value={String(sceneDiag?.loadMode ?? '—')} />
              </>
            )}
          </div>
        </div>
      )}
      <ConfirmDialog
        open={confirmReset}
        title="Reset layout?"
        description="This restores the automatic schematic and discards the saved custom layout. Zoom and pan are not affected."
        onClose={() => setConfirmReset(false)}
        footer={
          <>
            <button type="button" className="btn-secondary text-xs" onClick={() => setConfirmReset(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary text-xs"
              data-testid="confirm-reset-layout"
              onClick={() => {
                setConfirmReset(false)
                resetLayout.mutate()
              }}
            >
              Reset layout
            </button>
          </>
        }
      >
        <p className="text-sm text-slate-300">
          Reset view only changes zoom and pan. Reset layout recalculates equipment positions.
        </p>
      </ConfirmDialog>
    </div>
  )
}

function Row({
  label,
  value,
  mono,
}: {
  label: string
  value?: string | null
  mono?: boolean
}) {
  return (
    <div className="flex justify-between gap-3 text-sm">
      <span className="text-slate-500">{label}</span>
      <span className={`text-slate-200 text-right ${mono ? 'font-mono text-xs' : ''}`}>
        {value || '—'}
      </span>
    </div>
  )
}
