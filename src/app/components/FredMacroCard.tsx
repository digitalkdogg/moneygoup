'use client'

import { useEffect, useState } from 'react'

interface MacroRow {
  seriesId: string
  name: string
  category: string
  displayMode: 'mom_abs' | 'yoy_pct' | 'qoq_pct' | 'level'
  direction: 'higher_good' | 'lower_good' | 'neutral'
  obsValue: number | null
  obsDate: string
  momChange: number | null
  yoyPct: number | null
  qoqPct: number | null
  unit: string
}

const CATEGORY_LABELS: Record<string, string> = {
  labor:     'Labor',
  inflation: 'Inflation',
  monetary:  'Monetary Policy',
  growth:    'Economic Growth',
  credit:    'Credit Markets',
  sentiment: 'Consumer Sentiment',
}

function getSignal(row: MacroRow): 'green' | 'red' | 'neutral' {
  let change: number | null = null
  if (row.displayMode === 'mom_abs') change = row.momChange
  else if (row.displayMode === 'yoy_pct') change = row.yoyPct
  else if (row.displayMode === 'qoq_pct') change = row.qoqPct
  else return 'neutral'
  if (change == null) return 'neutral'
  if (row.direction === 'higher_good') return change >= 0 ? 'green' : 'red'
  if (row.direction === 'lower_good')  return change <= 0 ? 'green' : 'red'
  return 'neutral'
}

function formatVal(row: MacroRow): string {
  if (row.obsValue == null) return '—'
  if (row.unit === '%') return `${row.obsValue.toFixed(2)}%`
  if (row.unit === 'K jobs') return `${row.obsValue.toLocaleString('en-US', { maximumFractionDigits: 0 })}K`
  if (row.unit === 'B USD') return `$${row.obsValue.toFixed(1)}B`
  return row.obsValue.toFixed(2)
}

function formatChg(row: MacroRow): string | null {
  if (row.displayMode === 'mom_abs' && row.momChange != null) {
    const s = row.momChange >= 0 ? '+' : ''
    return `${s}${row.momChange.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${row.unit}`
  }
  if (row.displayMode === 'yoy_pct' && row.yoyPct != null) {
    const s = row.yoyPct >= 0 ? '+' : ''
    return `${s}${row.yoyPct.toFixed(2)}% YoY`
  }
  if (row.displayMode === 'qoq_pct' && row.qoqPct != null) {
    const s = row.qoqPct >= 0 ? '+' : ''
    return `${s}${row.qoqPct.toFixed(2)}% QoQ`
  }
  return null
}

function formatDate(d: string): string {
  return new Date(d).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })
}

// ── Modal ─────────────────────────────────────────────────────────────────────

function MacroModal({ grouped, syncedAt, onClose }: {
  grouped: Record<string, MacroRow[]>
  syncedAt: string | null
  onClose: () => void
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handler)
      document.body.style.overflow = ''
    }
  }, [onClose])

  const categoryOrder = ['labor', 'inflation', 'monetary', 'growth', 'credit', 'sentiment']
  const sortedKeys = Object.keys(grouped).sort(
    (a, b) => categoryOrder.indexOf(a) - categoryOrder.indexOf(b)
  )

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-base font-bold text-gray-900">Macro Indicators</h2>
            {syncedAt && (
              <p className="text-xs text-gray-600 mt-0.5">
                Updated {new Date(syncedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </p>
            )}
          </div>
          <button onClick={onClose} className="text-gray-600 hover:text-gray-700 p-1">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="overflow-y-auto flex-1 divide-y divide-gray-100">
          {sortedKeys.map(cat => (
            <div key={cat} className="px-6 py-3">
              <div className="text-[10px] font-bold text-gray-600 uppercase tracking-widest mb-1">
                {CATEGORY_LABELS[cat] ?? cat}
              </div>
              {grouped[cat].map(row => {
                const sig = getSignal(row)
                const chg = formatChg(row)
                const chgColor = sig === 'green' ? 'text-green-600' : sig === 'red' ? 'text-red-600' : 'text-gray-600'
                const dotColor = sig === 'green' ? 'bg-green-500' : sig === 'red' ? 'bg-red-500' : 'bg-gray-300'
                return (
                  <div key={row.seriesId} className="flex items-center justify-between py-2.5 border-b border-gray-50 last:border-0 gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${dotColor}`} />
                      <div className="min-w-0">
                        <span className="text-sm font-medium text-gray-800 block truncate">{row.name}</span>
                        <span className="text-xs text-gray-600">{formatDate(row.obsDate)}</span>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-sm font-semibold text-gray-900">{formatVal(row)}</div>
                      {chg && <div className={`text-xs font-medium ${chgColor}`}>{chg}</div>}
                    </div>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Card ──────────────────────────────────────────────────────────────────────

export default function FredMacroCard() {
  const [grouped, setGrouped]   = useState<Record<string, MacroRow[]>>({})
  const [syncedAt, setSynced]   = useState<string | null>(null)
  const [loading, setLoading]   = useState(true)
  const [open, setOpen]         = useState(false)

  useEffect(() => {
    fetch('/api/macro/fred')
      .then(r => r.json())
      .then(d => {
        setGrouped(d.indicators ?? {})
        setSynced(d.syncedAt ?? null)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return <div className="bg-white rounded-2xl border border-gray-100 p-4 h-14 animate-pulse" />
  }

  const all: MacroRow[] = Object.values(grouped).flat()
  if (all.length === 0) return null

  const green   = all.filter(r => getSignal(r) === 'green').length
  const red     = all.filter(r => getSignal(r) === 'red').length
  const neutral = all.filter(r => getSignal(r) === 'neutral').length

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="w-full bg-white rounded-2xl border border-gray-100 px-4 py-3 hover:border-gray-200 hover:shadow-sm transition-all flex items-center justify-between gap-3 text-left"
      >
        <span className="text-sm font-bold text-gray-600 uppercase tracking-widest shrink-0">Macro Climate</span>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1 text-sm text-green-600 font-medium">
            <span className="inline-block w-2 h-2 rounded-full bg-green-500" />{green} positive
          </span>
          <span className="flex items-center gap-1 text-sm text-gray-600 font-medium">
            <span className="inline-block w-2 h-2 rounded-full bg-gray-300" />{neutral} neutral
          </span>
          <span className="flex items-center gap-1 text-sm text-red-600 font-medium">
            <span className="inline-block w-2 h-2 rounded-full bg-red-400" />{red} negative
          </span>
          <svg className="w-3.5 h-3.5 text-gray-300 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </div>
      </button>

      {open && <MacroModal grouped={grouped} syncedAt={syncedAt} onClose={() => setOpen(false)} />}
    </>
  )
}
