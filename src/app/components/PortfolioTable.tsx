'use client'

import { useState, useMemo } from 'react'
import Link from 'next/link'
import type { PortfolioItem } from '@/types/portfolio'
import type { PortfolioTotals } from '@/types/dashboard'
import {
  formatPrice,
  formatPercent,
  formatShares,
  getChangeColor,
  getAnalystColor,
} from '@/app/components/cards/formatters'
import { formatCurrency } from '@/utils/formatters'

interface PortfolioTableProps {
  portfolio: PortfolioItem[]
  totals: PortfolioTotals | null
  loading?: boolean
}

type SortKey =
  | 'symbol'
  | 'shares'
  | 'avgCost'
  | 'currentPrice'
  | 'marketValue'
  | 'gainLoss'
  | 'gainLossPct'
  | 'dayChangeAmt'
  | 'dayChangePct'
  | 'gpsScore'
  | 'sector'

type SortDir = 'asc' | 'desc'

interface DerivedRow extends PortfolioItem {
  avgCost: number
  marketValue: number
  totalCost: number
  gainLoss: number
  gainLossPct: number
  dayChange: number | null
  dayChangeAmt: number | null
  dayChangePct: number | null
}

const TOOLTIPS: Record<SortKey, string> = {
  symbol: 'Stock ticker and company name. Click ↗ to open the detail page.',
  shares: 'Number of shares held in this position.',
  avgCost: 'Your average cost per share across all purchases for this position.',
  currentPrice: 'Latest market price per share.',
  marketValue: 'Current position value: Shares × Current Price.',
  gainLoss: 'Unrealized gain or loss in dollars since you opened the position.',
  gainLossPct: 'Unrealized return as a percentage of your total cost in this position.',
  dayChangeAmt: "Today's dollar gain or loss for this position: Day Change per share × Shares held.",
  dayChangePct: "Today's price movement as a percentage vs. yesterday's closing price.",
  sector: 'The market sector or industry category for this stock.',
  gpsScore:
    'GPS Score (0–100): composite signal combining ML prediction, technicals, and analyst ratings. Higher = stronger buy signal.',
}

function computeRow(item: PortfolioItem): DerivedRow {
  const avgCost = item.average_cost_basis ?? item.purchase_price
  const price = item.regularMarketPrice ?? 0
  const marketValue = item.shares * price
  const totalCost = item.shares * avgCost
  const gainLoss = marketValue - totalCost
  const gainLossPct = totalCost > 0 ? (gainLoss / totalCost) * 100 : 0
  const dayChange = item.prev_close != null ? price - item.prev_close : null
  const dayChangeAmt = dayChange != null ? dayChange * item.shares : null
  const dayChangePct =
    item.prev_close != null && item.prev_close > 0
      ? ((price - item.prev_close) / item.prev_close) * 100
      : null
  return { ...item, avgCost, marketValue, totalCost, gainLoss, gainLossPct, dayChange, dayChangeAmt, dayChangePct }
}

function sortRows(rows: DerivedRow[], key: SortKey, dir: SortDir): DerivedRow[] {
  return [...rows].sort((a, b) => {
    let av: any = a[key as keyof DerivedRow]
    let bv: any = b[key as keyof DerivedRow]
    if (av == null) av = dir === 'asc' ? Infinity : -Infinity
    if (bv == null) bv = dir === 'asc' ? Infinity : -Infinity
    if (typeof av === 'string' && typeof bv === 'string')
      return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
    return dir === 'asc' ? av - bv : bv - av
  })
}

function computeActiveTotals(rows: DerivedRow[]) {
  const marketValue = rows.reduce((s, r) => s + r.marketValue, 0)
  const costBasis = rows.reduce((s, r) => s + r.totalCost, 0)
  const unrealizedNet = marketValue - costBasis
  const unrealizedPct = costBasis > 0 ? (unrealizedNet / costBasis) * 100 : 0
  const prevValue = rows.reduce(
    (s, r) => s + (r.prev_close != null ? r.prev_close * r.shares : 0),
    0,
  )
  const dayAmt = rows.reduce(
    (s, r) => s + (r.dayChange != null ? r.dayChange * r.shares : 0),
    0,
  )
  const dailyChangePct = prevValue > 0 ? (dayAmt / prevValue) * 100 : null
  return { marketValue, costBasis, unrealizedNet, unrealizedPct, dailyChangeAmt: dayAmt, dailyChangePct }
}

function SortIcon({ active, dir }: { active: boolean; dir: SortDir }) {
  return (
    <span className={`ml-1 text-[10px] ${active ? 'text-[#017e3b]' : 'text-gray-300'}`}>
      {active ? (dir === 'asc' ? '▲' : '▼') : '⇅'}
    </span>
  )
}

function ColorCell({ value, formatted }: { value: number | null; formatted: string }) {
  return <span className={getChangeColor(value)}>{formatted}</span>
}

export default function PortfolioTable({ portfolio, totals, loading }: PortfolioTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('gainLossPct')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [hoveredCol, setHoveredCol] = useState<SortKey | null>(null)
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 })

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir(key === 'symbol' || key === 'sector' ? 'asc' : 'desc')
    }
  }

  function toggleExclude(symbol: string) {
    setExcluded(prev => {
      const next = new Set(prev)
      next.has(symbol) ? next.delete(symbol) : next.add(symbol)
      return next
    })
  }

  function handleColEnter(key: SortKey, e: React.MouseEvent<HTMLTableCellElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    setHoveredCol(key)
    setTooltipPos({ x: rect.left + rect.width / 2, y: rect.bottom })
  }

  const allRows = useMemo(
    () => sortRows(portfolio.map(computeRow), sortKey, sortDir),
    [portfolio, sortKey, sortDir],
  )

  const includedRows = useMemo(
    () => allRows.filter(r => !excluded.has(r.symbol)),
    [allRows, excluded],
  )

  const activeTotals = useMemo(() => computeActiveTotals(includedRows), [includedRows])

  const hasExclusions = excluded.size > 0

  if (loading && portfolio.length === 0) {
    return (
      <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-6 space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-10 bg-gray-100 rounded animate-pulse" />
        ))}
      </div>
    )
  }

  if (portfolio.length === 0) {
    return (
      <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-8 text-center text-gray-500 text-sm">
        No holdings yet.{' '}
        <Link href="/search" className="underline text-[#017e3b]">
          Search stocks
        </Link>{' '}
        to add your first position.
      </div>
    )
  }

  function th(
    key: SortKey,
    label: string,
    align: 'left' | 'right' | 'center' = 'right',
    cls = '',
  ) {
    const alignCls =
      align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left'
    return (
      <th
        key={key}
        onClick={() => handleSort(key)}
        onMouseEnter={e => handleColEnter(key, e)}
        onMouseLeave={() => setHoveredCol(null)}
        className={`px-3 py-3 text-xs font-bold text-gray-500 uppercase tracking-wider whitespace-nowrap cursor-pointer select-none hover:text-gray-700 ${alignCls} ${cls}`}
      >
        {label}
        <SortIcon active={sortKey === key} dir={sortDir} />
      </th>
    )
  }

  return (
    <div className="relative">
      {/* Floating column tooltip */}
      {hoveredCol && (
        <div
          className="fixed z-50 pointer-events-none bg-gray-900 text-white text-xs rounded-lg px-3 py-2 shadow-xl max-w-[200px] text-center leading-snug"
          style={{
            left: tooltipPos.x,
            top: tooltipPos.y + 6,
            transform: 'translateX(-50%)',
          }}
        >
          {TOOLTIPS[hoveredCol]}
          <span
            className="absolute -top-1.5 left-1/2 -translate-x-1/2 w-3 h-3 bg-gray-900 rotate-45 rounded-sm"
          />
        </div>
      )}

      <div className="bg-white rounded-2xl shadow-lg border border-gray-100 overflow-hidden">
        {/* Hint bar */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-gray-100 bg-gray-50/60">
          <p className="text-xs text-gray-400">
            Click a row to exclude it from the totals footer
          </p>
          {hasExclusions && (
            <button
              onClick={() => setExcluded(new Set())}
              className="text-xs text-[#017e3b] hover:underline font-medium"
            >
              Reset ({excluded.size} excluded)
            </button>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                {th('symbol', 'Ticker / Company', 'left')}
                {th('shares', 'Shares', 'right')}
                {th('avgCost', 'Avg Cost', 'right')}
                {th('currentPrice', 'Price', 'right')}
                {th('marketValue', 'Mkt Value', 'right')}
                {th('gainLoss', 'G/L $', 'right')}
                {th('gainLossPct', 'G/L %', 'right')}
                {th('dayChangeAmt', 'Day Chg $', 'right')}
                {th('dayChangePct', 'Day Chg %', 'right')}
                {th('sector', 'Sector', 'left', 'hidden md:table-cell')}
                {th('gpsScore', 'GPS', 'right', 'hidden md:table-cell')}
              </tr>
            </thead>

            <tbody className="bg-white divide-y divide-gray-200">
              {allRows.map(row => {
                const isExcluded = excluded.has(row.symbol)
                const isLoss = (row.regularMarketPrice ?? 0) < row.avgCost

                const rowBg = isExcluded
                  ? 'opacity-40'
                  : isLoss
                  ? 'bg-red-50 hover:bg-red-100'
                  : 'hover:bg-gray-50'

                return (
                  <tr
                    key={row.symbol}
                    onClick={() => toggleExclude(row.symbol)}
                    title={isExcluded ? 'Click to re-include in totals' : 'Click to exclude from totals'}
                    className={`cursor-pointer transition-colors active:scale-[0.995] ${rowBg}`}
                  >
                    {/* Ticker / Company */}
                    <td className="px-3 py-4 whitespace-nowrap">
                      <div className="flex items-center gap-1.5">
                        <div className="min-w-0">
                          <p className={`font-bold text-gray-900 text-sm ${isExcluded ? 'line-through' : ''}`}>
                            {row.symbol}
                          </p>
                          <p className="text-xs text-gray-400 truncate max-w-[130px]">
                            {row.company_name}
                          </p>
                        </div>
                        <Link
                          href={`/search/${row.symbol}`}
                          onClick={e => e.stopPropagation()}
                          className="text-gray-300 hover:text-[#017e3b] transition-colors text-xs shrink-0"
                          title="View detail page"
                        >
                          ↗
                        </Link>
                      </div>
                    </td>

                    {/* Shares */}
                    <td className="px-3 py-4 text-right text-sm text-gray-700 whitespace-nowrap">
                      {formatShares(row.shares)}
                    </td>

                    {/* Avg Cost */}
                    <td className="px-3 py-4 text-right text-sm text-gray-700 whitespace-nowrap">
                      {formatPrice(row.avgCost)}
                    </td>

                    {/* Current Price */}
                    <td className="px-3 py-4 text-right text-sm text-gray-700 whitespace-nowrap">
                      {formatPrice(row.regularMarketPrice)}
                    </td>

                    {/* Market Value */}
                    <td className="px-3 py-4 text-right text-sm font-medium text-gray-800 whitespace-nowrap">
                      {formatCurrency(row.marketValue)}
                    </td>

                    {/* G/L $ */}
                    <td className="px-3 py-4 text-right text-sm font-medium whitespace-nowrap">
                      <ColorCell
                        value={row.gainLoss}
                        formatted={(row.gainLoss >= 0 ? '+' : '') + formatCurrency(row.gainLoss)}
                      />
                    </td>

                    {/* G/L % */}
                    <td className="px-3 py-4 text-right text-sm font-medium whitespace-nowrap">
                      <ColorCell value={row.gainLossPct} formatted={formatPercent(row.gainLossPct)} />
                    </td>

                    {/* Day Chg $ */}
                    <td className="px-3 py-4 text-right text-sm whitespace-nowrap">
                      {row.dayChangeAmt != null ? (
                        <ColorCell
                          value={row.dayChangeAmt}
                          formatted={(row.dayChangeAmt >= 0 ? '+' : '') + formatCurrency(row.dayChangeAmt)}
                        />
                      ) : (
                        <span className="text-gray-300">—</span>
                      )}
                    </td>

                    {/* Day Chg % */}
                    <td className="px-3 py-4 text-right text-sm whitespace-nowrap">
                      {row.dayChangePct != null ? (
                        <ColorCell
                          value={row.dayChangePct}
                          formatted={formatPercent(row.dayChangePct)}
                        />
                      ) : (
                        <span className="text-gray-300">—</span>
                      )}
                    </td>

                    {/* Sector */}
                    <td className="px-3 py-4 whitespace-nowrap hidden md:table-cell">
                      {row.sector ? (
                        <span className="text-xs bg-gray-100 text-gray-600 rounded-full px-2 py-0.5">
                          {row.sector}
                        </span>
                      ) : (
                        <span className="text-gray-300 text-xs">—</span>
                      )}
                    </td>

                    {/* GPS */}
                    <td className="px-3 py-4 text-right whitespace-nowrap hidden md:table-cell">
                      {row.gpsScore != null ? (
                        <span
                          className={`text-sm font-bold ${
                            row.gpsScore >= 70
                              ? 'text-green-600'
                              : row.gpsScore >= 50
                              ? 'text-yellow-600'
                              : 'text-red-500'
                          }`}
                        >
                          {row.gpsScore.toFixed(0)}
                        </span>
                      ) : row.recommendationKey ? (
                        <span
                          className={`text-xs font-medium ${getAnalystColor(row.recommendationKey)}`}
                        >
                          {row.recommendationKey.replace(/([A-Z])/g, ' $1').trim()}
                        </span>
                      ) : (
                        <span className="text-gray-300 text-xs">—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>

            {/* Totals footer — recomputed from included rows only */}
            <tfoot>
              <tr className="bg-gray-50 border-t-2 border-gray-200">
                <td className="px-3 py-3 text-xs font-bold text-gray-500 uppercase tracking-wider whitespace-nowrap">
                  {hasExclusions
                    ? `${includedRows.length} of ${portfolio.length} holdings`
                    : `Total (${portfolio.length})`}
                </td>
                <td colSpan={3} />
                <td className="px-3 py-3 text-right text-sm font-bold text-gray-800 whitespace-nowrap">
                  {formatCurrency(activeTotals.marketValue)}
                </td>
                <td className="px-3 py-3 text-right text-sm font-bold whitespace-nowrap">
                  <ColorCell
                    value={activeTotals.unrealizedNet}
                    formatted={
                      (activeTotals.unrealizedNet >= 0 ? '+' : '') +
                      formatCurrency(activeTotals.unrealizedNet)
                    }
                  />
                </td>
                <td className="px-3 py-3 text-right text-sm font-bold whitespace-nowrap">
                  <ColorCell
                    value={activeTotals.unrealizedPct}
                    formatted={formatPercent(activeTotals.unrealizedPct)}
                  />
                </td>
                <td className="px-3 py-3 text-right text-sm font-bold whitespace-nowrap">
                  {activeTotals.dailyChangeAmt !== 0 ? (
                    <ColorCell
                      value={activeTotals.dailyChangeAmt}
                      formatted={
                        (activeTotals.dailyChangeAmt >= 0 ? '+' : '') +
                        formatCurrency(activeTotals.dailyChangeAmt)
                      }
                    />
                  ) : (
                    <span className="text-gray-400">—</span>
                  )}
                </td>
                <td className="px-3 py-3 text-right text-sm font-bold whitespace-nowrap">
                  {activeTotals.dailyChangePct != null ? (
                    <ColorCell
                      value={activeTotals.dailyChangePct}
                      formatted={formatPercent(activeTotals.dailyChangePct)}
                    />
                  ) : (
                    <span className="text-gray-400">—</span>
                  )}
                </td>
                <td colSpan={2} className="hidden md:table-cell" />
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  )
}
