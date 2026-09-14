/** Per-nozzle live dispensing session. Not component-local, not a CSS timer. */

export const COMPLETED_PRESENTATION_MS = 9_000
export const STALE_SESSION_MS = 120_000

export type NozzleOpState =
  | 'IDLE'
  | 'READY'
  | 'DISPENSING'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'INTERRUPTED'

export type NozzlePresentation = 'IDLE' | 'READY' | 'DISPENSING' | 'SALE_COMPLETED' | 'LAST_SALE'

export type LastCompletedSale = {
  transactionId: string
  amount: number | null
  volumeLiters: number | null
  pricePerLiter: number | null
  product: string | null
  completedAt: string | null
}

export type NozzleSession = {
  key: string
  stationId: string
  pumpId: string
  nozzleId: string
  state: NozzleOpState
  transactionId: string | null
  amount: number | null
  volumeLiters: number | null
  pricePerLiter: number | null
  product: string | null
  startedAt: string | null
  lastUpdateAt: string | null
  completedAt: string | null
  completedAtMs: number | null
  sequence: number
  lastCompleted: LastCompletedSale | null
  mappingWarning?: string
}

export type NozzleLiveEvent = {
  stationId: string
  pumpId: string
  nozzleId?: string | null
  transactionId: string
  state?: string | null
  status?: string | null
  eventType?: string | null
  amount?: number | null
  volumeLiters?: number | null
  pricePerLiter?: number | null
  product?: string | null
  sequence?: number | null
  startedAt?: string | null
  completedAt?: string | null
  occurredAt?: string | null
  receivedAt?: string | null
  mappingWarning?: string
  sourceIdentifier?: string | null
}

export type ApplySource = 'sse' | 'rest' | 'snapshot' | 'timer' | 'stale'

export type ApplyResult = {
  sessions: Record<string, NozzleSession>
  accepted: boolean
  reason: string
}

const DONE_STATES = new Set(['COMPLETED', 'COMPLETE'])
const CANCEL_STATES = new Set(['CANCELLED', 'CANCELED', 'ABORTED'])
const INTERRUPT_STATES = new Set(['INTERRUPTED', 'STALE'])

export function canonicalNozzleId(value?: string | null): string {
  const text = String(value || '').trim()
  return text || 'unknown'
}

export function sessionKey(stationId: string, pumpId: string, nozzleId?: string | null): string {
  return `${String(stationId || '').trim()}|${String(pumpId || '').trim()}|${canonicalNozzleId(nozzleId)}`
}

export function eventOperationalState(event: NozzleLiveEvent): NozzleOpState {
  const raw = String(event.state || event.status || event.eventType || '').toUpperCase()
  if (
    raw.includes('DISPENSING') ||
    raw.includes('FILLING_UPDATED') ||
    raw.includes('VERIFIED_DISPENSING') ||
    raw === 'IN_PROGRESS' ||
    raw === 'ACTIVE' ||
    raw === 'PROGRESS' ||
    raw.includes('TRANSACTION_STARTED')
  ) {
    return 'DISPENSING'
  }
  if (
    raw.includes('CANCELLED_NO_SALE') ||
    raw.includes('CANCELLED') ||
    raw.includes('CANCELED') ||
    raw.includes('ABORTED')
  ) {
    return 'CANCELLED'
  }
  if (INTERRUPT_STATES.has(raw) || raw.includes('POSSIBLE_UNINTENDED_FLOW')) {
    return 'INTERRUPTED'
  }
  if (
    DONE_STATES.has(raw) ||
    raw.includes('TRANSACTION_COMPLETED') ||
    raw.includes('FILLING_COMPLETED') ||
    raw.includes('SALE_COMPLETED')
  ) {
    return 'COMPLETED'
  }
  // Lift / authorize / FILLING without verified volume → Ready (not Dispensing).
  if (
    raw.includes('FILLING_STARTED') ||
    raw === 'STARTED' ||
    raw === 'READY' ||
    raw === 'AUTHORIZED' ||
    raw.includes('NOZZLE_LIFTED') ||
    raw.includes('NOZZLE_UP')
  ) {
    return 'READY'
  }
  if (raw === 'IDLE') return 'IDLE'
  return 'IDLE'
}

function tsMs(value?: string | null): number {
  if (!value) return 0
  const n = Date.parse(value)
  return Number.isFinite(n) ? n : 0
}

function emptySession(event: NozzleLiveEvent): NozzleSession {
  return {
    key: sessionKey(event.stationId, event.pumpId, event.nozzleId),
    stationId: event.stationId,
    pumpId: event.pumpId,
    nozzleId: canonicalNozzleId(event.nozzleId),
    state: 'IDLE',
    transactionId: null,
    amount: null,
    volumeLiters: null,
    pricePerLiter: null,
    product: event.product ?? null,
    startedAt: null,
    lastUpdateAt: null,
    completedAt: null,
    completedAtMs: null,
    sequence: 0,
    lastCompleted: null,
  }
}

function hasNumeric(value: unknown): value is number {
  return value != null && value !== '' && Number.isFinite(Number(value))
}

function valuesFrom(
  event: NozzleLiveEvent,
  prev: NozzleSession,
  resetLive: boolean,
): Pick<NozzleSession, 'amount' | 'volumeLiters' | 'pricePerLiter' | 'product' | 'startedAt'> {
  const nextAmount = hasNumeric(event.amount) ? Number(event.amount) : null
  const nextVolume = hasNumeric(event.volumeLiters) ? Number(event.volumeLiters) : null
  const nextPrice = hasNumeric(event.pricePerLiter) ? Number(event.pricePerLiter) : null
  if (resetLive) {
    return {
      amount: nextAmount,
      volumeLiters: nextVolume,
      pricePerLiter: nextPrice,
      product: event.product ?? null,
      startedAt: event.startedAt || null,
    }
  }
  // Same transaction: never clear or regress live totals (prevents LCD blink on
  // duplicate/partial events). Only accept numeric advances or first values.
  const sameTx =
    Boolean(event.transactionId) &&
    (event.transactionId === prev.transactionId || prev.transactionId == null)
  const amount =
    nextAmount != null
      ? sameTx && prev.amount != null
        ? Math.max(prev.amount, nextAmount)
        : nextAmount
      : prev.amount
  const volumeLiters =
    nextVolume != null
      ? sameTx && prev.volumeLiters != null
        ? Math.max(prev.volumeLiters, nextVolume)
        : nextVolume
      : prev.volumeLiters
  return {
    amount,
    volumeLiters,
    pricePerLiter: nextPrice != null ? nextPrice : prev.pricePerLiter,
    product: event.product ?? prev.product,
    startedAt: event.startedAt || prev.startedAt,
  }
}

function lastFrom(session: NozzleSession, event: NozzleLiveEvent): LastCompletedSale {
  const values = valuesFrom(event, session, false)
  return {
    transactionId: event.transactionId || session.transactionId || '',
    amount: values.amount,
    volumeLiters: values.volumeLiters,
    pricePerLiter: values.pricePerLiter,
    product: values.product,
    completedAt: event.completedAt || event.occurredAt || event.receivedAt || session.completedAt,
  }
}

export function shouldRejectEvent(
  prev: NozzleSession | undefined,
  event: NozzleLiveEvent,
  source: ApplySource,
): string | null {
  if (!prev) return null
  const nextState = eventOperationalState(event)
  const incomingSeq = Number(event.sequence)
  const hasSeq = Number.isFinite(incomingSeq) && incomingSeq > 0
  const sameTx = Boolean(event.transactionId) && event.transactionId === prev.transactionId
  const incomingAmount = hasNumeric(event.amount) ? Number(event.amount) : null
  // Completion is authoritative for the matching active transaction — even when
  // cloud-sync incorrectly reset envelope sequence (progress 17 → completed 2).
  // REST snapshots must still lose to fresher live dispensing totals.
  const completingActive =
    nextState === 'COMPLETED' &&
    (prev.state === 'DISPENSING' || prev.state === 'READY') &&
    (sameTx ||
      (prev.transactionId == null && incomingAmount != null) ||
      incomingAmount == null ||
      prev.amount == null ||
      incomingAmount + 1e-9 >= prev.amount)

  if (source === 'rest' && nextState === 'COMPLETED' && prev.state === 'DISPENSING') {
    const restTs = tsMs(event.occurredAt || event.receivedAt || event.completedAt)
    const liveTs = tsMs(prev.lastUpdateAt)
    if (restTs && liveTs && restTs < liveTs) return 'rest_older_than_live'
    if (
      incomingAmount != null &&
      prev.amount != null &&
      incomingAmount + 1e-9 < prev.amount
    ) {
      return 'stale_completion_totals'
    }
  }

  if (
    nextState === 'COMPLETED' &&
    sameTx &&
    source !== 'rest' &&
    (prev.state === 'DISPENSING' || prev.state === 'READY' || prev.state === 'COMPLETED')
  ) {
    if (prev.state === 'COMPLETED' && hasSeq && incomingSeq === prev.sequence) {
      return 'duplicate_sequence'
    }
    // Accept live/SSE COMPLETED for the live transaction id (incl. reset seq).
  } else if (
    completingActive &&
    incomingAmount != null &&
    prev.amount != null &&
    incomingAmount + 1e-9 < prev.amount
  ) {
    return 'stale_completion_totals'
  }

  if (!(nextState === 'COMPLETED' && sameTx && source !== 'rest') && !completingActive) {
    if (hasSeq && incomingSeq < prev.sequence) return 'stale_sequence'
    if (hasSeq && incomingSeq === prev.sequence && sameTx && nextState === prev.state) {
      return 'duplicate_sequence'
    }
  }
  const incomingTs = tsMs(event.occurredAt || event.receivedAt || event.completedAt)
  const prevTs = tsMs(prev.lastUpdateAt)
  if (
    !(nextState === 'COMPLETED' && sameTx && source !== 'rest') &&
    !completingActive &&
    incomingTs &&
    prevTs &&
    incomingTs < prevTs &&
    source !== 'timer'
  ) {
    return 'stale_timestamp'
  }
  // Late progress after COMPLETED must not reopen the same sale.
  if (
    nextState === 'DISPENSING' &&
    (prev.state === 'COMPLETED' || (prev.state === 'IDLE' && prev.lastCompleted)) &&
    (sameTx || event.transactionId === prev.lastCompleted?.transactionId)
  ) {
    return 'reopen_completed'
  }
  // REST must not overwrite a fresher live/completed session with older totals.
  if (source === 'rest' && prev.state === 'COMPLETED' && nextState === 'COMPLETED') {
    const prevCompletedTs = tsMs(prev.completedAt || prev.lastCompleted?.completedAt || prev.lastUpdateAt)
    if (incomingTs && prevCompletedTs && incomingTs < prevCompletedTs) {
      return 'rest_older_completed'
    }
    if (
      incomingAmount != null &&
      prev.amount != null &&
      incomingAmount + 1e-9 < prev.amount &&
      sameTx
    ) {
      return 'rest_older_totals'
    }
  }
  if (source === 'rest' && prev.state === 'DISPENSING' && nextState !== 'DISPENSING' && nextState !== 'COMPLETED') {
    if (!incomingTs || incomingTs <= prevTs) return 'rest_older_than_live'
  }
  if (source === 'rest' && prev.state === 'COMPLETED' && nextState === 'IDLE') return 'rest_clears_completed'
  return null
}

export function applyNozzleEvent(
  sessions: Record<string, NozzleSession>,
  event: NozzleLiveEvent,
  source: ApplySource = 'sse',
  now = Date.now(),
): ApplyResult {
  const key = sessionKey(event.stationId, event.pumpId, event.nozzleId)
  const prev = sessions[key]
  const reason = shouldRejectEvent(prev, event, source)
  if (reason) return { sessions, accepted: false, reason }
  const nextState = eventOperationalState(event)
  const current = prev || emptySession(event)
  const seq = Number(event.sequence)
  const sequence = Number.isFinite(seq) && seq > 0 ? seq : current.sequence + 1
  const stamp = event.occurredAt || event.receivedAt || new Date(now).toISOString()
  const newLiveTx =
    nextState === 'DISPENSING' &&
    Boolean(event.transactionId) &&
    event.transactionId !== current.transactionId &&
    event.transactionId !== current.lastCompleted?.transactionId
  const values = valuesFrom(event, current, newLiveTx)
  let session: NozzleSession = {
    ...current,
    ...values,
    key,
    pumpId: event.pumpId || current.pumpId,
    nozzleId: canonicalNozzleId(event.nozzleId || current.nozzleId),
    sequence,
    lastUpdateAt: stamp,
    mappingWarning:
      event.mappingWarning ||
      current.mappingWarning ||
      (!event.nozzleId ? 'Missing tank/nozzle mapping' : undefined),
  }

  if (nextState === 'DISPENSING') {
    session = {
      ...session,
      state: 'DISPENSING',
      transactionId: event.transactionId,
      startedAt: values.startedAt || current.startedAt || stamp,
      // New sale cancels any prior completion presentation timer.
      completedAt: null,
      completedAtMs: null,
    }
  } else if (nextState === 'READY') {
    session = {
      ...session,
      state: 'READY',
      transactionId: null,
      completedAt: null,
      completedAtMs: null,
      amount: null,
      volumeLiters: null,
    }
  } else if (nextState === 'COMPLETED') {
    const last = lastFrom(session, event)
    const completedAge = now - (tsMs(last.completedAt) || now)
    const skipPresentation =
      (source === 'rest' || source === 'snapshot') && completedAge > COMPLETED_PRESENTATION_MS
    session = {
      ...session,
      state: skipPresentation ? 'IDLE' : 'COMPLETED',
      transactionId: skipPresentation ? null : event.transactionId,
      completedAt: last.completedAt,
      completedAtMs: skipPresentation ? null : now,
      lastCompleted: last,
      amount: last.amount,
      volumeLiters: last.volumeLiters,
    }
  } else if (nextState === 'CANCELLED' || nextState === 'INTERRUPTED') {
    session = {
      ...session,
      state: nextState,
      transactionId: event.transactionId || current.transactionId,
      completedAtMs: now,
    }
  } else if (nextState === 'IDLE' && current.state !== 'DISPENSING') {
    session = {
      ...session,
      state: 'IDLE',
      transactionId: null,
      amount: current.lastCompleted?.amount ?? current.amount,
      volumeLiters: current.lastCompleted?.volumeLiters ?? current.volumeLiters,
    }
  } else if (nextState === 'IDLE' && current.state === 'DISPENSING' && source === 'rest') {
    return { sessions, accepted: false, reason: 'idle_does_not_clear_live' }
  }

  if (typeof localStorage !== 'undefined' && localStorage.getItem('INTELIPUMP_DEBUG_LIVE') === '1') {
    // eslint-disable-next-line no-console
    console.debug('[intelipump-live]', {
      key,
      prev: current.state,
      next: session.state,
      sequence: session.sequence,
      transactionId: session.transactionId,
      amount: session.amount,
      volumeLiters: session.volumeLiters,
      rejected: null,
      source,
    })
  }

  return { sessions: { ...sessions, [key]: session }, accepted: true, reason: 'applied' }
}

export function applyPresentationElapsed(
  sessions: Record<string, NozzleSession>,
  key: string,
): Record<string, NozzleSession> {
  const prev = sessions[key]
  if (!prev || (prev.state !== 'COMPLETED' && prev.state !== 'CANCELLED' && prev.state !== 'INTERRUPTED')) {
    return sessions
  }
  return {
    ...sessions,
    [key]: {
      ...prev,
      state: 'IDLE',
      transactionId: null,
      completedAtMs: null,
      amount: prev.lastCompleted?.amount ?? prev.amount,
      volumeLiters: prev.lastCompleted?.volumeLiters ?? prev.volumeLiters,
      pricePerLiter: prev.lastCompleted?.pricePerLiter ?? prev.pricePerLiter,
      product: prev.lastCompleted?.product ?? prev.product,
    },
  }
}

export function markStaleSessions(
  sessions: Record<string, NozzleSession>,
  now = Date.now(),
  staleMs = STALE_SESSION_MS,
): Record<string, NozzleSession> {
  let changed = false
  const next = { ...sessions }
  for (const [key, session] of Object.entries(sessions)) {
    if (session.state !== 'DISPENSING') continue
    const age = now - tsMs(session.lastUpdateAt)
    if (age < staleMs) continue
    next[key] = { ...session, state: 'INTERRUPTED', completedAtMs: now }
    changed = true
  }
  return changed ? next : sessions
}

export function presentationOf(session: NozzleSession | undefined, now = Date.now()): NozzlePresentation {
  if (!session) return 'IDLE'
  if (session.state === 'DISPENSING') return 'DISPENSING'
  if (session.state === 'READY') return 'READY'
  if (session.state === 'COMPLETED') {
    if (session.completedAtMs && now - session.completedAtMs < COMPLETED_PRESENTATION_MS) {
      return 'SALE_COMPLETED'
    }
    return session.lastCompleted ? 'LAST_SALE' : 'IDLE'
  }
  if (session.state === 'CANCELLED') return 'IDLE'
  if (session.lastCompleted && (session.amount != null || session.volumeLiters != null)) return 'LAST_SALE'
  return 'IDLE'
}

export function operationalDisplay(session: NozzleSession | undefined, now = Date.now()): string {
  const p = presentationOf(session, now)
  if (p === 'DISPENSING') return 'DISPENSING'
  if (p === 'READY') return 'READY'
  if (p === 'SALE_COMPLETED') return 'SALE_COMPLETED'
  return 'IDLE'
}

function identityList(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((v) => String(v || '').trim()).filter(Boolean))]
}

function isGenericNozzleToken(value?: string | null, channel?: string | null): boolean {
  const token = String(value || '').trim().toLowerCase()
  if (!token || token === 'unknown' || token === '1' || token === '01' || token === '0' || token === 'null') {
    return true
  }
  // Pi default_mapping assigns every DART address nozzle-1. When the channel is
  // legacy pump-2 (Nozzle 2 sourceIdentifier), that nozzle-1 is NOT physical Nozzle 1.
  if ((token === 'nozzle-1' || token === 'n1') && channel) {
    const ch = String(channel).trim().toLowerCase()
    if (ch && ch !== 'pump-1' && ch !== '1' && ch !== 'nozzle-1') return true
  }
  return false
}

function isExactNozzleToken(value?: string | null): boolean {
  const token = String(value || '').trim().toLowerCase()
  return /^nozzle-\d+$/i.test(token) || /^n\d+$/i.test(token)
}

function sessionMatchesNozzle(
  session: NozzleSession,
  nozzleIds: string[],
  pumpIds: string[] = [],
): boolean {
  const nozzleId = String(session.nozzleId || '').trim()
  const pumpId = String(session.pumpId || '').trim()
  const sessionExact = isExactNozzleToken(nozzleId)
  const queryExact = nozzleIds.filter(isExactNozzleToken)

  // Hard isolation: nozzle-1 events never match nozzle-2 queries (and vice versa),
  // except legacy DART sessions stored as pump-2/nozzle-1 (generic nozzle-1 on
  // channel pump-2) which belong to physical Nozzle 2.
  if (sessionExact && queryExact.length) {
    const sessionCanon = nozzleId.toLowerCase().replace(/^n(\d+)$/, 'nozzle-$1')
    const queryCanons = new Set(
      queryExact.map((n) => n.toLowerCase().replace(/^n(\d+)$/, 'nozzle-$1')),
    )
    if (!queryCanons.has(sessionCanon)) {
      if (nozzleIds.includes(pumpId) && isGenericNozzleToken(nozzleId, pumpId)) {
        return true
      }
      return false
    }
    return pumpIds.includes(pumpId) || nozzleIds.includes(pumpId) || !pumpIds.length
  }

  if (nozzleId && nozzleId !== 'unknown' && nozzleIds.includes(nozzleId)) {
    return pumpIds.includes(pumpId) || nozzleIds.includes(pumpId) || !pumpIds.length
  }
  // Legacy DART channel: pump-2 / missing-or-generic nozzle belongs to the
  // nozzle whose sourceIdentifier is pump-2, never a different exact nozzle-N.
  if (queryExact.length) return false
  if (nozzleIds.includes(pumpId) && (isGenericNozzleToken(nozzleId, pumpId) || nozzleId === pumpId)) {
    return true
  }
  return false
}

export function findSession(
  sessions: Record<string, NozzleSession>,
  stationId: string,
  pumpIds: Array<string | null | undefined>,
  nozzleIds: Array<string | null | undefined>,
): NozzleSession | undefined {
  const pumps = identityList(pumpIds)
  const nozzles = identityList(nozzleIds)
  const station = String(stationId || '').trim()
  if (!nozzles.length) return undefined
  for (const pumpId of pumps) {
    for (const nozzleId of nozzles) {
      const hit = sessions[sessionKey(station, pumpId, nozzleId)]
      if (hit && sessionMatchesNozzle(hit, nozzles, pumps)) return hit
    }
  }
  return Object.values(sessions).find((s) => {
    if (s.stationId && station && s.stationId !== station) return false
    return sessionMatchesNozzle(s, nozzles, pumps)
  })
}

export function flowingSessions(sessions: Record<string, NozzleSession>): NozzleSession[] {
  return Object.values(sessions).filter((s) => s.state === 'DISPENSING' && s.transactionId)
}
