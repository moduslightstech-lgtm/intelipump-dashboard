/** Pull a human-readable message from Axios / FastAPI error payloads. */

export function apiErrorMessage(err: unknown, fallback = 'Request failed'): string {
  const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data
    ?.detail
  if (typeof detail === 'string' && detail.trim()) return detail
  if (Array.isArray(detail)) {
    const parts = detail
      .map((item) => {
        if (typeof item === 'string') return item
        if (!item || typeof item !== 'object') return ''
        const rec = item as { loc?: unknown; msg?: unknown }
        const loc = Array.isArray(rec.loc)
          ? rec.loc.filter((part) => part !== 'body').join(' ')
          : ''
        const msg = typeof rec.msg === 'string' ? rec.msg : ''
        if (loc && msg) return `${loc}: ${msg}`
        return msg
      })
      .filter(Boolean)
    if (parts.length) return parts.join('. ')
  }
  if (detail && typeof detail === 'object' && 'message' in detail) {
    const message = (detail as { message?: unknown }).message
    if (typeof message === 'string' && message.trim()) return message
  }
  const message = (err as { message?: unknown })?.message
  if (typeof message === 'string' && message.trim() && message !== 'Request failed with status code 422') {
    return message
  }
  return fallback
}
