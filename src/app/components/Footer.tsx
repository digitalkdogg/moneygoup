import Link from 'next/link'
import Image from 'next/image'

const currentYear = new Date().getFullYear()

export default function Footer() {
  return (
    <footer className="mt-auto bg-white border-t-4 border-t-green-700">
      {/* Main footer content — light */}
      <div className="max-w-7xl mx-auto px-6 py-12">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-10">

          {/* Brand column */}
          <div>
            <div className="flex items-center gap-2 mb-4">
              <Image src="/growmystock_logo_dark.svg" alt="GrowMyStocks" width={32} height={32} />
              <span className="text-gray-900 font-bold text-lg">GrowMyStocks</span>
            </div>
            <p className="text-sm leading-relaxed text-gray-500">
              AI-powered stock analysis and portfolio tracking. Built for individual investors who want data-driven insight without the noise.
            </p>
          </div>

          {/* Contact CTA */}
          <div>
            <h3 className="text-gray-800 text-sm font-semibold uppercase tracking-wider mb-4">Get in Touch</h3>
            <p className="text-sm mb-4 text-gray-500">
              Questions about your account, data, or a feature request? We'd love to hear from you.
            </p>
            <Link
              href="/contact"
              className="inline-block bg-green-700 hover:bg-green-800 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors duration-200"
            >
              Send a Message
            </Link>
          </div>
        </div>
      </div>

      {/* Disclaimer — light gray strip */}
      <div className="bg-green-50 border-t border-green-100">
        <div className="max-w-7xl mx-auto px-6 py-6">
          <p className="text-xs text-gray-600 leading-relaxed mb-4">
            <strong className="text-gray-700">Investment Disclaimer:</strong>{' '}
            GrowMyStocks is provided for <strong className="text-gray-700">informational and educational purposes only</strong> and does not constitute financial, investment, tax, or legal advice.
            All data, analysis, predictions, GPS scores, analyst ratings, and other content displayed on this platform are for general informational use and should not be relied upon as the sole basis for making investment decisions.
            Past performance is not indicative of future results. Investing in securities involves risk, including the possible loss of principal.
            AI-generated predictions and scores are experimental and may be inaccurate. Always conduct your own due diligence and consult a qualified financial advisor before making any investment decision.
            GrowMyStocks and its operators are not responsible for any financial losses incurred as a result of using this platform.
          </p>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-xs text-gray-500">
            <p>
              &copy; {currentYear} GrowMyStocks. All rights reserved.
            </p>
            <div className="flex gap-4">
              <Link href="/legal/privacy" className="hover:text-gray-700 transition-colors">Privacy Policy</Link>
              <Link href="/legal/terms" className="hover:text-gray-700 transition-colors">Terms of Service</Link>
              <Link href="/legal/disclaimer" className="hover:text-gray-700 transition-colors">Disclaimer</Link>
            </div>
          </div>
        </div>
      </div>
    </footer>
  )
}
