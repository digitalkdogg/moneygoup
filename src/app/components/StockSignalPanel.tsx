'use client'

import { useState } from 'react'
import { GpsBreakdownModal } from './modals/GpsBreakdownModal'

export interface GpsData {
  gpsScore: number | null
  gpsBreakdown: Record<string, number> | null
  source: 'user_stock_predictions' | 'recommended_stocks' | 'none'
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
  fiftyTwoWeekChange: '52-Week Price',
  mlpUpside: 'MLP Alpha',
  mlpConfidence: 'AI Confidence',
}

function getGpsLabel(score: number) {
  if (score >= 80) return 'Strong Buy'
  if (score >= 60) return 'Buy'
  if (score >= 40) return 'Hold'
  if (score >= 20) return 'Weak'
  return 'Avoid'
}

function getScoreColors(score: number) {
  if (score >= 60) return { chip: 'bg-green-100 text-[#015a2c]', dot: 'bg-[#017e3b]' }
  if (score >= 40) return { chip: 'bg-gray-100 text-gray-700', dot: 'bg-gray-400' }
  if (score >= 20) return { chip: 'bg-amber-100 text-amber-800', dot: 'bg-amber-500' }
  return { chip: 'bg-red-100 text-red-800', dot: 'bg-red-500' }
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
  const asOf = gpsData?.asOf ?? null

  const sourceLabel =
    source === 'user_stock_predictions' ? 'Your Prediction' :
    source === 'recommended_stocks'     ? 'Market Snapshot' :
    null

  const asOfFormatted = asOf
    ? new Date(asOf).toLocaleString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
      })
    : null

  const topDrivers = score !== null ? getTopDrivers(breakdown) : []
  const colors = score !== null ? getScoreColors(score) : null

  return (
    <div>
      <h2 className="text-2xl font-semibold text-gray-800 mb-4">GPS + AI Prediction</h2>

      {gpsLoading ? (
        <div className="py-2 text-sm text-gray-400 animate-pulse">Loading GPS data...</div>
      ) : score !== null ? (
        <div className="space-y-4">
          {/* Score row */}
          <div className="flex flex-wrap items-center gap-3">
            <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-bold ${colors!.chip}`}>
              <span className={`w-2 h-2 rounded-full ${colors!.dot}`} />
              GPS {score.toFixed(1)}
            </span>
            <span className="font-semibold text-gray-700">{getGpsLabel(score)}</span>
            {sourceLabel && (
              <span className="px-2 py-0.5 bg-slate-100 text-slate-500 text-xs rounded font-medium">
                {sourceLabel}
              </span>
            )}
            {asOfFormatted && (
              <span className="text-xs text-gray-400">As of {asOfFormatted}</span>
            )}
            {breakdown && (
              <button
                onClick={() => setModalOpen(true)}
                className="text-xs font-medium hover:underline"
                style={{ color: '#017e3b' }}
              >
                View breakdown
              </button>
            )}
          </div>

          {/* Top drivers */}
          {topDrivers.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Top drivers</p>
              <ul className="space-y-1">
                {topDrivers.map(d => (
                  <li key={d.key} className="flex items-center gap-2 text-sm text-gray-700">
                    <span className="font-bold" style={{ color: '#017e3b' }}>•</span>
                    <span>{d.label}:</span>
                    <span className="font-semibold">{d.value.toFixed(1)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <p className="text-sm text-gray-500">
          GPS signal not yet available for {ticker}. Generate a prediction to build it.
        </p>
      )}

      {/* CTA footer */}
      <div className="mt-6 pt-4 border-t border-gray-100">
        <button
          onClick={onGeneratePrediction}
          disabled={predictionLoading}
          style={!predictionLoading ? { backgroundColor: '#017e3b' } : {}}
          className="inline-flex items-center gap-2 text-white font-semibold py-2 px-4 rounded-lg transition-colors disabled:bg-gray-400 disabled:cursor-wait hover:opacity-90 text-sm"
        >
          {predictionLoading ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="animate-spin" aria-hidden="true">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
          )}
          {predictionLoading ? 'Generating...' : 'Show prediction details'}
        </button>
      </div>

      {modalOpen && score !== null && (
        <GpsBreakdownModal
          isOpen={modalOpen}
          onClose={() => setModalOpen(false)}
          symbol={ticker}
          score={score}
          breakdown={breakdown}
        />
      )}
    </div>
  )
}
