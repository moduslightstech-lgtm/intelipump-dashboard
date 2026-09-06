import { memo } from 'react'
import { PIPE_THEME } from './pipeTheme'
import type { PipeRoute } from './pipeTypes'

type Props = {
  route: PipeRoute
}

/** Animated dash flow along an active pipe (tank → pump). */
function ActivePipeFlow({ route }: Props) {
  return (
    <g data-testid={`pipe-flow-${route.id}`} pointerEvents="none">
      <path
        d={route.path}
        fill="none"
        stroke={PIPE_THEME.active.glow}
        strokeWidth={PIPE_THEME.active.strokeWidth + 4}
        strokeLinecap="round"
        opacity={0.35}
      />
      <path
        d={route.path}
        fill="none"
        stroke={PIPE_THEME.active.stroke}
        strokeWidth={PIPE_THEME.active.strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray="10 8"
        className="pipe-flow-dash"
      />
      {/* lightweight particles */}
      {[0, 0.33, 0.66].map((offset, i) => (
        <circle key={i} r={2.8} fill={PIPE_THEME.active.stroke} opacity={0.9}>
          <animateMotion
            dur="1.1s"
            repeatCount="indefinite"
            begin={`${offset}s`}
            path={route.path}
            keyPoints="0;1"
            keyTimes="0;1"
            calcMode="linear"
          />
        </circle>
      ))}
    </g>
  )
}

export default memo(ActivePipeFlow)
