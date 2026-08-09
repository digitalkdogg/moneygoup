'use client'

import { useEffect, useState } from 'react'

interface MacroIndicator {
  seriesId: string
  name: string
  displayMode: 'mom_abs' | 'yoy_pct' | 'qoq_pct' | 'level'
  direction: 'higher_good' | 'lower_good' | 'neutral'
  obsDate: string
  obsValue: number | null
  priorValue: number | null
  yoyDate: string | null
  yoyValue: number | null
  momChange: number | null
  yoyPct: number | null
  qoqPct: number | null
  unit: string
  category: string
  frequency: string
  syncedAt: string
}

const CATEGORY_LABELS: Record<string, string> = {
  labor:     'Labor',
  inflation: 'Inflation',
  monetary:  'Monetary Policy',
  growth:    'Economic Growth',
  credit:    'Credit Markets',
  sentiment: 'Consumer Sentiment',
}

function getSignal(ind: MacroIndicator): 'green' | 'red' | 'neutral' {
  const { displayMode, direction, momChange, yoyPct, qoqPct } = ind
  let change: number | null = null
  if (displayMode === 'mom_abs') change = momChange
  else if (displayMode === 'yoy_pct') change = yoyPct
  else if (displayMode === 'qoq_pct') change = qoqPct
  else return 'neutral'
  if (change == null) return 'neutral'
  if (direction === 'higher_good') return change >= 0 ? 'green' : 'red'
  if (direction === 'lower_good')  return change <= 0 ? 'green' : 'red'
  return 'neutral'
}

function formatValue(ind: MacroIndicator): string {
  if (ind.obsValue == null) return '—'
  const v = ind.obsValue
  if (ind.unit === '%') return `${v.toFixed(2)}%`
  if (ind.unit === 'K jobs') return `${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}K`
  if (ind.unit === 'B USD') return `$${v.toFixed(1)}B`
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function formatChange(ind: MacroIndicator): string | null {
  const { displayMode, momChange, yoyPct, qoqPct, unit } = ind
  if (displayMode === 'mom_abs' && momChange != null) {
    const sign = momChange >= 0 ? '+' : ''
    return `${sign}${momChange.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${unit}`
  }
  if (displayMode === 'yoy_pct' && yoyPct != null) {
    const sign = yoyPct >= 0 ? '+' : ''
    return `${sign}${yoyPct.toFixed(2)}% YoY`
  }
  if (displayMode === 'qoq_pct' && qoqPct != null) {
    const sign = qoqPct >= 0 ? '+' : ''
    return `${sign}${qoqPct.toFixed(2)}% QoQ`
  }
  return null
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return ''
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })
}

function computeGrade(indicators: MacroIndicator[]): { green: number; red: number; total: number } {
  let green = 0, red = 0, total = 0
  for (const ind of indicators) {
    const sig = getSignal(ind)
    if (sig === 'neutral') continue
    total++
    if (sig === 'green') green++
    else red++
  }
  return { green, red, total }
}

// ── Modal ─────────────────────────────────────────────────────────────────────

function MacroModal({ grouped, syncedAt, onClose }: {
  grouped: Record<string, MacroIndicator[]>
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
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-base font-bold text-gray-900">Macro Indicators</h2>
            {syncedAt && (
              <p className="text-xs text-gray-600 mt-0.5">
                Updated {new Date(syncedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-gray-600 hover:text-gray-700 transition-colors p-1"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 divide-y divide-gray-100">
          {sortedKeys.map(cat => (
            <div key={cat} className="px-6 py-3">
              <div className="text-[10px] font-bold text-gray-600 uppercase tracking-widest mb-1">
                {CATEGORY_LABELS[cat] ?? cat}
              </div>
              {grouped[cat].map(ind => {
                const signal = getSignal(ind)
                const changeStr = formatChange(ind)
                const changeColor =
                  signal === 'green' ? 'text-green-600' :
                  signal === 'red'   ? 'text-red-600'   : 'text-gray-600'
                const dotColor =
                  signal === 'green' ? 'bg-green-500' :
                  signal === 'red'   ? 'bg-red-500'   : 'bg-gray-300'

                return (
                  <div key={ind.seriesId} className="flex items-center justify-between py-2.5 border-b border-gray-50 last:border-0 gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${dotColor}`} />
                      <div className="min-w-0">
                        <span className="text-sm font-medium text-gray-800 block truncate">{ind.name}</span>
                        <span className="text-xs text-gray-600">{formatDate(ind.obsDate)}</span>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-sm font-semibold text-gray-900">{formatValue(ind)}</div>
                      {changeStr && <div className={`text-xs font-medium ${changeColor}`}>{changeStr}</div>}
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

// ── Badge ─────────────────────────────────────────────────────────────────────

export default function MacroScoreBadge() {
  const [grouped, setGrouped]   = useState<Record<string, MacroIndicator[]>>({})
  const [syncedAt, setSyncedAt] = useState<string | null>(null)
  const [loading, setLoading]   = useState(true)
  const [open, setOpen]         = useState(false)

  useEffect(() => {
    fetch('/api/macro/fred')
      .then(r => r.json())
      .then(d => {
        setGrouped(d.indicators ?? {})
        setSyncedAt(d.syncedAt ?? null)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const allIndicators = Object.values(grouped).flat()
  const { green, red, total } = computeGrade(allIndicators)

  if (loading) {
    return (
      <div className="h-16 rounded-xl border border-gray-100 bg-gray-50 animate-pulse" />
    )
  }

  if (allIndicators.length === 0) return null

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="w-full text-left rounded-xl border border-gray-200 bg-white px-4 py-3 hover:border-gray-300 hover:shadow-sm transition-all flex items-center justify-between gap-4"
      >
        <div className="flex items-center gap-3">
          <div className="flex gap-1">
            {Array.from({ length: total }).map((_, i) => (
              <span
                key={i}
                className={`inline-block w-2 h-2 rounded-full ${i < green ? 'bg-green-500' : 'bg-red-400'}`}
              />
            ))}
          </div>
          <div>
            <div className="text-sm font-semibold text-gray-800">Macro Climate</div>
            <div className="text-xs text-gray-600">
              {green} of {total} signals positive
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1 text-xs text-gray-600 font-medium shrink-0">
          View details
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </div>
      </button>

      {open && (
        <MacroModal grouped={grouped} syncedAt={syncedAt} onClose={() => setOpen(false)} />
      )}
    </>
  )
}
