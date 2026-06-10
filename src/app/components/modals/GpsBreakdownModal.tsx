// src/app/components/modals/GpsBreakdownModal.tsx

import React from 'react'
import { getGpsLabel } from '@/utils/gps'

interface GpsBreakdownModalProps {
  isOpen: boolean
  onClose: () => void
  symbol: string
  company?: string
  score: number | null
  breakdown: any | null
  /** Which prediction horizon the mlpUpside component reflects.
   *  Defaults to '1_month' for back-compat with callers that don't pass it. */
  horizon?: '1_week' | '1_month' | '6_month' | '1_year'
}

const HORIZON_LABEL: Record<string, string> = {
  '1_week':  '1w',
  '1_month': '1m',
  '6_month': '6m',
  '1_year':  '1y',
}

export const GpsBreakdownModal: React.FC<GpsBreakdownModalProps> = ({
  isOpen,
  onClose,
  symbol,
  company,
  score,
  breakdown,
  horizon = '1_month',
}) => {
  const mlpLabel = `ML Prediction (${HORIZON_LABEL[horizon] ?? '1m'})`
  if (!isOpen) return null

  const getBarColor = (pct: number) => {
    if (pct >= 75) return '#017e3b'
    if (pct >= 45) return '#b45309'
    return '#b91c1c'
  }

  const getToneColor = (s: number) => {
    if (s >= 65) return 'text-[#17a346]'
    if (s >= 45) return 'text-[#b45309]'
    return 'text-[#b91c1c]'
  }

  const getMetricsArray = () => {
    if (!breakdown) return []
    return [
      { label: mlpLabel, score: breakdown.mlpUpside ?? 0, max: 20 },
      { label: 'AI Confidence', score: breakdown.mlpConfidence ?? 0, max: 5 },
      { label: 'Revenue Growth', score: breakdown.revenueGrowth ?? 0, max: 12 },
      { label: 'Earnings Growth', score: breakdown.earningsGrowth ?? 0, max: 12 },
      { label: 'Technical Signal', score: breakdown.technicalSignal ?? 0, max: 20 },
      { label: 'Analyst Upside', score: breakdown.analystUpside ?? 0, max: 12 },
      { label: 'Analyst Consensus', score: breakdown.analystConsensus ?? 0, max: 9 },
      { label: '52-Week Momentum', score: breakdown.priceChange52w ?? breakdown.fiftyTwoWeekChange ?? 0, max: 10 },
    ]
  }

  const metrics = getMetricsArray()

  return (
    <div
      className="fixed inset-0 bg-slate-900/45 backdrop-blur-sm flex items-center justify-center z-[1000] p-6"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClose() }}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-width-480px overflow-hidden border border-slate-200"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '480px' }}
      >
        {/* Header */}
        <div className="bg-[#017e3b] text-white p-5">
          <div className="flex items-start justify-between">
            <div>
              <div className="text-xs font-semibold letter-spacing-widest text-[#86efac] uppercase mb-1">
                {symbol}
                {company && ` · ${company}`}
              </div>
              <h3 className="text-lg font-bold tracking-tight" style={{ color: '#fff' }}>Global Performance Metric</h3>
              <p className="text-xs text-[#bbf7d0] mt-0.5">GPS v3.0 — 8 components, 100 points</p>
            </div>
            <button
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClose() }}
              className="flex-shrink-0 ml-4 p-1 bg-white/15 hover:bg-white/25 transition-colors rounded text-white"
              aria-label="Close modal"
              style={{ width: '28px', height: '28px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="p-6">
          {!breakdown ? (
            <div className="py-8 text-center">
              <p className="text-slate-500 font-medium">No algorithmic breakdown available.</p>
              <div className="mt-4 inline-flex items-center px-4 py-2 bg-[#dcfce7] text-[#017e3b] rounded-full font-bold text-base shadow-sm">
                GPS: {(score ?? 0).toFixed(1)}
              </div>
            </div>
          ) : (
            <>
              {/* Score + Rating Row */}
              <div className="flex items-center justify-between pb-4 border-b border-slate-100">
                <div>
                  <div className="text-xs font-semibold letter-spacing-wide text-slate-500 uppercase mb-1">Overall Score</div>
                  <div className="flex items-baseline gap-2">
                    <span className="text-4xl font-bold text-slate-900">{(score ?? 0).toFixed(1)}</span>
                    <span className="text-sm text-slate-600">/ 100</span>
                  </div>
                </div>
                <div className="bg-[#fef3c7] border border-[#fde68a] rounded-lg px-4 py-1.5 text-center">
                  <div className="text-xs font-semibold letter-spacing-widest text-[#92400e] uppercase">Rating</div>
                  <div className="text-base font-bold text-[#b45309]">{getGpsLabel(score ?? 0)}</div>
                </div>
              </div>

              {/* Metrics Table Header */}
              <div className="mt-4 mb-2">
                <div className="text-xs font-bold letter-spacing-widest text-slate-500 uppercase grid gap-2 px-0 pb-2 border-b border-slate-100" style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', alignItems: 'center' }}>
                  <span>Factor</span>
                  <span style={{ minWidth: '80px', textAlign: 'right' }}>Score</span>
                  <span style={{ minWidth: '32px', textAlign: 'right' }}>Max</span>
                </div>

                {/* Metrics Rows */}
                <div className="space-y-1">
                  {metrics.map((m, idx) => {
                    const pct = (m.score / m.max) * 100
                    const barColor = getBarColor(pct)
                    return (
                      <div
                        key={idx}
                        className="grid gap-2 py-2 border-b border-slate-50"
                        style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', alignItems: 'center' }}
                      >
                        <div>
                          <div className="text-sm font-medium text-slate-700">{m.label}</div>
                          <div
                            className="h-1 bg-slate-200 rounded-full mt-1 overflow-hidden"
                            style={{ height: '4px' }}
                          >
                            <div
                              className="rounded-full transition-all"
                              style={{
                                height: '100%',
                                width: `${pct}%`,
                                backgroundColor: barColor,
                              }}
                            />
                          </div>
                        </div>
                        <div className="text-sm font-semibold text-right" style={{ minWidth: '80px', color: barColor }}>
                          {m.score.toFixed(1)}
                        </div>
                        <div className="text-xs text-slate-500 text-right" style={{ minWidth: '32px' }}>
                          / {m.max}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>

              {/* Info Note */}
              <div className="mt-5 bg-[#f0fdf4] border-l-3 border-[#017e3b] rounded-r px-4 py-3">
                <div className="text-xs leading-relaxed text-[#166534]">
                  Combines ML prediction, technical signals, fundamentals, and analyst consensus.
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
