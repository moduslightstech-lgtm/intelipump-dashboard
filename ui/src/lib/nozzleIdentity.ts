/** Canonical live identity: stationId/pumpId/nozzleId. */

export type NozzleCatalogEntry = {
  physicalPumpId: string
  nozzleId: string
  sourceIdentifier?: string | null
  aliases?: string[]
}

export type CanonicalLiveIdentity = {
  pumpId: string
  nozzleId: string | null
  sourceIdentifier: string | null
  mapped: boolean
  mappingWarning?: string
  receivedPumpId: string
  receivedNozzleId: string | null
}

const GENERIC = new Set(['', 'unknown', 'null', 'none', '1', '01', '0'])
const GENERIC_NAMED = new Set(['nozzle-1', 'n1'])

function norm(value?: string | null): string {
  return String(value || '').trim()
}

function tokens(entry: NozzleCatalogEntry): Set<string> {
  return new Set(
    [entry.nozzleId, entry.physicalPumpId, entry.sourceIdentifier, ...(entry.aliases || [])]
      .map(norm)
      .filter(Boolean),
  )
}

function channelEntry(channel: string, catalog: NozzleCatalogEntry[]): NozzleCatalogEntry | undefined {
  const text = norm(channel)
  if (!text) return undefined
  const exact = catalog.filter((entry) => norm(entry.sourceIdentifier) === text)
  return exact.length === 1 ? exact[0] : undefined
}

function isGenericNozzle(nozzleId: string, channel: string, catalog: NozzleCatalogEntry[]): boolean {
  const token = nozzleId.trim().toLowerCase()
  if (GENERIC.has(token)) return true
  const hit = channelEntry(channel, catalog)
  if (GENERIC_NAMED.has(token)) {
    if (!hit) return true
    const own = norm(hit.nozzleId).toLowerCase()
    const source = norm(hit.sourceIdentifier).toLowerCase()
    if (!GENERIC_NAMED.has(own) && !['pump-1', '1', 'nozzle-1'].includes(source)) return true
  }
  return false
}

function entryForNozzleId(
  nozzleId: string,
  catalog: NozzleCatalogEntry[],
  pumpHint?: string | null,
): NozzleCatalogEntry | undefined {
  const token = norm(nozzleId)
  if (!token) return undefined
  let hits = catalog.filter((entry) => tokens(entry).has(token) && token !== norm(entry.physicalPumpId))
  if (!hits.length) hits = catalog.filter((entry) => tokens(entry).has(token))
  if (pumpHint) {
    const hint = norm(pumpHint)
    const scoped = hits.filter(
      (entry) =>
        hint === norm(entry.physicalPumpId) ||
        hint === norm(entry.sourceIdentifier) ||
        (entry.aliases || []).map(norm).includes(hint),
    )
    if (scoped.length) hits = scoped
  }
  return hits.length === 1 ? hits[0] : undefined
}

export function nozzleStateKey(stationId: string, pumpId: string, nozzleId?: string | null): string {
  return `${norm(stationId)}/${norm(pumpId)}/${norm(nozzleId) || 'unknown'}`
}

export function catalogFromPumps(pumps: Array<Record<string, any>> | undefined | null): NozzleCatalogEntry[] {
  const out: NozzleCatalogEntry[] = []
  for (const pump of pumps || []) {
    const physical = norm(pump.mqttPumpId || pump.pumpCode || pump.id)
    for (const nozzle of pump.nozzles || []) {
      const nozzleId = norm(nozzle.mqttNozzleId || nozzle.nozzleCode || (nozzle.nozzleNumber != null ? `nozzle-${nozzle.nozzleNumber}` : ''))
      const source = norm(nozzle.sourceIdentifier) || null
      const aliases = [
        nozzle.mqttNozzleId,
        nozzle.nozzleCode,
        source,
        nozzle.id,
        nozzle.nozzleNumber != null ? `nozzle-${nozzle.nozzleNumber}` : null,
      ]
        .map(norm)
        .filter(Boolean)
      if (!physical || !nozzleId) continue
      out.push({
        physicalPumpId: physical,
        nozzleId,
        sourceIdentifier: source,
        aliases,
      })
    }
  }
  return out
}

export function canonicalizeLiveIdentity(
  input: {
    pumpId?: string | null
    nozzleId?: string | null
    sourceIdentifier?: string | null
  },
  catalog: NozzleCatalogEntry[] = [],
): CanonicalLiveIdentity {
  const receivedPumpId = norm(input.pumpId)
  const receivedNozzleId = norm(input.nozzleId) || null
  const source = norm(input.sourceIdentifier) || null
  const channel = source || receivedPumpId
  if (!catalog.length) {
    return {
      pumpId: receivedPumpId,
      nozzleId: receivedNozzleId,
      sourceIdentifier: source || receivedPumpId,
      mapped: Boolean(receivedNozzleId),
      mappingWarning: receivedNozzleId ? undefined : 'Missing tank/nozzle mapping',
      receivedPumpId,
      receivedNozzleId,
    }
  }
  const channelHit = channelEntry(channel, catalog)
  const generic = isGenericNozzle(receivedNozzleId || '', channel, catalog)
  const specific =
    receivedNozzleId && !generic
      ? entryForNozzleId(receivedNozzleId, catalog, channelHit?.physicalPumpId || receivedPumpId)
      : undefined
  const chosen = specific || (channelHit && (generic || !receivedNozzleId || !specific) ? channelHit : undefined)
  if (chosen) {
    return {
      pumpId: chosen.physicalPumpId,
      nozzleId: chosen.nozzleId,
      sourceIdentifier: source || chosen.sourceIdentifier || receivedPumpId,
      mapped: true,
      receivedPumpId,
      receivedNozzleId,
    }
  }
  return {
    pumpId: receivedPumpId,
    nozzleId: receivedNozzleId,
    sourceIdentifier: source || receivedPumpId,
    mapped: false,
    mappingWarning: 'Requires mapping',
    receivedPumpId,
    receivedNozzleId,
  }
}
