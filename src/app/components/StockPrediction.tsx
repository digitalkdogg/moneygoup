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
  recommendationKey: string | null;
  analystGradeScore?: number;
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
  onPredictionFailure?: (errorMessage: string) => void
  embedded?: boolean
  // Server-fetched fresh prediction (<12h old). When present, render the
  // results panel immediately in place of the "Generate Prediction" button.
  prefetchedPrediction?: Partial<PredictionResult> | null
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
  predicted_price_1w: number
  predicted_price_1m: number
  predicted_price_6m: number
  predicted_price_1y: number
  predicted_change_pct_1w: number
  predicted_change_pct_1m: number
  predicted_change_pct_6m: number
  predicted_change_pct_1y: number
  confidence_score_1w: number
  confidence_score_1m: number
  confidence_score_6m: number
  confidence_score_1y: number
  high_uncertainty: boolean
  predicted_change_range: [number, number]
  predicted_range_1w?: [number, number]
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
  // Set by Python's _sanitize_predictions when 6m + 1y both push against
  // their vol-scaled caps in the same direction. Signals "strong directional
  // extrapolation, price target is at the model ceiling, don't treat the
  // point value as precise." UI swaps the "+X% from current" text for a
  // directional pill and prefixes the price with ≥ / ≤.
  at_model_ceiling_6m?: boolean
  at_model_ceiling_1y?: boolean
  ceiling_direction?: 'up' | 'down'
  confidence_breakdown?: ConfidenceBreakdown | null
  // Per-horizon override reasons emitted by _sanitize_predictions when it
  // manually adjusts a horizon's confidence (e.g. peak-and-reverse smoothness
  // gate, ceiling-clamp outlier, opposite-sign disagreement). Take precedence
  // over the component-based reasons when present.
  confidence_reason_1w?: string
  confidence_reason_1m?: string
  confidence_reason_6m?: string
  confidence_reason_1y?: string
  /** Optional LLM-written 2-3 sentence narrative. Rendered as a
   *  "Why this range" callout above the trajectory chart when present.
   *  NULL when Ollama is disabled/down; UI falls back to the rule-based
   *  confidence_reason_{h} strings displayed on the confidence badges. */
  llm_rationale?: string | null
  model_mode?: 'fallback' | string
}

interface ConfidenceBreakdown {
  total: number
  components: {
    cv_mape:  { points: number; max: number; value: number }
    history:  { points: number; max: number; value: number }
    features: { points: number; max: number; imputed_fields: string[] }
    analyst:  { points: number; max: number; analyst_count: number }
  }
  cv_mape_source?: string
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

// Build a plain-language "why is confidence Medium/Low?" tooltip by walking
// the breakdown and calling out only the components that are docking. High
// confidence returns null → no tooltip attribute rendered.
function buildConfidenceReason(
  breakdown: ConfidenceBreakdown | null | undefined,
  score: number,
  overrideReason?: string | null,
): string | null {
  if (score >= 66) return null
  // Sanitizer-supplied override wins: it explains WHY the score was manually
  // adjusted (e.g. peak-and-reverse trajectory, outlier clamp) — details the
  // component breakdown alone can't convey.
  if (overrideReason) {
    const label = score >= 41 ? 'Medium' : 'Low'
    return `${label} confidence because:\n\n${overrideReason}`
  }
  if (!breakdown) return null
  const c = breakdown.components
  const reasons: string[] = []

  // cv_mape (40 pts) — model tracking error on validation
  if (c.cv_mape.points < c.cv_mape.max) {
    const err = c.cv_mape.value
    if (err >= 20) {
      reasons.push(`Model tracks this stock with ±${err.toFixed(0)}% error on held-out data — high uncertainty in the price forecast itself.`)
    } else if (err >= 10) {
      reasons.push(`Model tracks this stock with ±${err.toFixed(0)}% error on held-out data — moderate uncertainty.`)
    } else if (err >= 5) {
      reasons.push(`Model tracks this stock with ±${err.toFixed(1)}% error on held-out data.`)
    }
  }

  // history (25 pts) — years of price data available
  if (c.history.points < c.history.max) {
    const yrs = c.history.value
    if (yrs < 2) {
      reasons.push(`Only ${yrs.toFixed(1)} years of price history — the model doesn't have much to learn from.`)
    } else if (yrs < 3) {
      reasons.push(`Only ${yrs.toFixed(1)} years of price history (5+ preferred).`)
    } else if (yrs < 4) {
      reasons.push(`${yrs.toFixed(1)} years of price history (5+ preferred).`)
    } else {
      reasons.push(`${yrs.toFixed(1)} years of price history (5+ preferred for full trust).`)
    }
  }

  // features (20 pts) — fundamentals imputed from sector medians
  if (c.features.points < c.features.max) {
    const imputed = c.features.imputed_fields || []
    if (imputed.length > 0) {
      const list = imputed.join(', ')
      reasons.push(
        imputed.length <= 2
          ? `${imputed.length} fundamental${imputed.length === 1 ? '' : 's'} filled from sector medians: ${list}.`
          : `${imputed.length} fundamentals filled from sector medians (${list}) — the model doesn't have this stock's real numbers for those fields.`
      )
    }
  }

  // analyst (15 pts) — Wall Street coverage
  if (c.analyst.points < c.analyst.max) {
    const n = c.analyst.analyst_count
    if (n === 0) {
      reasons.push('No analyst coverage — the model is flying without external validation.')
    } else if (n < 5) {
      reasons.push(`Only ${n} analyst${n === 1 ? '' : 's'} covering this stock (10+ preferred for full trust).`)
    } else if (n < 10) {
      reasons.push(`${n} analysts covering this stock (10+ preferred for full trust).`)
    } else {
      reasons.push(`Analyst signals are mixed or noisy — coverage exists but conviction is limited.`)
    }
  }

  if (reasons.length === 0) return null
  const label = score >= 41 ? 'Medium' : 'Low'
  return `${label} confidence because:\n\n• ${reasons.join('\n• ')}`
}

function ConfidenceBadgeBlue({ score, breakdown, overrideReason }: { score: number; breakdown?: ConfidenceBreakdown | null; overrideReason?: string | null }) {
  const reason = buildConfidenceReason(breakdown, score, overrideReason)
  const tooltipProps = reason ? { title: reason, className: 'cursor-help' } : {}

  if (score >= 66) {
    return (
      <span className={`inline-block text-xs font-semibold px-2 py-0.5 rounded-full border bg-blue-50 text-blue-600 border-blue-500`}>
        High Confidence · {score}
      </span>
    )
  }
  if (score >= 41) {
    return (
      <span
        {...tooltipProps}
        className={`inline-block text-xs font-semibold px-2 py-0.5 rounded-full border bg-gray-50 text-amber-700 border-gray-300 ${tooltipProps.className ?? ''}`}
      >
        Medium Confidence · {score}
      </span>
    )
  }
  return (
    <span
      {...tooltipProps}
      className={`inline-block text-xs font-semibold px-2 py-0.5 rounded-full border bg-red-50 text-red-700 border-red-300 ${tooltipProps.className ?? ''}`}
    >
      Low Confidence · {score}
    </span>
  )
}

function ConfidenceBadge({ score, breakdown, overrideReason }: { score: number; breakdown?: ConfidenceBreakdown | null; overrideReason?: string | null }) {
  const reason = buildConfidenceReason(breakdown, score, overrideReason)
  const tooltipProps = reason ? { title: reason, className: 'cursor-help' } : {}

  if (score >= 66) {
    return (
      <span className={`inline-block text-xs font-semibold px-2 py-0.5 rounded-full border bg-[#f0fdf4] text-[#005a00] border-[#005a00]`}>
        High Confidence · {score}
      </span>
    )
  }
  if (score >= 41) {
    return (
      <span
        {...tooltipProps}
        className={`inline-block text-xs font-semibold px-2 py-0.5 rounded-full border bg-gray-50 text-amber-700 border-gray-300 ${tooltipProps.className ?? ''}`}
      >
        Medium Confidence · {score}
      </span>
    )
  }
  return (
    <span
      {...tooltipProps}
      className={`inline-block text-xs font-semibold px-2 py-0.5 rounded-full border bg-red-50 text-red-700 border-red-300 ${tooltipProps.className ?? ''}`}
    >
      Low Confidence · {score}
    </span>
  )
}

// ---------------------------------------------------------------------------
// SVG Trajectory Chart
// ---------------------------------------------------------------------------
type TooltipState = { x: number; y: number; label: string; price: number; pct: number | null } | null

function TrajectoryChart({
  trajectory,
  currentPrice,
  anchorPcts,
}: {
  trajectory: TrajectoryPoint[]
  currentPrice: number
  anchorPcts?: { w1?: number | null; m1?: number | null; m6?: number | null; y1?: number | null }
}) {
  const [tooltip, setTooltip] = useState<TooltipState>(null)

  if (!trajectory || trajectory.length === 0) return null

  // Prepend current price as t=0 anchor so the line starts from "now"
  const nowPoint: TrajectoryPoint = { month: 'Now', predicted_price: currentPrice, lower_bound: currentPrice, upper_bound: currentPrice }
  const pts = [nowPoint, ...trajectory]

  const W = 700
  const H = 260
  const PAD = { top: 20, right: 24, bottom: 40, left: 64 }
  const chartW = W - PAD.left - PAD.right
  const chartH = H - PAD.top - PAD.bottom

  const allPrices = [
    currentPrice,
    ...pts.map(t => t.predicted_price),
    ...pts.map(t => t.lower_bound),
    ...pts.map(t => t.upper_bound),
  ]
  const minP = Math.min(...allPrices) * 0.98
  const maxP = Math.max(...allPrices) * 1.02

  const xScale = (i: number) => PAD.left + (i / (pts.length - 1)) * chartW
  const yScale = (p: number) => PAD.top + chartH - ((p - minP) / (maxP - minP)) * chartH

  const linePath = pts
    .map((t, i) => `${i === 0 ? 'M' : 'L'} ${xScale(i).toFixed(1)} ${yScale(t.predicted_price).toFixed(1)}`)
    .join(' ')

  const bandPath =
    pts.map((t, i) => `${i === 0 ? 'M' : 'L'} ${xScale(i).toFixed(1)} ${yScale(t.upper_bound).toFixed(1)}`).join(' ') +
    ' ' +
    pts.map((t, i) => `L ${xScale(pts.length - 1 - i).toFixed(1)} ${yScale(pts[pts.length - 1 - i].lower_bound).toFixed(1)}`).join(' ') +
    ' Z'

  const currentY  = yScale(currentPrice)
  // Indexes shift +1 because pts[0] is now the "Now" anchor
  const m1wIdx    = 1   // t+5  (1 week)
  const m1Idx     = 2   // t+21 (1 month)
  const m6Idx     = 7   // t+126 (6 months)
  const m12Idx    = 13  // t+252 (12 months)
  const dividerX  = xScale(m6Idx)
  const m1wX      = xScale(m1wIdx)
  const m1wY      = yScale(pts[m1wIdx]?.predicted_price ?? currentPrice)
  const m6X       = xScale(m6Idx)
  const m12X      = xScale(m12Idx)
  const m6Y       = yScale(pts[m6Idx]?.predicted_price ?? currentPrice)
  const m12Y      = yScale(pts[m12Idx]?.predicted_price ?? currentPrice)
  const m1X       = xScale(m1Idx)
  const m1Y       = yScale(pts[m1Idx]?.predicted_price ?? currentPrice)

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

        {/* Current price reference line */}
        <line
          x1={PAD.left} x2={PAD.left + chartW}
          y1={currentY}  y2={currentY}
          stroke="#9CA3AF" strokeWidth="1" strokeDasharray="5 3"
        />

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

        {/* 1-week dot */}
        <circle
          cx={m1wX} cy={m1wY} r="6" fill="#2563EB" stroke="#1d4ed8" style={{ cursor: 'pointer' }}
          onMouseEnter={() => { const p = pts[m1wIdx]?.predicted_price ?? currentPrice; setTooltip({ x: m1wX, y: m1wY, label: '1 Week', price: p, pct: anchorPcts?.w1 ?? (p - currentPrice) / currentPrice * 100 }) }}
          onMouseLeave={() => setTooltip(null)}
        />

        {/* 1-month dot */}
        <circle
          cx={m1X} cy={m1Y} r="6" fill="#2563EB" stroke="#1d4ed8" style={{ cursor: 'pointer' }}
          onMouseEnter={() => { const p = pts[m1Idx]?.predicted_price ?? currentPrice; setTooltip({ x: m1X, y: m1Y, label: '1 Month', price: p, pct: anchorPcts?.m1 ?? (p - currentPrice) / currentPrice * 100 }) }}
          onMouseLeave={() => setTooltip(null)}
        />

        {/* 6-month dot */}
        <circle
          cx={m6X} cy={m6Y} r="6" fill="#2563EB" stroke="#1d4ed8" style={{ cursor: 'pointer' }}
          onMouseEnter={() => { const p = pts[m6Idx]?.predicted_price ?? currentPrice; setTooltip({ x: m6X, y: m6Y, label: '6 Months', price: p, pct: anchorPcts?.m6 ?? (p - currentPrice) / currentPrice * 100 }) }}
          onMouseLeave={() => setTooltip(null)}
        />

        {/* 12-month dot */}
        <circle
          cx={m12X} cy={m12Y} r="6" fill="#2563EB" stroke="#1d4ed8" style={{ cursor: 'pointer' }}
          onMouseEnter={() => { const p = pts[m12Idx]?.predicted_price ?? currentPrice; setTooltip({ x: m12X, y: m12Y, label: '12 Months', price: p, pct: anchorPcts?.y1 ?? (p - currentPrice) / currentPrice * 100 }) }}
          onMouseLeave={() => setTooltip(null)}
        />

        {/* Y-axis ticks */}
        {yTicks.map((p, i) => (
          <g key={i}>
            <line x1={PAD.left - 4} x2={PAD.left} y1={yScale(p)} y2={yScale(p)} stroke="#D1D5DB" />
            <text x={PAD.left - 6} y={yScale(p) + 4} fontSize="10" fill="#6B7280" textAnchor="end">
              {formatCurrency(p)}
            </text>
          </g>
        ))}

        {/* "Now" dot at t=0 */}
        <circle
          cx={xScale(0)} cy={currentY} r="6" fill="#6B7280" stroke="#4B5563" style={{ cursor: 'pointer' }}
          onMouseEnter={() => setTooltip({ x: xScale(0), y: currentY, label: 'Current Price', price: currentPrice, pct: null })}
          onMouseLeave={() => setTooltip(null)}
        />

        {/* X-axis labels — "Now" + every 3rd forecast point */}
        {pts.map((t, i) => {
          if (i !== 0 && i % 3 !== 1) return null  // show "Now" (0) and every 3rd thereafter
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

        {/* Hover tooltip */}
        {tooltip && (() => {
          const TW = 128, TH = tooltip.pct !== null ? 58 : 42, TR = 5
          const flipLeft = tooltip.x + TW + 12 > W
          const tx = flipLeft ? tooltip.x - TW - 10 : tooltip.x + 10
          const ty = Math.max(PAD.top, Math.min(tooltip.y - TH / 2, PAD.top + chartH - TH))
          const pctStr = tooltip.pct !== null
            ? `${tooltip.pct >= 0 ? '+' : ''}${tooltip.pct.toFixed(2)}%`
            : null
          const pctColor = (tooltip.pct ?? 0) >= 0 ? '#4ade80' : '#f87171'
          return (
            <g pointerEvents="none">
              <rect x={tx} y={ty} width={TW} height={TH} rx={TR} ry={TR} fill="#1e293b" opacity="0.92" />
              <text x={tx + TW / 2} y={ty + 14} fontSize="10" fill="#94a3b8" textAnchor="middle">
                {tooltip.label}
              </text>
              <text x={tx + TW / 2} y={ty + 30} fontSize="13" fill="#f1f5f9" fontWeight="600" textAnchor="middle">
                {formatCurrency(tooltip.price)}
              </text>
              {pctStr && (
                <text x={tx + TW / 2} y={ty + 47} fontSize="11" fill={pctColor} textAnchor="middle">
                  {pctStr}
                </text>
              )}
            </g>
          )
        })()}
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
  analystGradeScore,
  newsArticles,
  historicalEarnings,
  titleLevel = 'h2',
  triggerRef,
  onLoadingChange,
  onPredictionComplete,
  onPredictionFailure,
  embedded = false,
  prefetchedPrediction,
}: StockPredictionProps) {
  const [step, setStep]               = useState<'idle' | 'fetching' | 'predicting' | 'done'>('idle')
  const [prediction, setPrediction]   = useState<PredictionResult | null>(null)
  const [dataQuality, setDataQuality] = useState<DataQuality | null>(null)
  const [error, setError]             = useState<string | null>(null)
  const [showMetrics, setShowMetrics] = useState(false)
  const [bannerDismissed, setBannerDismissed] = useState(false)
  const [fallbackBannerDismissed, setFallbackBannerDismissed] = useState(false)
  const loading = step === 'fetching' || step === 'predicting'
  const TitleTag = titleLevel;

  // Async rationale backfill state (Plan 2).
  const [rationaleLoading,    setRationaleLoading]    = useState(false)
  const [rationaleRefreshing, setRationaleRefreshing] = useState(false)
  const pollTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pollAttemptsRef = useRef(0)

  const generate = async (refresh = false) => {
    setError(null)
    setPrediction(null)
    setDataQuality(null)
    setBannerDismissed(false)
    setFallbackBannerDismissed(false)
    pollAttemptsRef.current = 0
    setRationaleLoading(false)
    if (pollTimerRef.current) { clearTimeout(pollTimerRef.current); pollTimerRef.current = null }

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
      const msg = err instanceof Error ? err.message : 'Failed to fetch stock data'
      setError(msg)
      setStep('idle')
      onPredictionFailure?.(msg)
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
        ...(analystGradeScore !== undefined && { analystGradeScore }),
        historicalEarnings:
          dataPayload.historicalEarnings?.length > 0
            ? dataPayload.historicalEarnings
            : (historicalEarnings ?? []),
      }

      const res = await fetch(`/api/prediction/${ticker}${refresh ? '?refresh=true' : ''}`, {
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
      const msg = err instanceof Error ? err.message : 'An unknown error occurred'
      setError(msg)
      setStep('idle')
      onPredictionFailure?.(msg)
    }
  }

  // Expose generate to StockSignalPanel via ref; keep ref current on every render
  const generateRef = useRef(generate)
  generateRef.current = generate
  if (triggerRef) triggerRef.current = () => generateRef.current()

  useEffect(() => {
    onLoadingChange?.(loading)
  }, [loading]) // eslint-disable-line react-hooks/exhaustive-deps

  // Hydrate from a server-fetched fresh prediction (<12h old). Only applied
  // while idle — a user-initiated regenerate always wins.
  useEffect(() => {
    if (!prefetchedPrediction) return
    if (step !== 'idle') return
    const inflated: PredictionResult = {
      ticker,
      regularMarketPrice:      prefetchedPrediction.regularMarketPrice      ?? currentPrice,
      predicted_price_1w:      prefetchedPrediction.predicted_price_1w      ?? 0,
      predicted_price_1m:      prefetchedPrediction.predicted_price_1m      ?? 0,
      predicted_price_6m:      prefetchedPrediction.predicted_price_6m      ?? 0,
      predicted_price_1y:      prefetchedPrediction.predicted_price_1y      ?? 0,
      predicted_change_pct_1w: prefetchedPrediction.predicted_change_pct_1w ?? 0,
      predicted_change_pct_1m: prefetchedPrediction.predicted_change_pct_1m ?? 0,
      predicted_change_pct_6m: prefetchedPrediction.predicted_change_pct_6m ?? 0,
      predicted_change_pct_1y: prefetchedPrediction.predicted_change_pct_1y ?? 0,
      confidence_score_1w:     prefetchedPrediction.confidence_score_1w     ?? 0,
      confidence_score_1m:     prefetchedPrediction.confidence_score_1m     ?? 0,
      confidence_score_6m:     prefetchedPrediction.confidence_score_6m     ?? 0,
      confidence_score_1y:     prefetchedPrediction.confidence_score_1y     ?? 0,
      high_uncertainty:        prefetchedPrediction.high_uncertainty        ?? false,
      predicted_change_range:  prefetchedPrediction.predicted_change_range  ?? [0, 0],
      predicted_range_1w:      prefetchedPrediction.predicted_range_1w,
      monthly_trajectory:      prefetchedPrediction.monthly_trajectory      ?? [],
      accuracy_metrics:        prefetchedPrediction.accuracy_metrics        ?? {},
      stock_type:              prefetchedPrediction.stock_type,
      growth_rate_20d:         prefetchedPrediction.growth_rate_20d,
      is_uptrend:              prefetchedPrediction.is_uptrend,
      model_status:            prefetchedPrediction.model_status,
      note:                    prefetchedPrediction.note,
      data_quality:            prefetchedPrediction.data_quality,
      metric_analysis:         prefetchedPrediction.metric_analysis,
      at_model_ceiling_6m:     prefetchedPrediction.at_model_ceiling_6m ?? undefined,
      at_model_ceiling_1y:     prefetchedPrediction.at_model_ceiling_1y ?? undefined,
      ceiling_direction:       prefetchedPrediction.ceiling_direction   ?? undefined,
      confidence_breakdown:    prefetchedPrediction.confidence_breakdown ?? undefined,
      confidence_reason_1w:    prefetchedPrediction.confidence_reason_1w ?? undefined,
      confidence_reason_1m:    prefetchedPrediction.confidence_reason_1m ?? undefined,
      confidence_reason_6m:    prefetchedPrediction.confidence_reason_6m ?? undefined,
      confidence_reason_1y:    prefetchedPrediction.confidence_reason_1y ?? undefined,
      llm_rationale:           (prefetchedPrediction as { llm_rationale?: string | null }).llm_rationale ?? null,
    }
    setPrediction(inflated)
    setStep('done')
  }, [prefetchedPrediction]) // eslint-disable-line react-hooks/exhaustive-deps

  // Poll for llm_rationale backfill after async narration (Plan 2).
  // Shows "Generating rationale..." immediately, then polls latest-prediction
  // (fast DB read) every 20s up to 3 times (~60s window).  Each poll schedules
  // the next one from within its own callback so the effect only needs to fire
  // once — avoids the re-run dependency problem when llm_rationale stays null.
  useEffect(() => {
    if (!prediction) return
    if (prediction.llm_rationale) { setRationaleLoading(false); return }
    if (pollAttemptsRef.current >= 3) { setRationaleLoading(false); return }

    setRationaleLoading(true)

    const poll = async () => {
      pollAttemptsRef.current++
      try {
        const res = await fetch(`/api/stock_data/${ticker}/latest-prediction`)
        if (res.ok) {
          const data = await res.json()
          const rationale: string | null = data?.prediction?.llm_rationale ?? null
          if (rationale) {
            setPrediction(prev => prev ? { ...prev, llm_rationale: rationale } : prev)
            setRationaleLoading(false)
            pollAttemptsRef.current = 0
            return
          }
        }
      } catch { /* narration is optional */ }

      // Schedule next attempt or give up
      if (pollAttemptsRef.current < 3) {
        pollTimerRef.current = setTimeout(poll, 20_000)
      } else {
        setRationaleLoading(false)
      }
    }

    pollTimerRef.current = setTimeout(poll, 20_000)

    return () => {
      if (pollTimerRef.current) { clearTimeout(pollTimerRef.current); pollTimerRef.current = null }
    }
  }, [prediction?.llm_rationale, ticker]) // eslint-disable-line react-hooks/exhaustive-deps

  const refreshRationale = async () => {
    if (rationaleRefreshing) return;
    setRationaleRefreshing(true);
    try {
      const res = await fetch(`/api/prediction/${encodeURIComponent(ticker)}/rationale`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        if (data?.rationale) {
          setPrediction(prev => prev ? { ...prev, llm_rationale: data.rationale } : prev);
        }
      }
    } catch { /* narration is optional */ } finally {
      setRationaleRefreshing(false);
    }
  };

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
            Click the button to generate 1-week, 1-month, 6-month and 12-month price predictions for {ticker} using an MLP neural network.
          </p>
        </>
      )}

      {/* Data quality warnings (shown after Step 1 completes) */}
      {showDqWarnings && (
        <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800 space-y-1">
          {(dq as any).shortHistory && (
            <p>⚠️ Only {(dq!.historyDays ?? 0)} trading days of history available. {ticker} may be a recent IPO — statistical fallback model will be used.</p>
          )}
          {!(dq as any).shortHistory && (dq!.historyYears ?? 0) < 4.9 && (
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
        <div className="flex items-center gap-3">
          <button
            onClick={() => generate()}
            disabled={loading}
            className={`text-white py-2 px-5 rounded-lg transition-colors disabled:bg-gray-400 disabled:cursor-wait ${
              loading ? 'bg-gray-400' : 'bg-[#017e3b] hover:opacity-90'
            }`}
          >
            {btnLabel}
          </button>
          {prediction && !loading && (
            <button
              onClick={() => generate(true)}
              className="text-xs text-gray-500 hover:text-gray-700 underline underline-offset-2"
            >
              ↺ Recalculate (skip cache)
            </button>
          )}
        </div>
      )}

      {error && (
        <div className="mt-4 p-3 bg-red-50 border border-red-300 rounded-lg text-sm text-red-700 flex items-start gap-2">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <div>
            <strong>Prediction failed.</strong>{' '}
            <span className="text-red-600">{error}</span>
            <p className="mt-1 text-red-600 text-xs">
              Try again in a moment. If the problem persists, this ticker may have data issues that prevent the model from running.
            </p>
          </div>
        </div>
      )}

      {prediction && (
        <div className="mt-8">
          {/* Fallback model banner */}
          {prediction.model_mode === 'fallback' && !fallbackBannerDismissed && (
            <div className="flex items-start justify-between mb-4 p-3 bg-amber-50 border border-amber-300 rounded-lg text-sm text-amber-900">
              <div className="flex items-start gap-2">
                <span className="shrink-0 mt-0.5">⚡</span>
                <div>
                  <strong>Statistical model used.</strong>{' '}
                  {(prediction as any).data_quality?.shortHistory
                    ? `${ticker} has limited trading history (recent IPO). `
                    : 'The full ML model was unavailable for this ticker. '}
                  Predictions are based on price trend &amp; momentum analysis. Confidence scores are capped at 65% and long-horizon targets carry higher uncertainty than usual.
                </div>
              </div>
              <button
                onClick={() => setFallbackBannerDismissed(true)}
                aria-label="Dismiss"
                className="ml-3 text-amber-500 hover:text-amber-700 shrink-0 leading-none"
              >
                ✕
              </button>
            </div>
          )}

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
            {/* 1-week card */}
            <div className="p-5 bg-purple-50 rounded-xl border border-purple-200">
              <p className="text-xs font-semibold text-purple-600 uppercase tracking-wide mb-2">1-Week Price Target</p>
              <p className="text-3xl font-bold text-purple-800 mb-1">
                {formatCurrency(prediction.predicted_price_1w)}
              </p>
              <p
                className={`text-sm font-semibold mb-3 ${prediction.predicted_change_pct_1w < 0 ? 'text-red-600' : ''}`}
                style={prediction.predicted_change_pct_1w >= 0 ? { color: "#005a00" } : {}}
              >
                {prediction.predicted_change_pct_1w >= 0 ? '+' : ''}{formatNumber(prediction.predicted_change_pct_1w, 2)}% from current
              </p>
              <ConfidenceBadgeBlue score={prediction.confidence_score_1w} breakdown={prediction.confidence_breakdown} overrideReason={prediction.confidence_reason_1w} />
              {prediction.predicted_range_1w && (
                <p className="text-xs text-purple-600 mt-3">
                  Range: {formatCurrency(prediction.predicted_range_1w[0])} – {formatCurrency(prediction.predicted_range_1w[1])}
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
              <ConfidenceBadgeBlue score={prediction.confidence_score_1m} breakdown={prediction.confidence_breakdown} overrideReason={prediction.confidence_reason_1m} />
              {prediction.monthly_trajectory?.[1] && (
                <p className="text-xs text-blue-600 mt-3">
                  Range: {formatCurrency(prediction.monthly_trajectory[1].lower_bound)} – {formatCurrency(prediction.monthly_trajectory[1].upper_bound)}
                </p>
              )}
            </div>

            {/* 6-month card */}
            <div className="p-5 bg-emerald-50 rounded-xl border border-emerald-200">
              <p className="text-xs font-semibold text-green-700 uppercase tracking-wide mb-2">6-Month Price Target</p>
              <p className="text-3xl font-bold text-emerald-800 mb-1">
                {prediction.at_model_ceiling_6m
                  ? `${prediction.ceiling_direction === 'down' ? '≤' : '≥'} ${formatCurrency(prediction.predicted_price_6m)}`
                  : formatCurrency(prediction.predicted_price_6m)}
              </p>
              {prediction.at_model_ceiling_6m ? (
                <p className="text-sm font-semibold mb-3"
                   style={{ color: prediction.ceiling_direction === 'down' ? '#dc2626' : '#005a00' }}>
                  Strong {prediction.ceiling_direction === 'down' ? 'downward' : 'upward'} signal — target at model ceiling
                </p>
              ) : (
                <p
                  className={`text-sm font-semibold mb-3 ${prediction.predicted_change_pct_6m < 0 ? 'text-red-600' : ''}`}
                  style={prediction.predicted_change_pct_6m >= 0 ? { color: "#005a00" } : {}}
                >
                  {prediction.predicted_change_pct_6m >= 0 ? '+' : ''}{formatNumber(prediction.predicted_change_pct_6m, 2)}% from current
                </p>
              )}
              <ConfidenceBadge score={prediction.confidence_score_6m} breakdown={prediction.confidence_breakdown} overrideReason={prediction.confidence_reason_6m} />
              {prediction.monthly_trajectory?.[6] && (
                <p className="text-xs text-green-700 mt-3">
                  Range: {formatCurrency(prediction.monthly_trajectory[6].lower_bound)} – {formatCurrency(prediction.monthly_trajectory[6].upper_bound)}
                </p>
              )}
            </div>

            {/* 12-month card */}
            <div className="p-5 bg-white rounded-xl border border-green-300">
              <p className="text-xs font-semibold text-green-700 uppercase tracking-wide mb-2">12-Month Price Target</p>
              <p className="text-3xl font-bold text-green-900 mb-1">
                {prediction.at_model_ceiling_1y
                  ? `${prediction.ceiling_direction === 'down' ? '≤' : '≥'} ${formatCurrency(prediction.predicted_price_1y)}`
                  : formatCurrency(prediction.predicted_price_1y)}
              </p>
              {prediction.at_model_ceiling_1y ? (
                <p className="text-sm font-semibold mb-3"
                   style={{ color: prediction.ceiling_direction === 'down' ? '#dc2626' : '#005a00' }}>
                  Strong {prediction.ceiling_direction === 'down' ? 'downward' : 'upward'} signal — target at model ceiling
                </p>
              ) : (
                <p
                  className={`text-sm font-semibold mb-3 ${prediction.predicted_change_pct_1y < 0 ? 'text-red-600' : ''}`}
                  style={prediction.predicted_change_pct_1y >= 0 ? { color: "#005a00" } : {}}
                >
                  {prediction.predicted_change_pct_1y >= 0 ? '+' : ''}{formatNumber(prediction.predicted_change_pct_1y, 2)}% from current
                </p>
              )}
              <ConfidenceBadge score={prediction.confidence_score_1y} breakdown={prediction.confidence_breakdown} overrideReason={prediction.confidence_reason_1y} />
              {prediction.monthly_trajectory?.[12] && (
                <p className="text-xs text-green-800 mt-3">
                  Range: {formatCurrency(prediction.monthly_trajectory[12].lower_bound)} – {formatCurrency(prediction.monthly_trajectory[12].upper_bound)}
                </p>
              )}
              <p className="text-xs text-gray-800 mt-2 italic">Wider uncertainty — treat as <br />directional guidance</p>
            </div>
          </div>

          {/* ---- "Why this range" LLM narrative ---- */}
          {prediction.llm_rationale ? (
            <div className="mt-6 p-4 bg-blue-50 border-l-4 border-blue-500 rounded-r-lg">
              <div className="flex items-center justify-between mb-1">
                <div className="text-[11px] font-semibold text-blue-700 uppercase tracking-wide">
                  Why this range
                </div>
                <button
                  onClick={refreshRationale}
                  disabled={rationaleRefreshing}
                  className="sm rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white transition-colors focus-ring"
                  style={{ padding: '0.375rem', fontSize: '1rem', lineHeight: 1, width: '2rem', height: '2rem', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  title="Regenerate rationale"
                >
                  {rationaleRefreshing
                    ? <span className="inline-block w-3 h-3 rounded-full border-2 border-white border-t-transparent animate-spin" />
                    : '↻'}
                </button>
              </div>
              {rationaleRefreshing ? (
                <p className="text-sm text-blue-400 italic flex items-center gap-2">
                  <span className="inline-block w-2 h-2 rounded-full bg-blue-300 animate-pulse" />
                  Regenerating rationale...
                </p>
              ) : (
                <p className="text-sm text-gray-800 leading-relaxed">
                  {prediction.llm_rationale}
                </p>
              )}
            </div>
          ) : rationaleLoading ? (
            <div className="mt-6 p-4 bg-blue-50 border-l-4 border-blue-300 rounded-r-lg">
              <div className="text-[11px] font-semibold text-blue-400 uppercase tracking-wide mb-1">
                Why this range
              </div>
              <p className="text-sm text-blue-400 italic flex items-center gap-2">
                <span className="inline-block w-2 h-2 rounded-full bg-blue-300 animate-pulse" />
                Generating rationale...
              </p>
            </div>
          ) : null}

          {/* ---- 18-month SVG trajectory chart ---- */}
          {prediction.monthly_trajectory?.length > 0 && (
            <TrajectoryChart
              trajectory={prediction.monthly_trajectory}
              currentPrice={prediction.regularMarketPrice}
              anchorPcts={{
                w1: prediction.predicted_change_pct_1w,
                m1: prediction.predicted_change_pct_1m,
                m6: prediction.predicted_change_pct_6m,
                y1: prediction.predicted_change_pct_1y,
              }}
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
                      <span className="text-gray-600 text-sm">RSI (14)</span>
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
                      <span className="text-gray-600 text-sm">Momentum</span>
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
                      <span className="text-gray-600 text-sm">SMA Trend</span>
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
                      <span className="text-gray-600 text-sm">P/E Ratio</span>
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
                    <span className="text-gray-600 text-sm">Stock Type</span>
                    <span className="font-semibold text-gray-700 capitalize">{prediction.stock_type.replace(/_/g, ' ')}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Right: model performance — only rendered when accuracy_metrics
                is present. Prefetched predictions restored from prediction_records
                don't carry MAE/RMSE (those are ephemeral training-time
                diagnostics), so the wrapper would otherwise show as an empty
                blue box. A fresh "Recalculate" run populates this. */}
            {(() => {
              const m = prediction.accuracy_metrics?.model ?? prediction.accuracy_metrics?.neural_network
              if (!m || prediction.regularMarketPrice === 0) return null
              const errRate = (m.mae / prediction.regularMarketPrice) * 100
              const accuracy = Math.max(0, 100 - errRate)
              return (
                <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
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
                </div>
              )
            })()}
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
