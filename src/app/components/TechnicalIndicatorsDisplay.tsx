'use client'

import { TechnicalIndicators, HistoricalData } from '@/utils/technicalIndicators'
import { formatNumber } from '@/utils/formatters'

interface Metrics {
  dollarChange: number
  percentChange: number
  avgDailyChange: number
}

interface TechnicalIndicatorsDisplayProps {
  indicators: TechnicalIndicators
}

export default function TechnicalIndicatorsDisplay({
  indicators
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
    <div className=" p-8 rounded-2xl">
      
      {/* Main Signal Box */}
      <div className={`p-8 rounded-xl border-2 mb-8 text-center ${getSignalColor(indicators.signal)}`}>
        <div className="text-sm font-semibold opacity-80 mb-2">TRADING SIGNAL</div>
        <div className="text-5xl font-bold mb-3">{indicators.signal}</div>
        <div className="text-base font-semibold mb-2">Signal Strength: {formatNumber(indicators.signalStrength, 0, true)}%</div>
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
                <td className="py-3 px-4">
                  <div className="font-semibold text-gray-800">MA Crossover (20/50)</div>
                </td>
                <td className={`text-center py-3 px-4 font-bold text-lg ${
                  indicators.scoreBreakdown.maScore > 0 ? 'text-green-600' :
                  indicators.scoreBreakdown.maScore < 0 ? 'text-red-600' :
                  'text-gray-600'
                }`}>
                  {indicators.scoreBreakdown.maScore > 0 ? '+' : ''}{formatNumber(indicators.scoreBreakdown.maScore, 0, true)}
                </td>
                <td className="py-3 px-4 text-gray-700">{indicators.scoreBreakdown.maReason}</td>
              </tr>

              {/* RSI */}
              <tr className="border-b border-gray-200 hover:bg-gray-50">
                <td className="py-3 px-4">
                  <div className="font-semibold text-gray-800">RSI (14)</div>
                </td>
                <td className={`text-center py-3 px-4 font-bold text-lg ${
                  indicators.scoreBreakdown.rsiScore > 0 ? 'text-green-600' :
                  indicators.scoreBreakdown.rsiScore < 0 ? 'text-red-600' :
                  'text-gray-600'
                }`}>
                  {indicators.scoreBreakdown.rsiScore > 0 ? '+' : ''}{formatNumber(indicators.scoreBreakdown.rsiScore, 0, true)}
                </td>
                <td className="py-3 px-4 text-gray-700">{indicators.scoreBreakdown.rsiReason}</td>
              </tr>

              {/* Momentum */}
              <tr className="border-b border-gray-200 hover:bg-gray-50">
                <td className="py-3 px-4">
                  <div className="font-semibold text-gray-800">Momentum (10d)</div>
                </td>
                <td className={`text-center py-3 px-4 font-bold text-lg ${
                  indicators.scoreBreakdown.momentumScore > 0 ? 'text-green-600' :
                  indicators.scoreBreakdown.momentumScore < 0 ? 'text-red-600' :
                  'text-gray-600'
                }`}>
                  {indicators.scoreBreakdown.momentumScore > 0 ? '+' : ''}{formatNumber(indicators.scoreBreakdown.momentumScore, 0, true)}
                </td>
                <td className="py-3 px-4 text-gray-700">{indicators.scoreBreakdown.momentumReason}</td>
              </tr>

              {/* Price vs MA50 */}
              <tr className="border-b border-gray-200 hover:bg-gray-50">
                <td className="py-3 px-4">
                  <div className="font-semibold text-gray-800">Price vs SMA (50)</div>
                </td>
                <td className={`text-center py-3 px-4 font-bold text-lg ${
                  indicators.scoreBreakdown.priceScore > 0 ? 'text-green-600' :
                  indicators.scoreBreakdown.priceScore < 0 ? 'text-red-600' :
                  'text-gray-600'
                }`}>
                  {indicators.scoreBreakdown.priceScore > 0 ? '+' : ''}{formatNumber(indicators.scoreBreakdown.priceScore, 0, true)}
                </td>
                <td className="py-3 px-4 text-gray-700">{indicators.scoreBreakdown.priceReason}</td>
              </tr>

              {/* Volatility */}
              <tr className="border-b border-gray-200 hover:bg-gray-50">
                <td className="py-3 px-4">
                  <div className="font-semibold text-gray-800">Volatility ({indicators.volatility || 'N/A'})</div>
                </td>
                <td className={`text-center py-3 px-4 font-bold text-lg ${
                  indicators.scoreBreakdown.volatilityScore > 0 ? 'text-green-600' :
                  indicators.scoreBreakdown.volatilityScore < 0 ? 'text-red-600' :
                  'text-gray-600'
                }`}>
                  {indicators.scoreBreakdown.volatilityScore > 0 ? '+' : ''}{formatNumber(indicators.scoreBreakdown.volatilityScore, 0, true)}
                </td>
                <td className="py-3 px-4 text-gray-700">{indicators.scoreBreakdown.volatilityReason}</td>
              </tr>

              {/* News Sentiment */}
              <tr className="border-b border-gray-200 hover:bg-gray-50">
                <td className="py-3 px-4">
                  <div className="font-semibold text-gray-800">News Sentiment</div>
                </td>
                <td className={`text-center py-3 px-4 font-bold text-lg ${
                  indicators.scoreBreakdown.newsScore > 0 ? 'text-green-600' :
                  indicators.scoreBreakdown.newsScore < 0 ? 'text-red-600' :
                  'text-gray-600'
                }`}>
                  {indicators.scoreBreakdown.newsScore > 0 ? '+' : ''}{formatNumber(indicators.scoreBreakdown.newsScore, 0, true)}
                </td>
                <td className="py-3 px-4 text-gray-700">{indicators.scoreBreakdown.newsReason}</td>
              </tr>

              {/* Core Metrics (PE, PB, Market Cap) */}
              <tr className="border-b-2 border-gray-300 hover:bg-gray-50">
                <td className="py-3 px-4">
                  <div className="font-semibold text-gray-800">Core Metrics (PE, PB, MC)</div>
                </td>
                <td className={`text-center py-3 px-4 font-bold text-lg ${
                  indicators.scoreBreakdown.coreMetricsScore > 0 ? 'text-green-600' :
                  indicators.scoreBreakdown.coreMetricsScore < 0 ? 'text-red-600' :
                  'text-gray-600'
                }`}>
                  {indicators.scoreBreakdown.coreMetricsScore > 0 ? '+' : ''}{formatNumber(indicators.scoreBreakdown.coreMetricsScore, 0, true)}
                </td>
                <td className="py-3 px-4 text-gray-700">{indicators.scoreBreakdown.coreMetricsReason}</td>
              </tr>

              {/* Total Score */}
              <tr className="bg-blue-50 font-bold">
                <td className="py-4 px-4 text-gray-900">TOTAL SCORE</td>
                <td className={`text-center py-4 px-4 text-2xl ${
                  indicators.scoreBreakdown.totalScore >= 4 ? 'text-green-600' : 
                  indicators.scoreBreakdown.totalScore <= -4 ? 'text-red-600' : 
                  'text-blue-600'
                }`}>
                  {indicators.scoreBreakdown.totalScore > 0 ? '+' : ''}{formatNumber(indicators.scoreBreakdown.totalScore, 0, true)}
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
            {indicators.sma20 !== null ? formatNumber(indicators.sma20, 2) : 'N/A'}
          </div>
          <div className="text-xs text-gray-600 mt-2">20-day Simple Moving Average — short-term trend reference. Price above this level suggests near-term bullish momentum.</div>
        </div>

        {/* SMA 50 */}
        <div className="bg-white p-5 rounded-lg shadow-md border-l-4 border-purple-500 hover:shadow-lg transition">
          <div className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">SMA 50</div>
          <div className="text-2xl font-bold text-gray-800">
            {indicators.sma50 !== null ? formatNumber(indicators.sma50, 2) : 'N/A'}
          </div>
          <div className="text-xs text-gray-600 mt-2">50-day Simple Moving Average — medium-term trend benchmark. Widely watched by institutional investors as a key support/resistance level.</div>
        </div>

        {/* RSI */}
        <div className="bg-white p-5 rounded-lg shadow-md border-l-4 border-orange-500 hover:shadow-lg transition">
          <div className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">RSI (14)</div>
          <div className={`text-2xl font-bold ${getRSIColor(indicators.rsi14)}`}>
            {indicators.rsi14 !== null ? formatNumber(indicators.rsi14, 2) : 'N/A'}
          </div>
          <div className="text-xs text-gray-600 mt-2">
            {indicators.rsi14 !== null
              ? indicators.rsi14 > 70
                ? '⚠️ Overbought — stock may be due for a pullback'
                : indicators.rsi14 < 30
                ? '✅ Oversold — potential buying opportunity'
                : '➡️ Neutral zone (30–70)'
              : 'N/A'}
          </div>
        </div>

        {/* Momentum */}
        <div className="bg-white p-5 rounded-lg shadow-md border-l-4 border-green-500 hover:shadow-lg transition">
          <div className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">Momentum (10d)</div>
          <div className={`text-2xl font-bold ${
            indicators.momentum !== null && indicators.momentum > 0
              ? 'text-green-600'
              : indicators.momentum !== null && indicators.momentum < 0
              ? 'text-red-600'
              : 'text-gray-800'
          }`}>
            {indicators.momentum !== null ? formatNumber(indicators.momentum, 2) : 'N/A'}
          </div>
          <div className="text-xs text-gray-600 mt-2">
            {indicators.momentum !== null
              ? indicators.momentum > 0
                ? '📈 Bullish — price accelerating upward'
                : '📉 Bearish — price losing ground'
              : 'N/A'}
          </div>
        </div>
      </div>

      {/* Educational Info */}
      <div className="bg-white rounded-lg p-6 border border-gray-300">
        <h5 className="text-lg font-bold text-gray-800 mb-4">📚 Indicator Guide</h5>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5 text-sm text-gray-700">
          <div>
            <p className="font-semibold text-gray-800">SMA — Simple Moving Average</p>
            <p className="mt-1">Smooths out daily price noise by averaging closing prices over a set period. The <strong>SMA-20</strong> reflects short-term sentiment; the <strong>SMA-50</strong> tracks medium-term trend. When SMA-20 crosses above SMA-50 it is called a "golden cross" — a bullish signal. The reverse (SMA-20 dropping below SMA-50) is a "death cross" — bearish. Institutional funds often buy or sell at these levels, making them self-fulfilling.</p>
          </div>
          <div>
            <p className="font-semibold text-gray-800">RSI — Relative Strength Index</p>
            <p className="mt-1">A 0–100 momentum oscillator calculated over 14 days. It compares average gains to average losses. <strong>Above 70</strong>: the stock has rallied hard and buyers may be exhausted — a pullback is more likely. <strong>Below 30</strong>: the stock has been beaten down and sellers may be exhausted — a bounce is more likely. RSI divergence (price makes a new high but RSI does not) is an early warning of a reversal.</p>
          </div>
          <div>
            <p className="font-semibold text-gray-800">Momentum</p>
            <p className="mt-1">Measures the raw price change over the past 10 days (current price minus price 10 days ago). A large positive value means the stock is in a strong uptrend with buying pressure behind it. A large negative value means sellers are dominating. Momentum tends to persist — rising stocks often keep rising and falling stocks keep falling — until a catalyst reverses the trend.</p>
          </div>
          <div>
            <p className="font-semibold text-gray-800">P/E Ratio — Price-to-Earnings</p>
            <p className="mt-1">How many dollars investors pay for each $1 of annual earnings. A <strong>high P/E</strong> (e.g., 40+) suggests investors expect strong future growth but the stock is pricier relative to current profits. A <strong>low P/E</strong> (e.g., under 15) may indicate undervaluation or slow growth expectations. Compare P/E to industry peers and the company's historical average for context.</p>
          </div>
          <div>
            <p className="font-semibold text-gray-800">P/B Ratio — Price-to-Book</p>
            <p className="mt-1">Compares the stock price to the company's net assets (total assets minus liabilities). A <strong>P/B below 1.0</strong> means you are buying the stock for less than the book value of its assets — often a value signal. A <strong>high P/B</strong> is common in asset-light businesses (software, services) where earnings power exceeds physical assets. Especially useful for evaluating banks and industrial companies.</p>
          </div>
          <div>
            <p className="font-semibold text-gray-800">Volatility</p>
            <p className="mt-1">Measures how much the stock price moves day-to-day. <strong>High volatility</strong> means larger swings — more profit potential but more risk. <strong>Low volatility</strong> stocks move predictably and are often preferred by conservative investors. Volatility typically spikes around earnings releases, major news events, or broader market sell-offs. It directly affects options pricing.</p>
          </div>
          <div>
            <p className="font-semibold text-gray-800">News Sentiment</p>
            <p className="mt-1">Analyzes the tone of recent headlines. Markets often react faster to news than to fundamentals. <strong>Positive sentiment</strong> (analyst upgrades, revenue beats, new products) can create buying pressure even if fundamentals have not changed yet. <strong>Negative sentiment</strong> (regulatory problems, CEO resignations, missed guidance) often precedes sharp sell-offs. Sentiment is a short-term signal — use alongside fundamentals.</p>
          </div>
          <div>
            <p className="font-semibold text-gray-800">Trading Signal</p>
            <p className="mt-1">A composite score combining all seven metrics above. Scores of +4 or higher generate a <strong>BUY</strong> signal; -4 or lower generate a <strong>SELL</strong>; everything in between is <strong>HOLD</strong>. No single indicator is reliable alone — the combined score aims to reduce false signals. Always do your own research and consider your personal risk tolerance before acting.</p>
          </div>
        </div>
      </div>
    </div>
  )
}
