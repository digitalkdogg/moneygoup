'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import PortfolioCompareChart, { type OverlaySeries } from '@/app/components/PortfolioCompareChart'
import GainsBreakdownCard from '@/app/components/GainsBreakdownCard'
import RecommendationsSection from '@/app/components/RecommendationsSection'
import type { PortfolioItem } from '@/types/portfolio'
import type { PortfolioTotals } from '@/types/dashboard'

type Period = '1m' | '6m' | '1y' | 'all'

interface ChartPoint { date: string; value: number }

interface KPIs {
  cagr: number
  maxDrawdown: number
  volatility: number
  periodReturn: number
}

const OVERLAY_COLORS = ['#3b82f6', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4', '#f97316']
const MAX_OVERLAYS = 4

// ── KPI calculations ─────────────────────────────────────────────────────────

function computeKPIs(history: ChartPoint[]): KPIs | null {
  if (history.length < 3) return null

  const first = history[0].value
  const last = history[history.length - 1].value

  const startMs = new Date(history[0].date).getTime()
  const endMs = new Date(history[history.length - 1].date).getTime()
  const years = (endMs - startMs) / (365.25 * 24 * 60 * 60 * 1000)

  const cagr = years > 0 && first > 0 ? Math.pow(last / first, 1 / years) - 1 : 0

  let peak = first
  let maxDrawdown = 0
  for (const p of history) {
    if (p.value > peak) peak = p.value
    const dd = peak > 0 ? (peak - p.value) / peak : 0
    if (dd > maxDrawdown) maxDrawdown = dd
  }

  const returns: number[] = []
  for (let i = 1; i < history.length; i++) {
    if (history[i - 1].value > 0) {
      returns.push((history[i].value - history[i - 1].value) / history[i - 1].value)
    }
  }
  let volatility = 0
  if (returns.length > 1) {
    const avg = returns.reduce((a, b) => a + b, 0) / returns.length
    const variance = returns.reduce((s, r) => s + Math.pow(r - avg, 2), 0) / returns.length
    volatility = Math.sqrt(variance * 252)
  }

  const periodReturn = first > 0 ? (last - first) / first : 0

  return { cagr, maxDrawdown, volatility, periodReturn }
}

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtCurrency(v: number) {
  if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`
  if (Math.abs(v) >= 1_000) return `$${(v / 1_000).toFixed(1)}k`
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v)
}

function fmtPct(v: number, decimals = 1) {
  return `${v >= 0 ? '+' : ''}${(v * 100).toFixed(decimals)}%`
}

// ── KPI card ─────────────────────────────────────────────────────────────────

function StatCard({
  label, value, sub, positive, neutral,
}: {
  label: string
  value: string
  sub?: string
  positive?: boolean
  neutral?: boolean
}) {
  const color = neutral ? 'text-gray-800' : positive ? 'text-green-700' : 'text-red-600'
  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4 flex flex-col gap-1">
      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">{label}</p>
      <p className={`text-xl font-bold ${color}`}>{value}</p>
      {sub && <p className="text-xs text-gray-400">{sub}</p>}
    </div>
  )
}

// ── Holdings sidebar ──────────────────────────────────────────────────────────

function HoldingRow({
  item,
  active,
  loading,
  color,
  onToggle,
  disabled,
}: {
  item: PortfolioItem
  active: boolean
  loading: boolean
  color?: string
  onToggle: (ticker: string) => void
  disabled: boolean
}) {
  const value = item.shares * (item.regularMarketPrice ?? item.purchase_price)
  const gain = item.regularMarketPrice && item.purchase_price
    ? (item.regularMarketPrice - item.purchase_price) / item.purchase_price
    : null

  return (
    <div
      className={`flex items-center justify-between p-3 rounded-xl border transition-colors ${
        active ? 'border-blue-200 bg-blue-50' : 'border-gray-100 bg-white hover:bg-gray-50'
      }`}
    >
      <div className="flex items-center gap-2.5 min-w-0">
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{ backgroundColor: active && color ? color : '#d1d5db' }}
        />
        <div className="min-w-0">
          <p className="font-bold text-gray-900 text-sm leading-tight">{item.symbol}</p>
          <p className="text-xs text-gray-400 truncate">{item.company_name}</p>
          <p className="text-xs text-gray-500">{item.shares} shares</p>
          <p className="text-xs font-medium text-gray-800">
            {fmtCurrency(value)}
            {gain !== null && (
              <span className={`ml-1 ${gain >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                ({fmtPct(gain)})
              </span>
            )}
          </p>
        </div>
      </div>
      <div className="ml-2 shrink-0 flex flex-col gap-1.5">
        <button
          onClick={() => onToggle(item.symbol)}
          disabled={disabled && !active}
          className={`sm px-3 py-1.5 rounded-lg border transition-colors ${
            active
              ? 'border-blue-300 bg-blue-100 text-blue-700 hover:bg-blue-200'
              : disabled
              ? 'border-gray-200 text-gray-300 cursor-not-allowed'
              : 'border-gray-200 text-gray-600 hover:border-gray-300 hover:bg-gray-100'
          }`}
        >
          {loading ? (
            <span className="inline-block w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
          ) : active ? (
            'Remove'
          ) : (
            'Compare'
          )}
        </button>
        <Link
          href={`/search/${item.symbol}`}
          className="sm px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:border-gray-300 hover:bg-gray-100 transition-colors text-center"
        >
          Details
        </Link>
      </div>
    </div>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function PortfolioPage() {
  const [period, setPeriod] = useState<Period>('1m')
  const [normalized, setNormalized] = useState(false)

  const [portfolio, setPortfolio] = useState<PortfolioItem[]>([])
  const [totals, setTotals] = useState<PortfolioTotals | null>(null)
  const [portfolioLoading, setPortfolioLoading] = useState(true)

  const [baseHistory, setBaseHistory] = useState<ChartPoint[]>([])
  const [historyLoading, setHistoryLoading] = useState(true)

  // ticker -> loaded series data
  const [overlayData, setOverlayData] = useState<Map<string, ChartPoint[]>>(new Map())
  // tickers actively shown on chart (insertion-ordered)
  const [activeOverlays, setActiveOverlays] = useState<string[]>([])
  const [overlayLoading, setOverlayLoading] = useState<Set<string>>(new Set())

  const kpis = computeKPIs(baseHistory)

  // ── Fetch portfolio ────────────────────────────────────────────────────────

  useEffect(() => {
    fetch('/api/user/portfolio')
      .then(r => r.json())
      .then(d => {
        setPortfolio(d.portfolio ?? [])
        setTotals(d.totals ?? null)
      })
      .catch(() => {})
      .finally(() => setPortfolioLoading(false))
  }, [])

  // ── Fetch portfolio history ────────────────────────────────────────────────

  useEffect(() => {
    setHistoryLoading(true)
    fetch(`/api/user/portfolio/historical-value?period=${period}`)
      .then(r => r.json())
      .then(d => setBaseHistory(Array.isArray(d) ? d : []))
      .catch(() => setBaseHistory([]))
      .finally(() => setHistoryLoading(false))
  }, [period])

  // Refetch overlay series when period changes to keep alignment
  useEffect(() => {
    if (activeOverlays.length === 0) return
    const tickers = [...activeOverlays]
    // Clear cached data; re-fetch will happen via toggleOverlay pattern below
    setOverlayData(new Map())
    setActiveOverlays([])
    // Re-fetch each
    setTimeout(() => {
      tickers.forEach(ticker => fetchOverlay(ticker, period))
    }, 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period])

  // ── Overlay toggle ────────────────────────────────────────────────────────

  const fetchOverlay = useCallback(async (ticker: string, p: Period) => {
    setOverlayLoading(prev => new Set(prev).add(ticker))
    try {
      const res = await fetch(`/api/user/portfolio/compare-series?ticker=${ticker}&period=${p}`)
      if (!res.ok) throw new Error('fetch failed')
      const data: ChartPoint[] = await res.json()
      setOverlayData(prev => new Map(prev).set(ticker, data))
      setActiveOverlays(prev => prev.includes(ticker) ? prev : [...prev, ticker])
    } catch {
      // silently skip
    } finally {
      setOverlayLoading(prev => { const s = new Set(prev); s.delete(ticker); return s })
    }
  }, [])

  const handleToggle = useCallback((ticker: string) => {
    if (activeOverlays.includes(ticker)) {
      const remaining = activeOverlays.filter(t => t !== ticker)
      setActiveOverlays(remaining)
      setOverlayData(prev => { const m = new Map(prev); m.delete(ticker); return m })
      if (remaining.length === 0) setNormalized(false)
    } else {
      fetchOverlay(ticker, period)
      setNormalized(true)
    }
  }, [activeOverlays, fetchOverlay, period])

  // ── Build overlay series for chart ────────────────────────────────────────

  const overlays: OverlaySeries[] = activeOverlays.map((ticker, i) => ({
    ticker,
    data: overlayData.get(ticker) ?? [],
    color: OVERLAY_COLORS[i % OVERLAY_COLORS.length],
  }))

  // ── Render ────────────────────────────────────────────────────────────────

  const marketValue = totals?.marketValue ?? 0
  const netGain = totals?.unrealizedNet ?? 0
  const netPct = totals?.unrealizedPct ?? 0

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">

        {/* Page title */}
        <div className="mb-6">
          <div className="flex items-center gap-2 text-sm text-gray-400 mb-1">
            <Link href="/" className="hover:text-gray-600 transition-colors">Dashboard</Link>
            <span>/</span>
            <span className="text-gray-600">My Portfolio</span>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">My Portfolio</h1>
          <p className="text-sm text-gray-500 mt-1">
            Performance overview · click a holding to overlay its value on the chart
          </p>
        </div>

        {/* KPI row */}
        {portfolioLoading ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-4 gap-3 mb-6">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="bg-white rounded-2xl border border-gray-100 p-4 h-20 animate-pulse" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-4 gap-3 mb-6">
            <StatCard
              label="Portfolio Value"
              value={fmtCurrency(marketValue)}
              neutral
            />
            <StatCard
              label="Net Gain / Loss"
              value={fmtCurrency(netGain)}
              sub={netPct !== 0 ? fmtPct(netPct / 100) : undefined}
              positive={netGain >= 0}
            />
            <StatCard
              label={`CAGR (${period})`}
              value={kpis ? fmtPct(kpis.cagr) : '—'}
              sub="annualized"
              positive={!kpis || kpis.cagr >= 0}
              neutral={!kpis}
            />
            <StatCard
              label="Volatility"
              value={kpis ? `${(kpis.volatility * 100).toFixed(1)}%` : '—'}
              sub="annualized"
              neutral
            />
          </div>
        )}

        {/* Chart + Holdings sidebar */}
        <div className="flex flex-col lg:flex-row gap-4">

          {/* Chart (grows to fill) */}
          <div className="flex-1 min-w-0">
            <PortfolioCompareChart
              period={period}
              onPeriodChange={p => setPeriod(p)}
              baseData={baseHistory}
              overlays={overlays}
              normalized={normalized}
              onNormalizedChange={setNormalized}
              loading={historyLoading}
            />
          </div>

          {/* Right sidebar */}
          <div className="lg:w-72 xl:w-80 flex flex-col gap-4">

            {/* Holdings list */}
            <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-4 flex flex-col">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-bold text-gray-700">Holdings</h2>
                {activeOverlays.length > 0 && (
                  <span className="text-xs text-gray-400">
                    {activeOverlays.length}/{MAX_OVERLAYS} overlaid
                  </span>
                )}
              </div>

              {portfolioLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="h-16 bg-gray-50 rounded-xl animate-pulse" />
                  ))}
                </div>
              ) : portfolio.length === 0 ? (
                <div className="flex-1 flex items-center justify-center">
                  <p className="text-sm text-gray-400 text-center">
                    No holdings yet.{' '}
                    <Link href="/search" className="underline" style={{ color: '#017e3b' }}>
                      Search stocks
                    </Link>{' '}
                    to add positions.
                  </p>
                </div>
              ) : (
                <div className="space-y-2 overflow-y-auto flex-1 pr-0.5">
                  {portfolio.map((item, i) => {
                    const isActive = activeOverlays.includes(item.symbol)
                    const colorIdx = activeOverlays.indexOf(item.symbol)
                    return (
                      <HoldingRow
                        key={item.symbol}
                        item={item}
                        active={isActive}
                        loading={overlayLoading.has(item.symbol)}
                        color={isActive ? OVERLAY_COLORS[colorIdx % OVERLAY_COLORS.length] : undefined}
                        onToggle={handleToggle}
                        disabled={activeOverlays.length >= MAX_OVERLAYS}
                      />
                    )
                  })}
                </div>
              )}

              {activeOverlays.length > 0 && (
                <div className="mt-3 pt-3 border-t border-gray-100">
                  <button
                    onClick={() => {
                      setActiveOverlays([])
                      setOverlayData(new Map())
                    }}
                    className="w-full text-xs text-gray-400 hover:text-gray-600 transition-colors"
                  >
                    Clear all overlays
                  </button>
                </div>
              )}
            </div>
          </div>

        </div>

        {/* Period return footnote */}
        {kpis && !historyLoading && (
          <p className="text-xs text-gray-400 mt-4 mb-8 text-center">
            Period return ({period}):{' '}
            <span className={kpis.periodReturn >= 0 ? 'text-green-600 font-medium' : 'text-red-600 font-medium'}>
              {fmtPct(kpis.periodReturn)}
            </span>
            {' '}· KPIs computed from portfolio value history
          </p>
        )}

        {/* Recommendations + Gains Breakdown */}
        <div className="flex flex-col lg:flex-row gap-4 items-start">
          <div className="flex-[3] min-w-0">
            <RecommendationsSection scopes={['portfolio', 'watchlist']} />
          </div>
          <div className="lg:w-[25%] shrink-0">
            <GainsBreakdownCard totals={totals} loading={portfolioLoading} />
          </div>
        </div>

      </div>
    </div>
  )
}
