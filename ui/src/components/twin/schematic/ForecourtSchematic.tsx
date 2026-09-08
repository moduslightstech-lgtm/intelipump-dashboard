import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useUpdateNodeInternals,
  type Edge,
  type Node,
  type NodeChange,
  type NodeTypes,
  type EdgeTypes,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { TwinLiveState } from '../../../api/client'
import type { ActiveDispensingState } from '../pipe/pipeTypes'
import {
  buildForecourtNodes,
  canvasSizeFromNodes,
  detectOverlappingEquipment,
  islandInteriorFitsPumps,
  metricsFromMeasured,
  metricsGrew,
  schematicViewportHeight,
  toLayoutPersist,
  topologyKey,
} from './autoLayout'
import { buildConnectionGraph, getConnections, relatedEquipment } from './connectionGraph'
import {
  DEFAULT_METRICS,
  GRID_SIZE,
  MAX_ZOOM,
  MIN_ZOOM,
  PUMP_NODE_HEIGHT,
  PUMP_NODE_WIDTH,
  type LayoutMetrics,
} from './constants'
import { displayPumpStatus } from './display'
import EquipmentDrawer from './EquipmentDrawer'
import { snapToGrid } from './geometry'
import { createHistory } from './layoutHistory'
import MobileSchematicList from './MobileSchematicList'
import IslandSchematicNode from './nodes/IslandSchematicNode'
import MarkerSchematicNode from './nodes/MarkerSchematicNode'
import PumpSchematicNode from './nodes/PumpSchematicNode'
import TankSchematicNode from './nodes/TankSchematicNode'
import PipeEdge from './edges/PipeEdge'
import { isSchematicPipeFlowing } from './pipeFlow'
import { buildManifoldRoutes } from './orthogonalRouting'
import SchematicLegend from './SchematicLegend'
import type { LayoutPersist, SchematicNode, SchematicSelection } from './types'

const nodeTypes: NodeTypes = {
  tank: TankSchematicNode,
  pump: PumpSchematicNode,
  island: IslandSchematicNode,
  marker: MarkerSchematicNode,
}

const edgeTypes: EdgeTypes = {
  pipe: PipeEdge,
}

type Props = {
  state?: TwinLiveState
  activeByPump?: Record<string, ActiveDispensingState>
  selection?: SchematicSelection
  onSelect?: (sel: SchematicSelection) => void
  editMode?: boolean
  canEdit?: boolean
  includeInactive?: boolean
  viewportWidth?: number
  onDraftChange?: (draft: LayoutPersist, dirty: boolean) => void
  onOverlap?: (overlap: boolean) => void
}

function statusById(state?: TwinLiveState) {
  const map = new Map<string, { status: string; raw: Record<string, any>; product?: string }>()
  for (const t of state?.tanks || []) {
    map.set(String(t.id), {
      status: String(t.inferredStatus || t.status || 'UNKNOWN'),
      raw: t,
      product: t.product,
    })
  }
  for (const p of state?.pumps || []) {
    map.set(String(p.id), {
      status: displayPumpStatus(p.inferredStatus || p.status),
      raw: p,
      product: p.product,
    })
    for (const n of p.nozzles || []) {
      map.set(String(n.id), {
        status: displayPumpStatus(n.inferredStatus || n.status),
        raw: { ...n, parentPumpId: p.id, parentPumpName: p.name, assetRole: 'NOZZLE' },
        product: n.product,
      })
    }
  }
  return map
}

function ForecourtSchematicInner({
  state,
  activeByPump = {},
  selection = null,
  onSelect,
  editMode = false,
  canEdit = false,
  includeInactive = false,
  viewportWidth = 1440,
  onDraftChange,
  onOverlap,
}: Props) {
  const flow = useReactFlow()
  const updateNodeInternals = useUpdateNodeInternals()
  const history = useRef(createHistory())
  const editOrigin = useRef<SchematicNode[] | null>(null)
  const lastTopo = useRef('')
  const metricsRef = useRef<LayoutMetrics>({ ...DEFAULT_METRICS })
  const fitKeyRef = useRef('')
  const prevDrawer = useRef(false)
  const lastViewport = useRef(viewportWidth)
  const [boxes, setBoxes] = useState<SchematicNode[]>(() =>
    buildForecourtNodes(state, { viewportWidth, metrics: DEFAULT_METRICS }),
  )
  const [narrow, setNarrow] = useState(false)
  const [overlap, setOverlap] = useState(false)
  const [previewAuto, setPreviewAuto] = useState(false)
  const forceDirtyRef = useRef(false)

  const topo = topologyKey(state)
  const layoutMode = String(state?.layout?.mode || 'AUTO').toUpperCase()
  const isCustom = layoutMode === 'CUSTOM' && Boolean(state?.layout?.items?.length)

  useEffect(() => {
    if (editMode && history.current.canUndo()) return
    if (topo === lastTopo.current && lastTopo.current && lastViewport.current === viewportWidth) return
    lastTopo.current = topo
    lastViewport.current = viewportWidth
    metricsRef.current = { ...DEFAULT_METRICS }
    fitKeyRef.current = ''
    forceDirtyRef.current = false
    setPreviewAuto(false)
    setBoxes(buildForecourtNodes(state, { viewportWidth, metrics: metricsRef.current }))
    history.current.clear()
  }, [topo, viewportWidth, state, editMode])

  useEffect(() => {
    if (editMode && !editOrigin.current) editOrigin.current = boxes
    if (!editMode) editOrigin.current = null
  }, [editMode, boxes])

  useEffect(() => {
    const live = statusById(state)
    setBoxes((prev) =>
      prev.map((n) => {
        const hit = live.get(n.id)
        if (!hit) return n
        return { ...n, status: hit.status, product: hit.product ?? n.product, raw: { ...n.raw, ...hit.raw } }
      }),
    )
  }, [state?.tanks, state?.pumps, state?.lastUpdatedAt])

  const connections = useMemo(() => getConnections(state), [state])
  const graph = useMemo(
    () => buildConnectionGraph(boxes, connections, { includeInactive }),
    [boxes, connections, includeInactive],
  )
  const routes = useMemo(() => buildManifoldRoutes(boxes, graph.edges).routes, [boxes, graph.edges])
  const size = canvasSizeFromNodes(boxes)

  useEffect(() => {
    onDraftChange?.(toLayoutPersist(boxes), editMode || forceDirtyRef.current)
    setOverlap(detectOverlappingEquipment(boxes))
    onOverlap?.(detectOverlappingEquipment(boxes))
  }, [boxes, editMode, onDraftChange, onOverlap])

  const selectedTank = selection?.kind === 'TANK' ? selection.node.id : null
  const selectedPump = selection?.kind === 'PUMP' ? selection.node.id : null
  const selectedPhysical =
    selection?.kind === 'PUMP' && selection.node.raw?.assetRole === 'PHYSICAL_PUMP'
      ? String(selection.node.assetId || selection.node.raw?.id || '')
      : selection?.kind === 'ISLAND'
        ? String(selection.node.assetId || selection.node.raw?.id || '')
        : null
  const selectedPipe = selection?.kind === 'PIPE' ? selection.routeId : null

  const related = useMemo(() => {
    const base = relatedEquipment(graph.edges, {
      tankId: selectedTank,
      pumpId: selectedPhysical ? null : selectedPump,
      physicalPumpId: selectedPhysical,
      pipeId: selectedPipe,
    })
    for (const s of Object.values(activeByPump)) {
      if (s.phase === 'DISPENSING') {
        if (s.tankId) base.tanks.add(s.tankId)
        if (s.pumpId) base.pumps.add(s.pumpId)
      }
    }
    return {
      ...base,
      active: Boolean(selectedTank || selectedPump || selectedPhysical || selectedPipe),
    }
  }, [graph.edges, selectedTank, selectedPump, selectedPhysical, selectedPipe, activeByPump])

  const unconnected = useMemo(
    () => new Set(graph.warnings.filter((w) => w.code === 'UNCONNECTED_PUMP').map((w) => w.pumpId)),
    [graph.warnings],
  )
  const unmapped = useMemo(
    () => new Set(graph.warnings.filter((w) => w.code === 'PRODUCT_NOT_MAPPED').map((w) => w.pumpId)),
    [graph.warnings],
  )

  const rfNodes: Node[] = useMemo(() => {
    const islands = boxes.filter((n) => n.kind === 'ISLAND')
    const pumps = boxes.filter((n) => n.kind === 'PUMP')
    const nestable = new Set(
      islands.filter((island) => islandInteriorFitsPumps(island, pumps)).map((i) => i.id),
    )
    const out: Node[] = []
    for (const island of islands) {
      const islandPumps = pumps.filter((p) => p.parentId === island.id || p.islandId === island.id)
      const dim = related.active && !islandPumps.some((p) => related.pumps.has(p.id))
      out.push({
        id: island.id,
        type: 'island',
        position: { x: island.x, y: island.y },
        style: { width: island.w, height: island.h },
        data: { label: island.label, dimmed: dim, status: island.status },
        draggable: editMode && canEdit,
        selectable: true,
        zIndex: 1,
      })
    }
    for (const n of boxes) {
      if (n.kind === 'FORECOURT' || n.kind === 'LABEL' || n.kind === 'ISLAND') continue
      const nest = Boolean(n.parentId && nestable.has(n.parentId))
      const parent = nest ? boxes.find((b) => b.id === n.parentId) : null
      const pos = parent
        ? { x: n.x - parent.x, y: n.y - parent.y }
        : { x: n.x, y: n.y }
      if (n.kind === 'TANK') {
        out.push({
          id: n.id,
          type: 'tank',
          position: pos,
          style: { width: n.w, height: n.h },
          data: {
            node: n,
            dimmed: related.active && !related.tanks.has(n.id),
            highlighted: related.tanks.has(n.id),
          },
          draggable: editMode && canEdit,
          zIndex: 3,
        })
      } else if (n.kind === 'PUMP') {
        const w = PUMP_NODE_WIDTH
        const h = Math.max(n.h, PUMP_NODE_HEIGHT)
        out.push({
          id: n.id,
          type: 'pump',
          position: pos,
          parentId: nest ? n.parentId : undefined,
          width: w,
          height: h,
          style: { width: w, height: h, minWidth: w, boxSizing: 'border-box' },
          data: {
            node: { ...n, w, h },
            dimmed: related.active && !related.pumps.has(n.id),
            highlighted:
              related.pumps.has(n.id) ||
              Boolean(
                activeByPump[n.id] ||
                  activeByPump[n.raw?.mqttPumpId] ||
                  activeByPump[n.raw?.sourceIdentifier],
              ),
            unconnected: unconnected.has(n.id),
            productMissing: unmapped.has(n.id),
          },
          draggable: false,
          zIndex: 4,
        })
      } else {
        out.push({
          id: n.id,
          type: 'marker',
          position: pos,
          style: { width: n.w, height: n.h },
          data: {
            kind: n.kind,
            label: n.label,
            dimmed: related.active,
          },
          draggable: editMode && canEdit,
          zIndex: 2,
        })
      }
    }
    return out
  }, [boxes, editMode, canEdit, related, activeByPump, unconnected, unmapped])

  const rfEdges: Edge[] = useMemo(
    () =>
      routes.map((r) => {
        const pump = boxes.find((n) => n.kind === 'PUMP' && n.id === r.pumpId)
        const flowing = isSchematicPipeFlowing(r, pump, activeByPump)
        return {
          id: r.id,
          source: r.tankId,
          target: r.pumpId,
          sourceHandle: 'out',
          targetHandle: 'in',
          type: 'pipe',
          selectable: true,
          zIndex: flowing ? 1 : 0,
          data: {
            path: r.path,
            product: r.product,
            role: r.mappingSource,
            dimmed: related.active && !related.pipes.has(r.id) && !flowing,
            highlighted: related.pipes.has(r.id) || flowing,
            flowing,
            label: `${r.product || 'Fuel'} · ${r.mappingSource}`,
          },
        }
      }),
    [routes, related, boxes, activeByPump],
  )

  const applyMeasuredLayout = useCallback(() => {
    const rf = flow.getNodes()
    const pumpNodes = rf.filter((n) => n.type === 'pump')
    const tankNodes = rf.filter((n) => n.type === 'tank')
    const dimsReady =
      (pumpNodes.length === 0 || pumpNodes.every((n) => (n.measured?.width || 0) > 0 && (n.measured?.height || 0) > 0)) &&
      (tankNodes.length === 0 || tankNodes.every((n) => (n.measured?.width || 0) > 0 && (n.measured?.height || 0) > 0))
    if (!dimsReady) return false
    const measured = metricsFromMeasured(
      rf.map((n) => ({
        type: n.type,
        width: n.measured?.width,
        height: n.measured?.height,
      })),
      metricsRef.current,
    )
    const allowRelayout = previewAuto || !isCustom
    if (!metricsGrew(metricsRef.current, measured) || !allowRelayout || editMode) return true
    metricsRef.current = measured
    setBoxes(buildForecourtNodes(state, { viewportWidth, metrics: measured }))
    return false
  }, [editMode, flow, isCustom, previewAuto, state, viewportWidth])

  const fitAll = useCallback(
    (padding: number | { top: number; right: number; bottom: number; left: number } = 0.14) => {
      flow.fitView({ padding, minZoom: MIN_ZOOM, maxZoom: 1.05, duration: 0 })
    },
    [flow],
  )

  useEffect(() => {
    let cancelled = false
    const frame = window.requestAnimationFrame(() => {
      rfNodes.forEach((n) => updateNodeInternals(n.id))
      window.requestAnimationFrame(() => {
        if (cancelled) return
        const ready = applyMeasuredLayout()
        if (ready && fitKeyRef.current !== topo) {
          fitKeyRef.current = topo
          fitAll()
        }
      })
    })
    return () => {
      cancelled = true
      window.cancelAnimationFrame(frame)
    }
  }, [applyMeasuredLayout, fitAll, rfNodes, topo, updateNodeInternals, boxes])

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      if (!changes.some((c) => c.type === 'dimensions')) return
      window.requestAnimationFrame(() => {
        applyMeasuredLayout()
      })
    },
    [applyMeasuredLayout],
  )

  const onNodeClick = useCallback(
    (_: unknown, node: Node) => {
      const box = boxes.find((b) => b.id === node.id)
      if (!box) return
      if (box.kind === 'TANK') onSelect?.({ kind: 'TANK', node: box })
      else if (box.kind === 'ISLAND') {
        onSelect?.({
          kind: 'PUMP',
          node: { ...box, raw: { ...box.raw, assetRole: 'PHYSICAL_PUMP' } },
        })
      }
      else if (box.kind === 'PUMP') onSelect?.({ kind: 'PUMP', node: box })
      else if (box.kind === 'OFFICE' || box.kind === 'ENTRANCE' || box.kind === 'EXIT') {
        onSelect?.({ kind: box.kind, node: box })
      }
    },
    [boxes, onSelect],
  )

  const onEdgeClick = useCallback(
    (_: unknown, edge: Edge) => {
      onSelect?.({ kind: 'PIPE', routeId: edge.id })
    },
    [onSelect],
  )

  const onPaneClick = useCallback(() => onSelect?.(null), [onSelect])

  const onNodeDragStart = useCallback(() => {
    if (editMode) history.current.push(boxes)
  }, [editMode, boxes])

  const onNodeDragStop = useCallback(
    (_: unknown, node: Node) => {
      if (!editMode || !canEdit) return
      const x = snapToGrid(node.position.x, GRID_SIZE)
      const y = snapToGrid(node.position.y, GRID_SIZE)
      setBoxes((prev) => {
        const current = prev.find((n) => n.id === node.id)
        if (!current) return prev
        if (current.kind === 'ISLAND') {
          const dx = x - current.x
          const dy = y - current.y
          return prev.map((n) =>
            n.id === current.id || n.parentId === current.id
              ? { ...n, x: n.x + dx, y: n.y + dy }
              : n,
          )
        }
        return prev.map((n) => (n.id === current.id ? { ...n, x, y } : n))
      })
    },
    [editMode, canEdit],
  )

  const resetView = useCallback(() => {
    fitAll()
  }, [fitAll])

  const drawerOpen = Boolean(selection)
  useEffect(() => {
    if (prevDrawer.current === drawerOpen) return
    prevDrawer.current = drawerOpen
    if (fitKeyRef.current !== topo) return
    fitAll(
      drawerOpen ? { top: 0.12, left: 0.1, bottom: 0.12, right: 0.24 } : 0.14,
    )
  }, [drawerOpen, fitAll, topo])

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)')
    const apply = () => setNarrow(mq.matches)
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])

  const autoArrange = () => {
    if (!canEdit) return
    history.current.push(boxes)
    metricsRef.current = { ...DEFAULT_METRICS }
    fitKeyRef.current = ''
    forceDirtyRef.current = true
    setPreviewAuto(true)
    setBoxes(
      buildForecourtNodes(
        { ...state, layout: { ...(state?.layout || {}), mode: 'AUTO', items: [] } },
        { viewportWidth, metrics: metricsRef.current },
      ),
    )
  }

  const undo = () => {
    const next = history.current.undo(boxes)
    if (next) setBoxes(next)
  }
  const redo = () => {
    const next = history.current.redo(boxes)
    if (next) setBoxes(next)
  }
  const cancelEdit = () => {
    if (editOrigin.current) setBoxes(editOrigin.current)
    history.current.clear()
  }

  const paneH = schematicViewportHeight({
    physicalPumpCount: boxes.filter((n) => n.kind === 'ISLAND').length,
    canvasHeight: size.height,
    viewportHeight: typeof window === 'undefined' ? 900 : window.innerHeight,
  })
  const showMini = size.width > viewportWidth || boxes.filter((n) => n.kind === 'PUMP').length > 8
  const products = Array.from(new Set(boxes.filter((n) => n.kind === 'TANK').map((n) => String(n.product || ''))))
  const configWarnings = graph.warnings.filter((w) =>
    ['MISSING_REF', 'DUAL_PRIMARY'].includes(w.code),
  )

  return (
    <div className="space-y-3" data-testid="forecourt-map" data-edit-mode={editMode ? 'true' : 'false'}>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
        <span>
          Forecourt schematic · Layout{' '}
          <span className="text-slate-200">
            {previewAuto ? 'AUTO preview' : state?.layout?.mode || 'AUTO'}
          </span>
          {editMode ? (
            <span className="ml-2 rounded border border-amber-700 bg-amber-950/50 px-2 py-0.5 text-amber-200">
              Editing layout
            </span>
          ) : (
            <span className="ml-2 text-slate-500">Read-only map</span>
          )}
        </span>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => flow.zoomIn()}>
            Zoom in
          </button>
          <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => flow.zoomOut()}>
            Zoom out
          </button>
          <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => fitAll()} data-testid="fit-all">
            Fit all equipment
          </button>
          <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={resetView} data-testid="reset-view">
            Reset view
          </button>
        </div>
      </div>

      {editMode && canEdit && (
        <div className="flex flex-wrap gap-2" data-testid="edit-toolbar">
          <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={undo}>
            Undo
          </button>
          <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={redo}>
            Redo
          </button>
          <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={cancelEdit} data-testid="cancel-edit">
            Cancel
          </button>
          <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={autoArrange} data-testid="auto-arrange-toolbar">
            Auto arrange
          </button>
        </div>
      )}

      {overlap ? (
        <div
          className="flex flex-wrap items-center justify-between gap-2 rounded border border-amber-800 bg-amber-950/40 px-3 py-2 text-xs text-amber-100"
          data-testid="layout-overlap-warning"
        >
          <span>This saved layout contains overlapping equipment.</span>
          {canEdit ? (
            <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={autoArrange} data-testid="auto-arrange">
              Auto arrange
            </button>
          ) : null}
        </div>
      ) : null}
      {previewAuto && canEdit ? (
        <div className="rounded border border-cyan-800 bg-cyan-950/30 px-3 py-2 text-xs text-cyan-100">
          Previewing a corrected automatic layout. Save layout to keep it, or Reset layout to persist AUTO on the server.
        </div>
      ) : null}

      {configWarnings.length > 0 && (
        <div className="rounded border border-amber-800 bg-amber-950/40 px-3 py-2 text-xs text-amber-100">
          {configWarnings.map((w) => w.message).join(' · ')}
        </div>
      )}
      {state?.connectionMappingMessage && !state.connectionMappingConfigured && (
        <div className="rounded border border-amber-800 bg-amber-950/40 px-3 py-2 text-xs text-amber-100">
          {state.connectionMappingMessage}
        </div>
      )}

      {narrow ? (
        <MobileSchematicList nodes={boxes} selection={selection} onSelect={(s) => onSelect?.(s)} />
      ) : null}

      <div className={`relative ${narrow ? 'hidden md:block' : ''}`}>
        <div
          className={`overflow-hidden rounded-lg border border-slate-800 bg-slate-950 w-full ${
            editMode ? 'cursor-grab' : 'cursor-default'
          }`}
          style={{ height: paneH }}
          data-testid="schematic-canvas"
        >
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onNodeClick={onNodeClick}
            onEdgeClick={onEdgeClick}
            onPaneClick={onPaneClick}
            onNodeDragStart={onNodeDragStart}
            onNodeDragStop={onNodeDragStop}
            nodesDraggable={editMode && canEdit}
            nodesConnectable={false}
            elementsSelectable
            panOnDrag
            zoomOnScroll
            snapToGrid={editMode}
            snapGrid={[GRID_SIZE, GRID_SIZE]}
            minZoom={MIN_ZOOM}
            maxZoom={MAX_ZOOM}
            proOptions={{ hideAttribution: false }}
            defaultEdgeOptions={{ zIndex: 0 }}
          >
            <Background color="#1e293b" gap={24} />
            <Controls showInteractive={false} />
            {showMini ? <MiniMap pannable zoomable maskColor="rgba(2,6,23,0.7)" /> : null}
          </ReactFlow>
        </div>
        <EquipmentDrawer
          selection={selection}
          connections={graph.edges}
          nodes={boxes}
          onClose={() => onSelect?.(null)}
        />
      </div>

      <SchematicLegend products={products} />

      <p className="sr-only" data-testid="layout-size">
        {size.width}x{size.height}
      </p>
    </div>
  )
}

export default function ForecourtSchematic(props: Props) {
  return (
    <ReactFlowProvider>
      <ForecourtSchematicInner {...props} />
    </ReactFlowProvider>
  )
}

export { autoArrangeNodes } from './autoLayout'
