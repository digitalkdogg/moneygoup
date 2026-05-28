'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import Link from 'next/link'
import PortfolioCompareChart, { type OverlaySeries } from '@/app/components/PortfolioCompareChart'
import RecommendationsSection from '@/app/components/RecommendationsSection'
import PortfolioMetricsPanel from '@/app/components/PortfolioMetricsPanel'
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

// Returns the earliest initial_purchase_date among the given tickers.
// Used to align the x-axis origin for all overlays when period='all'.
function earliestPurchaseDate(tickers: string[], portfolio: PortfolioItem[]): string | null {
  const dates = tickers.flatMap(t => {
    const item = portfolio.find(p => p.symbol === t)
    const d = item?.initial_purchase_date ?? item?.last_transaction_date
    return d ? [d] : []
  })
  if (dates.length === 0) return null
  return dates.reduce((min, d) => (d < min ? d : min))
}

function getPeriodStartMs(period: Period): number {
  const d = new Date()
  switch (period) {
    case '1m': d.setMonth(d.getMonth() - 1); break
    case '6m': d.setMonth(d.getMonth() - 6); break
    case '1y': d.setFullYear(d.getFullYear() - 1); break
    case 'all': return 0  // epoch — let the ticker date win
  }
  return d.getTime()
}

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

// ── Section heading ───────────────────────────────────────────────────────────

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2
      className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-4 pl-3 border-l-2"
      style={{ borderLeftColor: '#017e3b' }}
    >
      {children}
    </h2>
  )
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
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{label}</p>
      <p className={`text-xl font-bold ${color}`}>{value}</p>
      {sub && <p className="text-xs text-gray-500">{sub}</p>}
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
          <p className="font-bold text-gray-900 text-base leading-tight">{item.symbol}</p>
          <p className="text-sm text-gray-600 truncate">{item.company_name}</p>
          <p className="text-base text-gray-500">{item.shares} shares</p>
          <p className="text-base font-medium text-gray-800">
            {fmtCurrency(value)}
            {gain !== null && (
              <span className={`ml-1 ${gain >= 0 ? 'text-green-700' : 'text-red-600'}`}>
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
    setOverlayData(new Map())
    setActiveOverlays([])
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

  // Trim baseHistory so the x-axis starts at max(period_start, earliest_overlay_purchase_date).
  // This applies to every period: for fixed windows (1m/6m/1y) a ticker bought after
  // the window start shifts the origin forward; for 'all' the ticker date always wins
  // since getPeriodStartMs returns 0 (epoch).
  const chartBaseData = useMemo(() => {
    if (activeOverlays.length === 0) return baseHistory
    const anchor = earliestPurchaseDate(activeOverlays, portfolio)
    if (!anchor) return baseHistory
    const trimMs = Math.max(new Date(anchor).getTime(), getPeriodStartMs(period))
    return baseHistory.filter(p => new Date(p.date).getTime() >= trimMs)
  }, [period, activeOverlays, portfolio, baseHistory])

  // ── Render ────────────────────────────────────────────────────────────────

  const marketValue = totals?.marketValue ?? 0
  const netGain = totals?.unrealizedNet ?? 0
  const netPct = totals?.unrealizedPct ?? 0

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-10">

        {/* ── Page header ───────────────────────────────────────────────── */}
        <div>
          <div className="flex items-center gap-2 text-base text-gray-600 mb-1">
            <Link href="/" className="hover:text-gray-600 transition-colors">Dashboard</Link>
            <span>/</span>
            <span className="text-gray-600">My Portfolio</span>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">My Portfolio</h1>
          <p className="text-base text-gray-500 mt-1">
            Track performance, analyze holdings, and compare positions over time
          </p>
        </div>

        {/* ── At a Glance ───────────────────────────────────────────────── */}
        <section>
          <SectionHeading>At a Glance</SectionHeading>
          {portfolioLoading ? (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="bg-white rounded-2xl border border-gray-100 p-4 h-20 animate-pulse" />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatCard label="Portfolio Value" value={fmtCurrency(marketValue)} neutral />
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
        </section>

        {/* ── Portfolio Analytics ───────────────────────────────────────── */}
        <section>
          <SectionHeading>Portfolio Analytics</SectionHeading>
          <PortfolioMetricsPanel
            portfolio={portfolio}
            loading={portfolioLoading}
            totals={totals}
            totalsLoading={portfolioLoading}
          />
        </section>

        {/* ── Performance ───────────────────────────────────────────────── */}
        <section>
          <SectionHeading>Performance</SectionHeading>
          <div className="flex flex-col lg:flex-row gap-4">

            {/* Chart */}
            <div className="flex-1 min-w-0">
              <PortfolioCompareChart
                period={period}
                onPeriodChange={p => setPeriod(p)}
                baseData={chartBaseData}
                overlays={overlays}
                normalized={normalized}
                onNormalizedChange={setNormalized}
                loading={historyLoading}
              />
              {kpis && !historyLoading && (
                <p className="text-xs text-gray-500 mt-3 text-center">
                  Period return ({period}):{' '}
                  <span className={kpis.periodReturn >= 0 ? 'text-green-700 font-medium' : 'text-red-600 font-medium'}>
                    {fmtPct(kpis.periodReturn)}
                  </span>
                  {' '}· KPIs computed from portfolio value history
                </p>
              )}
            </div>

            {/* Holdings sidebar */}
            <div className="lg:w-72 xl:w-80">
              <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-4 flex flex-col">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-base font-bold text-gray-700">Holdings</h3>
                  {activeOverlays.length > 0 && (
                    <span className="text-xs text-gray-500">
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
                    <p className="text-base text-gray-600 text-center">
                      No holdings yet.{' '}
                      <Link href="/search" className="underline" style={{ color: '#017e3b' }}>
                        Search stocks
                      </Link>{' '}
                      to add positions.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2 overflow-y-auto flex-1 pr-0.5">
                    {portfolio.map((item) => {
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
                      onClick={() => { setActiveOverlays([]); setOverlayData(new Map()) }}
                      className="w-full text-sm text-gray-500 hover:text-gray-700 transition-colors"
                    >
                      Clear all overlays
                    </button>
                  </div>
                )}
              </div>
            </div>

          </div>
        </section>

        {/* ── Recommendations ───────────────────────────────────────────── */}
        <section>
          <SectionHeading>Recommendations</SectionHeading>
          <RecommendationsSection scopes={['portfolio', 'watchlist']} />
        </section>

      </div>
    </div>
  )
}
