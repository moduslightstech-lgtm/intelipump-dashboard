export const PIPE_THEME = {
  inactive: {
    stroke: '#475569',
    strokeWidth: 2.5,
    opacity: 0.75,
  },
  active: {
    stroke: '#22c55e',
    strokeWidth: 4,
    opacity: 1,
    glow: 'rgba(34, 197, 94, 0.45)',
  },
  warning: {
    stroke: '#f59e0b',
    strokeWidth: 3,
    opacity: 0.95,
  },
  fault: {
    stroke: '#ef4444',
    strokeWidth: 3,
    opacity: 0.95,
  },
  trunk: {
    stroke: '#334155',
    strokeWidth: 5,
    opacity: 0.9,
  },
  product: {
    PMS: '#2563eb',
    AGO: '#ca8a04',
    DPK: '#7c3aed',
    DEFAULT: '#64748b',
  },
} as const

export function productPipeColor(product?: string | null): string {
  const p = (product || '').toUpperCase()
  if (p.includes('AGO') || p.includes('DIESEL')) return PIPE_THEME.product.AGO
  if (p.includes('DPK') || p.includes('KEROSENE')) return PIPE_THEME.product.DPK
  if (p.includes('PMS') || p.includes('PETROL') || p.includes('GASOLINE')) return PIPE_THEME.product.PMS
  return PIPE_THEME.product.DEFAULT
}
