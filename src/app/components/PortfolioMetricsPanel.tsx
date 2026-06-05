'use client'

import { useMemo } from 'react'
import type { PortfolioItem } from '@/types/portfolio'
import type { PortfolioTotals } from '@/types/dashboard'
import GainsBreakdownCard from '@/app/components/GainsBreakdownCard'

interface Props {
  portfolio: PortfolioItem[]
  loading: boolean
  totals: PortfolioTotals | null
  totalsLoading: boolean
}

interface Metrics {
  perfScore: number
  qualityScore: number
  divScore: number
  gradeScore: number
  grade: string
  gradeStatus: string
  gradeColor: string
  hhi: number
  hhiBadgeClass: string
  weightedGainPct: number
  simpleAvgGainPct: number
  championTicker: string
  championPct: number
  championDollars: number
  laggardTicker: string
  laggardPct: number
  laggardDollars: number
  sectorAlloc: { name: string; pct: number; color: string }[]
  insights: { severity: 'alert' | 'info' | 'success'; html: string }[]
  hasAlerts: boolean
}

const SECTOR_COLORS: Record<string, string> = {
  Technology: '#3b82f6',
  Automotive: '#f97316',
  'Consumer Cyclical': '#8b5cf6',
  'Consumer Defensive': '#84cc16',
  'Financial Services': '#06b6d4',
  Energy: '#eab308',
  Healthcare: '#ec4899',
  Industrials: '#10b981',
  'Real Estate': '#f43f5e',
  'Communication Services': '#a855f7',
  'Basic Materials': '#d97706',
  Utilities: '#64748b',
}

function computeMetrics(portfolio: PortfolioItem[]): Metrics {
  let totalCostBasis = 0
  let totalMarketValue = 0
  let simpleGainSum = 0
  let bestPct = -Infinity
  let bestTicker = '—'
  let bestDollars = 0
  let worstPct = Infinity
  let worstTicker = '—'
  let worstDollars = 0
  const sectors: Record<string, number> = {}

  portfolio.forEach(item => {
    const costPerShare = item.average_cost_basis ?? item.purchase_price
    const price = item.regularMarketPrice ?? costPerShare
    const cost = item.shares * costPerShare
    const val = item.shares * price
    const gainDol = val - cost
    const gainPct = costPerShare > 0 ? (price - costPerShare) / costPerShare : 0

    totalCostBasis += cost
    totalMarketValue += val
    simpleGainSum += gainPct

    if (gainPct > bestPct) { bestPct = gainPct; bestTicker = item.symbol; bestDollars = gainDol }
    if (gainPct < worstPct) { worstPct = gainPct; worstTicker = item.symbol; worstDollars = gainDol }

    const sector = item.sector || 'Other'
    sectors[sector] = (sectors[sector] || 0) + val
  })

  const weightedGainPct = totalCostBasis > 0 ? (totalMarketValue - totalCostBasis) / totalCostBasis : 0
  const simpleAvgGainPct = simpleGainSum / portfolio.length

  const weights = portfolio.map(item => {
    const price = item.regularMarketPrice ?? (item.average_cost_basis ?? item.purchase_price)
    return totalMarketValue > 0 ? (item.shares * price) / totalMarketValue : 0
  })

  const hhi = weights.reduce((sum, w) => sum + Math.pow(w * 100, 2), 0)

  let divScore = 0
  if (hhi <= 1000) divScore = 100
  else if (hhi <= 1500) divScore = 95 - ((hhi - 1000) / 500) * 10
  else if (hhi <= 2500) divScore = 85 - ((hhi - 1500) / 1000) * 25
  else divScore = Math.max(10, 60 - ((hhi - 2500) / 7500) * 50)

  let gpsSum = 0
  portfolio.forEach((item, idx) => { gpsSum += (item.gpsScore ?? 50) * weights[idx] })
  const qualityScore = gpsSum

  const perfScore = Math.max(0, Math.min(100, 50 + weightedGainPct * 150))
  const gradeScore = Math.round(perfScore * 0.4 + qualityScore * 0.3 + divScore * 0.3)

  let grade = 'F'; let gradeStatus = 'Critical Risk'; let gradeColor = '#ef4444'
  if (gradeScore >= 95) { grade = 'A+'; gradeStatus = 'Elite Portfolio'; gradeColor = '#16a34a' }
  else if (gradeScore >= 90) { grade = 'A'; gradeStatus = 'Outstanding Quality'; gradeColor = '#22c55e' }
  else if (gradeScore >= 85) { grade = 'A−'; gradeStatus = 'Great Quality'; gradeColor = '#4ade80' }
  else if (gradeScore >= 80) { grade = 'B+'; gradeStatus = 'Very Strong'; gradeColor = '#3b82f6' }
  else if (gradeScore >= 75) { grade = 'B'; gradeStatus = 'Solid Allocation'; gradeColor = '#60a5fa' }
  else if (gradeScore >= 70) { grade = 'B−'; gradeStatus = 'Moderate Health'; gradeColor = '#93c5fd' }
  else if (gradeScore >= 60) { grade = 'C'; gradeStatus = 'Slight Concentration'; gradeColor = '#eab308' }
  else if (gradeScore >= 50) { grade = 'D'; gradeStatus = 'Needs Rebalancing'; gradeColor = '#f97316' }

  const hhiBadgeClass = hhi <= 1500 ? 'text-green-700 bg-green-50' : hhi <= 2500 ? 'text-yellow-700 bg-yellow-50' : 'text-red-700 bg-red-50'

  const sectorAlloc = Object.entries(sectors)
    .sort((a, b) => b[1] - a[1])
    .map(([name, val]) => ({
      name,
      pct: totalMarketValue > 0 ? (val / totalMarketValue) * 100 : 0,
      color: SECTOR_COLORS[name] ?? '#94a3b8',
    }))

  const insights: { severity: 'alert' | 'info' | 'success'; html: string }[] = []

  if (hhi > 2500) {
    let largestPct = 0; let largestSymbol = ''
    portfolio.forEach(item => {
      const price = item.regularMarketPrice ?? (item.average_cost_basis ?? item.purchase_price)
      const pct = totalMarketValue > 0 ? (item.shares * price / totalMarketValue) * 100 : 0
      if (pct > largestPct) { largestPct = pct; largestSymbol = item.symbol }
    })
    insights.push({ severity: 'alert', html: `<strong>${largestSymbol}</strong> occupies ${largestPct.toFixed(1)}% of your portfolio. Consider trimming or adding positions to reduce concentration risk.` })
  } else if (hhi > 1500) {
    insights.push({ severity: 'info', html: 'Assets are moderately clustered. Adding 2–3 stocks from different sectors would optimize diversification.' })
  } else {
    insights.push({ severity: 'success', html: 'Position sizes are nicely spread out, limiting single-stock vulnerability.' })
  }

  if (qualityScore < 65) {
    let lowestGPS = 100; let lowestSymbol = ''
    portfolio.forEach(item => {
      const gps = item.gpsScore ?? 50
      if (gps < lowestGPS) { lowestGPS = gps; lowestSymbol = item.symbol }
    })
    insights.push({ severity: 'alert', html: `Average GPS is sub-optimal (${Math.round(qualityScore)}). <strong>${lowestSymbol}</strong> scores ${lowestGPS}. Consider swapping it for higher-rated AI recommendations.` })
  } else if (qualityScore >= 80) {
    insights.push({ severity: 'success', html: 'You are holding highly-rated AI recommendation assets. Keep it up!' })
  } else {
    insights.push({ severity: 'info', html: 'Swap underperforming laggards for top <strong>AI Discovery</strong> buy signals to raise your quality score.' })
  }

  if (weightedGainPct < -0.05) {
    insights.push({ severity: 'alert', html: 'Net return is negative. Check AI predictions for your holdings to see if a rebound is forecasted.' })
  }

  const hasAlerts = insights.some(i => i.severity === 'alert')

  return {
    perfScore: Math.round(perfScore),
    qualityScore: Math.round(qualityScore),
    divScore: Math.round(divScore),
    gradeScore,
    grade,
    gradeStatus,
    gradeColor,
    hhi,
    hhiBadgeClass,
    weightedGainPct,
    simpleAvgGainPct,
    championTicker: bestTicker,
    championPct: bestPct === -Infinity ? 0 : bestPct,
    championDollars: bestDollars,
    laggardTicker: worstTicker,
    laggardPct: worstPct === Infinity ? 0 : worstPct,
    laggardDollars: worstDollars,
    sectorAlloc,
    insights,
    hasAlerts,
  }
}

function fmtPct(v: number, sign = true) {
  const s = sign && v >= 0 ? '+' : ''
  return `${s}${(v * 100).toFixed(1)}%`
}

function fmtDollars(v: number) {
  const abs = Math.abs(v)
  const prefix = v >= 0 ? '+$' : '−$'
  if (abs >= 1_000_000) return `${prefix}${(abs / 1_000_000).toFixed(2)}M`
  if (abs >= 1_000) return `${prefix}${(abs / 1_000).toFixed(1)}k`
  return `${prefix}${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function MetricBadge({ label, value, tooltip }: { label: string; value: number; tooltip: string }) {
  return (
    <div className="relative group bg-gray-50 border border-gray-100 rounded-lg px-2.5 py-1 text-center">
      <div className="flex items-center justify-center gap-1 leading-none mb-0.5">
        <p className="text-[9px] font-bold text-gray-600 uppercase tracking-wide leading-none">{label}</p>
        <svg className="w-4 h-4 text-blue-500 cursor-help shrink-0" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-3a1 1 0 00-.867.5 1 1 0 11-1.731-1A3 3 0 0113 10a3.001 3.001 0 01-2 2.83V13a1 1 0 11-2 0v-1a1 1 0 011-1 1 1 0 100-2zm0 8a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
        </svg>
      </div>
      <p className="text-base font-bold text-gray-800">{value}</p>
      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-52 bg-gray-900 text-white text-[10px] leading-snug rounded-lg px-3 py-2 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50 text-left shadow-lg">
        {tooltip}
        <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-gray-900" />
      </div>
    </div>
  )
}

function SkeletonPanel() {
  return (
    <div className="space-y-3">
      <div className="flex flex-col lg:flex-row gap-3">
        <div className="bg-white rounded-2xl border border-gray-100 p-5 h-28 animate-pulse lg:flex-1" />
        <div className="bg-white rounded-2xl border border-gray-100 p-5 h-28 animate-pulse lg:flex-1" />
      </div>
      <div className="grid grid-cols-3 gap-3">
        {[0, 1, 2].map(i => <div key={i} className="bg-white rounded-2xl border border-gray-100 p-4 h-24 animate-pulse" />)}
      </div>
      <div className="grid grid-cols-2 gap-3">
        {[0, 1].map(i => <div key={i} className="bg-white rounded-2xl border border-gray-100 p-4 h-32 animate-pulse" />)}
      </div>
    </div>
  )
}

export default function PortfolioMetricsPanel({ portfolio, loading, totals, totalsLoading }: Props) {
  const metrics = useMemo(() => {
    if (!portfolio || portfolio.length === 0) return null
    return computeMetrics(portfolio)
  }, [portfolio])

  if (loading) return <SkeletonPanel />
  if (!metrics) return null

  const delta = (metrics.weightedGainPct - metrics.simpleAvgGainPct) * 100
  const comparisonLabel = Math.abs(delta) < 0.5
    ? 'Neutral Sizing'
    : delta > 0
    ? `Weighted Wins (+${delta.toFixed(1)}%)`
    : `Average Wins (${delta.toFixed(1)}%)`
  const comparisonBadgeClass = Math.abs(delta) < 0.5
    ? 'text-gray-600 bg-gray-100'
    : delta > 0
    ? 'text-green-700 bg-green-50'
    : 'text-red-700 bg-red-50'
  const comparisonExplainer = Math.abs(delta) < 0.5
    ? 'Your simple average gain and dollar-weighted returns are aligned — position sizing is balanced.'
    : delta > 0
    ? 'Your largest positions are outperforming your smaller ones, amplifying overall gains.'
    : 'Warning: smaller positions are outperforming larger ones. Heavy allocations are dragging returns.'

  const insightsBg = metrics.hasAlerts ? 'bg-amber-50 border-amber-200' : 'bg-sky-50 border-sky-200'
  const insightsTitle = metrics.hasAlerts ? 'Portfolio Health Alerts' : 'Portfolio Insights'
  const insightsTitleColor = metrics.hasAlerts ? 'text-amber-800' : 'text-sky-800'
  const insightsTextColor = metrics.hasAlerts ? 'text-amber-700' : 'text-sky-700'

  return (
    <div className="space-y-3">

      {/* Portfolio Rating row — 75% grade card / 25% gains breakdown */}
      <div className="flex flex-col lg:flex-row gap-3">

        {/* Grade Card — 50% */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 lg:flex-1">
          <div className="flex items-center gap-5">
            <div
              className="w-[72px] h-[72px] rounded-full flex items-center justify-center text-white font-black text-2xl shadow-md shrink-0"
              style={{ backgroundColor: metrics.gradeColor }}
            >
              {metrics.grade}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-base font-bold text-gray-600 uppercase tracking-widest mb-0.5">Portfolio Rating</p>
              <p className="text-base font-bold leading-tight" style={{ color: metrics.gradeColor }}>
                {metrics.gradeStatus}
              </p>
              <p className="text-xs text-gray-500 mb-2">Score: {metrics.gradeScore} / 100</p>
              <div className="flex gap-2 flex-wrap">
                {[
                  {
                    label: 'Perf Score',
                    value: metrics.perfScore,
                    tooltip: 'Based on your portfolio\'s dollar-weighted return vs. cost basis. 50 = breakeven; scores above 50 reflect positive gains.',
                  },
                  {
                    label: 'GPS Quality',
                    value: metrics.qualityScore,
                    tooltip: 'Weighted average GPS score across your holdings. GPS combines AI momentum signals, analyst ratings, and price predictions into a single quality rating.',
                  },
                  {
                    label: 'Diversification',
                    value: metrics.divScore,
                    tooltip: 'Derived from the Herfindahl-Hirschman Index (HHI). Near 100 means positions are well spread; lower scores indicate concentration risk in a few holdings.',
                  },
                ].map(({ label, value, tooltip }) => (
                  <MetricBadge key={label} label={label} value={value} tooltip={tooltip} />
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Gains Breakdown — 25% */}
        <div className="lg:flex-1">
          <GainsBreakdownCard totals={totals} loading={totalsLoading} />
        </div>

      </div>

      {/* Champion | Laggard | Gain Comparison */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">

        {/* Champion */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-base font-bold text-gray-600 uppercase tracking-wide">🏆 Best Winner</span>
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-green-50 text-green-700">Champion</span>
          </div>
          <p className="text-xl font-bold text-gray-900 leading-none mb-1.5">{metrics.championTicker}</p>
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-sm font-bold px-2 py-0.5 rounded-full ${metrics.championPct >= 0 ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
              {fmtPct(metrics.championPct)}
            </span>
            <span className={`text-base font-semibold ${metrics.championDollars >= 0 ? 'text-green-700' : 'text-red-600'}`}>
              {fmtDollars(metrics.championDollars)}
            </span>
          </div>
        </div>

        {/* Laggard */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-base font-bold text-gray-600 uppercase tracking-wide">⚓ Biggest Drag</span>
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-red-50 text-red-700">Laggard</span>
          </div>
          <p className="text-xl font-bold text-gray-900 leading-none mb-1.5">{metrics.laggardTicker}</p>
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-sm font-bold px-2 py-0.5 rounded-full ${metrics.laggardPct >= 0 ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
              {fmtPct(metrics.laggardPct)}
            </span>
            <span className={`text-base font-semibold ${metrics.laggardDollars >= 0 ? 'text-green-700' : 'text-red-600'}`}>
              {fmtDollars(metrics.laggardDollars)}
            </span>
          </div>
        </div>

        {/* Gain Comparison */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-base font-bold text-gray-600 uppercase tracking-wide">📈 Gain Comparison</span>
            <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${comparisonBadgeClass}`}>
              {comparisonLabel}
            </span>
          </div>
          <div className="flex justify-between items-center">
            <div>
              <p className="text-[9px] font-bold text-gray-600 uppercase tracking-wide mb-0.5">Weighted Return</p>
              <p className={`text-lg font-bold ${metrics.weightedGainPct >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                {fmtPct(metrics.weightedGainPct)}
              </p>
            </div>
            <div className="w-px h-8 bg-gray-100 mx-2" />
            <div>
              <p className="text-[9px] font-bold text-gray-600 uppercase tracking-wide mb-0.5">Simple Avg</p>
              <p className={`text-lg font-bold ${metrics.simpleAvgGainPct >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                {fmtPct(metrics.simpleAvgGainPct)}
              </p>
            </div>
          </div>
          <p className="text-[10px] text-gray-500 mt-2 pt-2 border-t border-gray-50 leading-snug">{comparisonExplainer}</p>
        </div>

      </div>

      {/* Insights | Sector Exposure */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">

        {/* Insights */}
        <div className={`rounded-2xl border p-4 ${insightsBg}`}>
          <p className={`text-base font-bold mb-2 ${insightsTitleColor}`}>
            {metrics.hasAlerts ? '⚠️ ' : '💡 '}{insightsTitle}
          </p>
          <ul className={`space-y-1.5 text-base leading-snug pl-4 list-disc ${insightsTextColor}`}>
            {metrics.insights.map((insight, i) => (
              <li key={i} dangerouslySetInnerHTML={{ __html: insight.html }} />
            ))}
          </ul>
        </div>

        {/* Sector Exposure */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-base font-bold text-gray-600 uppercase tracking-wide">📂 Sector Exposure</span>
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${metrics.hhiBadgeClass}`}>
              HHI: {Math.round(metrics.hhi).toLocaleString()}
            </span>
          </div>
          {metrics.sectorAlloc.length === 0 ? (
            <p className="text-base text-gray-500 text-center py-3">Sector data loading…</p>
          ) : (
            <div className="space-y-2">
              {metrics.sectorAlloc.map(({ name, pct, color }) => (
                <div key={name}>
                  <div className="flex justify-between text-base font-medium mb-0.5">
                    <span className="text-gray-600">{name}</span>
                    <span className="text-gray-800">{pct.toFixed(1)}%</span>
                  </div>
                  <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${pct}%`, backgroundColor: color }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

      </div>
    </div>
  )
}
