'use client'

import { TechnicalIndicators } from '@/utils/technicalIndicators'
import React from 'react'
import { formatNumber } from '@/utils/formatters'

interface TechnicalIndicatorsDisplayProps {
  indicators: TechnicalIndicators;
  titleLevel?: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
}

function scoreColor(score: number): string {
  if (score > 0) return 'text-green-600'
  if (score < 0) return 'text-red-600'
  return 'text-gray-600'
}

function scoreLabel(score: number): string {
  return `${score > 0 ? '+' : ''}${formatNumber(score, 0, true)}`
}

export default function TechnicalIndicatorsDisplay({
  indicators,
}: TechnicalIndicatorsDisplayProps) {
  const getRSIColor = (rsi: number | null): string => {
    if (rsi === null) return 'text-gray-600'
    if (rsi > 70) return 'text-red-600 font-bold'
    if (rsi < 30) return 'text-green-600 font-bold'
    return 'text-gray-600'
  }

  const bd = indicators.scoreBreakdown

  return (
    <div>
      {/* Score Breakdown Table */}
      <div className="mb-8 overflow-x-auto">
        <div className="w-full">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-100 border-b-2 border-gray-300">
                <th className="text-left py-3 px-4 font-bold text-gray-800">Metric</th>
                <th className="text-center py-3 px-4 font-bold text-gray-800">Score</th>
                <th className="text-left py-3 px-4 font-bold text-gray-800">Details</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-gray-200 hover:bg-gray-50">
                <td className="py-3 px-4"><div className="font-semibold text-gray-800">MA Crossover (20/50)</div></td>
                <td className={`text-center py-3 px-4 font-bold ${scoreColor(bd.maScore)}`}>{scoreLabel(bd.maScore)}</td>
                <td className="py-3 px-4 text-gray-700">{bd.maReason}</td>
              </tr>
              <tr className="border-b border-gray-200 hover:bg-gray-50">
                <td className="py-3 px-4"><div className="font-semibold text-gray-800">RSI (14)</div></td>
                <td className={`text-center py-3 px-4 font-bold ${scoreColor(bd.rsiScore)}`}>{scoreLabel(bd.rsiScore)}</td>
                <td className="py-3 px-4 text-gray-700">{bd.rsiReason}</td>
              </tr>
              <tr className="border-b border-gray-200 hover:bg-gray-50">
                <td className="py-3 px-4"><div className="font-semibold text-gray-800">Momentum (10d)</div></td>
                <td className={`text-center py-3 px-4 font-bold ${scoreColor(bd.momentumScore)}`}>{scoreLabel(bd.momentumScore)}</td>
                <td className="py-3 px-4 text-gray-700">{bd.momentumReason}</td>
              </tr>
              <tr className="border-b border-gray-200 hover:bg-gray-50">
                <td className="py-3 px-4"><div className="font-semibold text-gray-800">Price vs SMA (50)</div></td>
                <td className={`text-center py-3 px-4 font-bold ${scoreColor(bd.priceScore)}`}>{scoreLabel(bd.priceScore)}</td>
                <td className="py-3 px-4 text-gray-700">{bd.priceReason}</td>
              </tr>
              <tr className="border-b border-gray-200 hover:bg-gray-50">
                <td className="py-3 px-4"><div className="font-semibold text-gray-800">Volatility ({indicators.volatility ?? 'N/A'})</div></td>
                <td className={`text-center py-3 px-4 font-bold ${scoreColor(bd.volatilityScore)}`}>{scoreLabel(bd.volatilityScore)}</td>
                <td className="py-3 px-4 text-gray-700">{bd.volatilityReason}</td>
              </tr>
              <tr className="border-b border-gray-200 hover:bg-gray-50">
                <td className="py-3 px-4"><div className="font-semibold text-gray-800">News Sentiment</div></td>
                <td className={`text-center py-3 px-4 font-bold ${scoreColor(bd.newsScore)}`}>{scoreLabel(bd.newsScore)}</td>
                <td className="py-3 px-4 text-gray-700">{bd.newsReason}</td>
              </tr>
              <tr className="border-b-2 border-gray-300 hover:bg-gray-50">
                <td className="py-3 px-4"><div className="font-semibold text-gray-800">Core Metrics (PE, PB, MC)</div></td>
                <td className={`text-center py-3 px-4 font-bold ${scoreColor(bd.coreMetricsScore)}`}>{scoreLabel(bd.coreMetricsScore)}</td>
                <td className="py-3 px-4 text-gray-700">{bd.coreMetricsReason}</td>
              </tr>
              <tr className="bg-blue-50 font-bold">
                <td className="py-4 px-4 text-gray-900 ">TOTAL SCORE</td>
                <td className={`text-center py-4 px-4 ${scoreColor(bd.totalScore)}`}>
                  {scoreLabel(bd.totalScore)}
                </td>
                <td className="py-4 px-4 text-gray-700">
                  {bd.totalScore >= 4 ? '✅ BUY Signal' :
                   bd.totalScore <= -4 ? '⚠️ SELL Signal' :
                   '➡️ HOLD Signal'}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Indicator Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 mb-1">
        <div className="bg-white p-2 rounded-lg shadow-md border-l-4 border-blue-500 hover:shadow-lg transition">
          <div className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">SMA 20</div>
          <div className="text-sm font-bold text-gray-800">
            {indicators.sma20 !== null ? formatNumber(indicators.sma20, 2) : 'N/A'}
          </div>
        </div>
        <div className="bg-white p-2 rounded-lg shadow-md border-l-4 border-purple-500 hover:shadow-lg transition">
          <div className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">SMA 50</div>
          <div className="text-sm font-bold text-gray-800">
            {indicators.sma50 !== null ? formatNumber(indicators.sma50, 2) : 'N/A'}
          </div>
        </div>
        <div className="bg-white p-2 rounded-lg shadow-md border-l-4 border-orange-500 hover:shadow-lg transition">
          <div className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">RSI (14)</div>
          <div className={`text-sm font-bold ${getRSIColor(indicators.rsi14)}`}>
            {indicators.rsi14 !== null ? formatNumber(indicators.rsi14, 2) : 'N/A'}
          </div>
        </div>
        <div className="bg-white p-2 rounded-lg shadow-md border-l-4 border-green-500 hover:shadow-lg transition">
          <div className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">Momentum (10d)</div>
          <div className={`text-sm font-bold ${
            indicators.momentum !== null && indicators.momentum > 0 ? 'text-green-600' :
            indicators.momentum !== null && indicators.momentum < 0 ? 'text-red-600' :
            'text-gray-800'
          }`}>
            {indicators.momentum !== null ? formatNumber(indicators.momentum, 2) : 'N/A'}
          </div>
        </div>
      </div>
    </div>
  )
}
