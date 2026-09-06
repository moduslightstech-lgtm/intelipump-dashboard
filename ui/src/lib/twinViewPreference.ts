export type TwinViewMode = 'operational' | '3d'

const KEY = 'intelipump.twinView'

export function getTwinViewPreference(): TwinViewMode {
  try {
    const v = localStorage.getItem(KEY)
    if (v === '3d' || v === 'operational') return v
  } catch {
    /* ignore */
  }
  return 'operational'
}

export function setTwinViewPreference(mode: TwinViewMode) {
  try {
    localStorage.setItem(KEY, mode)
  } catch {
    /* ignore */
  }
}
