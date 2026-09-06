import { apiUrls } from '../config/api'
import {
  parseRecentSales,
  parseSalesSummary,
  type RecentSalesResponse,
  type SalesSummary,
} from '../types/sales'

export class SalesApiError extends Error {
  status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'SalesApiError'
    this.status = status
  }
}

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, {
    signal,
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) {
    throw new SalesApiError(`Sales API ${res.status}`, res.status)
  }
  return res.json()
}

export async function fetchRecentSales(
  stationId: string,
  opts?: { limit?: number; pumpId?: string; signal?: AbortSignal },
): Promise<RecentSalesResponse> {
  const id = stationId.trim()
  if (!id) throw new SalesApiError('stationId is required', 422)
  const raw = await getJson(
    apiUrls.recentSales(id, opts?.limit ?? 50, opts?.pumpId),
    opts?.signal,
  )
  return parseRecentSales(raw)
}

export async function fetchSalesSummary(
  stationId: string,
  signal?: AbortSignal,
): Promise<SalesSummary> {
  const id = stationId.trim()
  if (!id) throw new SalesApiError('stationId is required', 422)
  return parseSalesSummary(await getJson(apiUrls.salesSummary(id), signal))
}
