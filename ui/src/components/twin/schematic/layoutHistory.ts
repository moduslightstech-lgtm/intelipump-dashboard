import type { SchematicNode } from './types'

export type LayoutSnapshot = {
  nodes: Pick<SchematicNode, 'id' | 'x' | 'y'>[]
}

export function snapshotNodes(nodes: SchematicNode[]): LayoutSnapshot {
  return { nodes: nodes.map((n) => ({ id: n.id, x: n.x, y: n.y })) }
}

export function applySnapshot(nodes: SchematicNode[], snap: LayoutSnapshot): SchematicNode[] {
  const pos = new Map(snap.nodes.map((n) => [n.id, n]))
  return nodes.map((n) => {
    const p = pos.get(n.id)
    return p ? { ...n, x: p.x, y: p.y } : n
  })
}

export function createHistory(limit = 40) {
  let past: LayoutSnapshot[] = []
  let future: LayoutSnapshot[] = []
  return {
    push(current: SchematicNode[]) {
      past = [...past, snapshotNodes(current)].slice(-limit)
      future = []
    },
    undo(current: SchematicNode[]): SchematicNode[] | null {
      const prev = past.pop()
      if (!prev) return null
      future.push(snapshotNodes(current))
      return applySnapshot(current, prev)
    },
    redo(current: SchematicNode[]): SchematicNode[] | null {
      const next = future.pop()
      if (!next) return null
      past.push(snapshotNodes(current))
      return applySnapshot(current, next)
    },
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    clear() {
      past = []
      future = []
    },
  }
}
