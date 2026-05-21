import Link from 'next/link'

export const metadata = {
  title: 'Terms of Service — GrowMyStocks',
  description: 'The terms and conditions governing your use of the GrowMyStocks platform.',
}

const EFFECTIVE_DATE = 'May 20, 2026'

export default function TermsOfServicePage() {
  return (
    <main id="main-content" className="min-h-screen bg-gray-50 py-12 px-4">
      <div className="max-w-3xl mx-auto">

        <div className="mb-8">
          <Link href="/dashboard" className="text-sm text-green-700 hover:text-green-800 font-medium">
            ← Back to Dashboard
          </Link>
        </div>

        <div className="bg-white rounded-2xl shadow-[0_1px_10px_rgba(0,0,0,0.1)] p-8 md:p-12">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">Terms of Service</h1>
          <p className="text-sm text-gray-400 mb-10">Effective date: {EFFECTIVE_DATE}</p>

          <div className="space-y-8 text-sm text-gray-700 leading-relaxed">

            <section>
              <h2 className="text-lg font-semibold text-gray-900 mb-3">1. Acceptance of Terms</h2>
              <p>
                By accessing or using GrowMyStocks (&ldquo;the Platform,&rdquo; &ldquo;we,&rdquo; &ldquo;us,&rdquo; or &ldquo;our&rdquo;), you agree to be bound by these Terms of Service (&ldquo;Terms&rdquo;). If you do not agree to these Terms, you may not use the Platform. These Terms apply to all users, including registered account holders and any visitors to the Platform.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-gray-900 mb-3">2. Description of Service</h2>
              <p>
                GrowMyStocks is an AI-assisted stock analysis and portfolio tracking platform. It provides tools including stock search, price data, technical indicators, AI-generated predictions, GPS scores, analyst sentiment aggregation, portfolio management, and watchlist tracking.
              </p>
              <p className="mt-3">
                All content, data, scores, and predictions provided by the Platform are for <strong>informational and educational purposes only</strong> and do not constitute financial advice. See our <Link href="/legal/disclaimer" className="text-green-700 hover:text-green-800 underline">Investment Disclaimer</Link> for full details.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-gray-900 mb-3">3. Eligibility</h2>
              <p>You must be at least 18 years of age to use GrowMyStocks. By using the Platform, you represent and warrant that you meet this requirement. We reserve the right to terminate accounts of users found to be under 18.</p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-gray-900 mb-3">4. Account Registration & Security</h2>
              <p>Access to the Platform requires registration and admin approval. You agree to:</p>
              <ul className="list-disc pl-5 space-y-2 mt-3">
                <li>Provide accurate and complete registration information</li>
                <li>Keep your password confidential and not share account access with others</li>
                <li>Notify us immediately of any unauthorized use of your account</li>
                <li>Accept responsibility for all activity that occurs under your account</li>
              </ul>
              <p className="mt-3">We reserve the right to suspend or terminate accounts at our discretion, including for violations of these Terms.</p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-gray-900 mb-3">5. Acceptable Use</h2>
              <p>You agree not to:</p>
              <ul className="list-disc pl-5 space-y-2 mt-3">
                <li>Use the Platform for any unlawful purpose or in violation of any applicable laws or regulations</li>
                <li>Attempt to gain unauthorized access to any part of the Platform, its servers, or related systems</li>
                <li>Scrape, crawl, or systematically extract data from the Platform without express written permission</li>
                <li>Reverse engineer, decompile, or disassemble any part of the Platform</li>
                <li>Use the Platform to transmit spam, malware, or any harmful content</li>
                <li>Impersonate any person or entity, or misrepresent your affiliation with any person or entity</li>
                <li>Interfere with or disrupt the integrity or performance of the Platform</li>
              </ul>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-gray-900 mb-3">6. No Financial Advice</h2>
              <p>
                GrowMyStocks is <strong>not a registered investment advisor, broker-dealer, or financial planning firm</strong>. Nothing on the Platform constitutes a recommendation to buy, sell, or hold any security. All data, scores, predictions, and analysis are provided solely for informational purposes.
              </p>
              <p className="mt-3">
                You are solely responsible for your investment decisions. Always consult a licensed financial professional before making investment decisions. Past performance displayed on the Platform is not indicative of future results.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-gray-900 mb-3">7. Data Accuracy & Availability</h2>
              <p>
                Market data is sourced from third-party providers and may be delayed, incomplete, or inaccurate. AI-generated predictions and scores are experimental and carry no guarantee of accuracy. We make no representations or warranties regarding the accuracy, timeliness, or completeness of any data on the Platform.
              </p>
              <p className="mt-3">
                The Platform may be unavailable from time to time due to maintenance, updates, or circumstances beyond our control. We do not guarantee uninterrupted access.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-gray-900 mb-3">8. Intellectual Property</h2>
              <p>
                All content, design, software, branding, and features of the Platform are the property of GrowMyStocks and are protected by applicable intellectual property laws. You may not reproduce, distribute, or create derivative works from any part of the Platform without our express written consent.
              </p>
              <p className="mt-3">
                You retain ownership of the portfolio and watchlist data you enter. By submitting data to the Platform, you grant us a limited license to store and process that data solely for the purpose of providing the service to you.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-gray-900 mb-3">9. Limitation of Liability</h2>
              <p>
                To the fullest extent permitted by law, GrowMyStocks and its operators shall not be liable for any indirect, incidental, special, consequential, or punitive damages, including but not limited to loss of profits, loss of data, or financial losses arising from:
              </p>
              <ul className="list-disc pl-5 space-y-2 mt-3">
                <li>Your use of or inability to use the Platform</li>
                <li>Any investment decisions made based on information from the Platform</li>
                <li>Errors, inaccuracies, or omissions in market data or AI-generated content</li>
                <li>Unauthorized access to or alteration of your data</li>
                <li>Any interruption or cessation of the Platform</li>
              </ul>
              <p className="mt-3">
                In no event shall our total liability to you exceed the greater of (a) the amount you paid to use the Platform in the 12 months preceding the claim, or (b) $100 USD.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-gray-900 mb-3">10. Disclaimer of Warranties</h2>
              <p>
                The Platform is provided on an &ldquo;as is&rdquo; and &ldquo;as available&rdquo; basis without warranties of any kind, either express or implied, including but not limited to implied warranties of merchantability, fitness for a particular purpose, or non-infringement.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-gray-900 mb-3">11. Indemnification</h2>
              <p>
                You agree to indemnify and hold harmless GrowMyStocks and its operators from any claims, damages, losses, liabilities, costs, and expenses (including reasonable legal fees) arising out of or related to your use of the Platform, your violation of these Terms, or your violation of any rights of a third party.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-gray-900 mb-3">12. Privacy</h2>
              <p>
                Your use of the Platform is also governed by our <Link href="/legal/privacy" className="text-green-700 hover:text-green-800 underline">Privacy Policy</Link>, which is incorporated into these Terms by reference.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-gray-900 mb-3">13. Termination</h2>
              <p>
                We may suspend or terminate your access to the Platform at any time, with or without notice, for any reason including breach of these Terms. Upon termination, your right to use the Platform ceases immediately. Provisions of these Terms that by their nature should survive termination (including limitations of liability, disclaimers, and indemnification) will remain in effect.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-gray-900 mb-3">14. Changes to These Terms</h2>
              <p>
                We reserve the right to modify these Terms at any time. Changes will be posted on this page with an updated effective date. Continued use of the Platform after changes are posted constitutes your acceptance of the revised Terms. For material changes, we will make reasonable efforts to notify registered users via email.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-gray-900 mb-3">15. Governing Law</h2>
              <p>
                These Terms shall be governed by and construed in accordance with the laws of the United States, without regard to conflict of law principles. Any disputes arising under these Terms shall be resolved through binding arbitration or in a court of competent jurisdiction.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-gray-900 mb-3">16. Contact</h2>
              <p>
                If you have questions about these Terms, please reach out via our <Link href="/contact" className="text-green-700 hover:text-green-800 underline">contact form</Link>.
              </p>
            </section>

          </div>
        </div>

        <div className="flex gap-4 justify-center mt-8 text-sm text-gray-500">
          <Link href="/legal/privacy" className="hover:text-gray-700 underline">Privacy Policy</Link>
          <Link href="/legal/disclaimer" className="hover:text-gray-700 underline">Investment Disclaimer</Link>
        </div>

      </div>
    </main>
  )
}
