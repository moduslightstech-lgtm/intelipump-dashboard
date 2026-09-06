import { useEffect, useId, useRef, useState } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import {
  getStationSearchMeta,
  searchStations,
  type StationSearchItem,
} from '../api/client'

type Props = {
  value: string
  selectedLabel?: string
  onChange: (stationIdOrCode: string, item?: StationSearchItem) => void
}

export default function StationSearchCombobox({ value, selectedLabel, onChange }: Props) {
  const listId = useId()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  const [highlight, setHighlight] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 300)
    return () => clearTimeout(t)
  }, [q])

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const metaQ = useQuery({
    queryKey: ['stations', 'search-meta'],
    queryFn: async () => (await getStationSearchMeta()).data,
    enabled: open,
  })

  const searchQ = useInfiniteQuery({
    queryKey: ['stations', 'search', debounced],
    enabled: open,
    initialPageParam: 1,
    queryFn: async ({ pageParam }) =>
      (await searchStations({ q: debounced || undefined, page: pageParam as number, pageSize: 20 })).data,
    getNextPageParam: (last) => (last.hasMore ? last.page + 1 : undefined),
  })

  const results = searchQ.data?.pages.flatMap((p) => p.items) ?? []
  const sections: { title: string; items: StationSearchItem[] }[] = []
  if (!debounced && metaQ.data) {
    if (metaQ.data.criticalAlerts?.length) {
      sections.push({ title: 'Critical alerts', items: metaQ.data.criticalAlerts as StationSearchItem[] })
    }
    if (metaQ.data.favorites?.length) {
      sections.push({ title: 'Favorites', items: metaQ.data.favorites as StationSearchItem[] })
    }
    if (metaQ.data.recent?.length) {
      sections.push({ title: 'Recently viewed', items: metaQ.data.recent as StationSearchItem[] })
    }
  }
  if (debounced || sections.length === 0) {
    sections.push({ title: debounced ? 'Search results' : 'Stations', items: results })
  }

  const flat = sections.flatMap((s) => s.items)

  const pick = (item: StationSearchItem) => {
    const id = item.stationCode || item.id
    onChange(id, item)
    setQ('')
    setOpen(false)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) {
      setOpen(true)
      return
    }
    if (e.key === 'Escape') {
      setOpen(false)
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight((h) => Math.min(h + 1, Math.max(flat.length - 1, 0)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => Math.max(h - 1, 0))
    } else if (e.key === 'Enter' && flat[highlight]) {
      e.preventDefault()
      pick(flat[highlight])
    }
  }

  return (
    <div className="relative min-w-[280px] max-w-md w-full" ref={rootRef}>
      <label className="label-text block mb-1" htmlFor={`${listId}-input`}>
        Station
      </label>
      <div className="flex gap-2">
        <input
          id={`${listId}-input`}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          className="input w-full"
          placeholder="Search name, code, city, or state…"
          value={open ? q : selectedLabel || value || ''}
          onChange={(e) => {
            setQ(e.target.value)
            setOpen(true)
            setHighlight(0)
          }}
          onFocus={() => {
            setOpen(true)
            setQ('')
          }}
          onKeyDown={onKeyDown}
        />
        {value && (
          <button
            type="button"
            className="btn-secondary px-3"
            aria-label="Clear station"
            onClick={() => onChange('')}
          >
            Clear
          </button>
        )}
      </div>

      {open && (
        <div
          id={listId}
          role="listbox"
          className="absolute z-30 mt-1 w-full max-h-80 overflow-auto rounded-lg border border-slate-700 bg-slate-900 shadow-xl"
        >
          {searchQ.isLoading && !results.length && (
            <div className="px-3 py-4 text-sm text-slate-400">Searching…</div>
          )}
          {!searchQ.isLoading && debounced && results.length === 0 && (
            <div className="px-3 py-4 text-sm text-slate-400">No stations match “{debounced}”</div>
          )}
          {sections.map((section) => (
            <div key={section.title}>
              {section.items.length > 0 && (
                <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-slate-500">
                  {section.title}
                </div>
              )}
              {section.items.map((item) => {
                const idx = flat.indexOf(item)
                const active = idx === highlight
                const id = item.stationCode || item.id
                return (
                  <button
                    key={`${section.title}-${item.id}`}
                    type="button"
                    role="option"
                    aria-selected={id === value}
                    className={`w-full text-left px-3 py-2 text-sm border-b border-slate-800/80 ${
                      active ? 'bg-slate-800' : 'hover:bg-slate-800/60'
                    }`}
                    onMouseEnter={() => setHighlight(idx)}
                    onClick={() => pick(item)}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-white font-medium truncate">{item.name}</span>
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded ${
                          item.connectivity === 'ONLINE' || item.status === 'ACTIVE'
                            ? 'bg-emerald-950 text-emerald-400'
                            : 'bg-slate-800 text-slate-400'
                        }`}
                      >
                        {item.connectivity || item.status}
                      </span>
                    </div>
                    <div className="text-xs text-slate-400 font-mono">{item.stationCode}</div>
                    <div className="text-xs text-slate-500">
                      {[item.city, item.state].filter(Boolean).join(', ') || '—'}
                      {(item.activeAlertCount ?? item.criticalAlertCount ?? 0) > 0 && (
                        <span className="text-amber-400 ml-2">
                          {item.activeAlertCount ?? item.criticalAlertCount} alerts
                        </span>
                      )}
                    </div>
                  </button>
                )
              })}
            </div>
          ))}
          {searchQ.hasNextPage && (
            <button
              type="button"
              className="w-full px-3 py-2 text-xs text-emerald-400 hover:bg-slate-800"
              onClick={() => searchQ.fetchNextPage()}
            >
              {searchQ.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
