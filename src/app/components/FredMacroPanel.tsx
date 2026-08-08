'use client'

import { useEffect, useState } from 'react'

interface MacroIndicator {
  seriesId: string
  name: string
  category: string
  unit: string
  frequency: string
  displayMode: 'mom_abs' | 'yoy_pct' | 'qoq_pct' | 'level'
  direction: 'higher_good' | 'lower_good' | 'neutral'
  obsDate: string
  obsValue: number | null
  priorDate: string | null
  priorValue: number | null
  yoyDate: string | null
  yoyValue: number | null
  momChange: number | null
  yoyPct: number | null
  qoqPct: number | null
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

function getSignal(indicator: MacroIndicator): 'green' | 'red' | 'neutral' {
  const { displayMode, direction, momChange, yoyPct, qoqPct } = indicator
  let change: number | null = null
  if (displayMode === 'mom_abs') change = momChange
  else if (displayMode === 'yoy_pct') change = yoyPct
  else if (displayMode === 'qoq_pct') change = qoqPct
  else return 'neutral' // level mode

  if (change == null) return 'neutral'

  if (direction === 'higher_good') return change >= 0 ? 'green' : 'red'
  if (direction === 'lower_good')  return change <= 0 ? 'green' : 'red'
  return 'neutral'
}

function formatChange(indicator: MacroIndicator): string | null {
  const { displayMode, momChange, yoyPct, qoqPct, unit } = indicator
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

function formatValue(indicator: MacroIndicator): string {
  if (indicator.obsValue == null) return '—'
  const v = indicator.obsValue
  if (indicator.unit === '%') return `${v.toFixed(2)}%`
  if (indicator.unit === 'K jobs') return `${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}K`
  if (indicator.unit === 'B USD') return `$${v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}B`
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })
}

function SignalDot({ signal }: { signal: 'green' | 'red' | 'neutral' }) {
  if (signal === 'green') return <span className="inline-block w-2 h-2 rounded-full bg-green-500" title="Positive signal" />
  if (signal === 'red')   return <span className="inline-block w-2 h-2 rounded-full bg-red-500"   title="Negative signal" />
  return                         <span className="inline-block w-2 h-2 rounded-full bg-gray-300"  title="Neutral" />
}

function IndicatorRow({ ind }: { ind: MacroIndicator }) {
  const signal = getSignal(ind)
  const changeStr = formatChange(ind)
  const changeColor =
    signal === 'green' ? 'text-green-600' :
    signal === 'red'   ? 'text-red-500'   : 'text-gray-500'

  return (
    <div className="flex items-center justify-between py-2.5 border-b border-gray-100 last:border-0 gap-2">
      <div className="flex items-center gap-2 min-w-0">
        <SignalDot signal={signal} />
        <div className="min-w-0">
          <span className="text-sm font-medium text-gray-800 truncate block">{ind.name}</span>
          <span className="text-xs text-gray-400">{formatDate(ind.obsDate)}</span>
        </div>
      </div>
      <div className="text-right shrink-0">
        <div className="text-sm font-semibold text-gray-900">{formatValue(ind)}</div>
        {changeStr && (
          <div className={`text-xs font-medium ${changeColor}`}>{changeStr}</div>
        )}
      </div>
    </div>
  )
}

export default function FredMacroPanel() {
  const [grouped, setGrouped]     = useState<Record<string, MacroIndicator[]>>({})
  const [syncedAt, setSyncedAt]   = useState<string | null>(null)
  const [loading, setLoading]     = useState(true)
  const [empty, setEmpty]         = useState(false)

  useEffect(() => {
    fetch('/api/macro/fred')
      .then(r => r.json())
      .then(d => {
        setGrouped(d.indicators ?? {})
        setSyncedAt(d.syncedAt ?? null)
        setEmpty(Object.keys(d.indicators ?? {}).length === 0)
      })
      .catch(() => setEmpty(true))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="h-4 w-40 bg-gray-100 rounded animate-pulse mb-4" />
        {[...Array(4)].map((_, i) => (
          <div key={i} className="h-10 bg-gray-50 rounded mb-2 animate-pulse" />
        ))}
      </div>
    )
  }

  if (empty) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-5">
        <h3 className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-3">
          Macro Indicators
        </h3>
        <p className="text-sm text-gray-400 text-center py-6">
          No data yet. Run <code className="bg-gray-100 px-1 rounded text-xs">python3 scripts/fred_macro_sync.py</code> to populate.
        </p>
      </div>
    )
  }

  const categoryOrder = ['labor', 'inflation', 'monetary', 'growth', 'credit', 'sentiment']
  const sortedKeys = Object.keys(grouped).sort(
    (a, b) => categoryOrder.indexOf(a) - categoryOrder.indexOf(b)
  )

  return (
    <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
        <h3 className="text-xs font-bold text-gray-500 uppercase tracking-widest">
          Macro Indicators
        </h3>
        {syncedAt && (
          <span className="text-[11px] text-gray-400">
            Updated {new Date(syncedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
          </span>
        )}
      </div>

      <div className="divide-y divide-gray-100">
        {sortedKeys.map(cat => (
          <div key={cat} className="px-5 py-3">
            <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">
              {CATEGORY_LABELS[cat] ?? cat}
            </div>
            {grouped[cat].map(ind => (
              <IndicatorRow key={ind.seriesId} ind={ind} />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
