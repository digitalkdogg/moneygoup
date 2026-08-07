'use client'

import { useState, useMemo } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  formatPrice,
  formatPercent,
  getChangeColor,
  getAnalystColor,
} from '@/app/components/cards/formatters'
import { formatCurrency } from '@/utils/formatters'

export interface WatchlistItem {
  stock_id: number
  symbol: string
  company_name: string
  purchase_price: number
  regularMarketPrice: number
  prev_close?: number | null
  ma6_month?: number | null
  predicted_change_pct_horizon?: number | string | null
  confidence_score_horizon?: number | string | null
  gpsScore?: number | null
  recommendationKey?: string | null
  [key: string]: any
}

interface WatchlistTableProps {
  watchlist: WatchlistItem[]
  horizonLabel?: string
  loading?: boolean
}

type SortKey =
  | 'symbol'
  | 'currentPrice'
  | 'sinceAddedPct'
  | 'dayChangeAmt'
  | 'dayChangePct'
  | 'ma6Month'
  | 'predChangePct'
  | 'confidencePct'
  | 'gpsScore'
  | 'recommendationKey'

type SortDir = 'asc' | 'desc'

interface DerivedRow extends WatchlistItem {
  currentPrice: number
  sinceAddedPct: number | null
  dayChangeAmt: number | null
  dayChangePct: number | null
  ma6Month: number | null
  predChangePct: number | null
  confidencePct: number | null
}

const TOOLTIPS: Record<SortKey, string> = {
  symbol:        'Stock ticker and company name. Click a row to open the detail page.',
  currentPrice:  'Latest market price per share.',
  sinceAddedPct: 'Percentage change from the price when you added this stock to now.',
  dayChangeAmt:  "Today's per-share dollar change vs. yesterday's closing price.",
  dayChangePct:  "Today's price movement as a percentage vs. yesterday's closing price.",
  ma6Month:         '6-month moving average price. ▲ means current price is above the average (bullish); ▼ means below (bearish).',
  predChangePct:    'AI-predicted price change for your selected investment horizon. Based on the DeepMoney model.',
  confidencePct:    'Model confidence in the prediction (0–100%). Higher means the model is more certain.',
  gpsScore:         'GPS Score (0–100): composite signal combining AI momentum, analyst ratings, and price predictions. Higher = stronger buy signal.',
  recommendationKey:'Analyst consensus recommendation based on Wall Street ratings.',
}

function computeRow(item: WatchlistItem): DerivedRow {
  const purchasePrice = Number(item.purchase_price) || 0
  const currentPrice  = Number(item.regularMarketPrice) || 0

  const sinceAddedPct = purchasePrice > 0
    ? ((currentPrice - purchasePrice) / purchasePrice) * 100
    : null

  const prevClose    = item.prev_close != null ? Number(item.prev_close) : null
  const dayChangeAmt = prevClose != null ? currentPrice - prevClose : null
  const dayChangePct = prevClose && prevClose > 0
    ? ((currentPrice - prevClose) / prevClose) * 100
    : null

  const ma6Month      = item.ma6_month != null ? Number(item.ma6_month) : null
  const predChangePct = item.predicted_change_pct_horizon != null
    ? Number(item.predicted_change_pct_horizon)
    : null
  const confidencePct = item.confidence_score_horizon != null
    ? Number(item.confidence_score_horizon)
    : null

  return {
    ...item,
    currentPrice,
    sinceAddedPct,
    dayChangeAmt,
    dayChangePct,
    ma6Month,
    predChangePct,
    confidencePct,
  }
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

export default function WatchlistTable({ watchlist, horizonLabel = '—', loading }: WatchlistTableProps) {
  const router = useRouter()
  const [sortKey, setSortKey] = useState<SortKey>('gpsScore')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [hoveredCol, setHoveredCol] = useState<SortKey | null>(null)
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 })

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir(key === 'symbol' || key === 'recommendationKey' ? 'asc' : 'desc')
    }
  }

  function handleColEnter(key: SortKey, e: React.MouseEvent<HTMLTableCellElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    setHoveredCol(key)
    setTooltipPos({ x: rect.left + rect.width / 2, y: rect.bottom })
  }

  const rows = useMemo(
    () => sortRows(watchlist.map(computeRow), sortKey, sortDir),
    [watchlist, sortKey, sortDir],
  )

  const avgGps = useMemo(() => {
    const scored = watchlist.filter(i => i.gpsScore != null)
    if (!scored.length) return null
    return scored.reduce((s, i) => s + (i.gpsScore as number), 0) / scored.length
  }, [watchlist])

  const aboveMaCount = useMemo(() =>
    rows.filter(r => r.ma6Month != null && r.currentPrice > r.ma6Month).length,
  [rows])

  if (loading && watchlist.length === 0) {
    return (
      <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-6 space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-10 bg-gray-100 rounded animate-pulse" />
        ))}
      </div>
    )
  }

  if (watchlist.length === 0) {
    return (
      <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-8 text-center text-gray-500 text-sm">
        Your watchlist is empty.{' '}
        <Link href="/search" className="underline text-[#017e3b]">
          Search stocks
        </Link>{' '}
        to start tracking positions.
      </div>
    )
  }

  function th(key: SortKey, label: string, align: 'left' | 'right' = 'right', cls = '') {
    const alignCls = align === 'right' ? 'text-right' : 'text-left'
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
          className="fixed z-50 pointer-events-none bg-gray-900 text-white text-xs rounded-lg px-3 py-2 shadow-xl max-w-[210px] text-center leading-snug"
          style={{ left: tooltipPos.x, top: tooltipPos.y + 6, transform: 'translateX(-50%)' }}
        >
          {TOOLTIPS[hoveredCol]}
          <span className="absolute -top-1.5 left-1/2 -translate-x-1/2 w-3 h-3 bg-gray-900 rotate-45 rounded-sm" />
        </div>
      )}

      <div className="bg-white rounded-2xl shadow-lg border border-gray-100 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                {th('symbol',        'Ticker / Company', 'left')}
                {th('currentPrice',  'Current',          'right')}
                {th('sinceAddedPct', 'Since Added %',    'right')}
                {th('dayChangeAmt',  'Day Chg $',        'right')}
                {th('dayChangePct',  'Day Chg %',        'right')}
                {th('ma6Month',         '6M MA',                 'right')}
                {th('predChangePct',    `Pred ${horizonLabel} %`,'right')}
                {th('confidencePct',    'Conf',                  'right', 'hidden lg:table-cell')}
                {th('gpsScore',         'GPS',                   'right')}
                {th('recommendationKey','Analyst',               'right', 'hidden md:table-cell')}
              </tr>
            </thead>

            <tbody className="bg-white divide-y divide-gray-200">
              {rows.map(row => {
                // 6M MA direction indicator
                const maDir = row.ma6Month != null
                  ? row.currentPrice > row.ma6Month ? '▲' : '▼'
                  : null
                const maDirColor = row.ma6Month != null
                  ? row.currentPrice > row.ma6Month ? 'text-green-600' : 'text-red-500'
                  : ''

                return (
                  <tr
                    key={row.symbol}
                    onClick={() => router.push(`/search/${row.symbol}`)}
                    className="cursor-pointer transition-colors active:scale-[0.995] hover:bg-gray-50"
                  >
                    {/* Ticker / Company */}
                    <td className="px-3 py-4 whitespace-nowrap">
                      <div className="flex items-center gap-1.5">
                        <div className="min-w-0">
                          <p className="font-bold text-gray-900 text-sm">{row.symbol}</p>
                          <p className="text-xs text-gray-400 truncate max-w-[130px]">{row.company_name}</p>
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

                    {/* Current Price */}
                    <td className="px-3 py-4 text-right text-sm font-medium text-gray-800 whitespace-nowrap">
                      {formatPrice(row.currentPrice)}
                    </td>

                    {/* Since Added % */}
                    <td className="px-3 py-4 text-right text-sm font-medium whitespace-nowrap">
                      {row.sinceAddedPct != null ? (
                        <ColorCell value={row.sinceAddedPct} formatted={formatPercent(row.sinceAddedPct)} />
                      ) : <span className="text-gray-300">—</span>}
                    </td>

                    {/* Day Chg $ */}
                    <td className="px-3 py-4 text-right text-sm font-medium whitespace-nowrap">
                      {row.dayChangeAmt != null ? (
                        <ColorCell
                          value={row.dayChangeAmt}
                          formatted={(row.dayChangeAmt >= 0 ? '+' : '') + formatCurrency(row.dayChangeAmt)}
                        />
                      ) : <span className="text-gray-300">—</span>}
                    </td>

                    {/* Day Chg % */}
                    <td className="px-3 py-4 text-right text-sm whitespace-nowrap">
                      {row.dayChangePct != null ? (
                        <ColorCell value={row.dayChangePct} formatted={formatPercent(row.dayChangePct)} />
                      ) : <span className="text-gray-300">—</span>}
                    </td>

                    {/* 6M MA */}
                    <td className="px-3 py-4 text-right text-sm whitespace-nowrap">
                      {row.ma6Month != null ? (
                        <span className="inline-flex items-center gap-1">
                          <span className="text-gray-600">{formatPrice(row.ma6Month)}</span>
                          {maDir && <span className={`text-[10px] font-bold ${maDirColor}`}>{maDir}</span>}
                        </span>
                      ) : <span className="text-gray-300">—</span>}
                    </td>

                    {/* Predicted % */}
                    <td className="px-3 py-4 text-right text-sm font-medium whitespace-nowrap">
                      {row.predChangePct != null ? (
                        <ColorCell value={row.predChangePct} formatted={formatPercent(row.predChangePct)} />
                      ) : <span className="text-gray-300">—</span>}
                    </td>

                    {/* Confidence */}
                    <td className="px-3 py-4 text-right text-sm whitespace-nowrap hidden lg:table-cell">
                      {row.confidencePct != null ? (
                        <span className={`font-medium ${
                          row.confidencePct >= 80 ? 'text-green-600'
                          : row.confidencePct >= 60 ? 'text-yellow-600'
                          : 'text-gray-500'
                        }`}>
                          {Math.round(row.confidencePct)}%
                        </span>
                      ) : <span className="text-gray-300">—</span>}
                    </td>

                    {/* GPS */}
                    <td className="px-3 py-4 text-right whitespace-nowrap">
                      {row.gpsScore != null ? (
                        <span className={`text-sm font-bold ${
                          row.gpsScore >= 70 ? 'text-green-600'
                          : row.gpsScore >= 50 ? 'text-yellow-600'
                          : 'text-red-500'
                        }`}>
                          {Math.round(row.gpsScore)}
                        </span>
                      ) : <span className="text-gray-300 text-xs">—</span>}
                    </td>

                    {/* Analyst */}
                    <td className="px-3 py-4 text-right whitespace-nowrap hidden md:table-cell">
                      {row.recommendationKey ? (
                        <span className={`text-xs font-medium ${getAnalystColor(row.recommendationKey)}`}>
                          {row.recommendationKey.replace(/([A-Z])/g, ' $1').trim()}
                        </span>
                      ) : <span className="text-gray-300 text-xs">—</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>

            {/* Summary footer */}
            <tfoot>
              <tr className="bg-gray-50 border-t-2 border-gray-200">
                <td className="px-3 py-3 text-xs font-bold text-gray-500 uppercase tracking-wider whitespace-nowrap">
                  {watchlist.length} stock{watchlist.length !== 1 ? 's' : ''}
                </td>
                <td colSpan={4} />
                <td className="px-3 py-3 text-right text-xs text-gray-400 whitespace-nowrap">
                  {aboveMaCount} above MA
                </td>
                <td />
                <td className="hidden lg:table-cell" />
                <td colSpan={1} className="px-3 py-3 text-right whitespace-nowrap">
                  {avgGps != null && (
                    <span className={`text-sm font-bold ${
                      avgGps >= 70 ? 'text-green-600'
                      : avgGps >= 50 ? 'text-yellow-600'
                      : 'text-red-500'
                    }`}>
                      {avgGps.toFixed(0)} avg
                    </span>
                  )}
                </td>
                <td className="hidden md:table-cell" />
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  )
}
