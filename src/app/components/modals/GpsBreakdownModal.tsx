// src/app/components/modals/GpsBreakdownModal.tsx

import React from 'react'
import { getGpsLabel } from '@/utils/gps'

interface GpsBreakdownModalProps {
  isOpen: boolean
  onClose: () => void
  symbol: string
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
  score,
  breakdown,
  horizon = '1_month',
}) => {
  const mlpLabel = `ML Prediction (${HORIZON_LABEL[horizon] ?? '1m'})`
  if (!isOpen) return null

  const getToneColor = (s: number) => {
    if (s >= 65) return 'text-[#15803d]'
    if (s >= 45) return 'text-[#b45309]'
    return 'text-[#b91c1c]'
  }

  const getBgColor = (s: number) => {
    if (s >= 65) return 'bg-green-50'
    if (s >= 45) return 'bg-amber-50'
    return 'bg-red-50'
  }

  const CONSENSUS_LABELS: Record<number, string> = {
    9: 'Strong Buy',
    7: 'Buy',
    4: 'Hold',
    2: 'Underperform',
    0: 'Sell',
  }

  const consensusLabel = breakdown?.analystConsensus != null
    ? (CONSENSUS_LABELS[Math.round(breakdown.analystConsensus)] ?? '')
    : ''

  return (
    <div
      className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center z-[1000] p-4 animate-in fade-in duration-200"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClose() }}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden animate-in zoom-in-95 duration-200 border border-slate-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="bg-[#017e3b] text-white p-4 relative">
          <div className="pr-8">
            <h3 className="text-lg font-bold tracking-tight" style={{ color: '#fff' }}>{symbol}</h3>
            <p className="text-[10px] text-green-100 uppercase tracking-widest font-semibold mt-0.5">Global Performance Metric (GPS) v3.0</p>
          </div>
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClose() }}
            className="absolute top-4 right-4 text-green-100 hover:text-white transition-colors p-1 bg-white/10 hover:bg-white/20 rounded-lg"
            aria-label="Close modal"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-5">
          {!breakdown ? (
            <div className="py-8 text-center">
              <p className="text-slate-500 font-medium">No algorithmic breakdown available.</p>
              <div className="mt-4 inline-flex items-center px-4 py-2 bg-[#dcfce7] text-[#017e3b] rounded-full font-bold text-base shadow-sm">
                GPS: {(score ?? 0).toFixed(1)}
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-0.5">
                <div className="flex justify-between items-center py-2 border-b border-slate-50">
                  <span className="text-slate-500 text-[10px] uppercase font-bold tracking-wider">{mlpLabel}</span>
                  <span className="font-mono font-bold text-slate-900 bg-slate-50 px-2 py-0.5 rounded text-sm">{(breakdown.mlpUpside ?? 0).toFixed(1)} / 20</span>
                </div>
                <div className="flex justify-between items-center py-2 border-b border-slate-50">
                  <span className="text-slate-500 text-[10px] uppercase font-bold tracking-wider">AI Confidence</span>
                  <span className="font-mono font-bold text-slate-900 bg-slate-50 px-2 py-0.5 rounded text-sm">{(breakdown.mlpConfidence ?? 0).toFixed(1)} / 5</span>
                </div>
                <div className="flex justify-between items-center py-2 border-b border-slate-50">
                  <span className="text-slate-500 text-[10px] uppercase font-bold tracking-wider">Revenue Growth</span>
                  <span className="font-mono font-bold text-slate-900 bg-slate-50 px-2 py-0.5 rounded text-sm">{(breakdown.revenueGrowth ?? 0).toFixed(1)} / 12</span>
                </div>
                <div className="flex justify-between items-center py-2 border-b border-slate-50">
                  <span className="text-slate-500 text-[10px] uppercase font-bold tracking-wider">Earnings Growth</span>
                  <span className="font-mono font-bold text-slate-900 bg-slate-50 px-2 py-0.5 rounded text-sm">{(breakdown.earningsGrowth ?? 0).toFixed(1)} / 12</span>
                </div>
                <div className="flex justify-between items-center py-2 border-b border-slate-50">
                  <span className="text-slate-500 text-[10px] uppercase font-bold tracking-wider">Technical Signal</span>
                  <span className="font-mono font-bold text-slate-900 bg-slate-50 px-2 py-0.5 rounded text-sm">{(breakdown.technicalSignal ?? 0).toFixed(1)} / 20</span>
                </div>
                <div className="flex justify-between items-center py-2 border-b border-slate-50">
                  <span className="text-slate-500 text-[10px] uppercase font-bold tracking-wider">Analyst Upside</span>
                  <span className="font-mono font-bold text-slate-900 bg-slate-50 px-2 py-0.5 rounded text-sm">{(breakdown.analystUpside ?? 0).toFixed(1)} / 12</span>
                </div>
                <div className="flex justify-between items-center py-2 border-b border-slate-50">
                  <span className="text-slate-500 text-[10px] uppercase font-bold tracking-wider">
                    Analyst Consensus{consensusLabel ? ` — ${consensusLabel}` : ''}
                  </span>
                  <span className="font-mono font-bold text-slate-900 bg-slate-50 px-2 py-0.5 rounded text-sm">{(breakdown.analystConsensus ?? 0).toFixed(1)} / 9</span>
                </div>
                <div className="flex justify-between items-center py-2">
                  <span className="text-slate-500 text-[10px] uppercase font-bold tracking-wider">52-Week Momentum</span>
                  <span className="font-mono font-bold text-slate-900 bg-slate-50 px-2 py-0.5 rounded text-sm">{(breakdown.priceChange52w ?? breakdown.fiftyTwoWeekChange ?? 0).toFixed(1)} / 10</span>
                </div>
              </div>

              {/* Summary Footer */}
              <div className={`mt-4 rounded-xl p-4 border ${getBgColor(score ?? 0)} border-slate-100 shadow-sm`}>
                <div className="flex justify-between items-center w-full uppercase tracking-wider text-slate-500">
                  <span className={`text-xl font-semibold ${getToneColor(score ?? 0)}`}>{getGpsLabel(score ?? 0)}</span>
                  <span className="text-xl">Score: {(score ?? 0).toFixed(1)}</span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer Info */}
        <div className="bg-slate-50/50 px-6 py-3 border-t border-slate-100">
          <div className="text-[10px] text-slate-500 text-center leading-relaxed">
            GPS v3.0 — 8 components, 100 points. Combines ML prediction, technical signals, fundamentals, and analyst consensus.
          </div>
        </div>
      </div>
    </div>
  )
}
