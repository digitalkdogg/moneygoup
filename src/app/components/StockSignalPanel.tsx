'use client'

import { useState } from 'react'
import { GpsBreakdownModal } from './modals/GpsBreakdownModal'

export interface GpsData {
  gpsScore: number | null
  gpsBreakdown: Record<string, number> | null
  source: 'stock_gps_scores' | 'user_stock_predictions' | 'recommended_stocks' | 'none'
  asOf: string | null
}

interface StockSignalPanelProps {
  ticker: string
  gpsData: GpsData | null
  gpsLoading: boolean
  onGeneratePrediction: () => void
  predictionLoading: boolean
}

const DRIVER_LABELS: Record<string, string> = {
  analystUpside: 'Analyst Upside',
  revenueGrowth: 'Revenue Growth',
  earningsGrowth: 'Earnings Growth',
  fiftyTwoWeekChange: '52-week price',
  mlpUpside: 'MLP Alpha',
  mlpConfidence: 'AI Confidence',
}

const DRIVER_MAX: Record<string, number> = {
  analystUpside: 19,
  revenueGrowth: 19,
  earningsGrowth: 19,
  fiftyTwoWeekChange: 19,
  mlpUpside: 19,
  mlpConfidence: 5,
}

function getGpsLabel(score: number) {
  if (score >= 80) return 'Strong Buy'
  if (score >= 60) return 'Buy'
  if (score >= 40) return 'Hold'
  if (score >= 20) return 'Weak'
  return 'Avoid'
}

function getChipColors(score: number) {
  if (score >= 60) return { bg: '#dcfce7', text: '#166534', dot: '#16a34a' }
  if (score >= 40) return { bg: '#f3f4f6', text: '#374151', dot: '#9ca3af' }
  if (score >= 20) return { bg: '#fef3c7', text: '#92400e', dot: '#d97706' }
  return { bg: '#fee2e2', text: '#991b1b', dot: '#dc2626' }
}

function getTopDrivers(breakdown: Record<string, number> | null) {
  if (!breakdown) return []
  return Object.entries(DRIVER_LABELS)
    .map(([key, label]) => ({ key, label, value: breakdown[key] ?? 0 }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 3)
}

export default function StockSignalPanel({
  ticker,
  gpsData,
  gpsLoading,
  onGeneratePrediction,
  predictionLoading,
}: StockSignalPanelProps) {
  const [modalOpen, setModalOpen] = useState(false)

  const score = gpsData?.gpsScore ?? null
  const breakdown = gpsData?.gpsBreakdown ?? null
  const source = gpsData?.source ?? 'none'
  const isBearish = breakdown != null && typeof (breakdown as any).mlpUpside === 'number' && (breakdown as any).mlpUpside < 0

  const sourceLabel =
    source === 'user_stock_predictions' ? 'Your prediction' :
    source === 'recommended_stocks'     ? 'Market snapshot' :
    null

  const topDrivers = score !== null ? getTopDrivers(breakdown) : []
  const chipColors = score !== null ? getChipColors(score) : null

  return (
    <div>
      {/* Header */}
      <div className="mb-1">
        <h2 className="section-heading">GPS + AI prediction</h2>
      </div>
      <p className="text-sm text-gray-500 mb-5">
        Our model scores each stock across key financial signals to generate a rating and outlook. Higher scores indicate stronger momentum in that factor.
      </p>

      {gpsLoading ? (
        <div className="py-2 text-sm text-gray-400 animate-pulse">Loading GPS data...</div>
      ) : score !== null ? (
        <>
          {/* Score row */}
          <div className="flex flex-wrap items-center gap-2 mb-5">
            <span
              className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-semibold"
              style={{ backgroundColor: chipColors!.bg, color: chipColors!.text }}
            >
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: chipColors!.dot }} />
              GPS {score.toFixed(1)} / 100
            </span>
            <span className="text-sm font-semibold text-gray-700">{getGpsLabel(score)}</span>
            {sourceLabel && (
              <span className="text-sm text-gray-400">{sourceLabel}</span>
            )}
            {breakdown && (
              <button
                onClick={() => setModalOpen(true)}
                className="hover:underline ml-1 text-[#017e3b]"
              >
                View score
              </button>
            )}
          </div>

          {/* Bearish warning */}
          {isBearish && (
            <div className="flex items-start gap-2.5 px-3.5 py-3 mb-5 rounded-xl bg-red-50 border border-red-200 text-red-700">
              <svg className="w-4 h-4 shrink-0 mt-0.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M8 2L2 13h12L8 2z" />
                <line x1="8" y1="6.5" x2="8" y2="9.5" />
                <circle cx="8" cy="11.5" r="0.5" fill="currentColor" stroke="none" />
              </svg>
              <p className="text-sm font-medium">AI model predicts downside — the MLP signal is negative for this stock&apos;s 1-month outlook.</p>
            </div>
          )}

          {/* Top drivers */}
          {topDrivers.length > 0 && (
            <div className="mb-5">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3">Top Drivers</p>
              <ul className="space-y-3">
                {topDrivers.map(d => {
                  const pct = Math.min(Math.round((d.value / (DRIVER_MAX[d.key] ?? 19)) * 100), 100)
                  return (
                    <li key={d.key}>
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-sm font-medium text-gray-800">{d.label}</span>
                        <span className="text-xs text-gray-400">{d.value.toFixed(1)} / {DRIVER_MAX[d.key] ?? 19}</span>
                      </div>
                      <div className="h-1.5 w-full bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all duration-500 bg-[#017e3b]"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
        </>
      ) : (
        <p className="text-sm text-gray-500 mb-5">
          GPS signal not yet available for {ticker}. Generate a prediction to build it.
        </p>
      )}

      {/* Info callout */}
      <div className="flex gap-2.5 p-3.5 bg-gray-50 border border-gray-200 rounded-xl mb-5 text-sm text-gray-600">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <span>
          <strong>Show prediction details</strong> expands the full factor breakdown — including signal weights, model confidence, and how your prediction compares to the AI&apos;s rating.
        </span>
      </div>

      {/* Footer buttons */}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={onGeneratePrediction}
          disabled={predictionLoading}
          className={`inline-flex items-center gap-2 text-white py-2.5 px-5 rounded-lg transition-colors disabled:bg-gray-400 disabled:cursor-wait hover:opacity-90 ${!predictionLoading ? 'bg-[#017e3b]' : ''}`}
        >
          {predictionLoading ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="animate-spin" aria-hidden="true">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
            </svg>
          )}
          {predictionLoading ? 'Generating...' : 'Show prediction details'}
        </button>

      </div>

      {modalOpen && (
        <GpsBreakdownModal
          isOpen={modalOpen}
          onClose={() => setModalOpen(false)}
          symbol={ticker}
          score={score ?? 0}
          breakdown={breakdown}
        />
      )}
    </div>
  )
}
