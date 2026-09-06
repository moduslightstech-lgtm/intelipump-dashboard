const DEFAULT_TTL_MS = 10 * 60 * 1000
const MAX_ENTRIES = 200

/**
 * Bounded TTL cache of recently animated transaction IDs to prevent duplicate playback.
 */
export function createRecentTransactionDedup(opts?: { ttlMs?: number; max?: number }) {
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS
  const max = opts?.max ?? MAX_ENTRIES
  const seen = new Map<string, number>()

  const prune = (now: number) => {
    for (const [id, ts] of seen) {
      if (now - ts > ttlMs) seen.delete(id)
    }
    while (seen.size > max) {
      const oldest = seen.keys().next().value
      if (oldest == null) break
      seen.delete(oldest)
    }
  }

  return {
    has(transactionId: string | undefined | null): boolean {
      if (!transactionId) return false
      const now = Date.now()
      prune(now)
      return seen.has(transactionId)
    },
    remember(transactionId: string | undefined | null): void {
      if (!transactionId) return
      const now = Date.now()
      prune(now)
      seen.set(transactionId, now)
    },
    size(): number {
      return seen.size
    },
    clear(): void {
      seen.clear()
    },
  }
}

export function useRecentTransactionDedup(opts?: { ttlMs?: number; max?: number }) {
  // Stable singleton per hook instance
  const ref = (globalThis as any).__intelipumpTxDedup as
    | ReturnType<typeof createRecentTransactionDedup>
    | undefined
  if (!ref) {
    const created = createRecentTransactionDedup(opts)
    ;(globalThis as any).__intelipumpTxDedup = created
    return created
  }
  return ref
}
