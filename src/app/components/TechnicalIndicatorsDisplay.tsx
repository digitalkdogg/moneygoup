'use client'

import { TechnicalIndicators, HistoricalData } from '@/utils/technicalIndicators'

interface Metrics {
  dollarChange: number
  percentChange: number
  avgDailyChange: number
}

interface TechnicalIndicatorsDisplayProps {
  indicators: TechnicalIndicators
  metrics: Metrics
  historicalData: HistoricalData[]
}

export default function TechnicalIndicatorsDisplay({
  indicators,
  metrics,
  historicalData
}: TechnicalIndicatorsDisplayProps) {
  const getRSIColor = (rsi: number | null): string => {
    if (rsi === null) return 'text-gray-600'
    if (rsi > 70) return 'text-red-600 font-bold'
    if (rsi < 30) return 'text-green-600 font-bold'
    return 'text-gray-600'
  }

  const getSignalColor = (signal: string): string => {
    switch (signal) {
      case 'BUY':
        return 'bg-green-100 border-green-400 text-green-800'
      case 'SELL':
        return 'bg-red-100 border-red-400 text-red-800'
      default:
        return 'bg-yellow-100 border-yellow-400 text-yellow-800'
    }
  }

  return (
    <div className="bg-gradient-to-br from-slate-50 to-slate-100 p-8 rounded-2xl shadow-lg border-2 border-indigo-300">
      <h4 className="text-2xl font-bold text-gray-800 mb-6 text-center">🎯 Technical Indicators & Trading Signal</h4>
      
      {/* Main Signal Box */}
      <div className={`p-8 rounded-xl border-2 mb-8 text-center ${getSignalColor(indicators.signal)}`}>
        <div className="text-sm font-semibold opacity-80 mb-2">TRADING SIGNAL</div>
        <div className="text-5xl font-bold mb-3">{indicators.signal}</div>
        <div className="text-base font-semibold mb-2">Signal Strength: {indicators.signalStrength}%</div>
        <div className="text-sm leading-relaxed mt-4">{indicators.signalReason}</div>
      </div>

      {/* Score Breakdown Table */}
      <div className="bg-white rounded-xl p-6 mb-8 shadow-md border border-gray-300 overflow-x-auto">
        <h5 className="text-lg font-bold text-gray-800 mb-4">📈 Signal Score Breakdown</h5>
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
              {/* MA Crossover */}
              <tr className="border-b border-gray-200 hover:bg-gray-50">
                <td className="py-3 px-4 font-semibold text-gray-800">MA Crossover (20/50)</td>
                <td className={`text-center py-3 px-4 font-bold text-lg ${
                  indicators.scoreBreakdown.maScore > 0 ? 'text-green-600' : 
                  indicators.scoreBreakdown.maScore < 0 ? 'text-red-600' : 
                  'text-gray-600'
                }`}>
                  {indicators.scoreBreakdown.maScore > 0 ? '+' : ''}{indicators.scoreBreakdown.maScore}
                </td>
                <td className="py-3 px-4 text-gray-700">{indicators.scoreBreakdown.maReason}</td>
              </tr>

              {/* RSI */}
              <tr className="border-b border-gray-200 hover:bg-gray-50">
                <td className="py-3 px-4 font-semibold text-gray-800">RSI (14)</td>
                <td className={`text-center py-3 px-4 font-bold text-lg ${
                  indicators.scoreBreakdown.rsiScore > 0 ? 'text-green-600' : 
                  indicators.scoreBreakdown.rsiScore < 0 ? 'text-red-600' : 
                  'text-gray-600'
                }`}>
                  {indicators.scoreBreakdown.rsiScore > 0 ? '+' : ''}{indicators.scoreBreakdown.rsiScore}
                </td>
                <td className="py-3 px-4 text-gray-700">{indicators.scoreBreakdown.rsiReason}</td>
              </tr>

              {/* Momentum */}
              <tr className="border-b border-gray-200 hover:bg-gray-50">
                <td className="py-3 px-4 font-semibold text-gray-800">Momentum (10d)</td>
                <td className={`text-center py-3 px-4 font-bold text-lg ${
                  indicators.scoreBreakdown.momentumScore > 0 ? 'text-green-600' : 
                  indicators.scoreBreakdown.momentumScore < 0 ? 'text-red-600' : 
                  'text-gray-600'
                }`}>
                  {indicators.scoreBreakdown.momentumScore > 0 ? '+' : ''}{indicators.scoreBreakdown.momentumScore}
                </td>
                <td className="py-3 px-4 text-gray-700">{indicators.scoreBreakdown.momentumReason}</td>
              </tr>

              {/* Price vs MA50 */}
              <tr className="border-b border-gray-200 hover:bg-gray-50">
                <td className="py-3 px-4 font-semibold text-gray-800">Price vs SMA(50)</td>
                <td className={`text-center py-3 px-4 font-bold text-lg ${
                  indicators.scoreBreakdown.priceScore > 0 ? 'text-green-600' : 
                  indicators.scoreBreakdown.priceScore < 0 ? 'text-red-600' : 
                  'text-gray-600'
                }`}>
                  {indicators.scoreBreakdown.priceScore > 0 ? '+' : ''}{indicators.scoreBreakdown.priceScore}
                </td>
                <td className="py-3 px-4 text-gray-700">{indicators.scoreBreakdown.priceReason}</td>
              </tr>
              
              {/* Volatility */}
              <tr className="border-b-2 border-gray-300 hover:bg-gray-50">
                <td className="py-3 px-4 font-semibold text-gray-800">Volatility</td>
                <td className={`text-center py-3 px-4 font-bold text-lg ${
                  indicators.scoreBreakdown.volatilityScore > 0 ? 'text-green-600' : 
                  indicators.scoreBreakdown.volatilityScore < 0 ? 'text-red-600' : 
                  'text-gray-600'
                }`}>
                  {indicators.scoreBreakdown.volatilityScore > 0 ? '+' : ''}{indicators.scoreBreakdown.volatilityScore}
                </td>
                <td className="py-3 px-4 text-gray-700">{indicators.scoreBreakdown.volatilityReason}</td>
              </tr>

              {/* Total Score */}
              <tr className="bg-blue-50 font-bold">
                <td className="py-4 px-4 text-gray-900">TOTAL SCORE</td>
                <td className={`text-center py-4 px-4 text-2xl ${
                  indicators.scoreBreakdown.totalScore >= 4 ? 'text-green-600' : 
                  indicators.scoreBreakdown.totalScore <= -4 ? 'text-red-600' : 
                  'text-blue-600'
                }`}>
                  {indicators.scoreBreakdown.totalScore > 0 ? '+' : ''}{indicators.scoreBreakdown.totalScore}
                </td>
                <td className="py-4 px-4 text-gray-700">
                  {indicators.scoreBreakdown.totalScore >= 4 ? '✅ BUY Signal' :
                   indicators.scoreBreakdown.totalScore <= -4 ? '⚠️ SELL Signal' :
                   '➡️ HOLD Signal'}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="mt-4 p-3 bg-blue-50 rounded-lg border-l-4 border-blue-500 text-sm text-gray-700">
          <p><span className="font-semibold">Score Thresholds:</span> {'≥'}4 = BUY | {'≤'}-4 = SELL | -3 to 3 = HOLD</p>
        </div>
      </div>

      {/* Indicator Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {/* SMA 20 */}
        <div className="bg-white p-5 rounded-lg shadow-md border-l-4 border-blue-500 hover:shadow-lg transition">
          <div className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">SMA 20</div>
          <div className="text-2xl font-bold text-gray-800">
            {indicators.sma20 !== null ? indicators.sma20.toFixed(2) : 'N/A'}
          </div>
          <div className="text-xs text-gray-600 mt-2">20-day Avg</div>
        </div>

        {/* SMA 50 */}
        <div className="bg-white p-5 rounded-lg shadow-md border-l-4 border-purple-500 hover:shadow-lg transition">
          <div className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">SMA 50</div>
          <div className="text-2xl font-bold text-gray-800">
            {indicators.sma50 !== null ? indicators.sma50.toFixed(2) : 'N/A'}
          </div>
          <div className="text-xs text-gray-600 mt-2">50-day Avg</div>
        </div>

        {/* RSI */}
        <div className="bg-white p-5 rounded-lg shadow-md border-l-4 border-orange-500 hover:shadow-lg transition">
          <div className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">RSI (14)</div>
          <div className={`text-2xl font-bold ${getRSIColor(indicators.rsi14)}`}>
            {indicators.rsi14 !== null ? indicators.rsi14.toFixed(2) : 'N/A'}
          </div>
          <div className="text-xs text-gray-600 mt-2">
            {indicators.rsi14 !== null
              ? indicators.rsi14 > 70
                ? '⚠️ Overbought'
                : indicators.rsi14 < 30
                ? '✅ Oversold'
                : '➡️ Neutral'
              : 'N/A'}
          </div>
        </div>

        {/* Momentum */}
        <div className="bg-white p-5 rounded-lg shadow-md border-l-4 border-green-500 hover:shadow-lg transition">
          <div className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">Momentum</div>
          <div className={`text-2xl font-bold ${
            indicators.momentum !== null && indicators.momentum > 0
              ? 'text-green-600'
              : indicators.momentum !== null && indicators.momentum < 0
              ? 'text-red-600'
              : 'text-gray-800'
          }`}>
            {indicators.momentum !== null ? indicators.momentum.toFixed(2) : 'N/A'}
          </div>
          <div className="text-xs text-gray-600 mt-2">
            {indicators.momentum !== null
              ? indicators.momentum > 0
                ? '📈 Bullish'
                : '📉 Bearish'
              : 'N/A'}
          </div>
        </div>
      </div>

      {/* Educational Info */}
      <div className="bg-white rounded-lg p-6 border border-gray-300">
        <h5 className="text-lg font-bold text-gray-800 mb-4">📚 Indicator Guide</h5>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm text-gray-700">
          <div>
            <p className="font-semibold text-gray-800">SMA (Simple Moving Average)</p>
            <p className="mt-1">20 {'>'} 50 = Bullish trend. 20 {'<'} 50 = Bearish trend. Price above 50-SMA = Uptrend support.</p>
          </div>
          <div>
            <p className="font-semibold text-gray-800">RSI (Relative Strength Index)</p>
            <p className="mt-1">{'<'}30 = Oversold (buying opportunity). {'>'}70 = Overbought (selling pressure). 40-60 = Neutral.</p>
          </div>
          <div>
            <p className="font-semibold text-gray-800">Momentum</p>
            <p className="mt-1">Positive = Price rising faster (bullish). Negative = Price falling (bearish). Measures rate of change.</p>
          </div>
          <div>
            <p className="font-semibold text-gray-800">Trading Signal</p>
            <p className="mt-1">Composite signal combining all indicators. Base real decisions on multiple factors and do your own research!</p>
          </div>
        </div>
      </div>
    </div>
  )
}
