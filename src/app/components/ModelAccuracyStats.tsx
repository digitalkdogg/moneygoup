'use client'

import { useEffect, useState } from 'react'

interface AccuracyData {
  status: 'ready' | 'insufficient_data' | string
  total_accuracy_pct: number | null
  horizons?: {
    '1_week'?: { resolved_count: number; proximity_accuracy_pct: number | null; high_accuracy_count: number }
    '1_month'?: { resolved_count: number; proximity_accuracy_pct: number | null; high_accuracy_count: number }
    '6_month'?: { resolved_count: number; proximity_accuracy_pct: number | null; high_accuracy_count: number }
    '1_year'?: { resolved_count: number; proximity_accuracy_pct: number | null; high_accuracy_count: number }
  }
}

interface Stat {
  value: string
  label: string
  sublabel?: string
}

interface ModelAccuracyStatsProps {
  /** 'strip' = compact bar. 'cards' = card grid, no heading (login page). 'section' = full section with heading (landing page). */
  variant?: 'strip' | 'cards' | 'section'
}

export default function ModelAccuracyStats({ variant = 'strip' }: ModelAccuracyStatsProps) {
  const [data, setData] = useState<AccuracyData | null>(null)

  useEffect(() => {
    fetch('/api/analytics/model-accuracy')
      .then(r => r.json())
      .then(setData)
      .catch(() => {})
  }, [])

  if (!data || data.status !== 'ready') return null

  const h1w = data.horizons?.['1_week']
  const h1m = data.horizons?.['1_month']

  const totalResolved =
    (h1w?.resolved_count ?? 0) +
    (h1m?.resolved_count ?? 0) +
    (data.horizons?.['6_month']?.resolved_count ?? 0) +
    (data.horizons?.['1_year']?.resolved_count ?? 0)

  const stats: Stat[] = [
    h1w?.proximity_accuracy_pct != null
      ? { value: `${h1w.proximity_accuracy_pct.toFixed(1)}%`, label: '1-Week Accuracy', sublabel: 'Price proximity' }
      : null,
    h1m?.proximity_accuracy_pct != null
      ? { value: `${h1m.proximity_accuracy_pct.toFixed(1)}%`, label: '1-Month Accuracy', sublabel: 'Price proximity' }
      : null,
    totalResolved > 0
      ? { value: `${totalResolved.toLocaleString()}+`, label: 'Predictions Resolved', sublabel: 'Live tracked' }
      : null,
  ].filter(Boolean) as Stat[]

  if (stats.length === 0) return null

  if (variant === 'section') {
    return (
      <section className="bg-white border-y border-gray-100 py-12">
        <div className="max-w-4xl mx-auto px-6">
          <div className="text-center mb-8">
            <span className="inline-block text-xs font-bold text-[#017e3b] uppercase tracking-widest bg-green-50 px-3 py-1 rounded-full mb-3">
              Proven Track Record
            </span>
            <h2 className="text-xl font-bold text-gray-900">
              Model accuracy tracked in real time
            </h2>
            <p className="text-sm text-gray-500 mt-1 max-w-md mx-auto">
              Every prediction is logged and compared to actual price when it resolves. These numbers update live.
            </p>
          </div>
          <div className={`grid gap-4 ${stats.length === 4 ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-2 sm:grid-cols-3'}`}>
            {stats.map((s) => (
              <div
                key={s.label}
                className="bg-gray-50 rounded-xl p-5 text-center border border-gray-100"
              >
                <div className="text-2xl font-bold text-[#017e3b]">{s.value}</div>
                <div className="text-xs font-semibold text-gray-700 mt-1">{s.label}</div>
                {s.sublabel && <div className="text-[11px] text-gray-400 mt-0.5">{s.sublabel}</div>}
              </div>
            ))}
          </div>
          <p className="text-center text-[11px] text-gray-400 mt-4">
            Price accuracy = max(0, 1 − |predicted − actual| / actual). Not a guarantee of future performance.
          </p>
        </div>
      </section>
    )
  }

  if (variant === 'cards') {
    return (
      <div className="w-full max-w-4xl mx-auto mt-6">
        <div className={`grid gap-4 ${stats.length === 3 ? 'grid-cols-3' : 'grid-cols-2 sm:grid-cols-4'}`}>
          {stats.map((s) => (
            <div key={s.label} className="bg-white rounded-xl p-4 shadow-sm flex flex-col items-start gap-2">
              <div className="px-2.5 py-1 bg-green-50 rounded-lg">
                <span className="text-base font-bold text-[#017e3b]">{s.value}</span>
              </div>
              <h3 className="text-sm font-semibold text-gray-800 leading-tight">{s.label}</h3>
              {s.sublabel && <p className="text-xs text-gray-500 leading-snug">{s.sublabel}</p>}
            </div>
          ))}
        </div>
      </div>
    )
  }

  // strip variant
  return (
    <div className="w-full max-w-2xl mx-auto mt-6">
      <div className="text-center mb-2">
        <span className="text-[11px] font-bold text-[#017e3b] uppercase tracking-widest">
          Live Model Accuracy
        </span>
      </div>
      <div className={`bg-white rounded-xl shadow-sm border border-gray-100 px-6 py-4 grid gap-4 text-center ${stats.length === 4 ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-2 sm:grid-cols-3'}`}>
        {stats.map((s) => (
          <div key={s.label}>
            <p className="text-xl font-bold text-[#017e3b]">{s.value}</p>
            <p className="text-xs text-gray-600 mt-0.5 font-medium">{s.label}</p>
          </div>
        ))}
      </div>
      <p className="text-center text-[10px] text-gray-400 mt-2">
        Live tracked. Not a guarantee of future performance.
      </p>
    </div>
  )
}
