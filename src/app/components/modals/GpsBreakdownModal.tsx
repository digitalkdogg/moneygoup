// src/app/components/modals/GpsBreakdownModal.tsx
'use client'

import React, { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { getGpsLabel, getCardCallLabel } from '@/utils/gps'

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
  /** When 'card', the headline Rating badge label uses the card-only
   *  variant-B thresholds (Hold 45-55, Buy 55-75) and the footer tone
   *  color flips its Buy anchor from 65 to 55. Keeps the modal consistent
   *  with the calling card on PortfolioCardView. Defaults to 'default'
   *  so all existing modal callers (IndustryStocks, RecommendationsSection,
   *  DeepmoneyCardView, stock detail page) are unaffected. */
  variant?: 'default' | 'card'
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
  variant = 'default',
}) => {
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handler);
      document.body.style.overflow = '';
    };
  }, [isOpen, onClose]);

  const mlpLabel = `ML Prediction (${HORIZON_LABEL[horizon] ?? '1m'})`
  const isCardVariant = variant === 'card'
  // Card variant uses getCardCallLabel (Hold 45-55 / Buy 55-75) so the
  // Rating badge matches the headline on the calling card. Default uses
  // the canonical getGpsLabel (Hold 45-64 / Buy 65-79) — env-var aligned.
  const ratingLabel = isCardVariant ? getCardCallLabel(score ?? 0) : getGpsLabel(score ?? 0)
  // Footer tone color: in card variant the green threshold drops from 65 → 55
  // so the tone matches the new Buy band. The amber/red 45 anchor is shared.
  const toneGreenThreshold = isCardVariant ? 55 : 65
  if (!isOpen || typeof document === 'undefined') return null

  const getBarColor = (pct: number) => {
    if (pct >= 75) return '#017e3b'
    if (pct >= 45) return '#b45309'
    return '#b91c1c'
  }

  const getToneColor = (s: number) => {
    if (s >= toneGreenThreshold) return 'text-[#17a346]'
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

  return createPortal(
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center p-4 bg-black/40"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClose() }}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-h-[90vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '480px' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h3 className="text-base font-bold text-gray-900">Global Performance Metric</h3>
            <p className="text-xs text-gray-600 mt-0.5">
              {symbol}{company && ` · ${company}`} · GPS v3.0 — 8 components, 100 points
            </p>
          </div>
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClose() }}
            className="text-gray-500 hover:text-gray-700 transition-colors p-1"
            aria-label="Close modal"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto flex-1">
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
                  <div className="text-base font-bold text-[#b45309]">{ratingLabel}</div>
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
    </div>,
    document.body
  )
}
