import { PMS_LIQUID, TANK_INNER_H, TANK_INNER_W, TANK_INNER_X, TANK_INNER_Y } from '../constants'
import { liquidHeight, tankFillPercent } from '../tankFill'

type Props = {
  tank: Record<string, any>
  product?: string | null
  inactive?: boolean
  missing?: boolean
  reducedMotion?: boolean
}

function liquidColors(product?: string | null) {
  const p = (product || '').toUpperCase()
  if (p.includes('AGO') || p.includes('DIESEL')) {
    return { base: '#C4841A', highlight: '#E8B44A', dark: '#8A5A10' }
  }
  if (p.includes('DPK') || p.includes('KEROSENE')) {
    return { base: '#C9A227', highlight: '#E6C75A', dark: '#8C7010' }
  }
  return PMS_LIQUID
}

export default function CylindricalTank({
  tank,
  product,
  inactive,
  missing,
  reducedMotion,
}: Props) {
  const fill = missing ? 0 : tankFillPercent(tank)
  const colors = liquidColors(product)
  const uid = String(tank.id || tank.tankCode || 'tank').replace(/[^a-zA-Z0-9_-]/g, '')
  const innerY = TANK_INNER_Y
  const innerH = TANK_INNER_H
  const innerX = TANK_INNER_X
  const innerW = TANK_INNER_W
  const liqH = liquidHeight(fill, innerH)
  const liqY = innerY + innerH - liqH
  const surfaceY = liqY
  const wave = !reducedMotion && fill > 2 && fill < 98

  return (
    <svg
      viewBox="0 0 200 78"
      className={`h-[78px] w-full ${inactive ? 'saturate-0 opacity-80' : ''}`}
      aria-hidden
      data-testid="tank-cylinder"
      data-fill={fill.toFixed(1)}
    >
      <defs>
        <linearGradient id={`shell-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#64748b" />
          <stop offset="35%" stopColor="#334155" />
          <stop offset="100%" stopColor="#0f172a" />
        </linearGradient>
        <linearGradient id={`fuel-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={colors.highlight} />
          <stop offset="45%" stopColor={colors.base} />
          <stop offset="100%" stopColor={colors.dark} />
        </linearGradient>
        <clipPath id={`clip-${uid}`}>
          <rect x={innerX} y={innerY} width={innerW} height={innerH} rx={innerH / 2} ry={innerH / 2} />
        </clipPath>
      </defs>
      <rect x="4" y="4" width="192" height="70" rx="35" fill={`url(#shell-${uid})`} stroke="#94a3b8" strokeWidth="1.5" />
      <ellipse cx="39" cy="39" rx="12" ry="28" fill="#94a3b8" opacity="0.18" />
      <ellipse cx="161" cy="39" rx="12" ry="28" fill="#0f172a" opacity="0.35" />
      <rect x="18" y="10" width="164" height="10" rx="5" fill="#e2e8f0" opacity="0.12" />
      <g clipPath={`url(#clip-${uid})`} data-testid="tank-liquid" data-liquid-height={liqH.toFixed(2)}>
        {!missing && fill > 0 ? (
          <>
            <rect x={innerX} y={liqY} width={innerW} height={liqH} fill={`url(#fuel-${uid})`} />
            {wave ? (
              <path
                data-testid="tank-liquid-wave"
                d={`M ${innerX} ${surfaceY} Q ${innerX + innerW / 4} ${surfaceY - 2.2} ${innerX + innerW / 2} ${surfaceY} T ${innerX + innerW} ${surfaceY} V ${surfaceY + 4} H ${innerX} Z`}
                fill={colors.highlight}
                opacity="0.45"
              />
            ) : (
              <rect data-testid="tank-liquid-surface" x={innerX} y={surfaceY} width={innerW} height="2" fill={colors.highlight} opacity="0.7" />
            )}
          </>
        ) : null}
      </g>
      <rect x="4" y="4" width="192" height="70" rx="35" fill="none" stroke="#cbd5e1" strokeWidth="0.6" opacity="0.35" />
      <circle cx="100" cy="74" r="3.5" fill="#cbd5e1" stroke="#64748b" data-testid="tank-outlet" />
    </svg>
  )
}
