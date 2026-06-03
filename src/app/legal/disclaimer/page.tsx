import Link from 'next/link'

export const metadata = {
  title: 'Investment Disclaimer — GrowMyStocks',
  description: 'Important information about the limitations of GrowMyStocks data, predictions, and analysis.',
}

const EFFECTIVE_DATE = 'May 20, 2026'

export default function DisclaimerPage() {
  return (
    <main id="main-content" className="min-h-screen bg-gray-50 py-12 px-4">
      <div className="max-w-3xl mx-auto">

        <div className="mb-8">
          <Link href="/dashboard" className="text-sm text-green-700 hover:text-green-800 font-medium">
            ← Back to Dashboard
          </Link>
        </div>

        <div className="bg-white rounded-2xl shadow-[0_1px_10px_rgba(0,0,0,0.1)] p-8 md:p-12">

          {/* Header */}
          <div className="flex items-start gap-4 mb-8 p-5 bg-amber-50 border border-amber-200 rounded-xl">
            <svg className="w-6 h-6 text-amber-500 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            </svg>
            <p className="text-sm text-amber-800 leading-relaxed">
              <strong>Please read this disclaimer carefully.</strong> GrowMyStocks does not provide financial advice. All content on this platform is for informational and educational purposes only. You are solely responsible for your investment decisions.
            </p>
          </div>

          <h1 className="text-3xl font-bold text-gray-900 mb-2">Investment Disclaimer</h1>
          <p className="text-sm text-gray-400 mb-10">Effective date: {EFFECTIVE_DATE}</p>

          <div className="space-y-8 text-sm text-gray-700 leading-relaxed">

            <section>
              <h2 className="section-heading mb-3">1. Not Financial Advice</h2>
              <p>
                GrowMyStocks is an informational and educational platform. Nothing on this website — including but not limited to stock data, GPS scores, AI-generated predictions, analyst sentiment summaries, technical indicators, trading signals, portfolio analysis, or any other content — constitutes financial, investment, tax, or legal advice.
              </p>
              <p className="mt-3">
                GrowMyStocks is <strong>not a registered investment advisor, broker-dealer, financial planner, or fiduciary</strong> under any applicable law. We are not licensed to provide personalized investment recommendations. No content on this platform should be construed as a solicitation or recommendation to buy, sell, hold, or otherwise transact in any security or financial instrument.
              </p>
            </section>

            <section>
              <h2 className="section-heading mb-3">2. AI Predictions & GPS Scores</h2>
              <p>
                GrowMyStocks uses artificial intelligence and machine learning models to generate price predictions and GPS (Growth Potential Score) ratings. These outputs are <strong>experimental, speculative, and may be materially inaccurate</strong>.
              </p>
              <ul className="list-disc pl-5 space-y-2 mt-3">
                <li>AI models are trained on historical data and cannot account for future events, news, earnings surprises, macroeconomic shifts, geopolitical events, or other factors that affect stock prices.</li>
                <li>A high GPS score or positive price prediction does not guarantee that a stock will increase in value.</li>
                <li>A low GPS score or negative prediction does not guarantee that a stock will decline in value.</li>
                <li>Model performance varies across market conditions and sectors. Past model accuracy is not indicative of future accuracy.</li>
              </ul>
              <p className="mt-3">
                You should treat AI-generated content as one data point among many and conduct your own thorough research before making any investment decision.
              </p>
            </section>

            <section>
              <h2 className="section-heading mb-3">3. Past Performance</h2>
              <p>
                Any historical data, charts, returns, or performance metrics displayed on GrowMyStocks are provided for informational context only. <strong>Past performance is not indicative of future results.</strong> The value of investments can go down as well as up, and you may receive back less than you invest.
              </p>
            </section>

            <section>
              <h2 className="section-heading mb-3">4. Market Data Accuracy</h2>
              <p>
                Market data displayed on GrowMyStocks is sourced from third-party providers including Yahoo Finance. This data may be:
              </p>
              <ul className="list-disc pl-5 space-y-2 mt-3">
                <li>Delayed by 15 minutes or more and not suitable for real-time trading decisions</li>
                <li>Subject to errors, gaps, or corrections by the data provider</li>
                <li>Incomplete or unavailable for certain securities</li>
              </ul>
              <p className="mt-3">
                GrowMyStocks makes no warranty, express or implied, regarding the accuracy, completeness, or timeliness of any market data. Always verify data with your brokerage or a licensed financial data provider before executing trades.
              </p>
            </section>

            <section>
              <h2 className="section-heading mb-3">5. Investment Risk</h2>
              <p>Investing in securities involves significant risk. You should be aware that:</p>
              <ul className="list-disc pl-5 space-y-2 mt-3">
                <li>Stock prices are volatile and can change rapidly due to factors outside anyone's control</li>
                <li>You may lose some or all of your invested capital</li>
                <li>Smaller companies and speculative stocks carry higher risk than established blue-chip stocks</li>
                <li>Diversification does not guarantee profit or protect against loss in declining markets</li>
                <li>Margin trading and options carry additional risk and may not be suitable for all investors</li>
              </ul>
            </section>

            <section>
              <h2 className="section-heading mb-3">6. No Responsibility for Losses</h2>
              <p>
                GrowMyStocks, its founders, operators, employees, and affiliates expressly disclaim all liability for any financial losses, damages, or adverse outcomes resulting from your use of this platform or reliance on any information, data, score, prediction, or analysis provided herein.
              </p>
              <p className="mt-3">
                Your investment decisions are entirely your own. By using GrowMyStocks, you acknowledge that you bear sole responsibility for any investment decisions you make and any resulting gains or losses.
              </p>
            </section>

            <section>
              <h2 className="section-heading mb-3">7. Seek Professional Advice</h2>
              <p>
                Before making any investment decision, we strongly encourage you to consult with a qualified and licensed financial advisor who can assess your individual financial situation, goals, risk tolerance, and time horizon. GrowMyStocks is a tool to help you research — it is not a substitute for professional financial guidance.
              </p>
            </section>

            <section>
              <h2 className="section-heading mb-3">8. Third-Party References</h2>
              <p>
                GrowMyStocks may display analyst ratings, price targets, news sentiment, or other content sourced from or referencing third parties. Such references do not constitute an endorsement of those parties or their views. We are not responsible for the accuracy or completeness of third-party content.
              </p>
            </section>

            <section>
              <h2 className="section-heading mb-3">9. Regulatory Notice</h2>
              <p>
                GrowMyStocks is not registered with the U.S. Securities and Exchange Commission (SEC), the Financial Industry Regulatory Authority (FINRA), or any other financial regulatory body. Use of this platform does not create any client, advisory, or fiduciary relationship between you and GrowMyStocks.
              </p>
            </section>

            <section>
              <h2 className="section-heading mb-3">10. Questions</h2>
              <p>
                If you have questions about this disclaimer, please <Link href="/contact" className="text-green-700 hover:text-green-800 underline">contact us</Link>.
              </p>
            </section>

          </div>
        </div>

        <div className="flex gap-4 justify-center mt-8 text-sm text-gray-500">
          <Link href="/legal/privacy" className="hover:text-gray-700 underline">Privacy Policy</Link>
          <Link href="/legal/terms" className="hover:text-gray-700 underline">Terms of Service</Link>
        </div>

      </div>
    </main>
  )
}
