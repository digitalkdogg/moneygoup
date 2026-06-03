'use client'

import { useState, useEffect, useRef } from 'react'
import { formatNumber, formatCurrency } from '@/utils/formatters'
import type { GpsData } from './StockSignalPanel'

// ---------------------------------------------------------------------------
// Props — historicalData removed; data is fetched internally via /data route
// ---------------------------------------------------------------------------
interface StockPredictionProps {
  ticker: string
  currentPrice: number
  peRatio?: number
  pbRatio?: number
  marketCap?: number
  sma20?: number
  sma50?: number
  rsi?: number
  momentum?: number
  technicalScore?: number
  recommendationKey: string | null; // Added recommendationKey
  newsArticles?: Array<{
    title?: string
    description?: string
    content?: string
    sentiment_score?: number
    publishedAt?: string
    article_type?: string
  }>
  historicalEarnings?: Array<{
    date: string
    revenue: number | null
    earnings: number | null
    epsActual: number | null
    epsEstimate: number | null
  }>
  titleLevel?: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
  triggerRef?: React.MutableRefObject<() => void>
  onLoadingChange?: (loading: boolean) => void
  onPredictionComplete?: (gpsData?: GpsData | null) => void
  embedded?: boolean
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------
interface TrajectoryPoint {
  month: string
  predicted_price: number
  lower_bound: number
  upper_bound: number
}

interface PredictionResult {
  ticker: string
  regularMarketPrice: number
  predicted_price_1d: number
  predicted_price_1m: number
  predicted_price_6m: number
  predicted_price_1y: number
  predicted_change_pct_1d: number
  predicted_change_pct_1m: number
  predicted_change_pct_6m: number
  predicted_change_pct_1y: number
  confidence_score_1d: number
  confidence_score_1m: number
  confidence_score_6m: number
  confidence_score_1y: number
  high_uncertainty: boolean
  predicted_change_range: [number, number]
  predicted_range_1d?: [number, number]
  monthly_trajectory: TrajectoryPoint[]
  accuracy_metrics: {
    model?: { mae: number; rmse: number; cv_mae?: number }
    neural_network?: { mae: number; rmse: number }
  }
  stock_type?: string
  growth_rate_20d?: number
  is_uptrend?: number
  model_status?: string
  note?: string
  data_quality?: {
    historyDays: number
    historyYears: number
    fundamentalsComplete: boolean
    analystDataAvailable: boolean
    imputedFields: string[]
  }
  metric_analysis?: any
}

interface DataQuality {
  historyDays: number
  historyYears: number
  fundamentalsComplete: boolean
  analystDataAvailable: boolean
  macroDataAvailable: boolean
  imputedFields: string[]
}

// ---------------------------------------------------------------------------
// Confidence badge
// ---------------------------------------------------------------------------
const CONFIDENCE_TOOLTIP =
  'Score is based on: data depth (25 pts), cross-validation error (40 pts), feature completeness (20 pts), analyst coverage (15 pts).'

function ConfidenceBadgeBlue({ score }: { score: number }) {
  if (score >= 66) {
    return (
      <span
        title={CONFIDENCE_TOOLTIP}
        className="inline-block text-xs font-semibold px-2 py-0.5 rounded-full border bg-blue-50 text-blue-600 border-blue-500 cursor-help"
      >
        High Confidence · {score}
      </span>
    )
  }
   if (score >= 41) {
    return (
      <span
        title={CONFIDENCE_TOOLTIP}
        className="inline-block text-xs font-semibold px-2 py-0.5 rounded-full border bg-gray-50 text-amber-700 border-gray-300 cursor-help"
      >
        Medium Confidence · {score}
      </span>
    )
  }
  return (
    <span
      title={CONFIDENCE_TOOLTIP}
      className="inline-block text-xs font-semibold px-2 py-0.5 rounded-full border bg-red-50 text-red-700 border-red-300 cursor-help"
    >
      Low Confidence · {score}
    </span>
  )
}

function ConfidenceBadge({ score }: { score: number }) {
  if (score >= 66) {
    return (
      <span
        title={CONFIDENCE_TOOLTIP}
        className="inline-block text-xs font-semibold px-2 py-0.5 rounded-full border cursor-help bg-[#f0fdf4] text-[#005a00] border-[#005a00]"
      >
        High Confidence · {score}
      </span>
    )
  }
  if (score >= 41) {
    return (
      <span
        title={CONFIDENCE_TOOLTIP}
        className="inline-block text-xs font-semibold px-2 py-0.5 rounded-full border bg-gray-50 text-amber-700 border-gray-300 cursor-help"
      >
        Medium Confidence · {score}
      </span>
    )
  }
  return (
    <span
      title={CONFIDENCE_TOOLTIP}
      className="inline-block text-xs font-semibold px-2 py-0.5 rounded-full border bg-red-50 text-red-700 border-red-300 cursor-help"
    >
      Low Confidence · {score}
    </span>
  )
}

// ---------------------------------------------------------------------------
// SVG Trajectory Chart
// ---------------------------------------------------------------------------
function TrajectoryChart({
  trajectory,
  currentPrice,
}: {
  trajectory: TrajectoryPoint[]
  currentPrice: number
}) {
  if (!trajectory || trajectory.length === 0) return null

  const W = 700
  const H = 260
  const PAD = { top: 20, right: 24, bottom: 40, left: 64 }
  const chartW = W - PAD.left - PAD.right
  const chartH = H - PAD.top - PAD.bottom

  const allPrices = [
    currentPrice,
    ...trajectory.map(t => t.predicted_price),
    ...trajectory.map(t => t.lower_bound),
    ...trajectory.map(t => t.upper_bound),
  ]
  const minP = Math.min(...allPrices) * 0.98
  const maxP = Math.max(...allPrices) * 1.02

  const xScale = (i: number) => PAD.left + (i / (trajectory.length - 1)) * chartW
  const yScale = (p: number) => PAD.top + chartH - ((p - minP) / (maxP - minP)) * chartH

  const linePath = trajectory
    .map((t, i) => `${i === 0 ? 'M' : 'L'} ${xScale(i).toFixed(1)} ${yScale(t.predicted_price).toFixed(1)}`)
    .join(' ')

  const bandPath =
    trajectory.map((t, i) => `${i === 0 ? 'M' : 'L'} ${xScale(i).toFixed(1)} ${yScale(t.upper_bound).toFixed(1)}`).join(' ') +
    ' ' +
    trajectory.map((t, i) => `L ${xScale(trajectory.length - 1 - i).toFixed(1)} ${yScale(trajectory[trajectory.length - 1 - i].lower_bound).toFixed(1)}`).join(' ') +
    ' Z'

  const currentY  = yScale(currentPrice)
  const dividerX  = xScale(5)  // between month 6 and 7 (index 5 = 6th point)
  const m6Idx     = 5
  const m12Idx    = 11
  const m6X       = xScale(m6Idx)
  const m12X      = xScale(m12Idx)
  const m6Y       = yScale(trajectory[m6Idx]?.predicted_price ?? currentPrice)
  const m12Y      = yScale(trajectory[m12Idx]?.predicted_price ?? currentPrice)
  const m1Idx     = 0   
  const m1X       = xScale(m1Idx)
  const m1Y       = yScale(trajectory[m1Idx]?.predicted_price ?? currentPrice)

  const yTicks = Array.from({ length: 4 }, (_, i) => minP + (i / 3) * (maxP - minP))

  return (
    <div className="w-full overflow-x-auto mt-6">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-full min-w-[340px]">
        <defs>
          <clipPath id="chart-clip">
            <rect x={PAD.left} y={PAD.top} width={chartW} height={chartH} />
          </clipPath>
        </defs>

        {/* Confidence band */}
        <path d={bandPath} fill="#2563EB" fillOpacity="0.10" clipPath="url(#chart-clip)" />

        {/* Current price dashed line */}
        <line
          x1={PAD.left} x2={PAD.left + chartW}
          y1={currentY}  y2={currentY}
          stroke="#9CA3AF" strokeWidth="1" strokeDasharray="5 3"
        />
        <text x={PAD.left + 11} y={currentY - 4} fontSize="10" fill="#6B7280">Current</text>

        {/* Month-6 divider */}
        <line
          x1={dividerX} x2={dividerX}
          y1={PAD.top}   y2={PAD.top + chartH}
          stroke="#9CA3AF" strokeWidth="1" strokeDasharray="4 3"
        />
        <text x={PAD.left + 4}  y={PAD.top + 12} fontSize="9" fill="#6B7280">Primary Forecast</text>
        <text x={dividerX + 4}  y={PAD.top + 12} fontSize="9" fill="#6B7280">Extended Outlook</text>

        {/* Price line */}
        <path d={linePath} fill="none" stroke="#2563EB" strokeWidth="2" clipPath="url(#chart-clip)" />

        {/* Month 1 dot */}
        <circle cx={m1X} cy={m1Y} r="5" fill="#2563EB" stroke="#2826b1c4" />

        {/* Month 6 dot */}
        <circle cx={m6X} cy={m6Y} r="5" fill="#2563EB" stroke = "#2826b1c4" />

        {/* Month 12 dot */}
        <circle cx={m12X} cy={m12Y} r="5" fill="#2563EB" stroke = "#2826b1c4" />

        {/* Y-axis ticks */}
        {yTicks.map((p, i) => (
          <g key={i}>
            <line x1={PAD.left - 4} x2={PAD.left} y1={yScale(p)} y2={yScale(p)} stroke="#D1D5DB" />
            <text x={PAD.left - 6} y={yScale(p) + 4} fontSize="10" fill="#6B7280" textAnchor="end">
              {formatCurrency(p)}
            </text>
          </g>
        ))}

        {/* X-axis labels — every 3rd */}
        {trajectory.map((t, i) => {
          if (i % 3 !== 0) return null
          return (
            <text
              key={i}
              x={xScale(i)} y={H - 8}
              fontSize="9" fill="#6B7280" textAnchor="middle"
            >
              {t.month}
            </text>
          )
        })}

        {/* Axes */}
        <line x1={PAD.left} x2={PAD.left}           y1={PAD.top} y2={PAD.top + chartH} stroke="#D1D5DB" />
        <line x1={PAD.left} x2={PAD.left + chartW}  y1={PAD.top + chartH} y2={PAD.top + chartH} stroke="#D1D5DB" />
      </svg>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function StockPrediction({
  ticker,
  currentPrice,
  peRatio,
  pbRatio,
  marketCap,
  sma20,
  sma50,
  rsi,
  momentum,
  technicalScore,
  recommendationKey,
  newsArticles,
  historicalEarnings,
  titleLevel = 'h2',
  triggerRef,
  onLoadingChange,
  onPredictionComplete,
  embedded = false,
}: StockPredictionProps) {
  const [step, setStep]               = useState<'idle' | 'fetching' | 'predicting' | 'done'>('idle')
  const [prediction, setPrediction]   = useState<PredictionResult | null>(null)
  const [dataQuality, setDataQuality] = useState<DataQuality | null>(null)
  const [error, setError]             = useState<string | null>(null)
  const [showMetrics, setShowMetrics] = useState(false)
  const [bannerDismissed, setBannerDismissed] = useState(false)

  const loading = step === 'fetching' || step === 'predicting'
  const TitleTag = titleLevel;

  const generate = async () => {
    setError(null)
    setPrediction(null)
    setDataQuality(null)
    setBannerDismissed(false)

    // ---- Step 1: fetch enriched data payload ----
    setStep('fetching')
    let dataPayload: any
    try {
      const res = await fetch(`/api/stock_data/${ticker}/data`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.message || `Data fetch failed (${res.status})`)
      }
      dataPayload = await res.json()
      setDataQuality(dataPayload.dataQuality ?? null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch stock data')
      setStep('idle')
      return
    }

    // ---- Step 2: run MLP prediction ----
    setStep('predicting')
    try {
      // Merge client-side news + fallback earnings + technicalScore
      const payload = {
        ...dataPayload,
        newsArticles: newsArticles ?? [],
        technicalScore: technicalScore,
        recommendationKey: recommendationKey,
        historicalEarnings:
          dataPayload.historicalEarnings?.length > 0
            ? dataPayload.historicalEarnings
            : (historicalEarnings ?? []),
      }

      const res = await fetch(`/api/prediction/${ticker}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.message || `Prediction failed (${res.status})`)
      }

      const result = await res.json()
      if (result.error) throw new Error(result.error)

      const freshGps: GpsData | null = result.gps_score != null ? {
        gpsScore: result.gps_score,
        gpsBreakdown: result.gps_breakdown ?? null,
        source: 'stock_gps_scores',
        asOf: new Date().toISOString(),
      } : null

      setPrediction(result)
      setStep('done')
      onPredictionComplete?.(freshGps)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unknown error occurred')
      setStep('idle')
    }
  }

  // Expose generate to StockSignalPanel via ref; keep ref current on every render
  const generateRef = useRef(generate)
  generateRef.current = generate
  if (triggerRef) triggerRef.current = () => generateRef.current()

  useEffect(() => {
    onLoadingChange?.(loading)
  }, [loading]) // eslint-disable-line react-hooks/exhaustive-deps

  const btnLabel =
    step === 'fetching'   ? 'Fetching 5-year data...' :
    step === 'predicting' ? 'Running MLP model...' :
                            'Generate Prediction'

  const dq = dataQuality
  const showDqWarnings = dq && (dq.historyYears < 4.9 || !dq.fundamentalsComplete || !dq.analystDataAvailable)

  const content = (
    <>
      {!embedded && (
        <>
          <TitleTag className="text-2xl font-semibold text-gray-800 mb-4">📊 AI-Powered Price Prediction</TitleTag>
          <p className="text-gray-600 mb-4">
            Click the button to generate 1-day, 1-month, 6-month and 12-month price predictions for {ticker} using an MLP neural network.
          </p>
        </>
      )}

      {/* Data quality warnings (shown after Step 1 completes) */}
      {showDqWarnings && (
        <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800 space-y-1">
          {(dq!.historyYears ?? 0) < 4.9 && (
            <p>⚠️ Only {(dq!.historyYears ?? 0).toFixed(1)} years of history available (5 preferred). Predictions may be less reliable.</p>
          )}
          {!dq!.fundamentalsComplete && (
            <p>⚠️ Some fundamental metrics were imputed from sector medians: {dq!.imputedFields?.join(', ') || 'None'}.</p>
          )}
          {!dq!.analystDataAvailable && (
            <p>⚠️ No analyst consensus data available for this ticker.</p>
          )}
        </div>
      )}

      {!embedded && (
        <button
          onClick={generate}
          disabled={loading}
          className={`text-white py-2 px-5 rounded-lg transition-colors disabled:bg-gray-400 disabled:cursor-wait ${
            loading ? 'bg-gray-400' : 'bg-[#017e3b] hover:opacity-90'
          }`}
        >
          {btnLabel}
        </button>
      )}

      {error && <p className="text-red-500 mt-4 text-sm">{error}</p>}

      {prediction && (
        <div className="mt-8">
          {/* High-uncertainty banner */}
          {prediction.high_uncertainty && !bannerDismissed && (
            <div className="flex items-start justify-between mb-4 p-3 bg-yellow-50 border border-yellow-300 rounded-lg text-sm text-yellow-800">
              <p>
                ⚠️ <strong>This prediction carries high uncertainty.</strong> The predicted change exceeds ±60%.
                Treat this as a directional signal only, not a price target.
              </p>
              <button
                onClick={() => setBannerDismissed(true)}
                className="ml-3 text-yellow-600 hover:text-yellow-800 shrink-0"
                aria-label="Dismiss"
              >
                ✕
              </button>
            </div>
          )}

          {/* ---- four-horizon headline cards ---- */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            {/* 1-day card */}
            <div className="p-5 bg-purple-50 rounded-xl border border-purple-200">
              <p className="text-xs font-semibold text-purple-600 uppercase tracking-wide mb-2">1-Day Price Target</p>
              <p className="text-3xl font-bold text-purple-800 mb-1">
                {formatCurrency(prediction.predicted_price_1d)}
              </p>
              <p 
                className={`text-sm font-semibold mb-3 ${prediction.predicted_change_pct_1d < 0 ? 'text-red-600' : ''}`}
                style={prediction.predicted_change_pct_1d >= 0 ? { color: "#005a00" } : {}}
              >
                {prediction.predicted_change_pct_1d >= 0 ? '+' : ''}{formatNumber(prediction.predicted_change_pct_1d, 2)}% from current
              </p>
              <ConfidenceBadgeBlue score={prediction.confidence_score_1d} />
              {prediction.predicted_range_1d && (
                <p className="text-xs text-purple-600 mt-3">
                  Range: {formatCurrency(prediction.predicted_range_1d[0])} – {formatCurrency(prediction.predicted_range_1d[1])}
                </p>
              )}
            </div>

            {/* 1-month card */}
            <div className="p-5 bg-blue-50 rounded-xl border border-blue-200">
              <p className="text-xs font-semibold text-blue-500 uppercase tracking-wide mb-2">1-Month Price Target</p>
              <p className="text-3xl font-bold text-blue-800 mb-1">
                {formatCurrency(prediction.predicted_price_1m)}
              </p>
              <p 
                className={`text-sm font-semibold mb-3 ${prediction.predicted_change_pct_1m < 0 ? 'text-red-600' : ''}`}
                style={prediction.predicted_change_pct_1m >= 0 ? { color: "#005a00" } : {}}
              >
                {prediction.predicted_change_pct_1m >= 0 ? '+' : ''}{formatNumber(prediction.predicted_change_pct_1m, 2)}% from current
              </p>
              <ConfidenceBadgeBlue score={prediction.confidence_score_1m} />
              {prediction.monthly_trajectory?.[0] && (
                <p className="text-xs text-blue-600 mt-3">
                  Range: {formatCurrency(prediction.monthly_trajectory[0].lower_bound)} – {formatCurrency(prediction.monthly_trajectory[0].upper_bound)}
                </p>
              )}
            </div>

            {/* 6-month card */}
            <div className="p-5 bg-emerald-50 rounded-xl border border-emerald-200">
              <p className="text-xs font-semibold text-green-700 uppercase tracking-wide mb-2">6-Month Price Target</p>
              <p className="text-3xl font-bold text-emerald-800 mb-1">
                {formatCurrency(prediction.predicted_price_6m)}
              </p>
              <p 
                className={`text-sm font-semibold mb-3 ${prediction.predicted_change_pct_6m < 0 ? 'text-red-600' : ''}`}
                style={prediction.predicted_change_pct_6m >= 0 ? { color: "#005a00" } : {}}
              >
                {prediction.predicted_change_pct_6m >= 0 ? '+' : ''}{formatNumber(prediction.predicted_change_pct_6m, 2)}% from current
              </p>
              <ConfidenceBadge score={prediction.confidence_score_6m} />
              {prediction.monthly_trajectory?.[5] && (
                <p className="text-xs text-green-700 mt-3">
                  Range: {formatCurrency(prediction.monthly_trajectory[5].lower_bound)} – {formatCurrency(prediction.monthly_trajectory[5].upper_bound)}
                </p>
              )}
            </div>

            {/* 12-month card */}
            <div className="p-5 bg-white rounded-xl border border-green-300">
              <p className="text-xs font-semibold text-green-700 uppercase tracking-wide mb-2">12-Month Price Target</p>
              <p className="text-3xl font-bold text-green-900 mb-1">
                {formatCurrency(prediction.predicted_price_1y)}
              </p>
              <p 
                className={`text-sm font-semibold mb-3 ${prediction.predicted_change_pct_1y < 0 ? 'text-red-600' : ''}`}
                style={prediction.predicted_change_pct_1y >= 0 ? { color: "#005a00" } : {}}
              >
                {prediction.predicted_change_pct_1y >= 0 ? '+' : ''}{formatNumber(prediction.predicted_change_pct_1y, 2)}% from current
              </p>
              <ConfidenceBadge score={prediction.confidence_score_1y} />
              {prediction.monthly_trajectory?.[11] && (
                <p className="text-xs text-green-800 mt-3">
                  Range: {formatCurrency(prediction.monthly_trajectory[11].lower_bound)} – {formatCurrency(prediction.monthly_trajectory[11].upper_bound)}
                </p>
              )}
              <p className="text-xs text-gray-800 mt-2 italic">Wider uncertainty — treat as <br />directional guidance</p>
            </div>
          </div>

          {/* ---- 18-month SVG trajectory chart ---- */}
          {prediction.monthly_trajectory?.length > 0 && (
            <TrajectoryChart
              trajectory={prediction.monthly_trajectory}
              currentPrice={prediction.regularMarketPrice}
            />
          )}

          {/* ---- Sidebar metrics + model performance ---- */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-6">
            {/* Left: key metrics */}
            <div className="p-4 bg-gray-50 rounded-lg">
              <p className="text-sm text-gray-600 mb-1">Current Price</p>
              <p className="text-2xl font-bold text-gray-800 mb-4">{formatCurrency(prediction.regularMarketPrice)}</p>
              <div className="space-y-2 text-xs">
                {rsi !== undefined && (
                  <div className="pb-2 border-b border-gray-200">
                    <div className="flex justify-between">
                      <span className="text-gray-600">RSI (14)</span>
                      <span 
                        className={`font-semibold ${rsi > 70 ? 'text-red-600' : rsi < 30 ? '' : 'text-gray-700'}`}
                        style={rsi < 30 ? { color: "#005a00" } : {}}
                      >
                        {formatNumber(rsi, 1)}
                      </span>
                    </div>
                    <p className="text-gray-400 mt-0.5">{rsi > 70 ? '🔴 Overbought' : rsi < 30 ? '🟢 Oversold' : '⚪ Neutral'}</p>
                  </div>
                )}
                {momentum !== undefined && (
                  <div className="pb-2 border-b border-gray-200">
                    <div className="flex justify-between">
                      <span className="text-gray-600">Momentum</span>
                      <span 
                        className={`font-semibold ${Math.abs(momentum) > 2 ? momentum > 0 ? '' : 'text-red-600' : 'text-gray-700'}`}
                        style={Math.abs(momentum) > 2 && momentum > 0 ? { color: "#005a00" } : {}}
                      >
                        {formatNumber(momentum, 2)}
                      </span>
                    </div>
                    <p className="text-gray-400 mt-0.5">{Math.abs(momentum) > 2 ? momentum > 0 ? '🚀 Strong Upward' : '📉 Strong Downward' : '➡️ Neutral'}</p>
                  </div>
                )}
                {sma20 !== undefined && sma50 !== undefined && (
                  <div className="pb-2 border-b border-gray-200">
                    <div className="flex justify-between">
                      <span className="text-gray-600">SMA Trend</span>
                      <span 
                        className={`font-semibold ${sma20 > sma50 ? '' : 'text-red-600'}`}
                        style={sma20 > sma50 ? { color: "#005a00" } : {}}
                      >
                        {sma20 > sma50 ? 'Bullish' : 'Bearish'}
                      </span>
                    </div>
                    <p className="text-gray-400 mt-0.5">SMA20: {formatCurrency(sma20)} {sma20 > prediction.regularMarketPrice ? '(Above)' : '(Below)'} Price</p>
                  </div>
                )}
                {peRatio !== undefined && peRatio > 0 && (
                  <div className="pb-2 border-b border-gray-200">
                    <div className="flex justify-between">
                      <span className="text-gray-600">P/E Ratio</span>
                      <span 
                        className={`font-semibold ${peRatio < 15 ? '' : peRatio > 25 ? 'text-red-600' : 'text-gray-700'}`}
                        style={peRatio < 15 ? { color: "#005a00" } : {}}
                      >
                        {formatNumber(peRatio, 1)}
                      </span>
                    </div>
                    <p className="text-gray-400 mt-0.5">{peRatio < 15 ? '💰 Undervalued' : peRatio > 25 ? '⚠️ Overvalued' : '⚪ Fair Value'}</p>
                  </div>
                )}
                {prediction.stock_type && (
                  <div className="flex justify-between">
                    <span className="text-gray-600">Stock Type</span>
                    <span className="font-semibold text-gray-700 capitalize">{prediction.stock_type.replace(/_/g, ' ')}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Right: model performance */}
            <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
              {(() => {
                const m = prediction.accuracy_metrics?.model ?? prediction.accuracy_metrics?.neural_network
                if (!m || prediction.regularMarketPrice === 0) return null
                const errRate = (m.mae / prediction.regularMarketPrice) * 100
                const accuracy = Math.max(0, 100 - errRate)
                return (
                  <>
                    <p className="text-sm font-semibold text-gray-700 mb-3">Model Performance</p>
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <div>
                        <p className="text-xs text-gray-500 mb-1">Accuracy</p>
                        <p 
                          className={`text-lg font-bold ${accuracy >= 85 ? '' : accuracy >= 70 ? 'text-yellow-600' : 'text-red-600'}`}
                          style={accuracy >= 85 ? { color: "#005a00" } : {}}
                        >
                          {formatNumber(accuracy, 1)}%
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-500 mb-1">Error Rate (MAE)</p>
                        <p className="text-lg font-bold text-gray-700">±{formatNumber(errRate, 2)}%</p>
                      </div>
                    </div>
                    <p className="text-xs text-gray-400 mt-2">
                      MAE: {formatCurrency(m.mae)} | RMSE: {m.rmse != null ? formatNumber(m.rmse, 2) : 'N/A'}
                      {(m as any).cv_mae != null && ` | CV-MAE: ${formatCurrency((m as any).cv_mae)}`}
                    </p>
                    {prediction.model_status === 'fallback_baseline_model' && (
                      <p className="text-xs text-amber-600 mt-2">⚠️ Using fallback baseline model</p>
                    )}
                    {prediction.note && (
                      <p className="text-xs text-blue-600 mt-1">Note: {prediction.note}</p>
                    )}
                    {prediction.data_quality && (
                      <div className="mt-3 pt-2 border-t border-blue-200 text-xs text-gray-500 space-y-0.5">
                        <p>History: {(prediction.data_quality.historyYears ?? 0).toFixed(1)} years ({prediction.data_quality.historyDays ?? 'N/A'} days)</p>
                        {(prediction.data_quality.imputedFields?.length ?? 0) > 0 && (
                          <p>Imputed: {prediction.data_quality.imputedFields?.join(', ')}</p>
                        )}
                      </div>
                    )}
                  </>
                )
              })()}
            </div>
          </div>

          {/* ---- Detailed Metric Analysis (accordion) ---- */}
          {prediction.metric_analysis && (
            <div className="mt-6">
              <button
                className="w-full text-left p-4 bg-gray-50 rounded-t-lg border border-gray-200 flex justify-between items-center focus:outline-none"
                onClick={() => setShowMetrics(!showMetrics)}
              >
                <h3 className="text-lg font-semibold text-gray-800">Detailed Metric Analysis</h3>
                <span className="text-gray-500">{showMetrics ? '▲' : '▼'}</span>
              </button>
              {showMetrics && (
                <div className="p-4 bg-gray-50 rounded-b-lg border border-gray-200 border-t-0">
                  {Object.entries(prediction.metric_analysis).map(([key, value]: [string, any]) => {
                    if (key === 'total_metric_impact' || key === 'impact_classification') return null

                    const metricDescriptions: Record<string, string> = {
                      rsi: 'Relative Strength Index (14-day) — a momentum oscillator on a 0–100 scale. Above 70 signals the stock is overbought (selling pressure likely); below 30 signals oversold (potential buying opportunity). The model reduces its price target when RSI is overbought and raises it when oversold.',
                      moving_averages: 'SMA-20 / EMA-50 trend — compares the 20-day simple moving average to the 50-day exponential moving average. When SMA-20 is above EMA-50 it is a bullish "golden cross" trend; below is bearish. The model weights this heavily as it reflects medium-term institutional buying or selling pressure.',
                      volume: 'Volume conviction — compares today\'s trading volume to the 20-day average. High volume on an up day confirms strong buyer interest and lends credibility to the move. Low volume means the price move has weak participation and may not sustain. Volume spikes often precede or confirm trend changes.',
                      macd: 'Moving Average Convergence/Divergence — measures the gap between a 12-day and 26-day exponential moving average, smoothed by a 9-day signal line. When the MACD line crosses above the signal line it is a bullish crossover; crossing below is bearish. It captures momentum shifts before they fully show in price.',
                      stochastic: 'Stochastic Oscillator (14-day) — compares the closing price to its trading range over 14 days, giving a 0–100 reading. Above 80 = overbought, below 20 = oversold. It works best in range-bound markets to spot reversals, and is used alongside RSI to confirm momentum signals.',
                      atr: 'Average True Range (14-day) — measures average daily price swings to quantify volatility. A rising ATR means the stock is making larger moves each day (higher risk/reward). The model uses ATR to set the confidence bands around the prediction — wider bands for volatile stocks.',
                      bollinger_bands: 'Bollinger Bands (20-day, 2 std dev) — a volatility envelope around the 20-day moving average. Price touching the upper band can signal overbought conditions; touching the lower band can signal oversold. When the bands squeeze (narrow), it often precedes a sharp price breakout in either direction.',
                      growth_and_trend: '20-day price growth rate and trend direction — measures raw price momentum over the last 20 trading days and classifies whether the stock is in an uptrend. Strong positive growth in an uptrend is the single largest positive input to the model\'s impact score (+8%). A downtrend subtracts the same amount.',
                      sentiment: 'News sentiment score derived from recent headlines. Ranges from -1 (very negative) to +1 (very positive). Positive news flow (earnings beats, upgrades, new products) tends to attract buyers and lift the price. Negative news (lawsuits, misses, leadership changes) does the reverse. The model applies this as a short-term multiplier.',
                      fundamentals: 'Core valuation metrics used as baseline context. P/E ratio shows how much the market pays per dollar of earnings (high = growth premium, low = value or distress). P/B ratio compares price to net assets (below 1.0 often signals undervaluation). Market cap determines the size tier, which affects risk and liquidity in the model.',
                      analyst_consensus: 'Aggregate analyst consensus rating (e.g., Buy, Strong Buy, Hold). The model converts these qualitative ratings into a numeric multiplier. A strong consensus across many analysts provides a statistically significant "wisdom of the crowd" signal that adjusts the price target up or down (+/- 2%).',
                    }

                    const description = metricDescriptions[key]

                    return (
                      <div key={key} className="mb-4 pb-4 border-b border-gray-200 last:border-b-0">
                        <p className="text-sm font-semibold text-gray-800 mb-1 capitalize">{key.replace(/_/g, ' ')}</p>
                        {description && (
                          <p className="text-xs text-gray-500 mb-2 leading-relaxed">{description}</p>
                        )}
                        <div className="text-xs text-gray-600 pl-2 space-y-0.5 bg-white rounded p-2 border border-gray-100">
                          {Object.entries(value).map(([mk, mv]: [string, any]) => (
                            <p key={mk}>
                              <span className="font-medium capitalize">{mk.replace(/_/g, ' ')}:</span>{' '}
                              {typeof mv === 'boolean' ? (mv ? 'Yes' : 'No') :
                               typeof mv === 'number' ? formatNumber(mv, 4) : String(mv)}
                            </p>
                          ))}
                        </div>
                      </div>
                    )
                  })}
                  {prediction.metric_analysis.total_metric_impact !== undefined && (
                    <div className="mt-3 pt-2 border-t border-gray-200">
                      <p className="text-sm text-gray-500 mb-2">The overall impact score is the sum of all metric signals. It adjusts the model's raw MLP output up or down before generating the final price target. Scores above +0.08 are classified as very bullish; below -0.08 as very bearish.</p>
                      <p className="text-sm font-semibold text-gray-700">
                        Overall Impact Score:{' '}
                        <span className="text-blue-600">{formatNumber(prediction.metric_analysis.total_metric_impact, 4)}</span>
                      </p>
                      <p className="text-sm font-semibold text-gray-700">
                        Classification:{' '}
                        <span className="text-purple-600 capitalize">
                          {prediction.metric_analysis.impact_classification.replace(/_/g, ' ')}
                        </span>
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </>
  )

  if (embedded) {
    const hasContent = !!(error || showDqWarnings || prediction)
    return (
      <div className={hasContent ? 'mt-6 pt-6 border-t border-gray-100' : ''}>
        {content}
      </div>
    )
  }

  return (
    <div className="bg-white p-6 rounded-2xl shadow-[0_1px_10px_rgba(0,0,0,0.1)] mb-8">
      {content}
    </div>
  )
}
