import Link from 'next/link'

export const metadata = {
  title: 'Privacy Policy — GrowMyStocks',
  description: 'How GrowMyStocks collects, uses, and protects your personal information.',
}

const EFFECTIVE_DATE = 'May 20, 2026'

export default function PrivacyPolicyPage() {
  return (
    <main id="main-content" className="min-h-screen bg-gray-50 py-12 px-4">
      <div className="max-w-3xl mx-auto">

        <div className="mb-8">
          <Link href="/dashboard" className="text-sm text-green-700 hover:text-green-800 font-medium">
            ← Back to Dashboard
          </Link>
        </div>

        <div className="bg-white rounded-2xl shadow-[0_1px_10px_rgba(0,0,0,0.1)] p-8 md:p-12">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">Privacy Policy</h1>
          <p className="text-sm text-gray-400 mb-10">Effective date: {EFFECTIVE_DATE}</p>

          <div className="prose prose-gray max-w-none space-y-8 text-sm text-gray-700 leading-relaxed">

            <section className="section-1-overview">
              <h2 className="section-heading mb-3">1. Overview</h2>
              <p>
                GrowMyStocks (&ldquo;we,&rdquo; &ldquo;us,&rdquo; or &ldquo;our&rdquo;) is committed to protecting your privacy. This Privacy Policy explains what information we collect when you use our platform, how we use it, and the choices you have regarding your data.
              </p>
              <p className="mt-3">
                By creating an account or using GrowMyStocks, you agree to the collection and use of information in accordance with this policy.
              </p>
            </section>

            <section className="section-2-information-we-collect">
              <h2 className="section-heading mb-3">2. Information We Collect</h2>
              <h3 className="font-semibold text-gray-800 mb-2">Account Information</h3>
              <p>When you register, we collect your username and email address. We do not collect payment information directly — if billing is introduced, it will be handled by a PCI-compliant third-party processor.</p>

              <h3 className="font-semibold text-gray-800 mt-4 mb-2">Portfolio & Watchlist Data</h3>
              <p>Information you enter about your stock holdings, purchase prices, share quantities, and watchlist symbols is stored in our database and associated with your account.</p>

              <h3 className="font-semibold text-gray-800 mt-4 mb-2">Usage Data</h3>
              <p>We may collect non-personally identifiable information about how you interact with the platform (pages visited, features used, session duration) to improve the product. This data is not sold or shared with third parties for advertising purposes.</p>

              <h3 className="font-semibold text-gray-800 mt-4 mb-2">Contact Form Submissions</h3>
              <p>If you contact us via the contact form, we collect your name, email address, and the content of your message solely to respond to your inquiry.</p>
            </section>

            <section className="section-3-how-we-use-your-information">
              <h2 className="section-heading mb-3">3. How We Use Your Information</h2>
              <ul className="list-disc pl-5 space-y-2">
                <li>To provide and operate the GrowMyStocks platform</li>
                <li>To personalize your dashboard, portfolio, and watchlist experience</li>
                <li>To send transactional emails (account approval, password resets, contact confirmations)</li>
                <li>To analyze and improve platform performance and features</li>
                <li>To respond to support requests and inquiries</li>
                <li>To comply with legal obligations</li>
              </ul>
              <p className="mt-3">We do <strong>not</strong> sell, rent, or trade your personal information to third parties for marketing purposes.</p>
            </section>

            <section className="section-4-data-storage-security">
              <h2 className="section-heading mb-3">4. Data Storage & Security</h2>
              <p>
                Your data is stored on secured servers. We implement reasonable technical and organizational safeguards — including encrypted connections (HTTPS), hashed passwords, and access controls — to protect your information against unauthorized access, alteration, or disclosure.
              </p>
              <p className="mt-3">
                No method of transmission over the internet or electronic storage is 100% secure. While we strive to use commercially acceptable means to protect your data, we cannot guarantee absolute security.
              </p>
            </section>

            <section className="section-5-third-party-services">
              <h2 className="section-heading mb-3">5. Third-Party Services</h2>
              <p>We use the following third-party services that may process your data as part of delivering the platform:</p>
              <ul className="list-disc pl-5 space-y-2 mt-3">
                <li><strong>Resend</strong> — transactional email delivery (account and contact emails)</li>
                <li><strong>Yahoo Finance API</strong> — real-time and historical stock market data (no personal data shared)</li>
              </ul>
              <p className="mt-3">These providers have their own privacy policies governing their use of data. We only share the minimum information necessary for each service to function.</p>
            </section>

            <section className="section-6-cookies-session-data">
              <h2 className="section-heading mb-3">6. Cookies & Session Data</h2>
              <p>
                GrowMyStocks uses session cookies to keep you logged in between visits. These cookies are essential to the operation of the platform and are not used for advertising tracking. You can disable cookies in your browser settings, but doing so will prevent you from logging in.
              </p>
            </section>

            <section className="section-7-your-rights-choices">
              <h2 className="section-heading mb-3">7. Your Rights & Choices</h2>
              <p>You have the right to:</p>
              <ul className="list-disc pl-5 space-y-2 mt-3">
                <li><strong>Access</strong> the personal information we hold about you</li>
                <li><strong>Correct</strong> inaccurate or incomplete information via your profile settings</li>
                <li><strong>Delete</strong> your account and associated data by contacting us</li>
                <li><strong>Export</strong> your portfolio data (contact us to request)</li>
              </ul>
              <p className="mt-3">To exercise any of these rights, please <Link href="/contact" className="text-green-700 hover:text-green-800 underline">contact us</Link>.</p>
            </section>

            <section className="section-8-data-retention">
              <h2 className="section-heading mb-3">8. Data Retention</h2>
              <p>
                We retain your account information for as long as your account is active. If you delete your account, we will remove your personal data from our systems within 30 days, except where retention is required by law or legitimate business necessity (e.g., fraud prevention).
              </p>
            </section>

            <section className="section-9-childrens-privacy">
              <h2 className="section-heading mb-3">9. Children&rsquo;s Privacy</h2>
              <p>
                GrowMyStocks is not intended for users under the age of 18. We do not knowingly collect personal information from minors. If we become aware that a minor has provided us with personal data, we will delete it promptly.
              </p>
            </section>

            <section className="section-10-changes-to-this-policy">
              <h2 className="section-heading mb-3">10. Changes to This Policy</h2>
              <p>
                We may update this Privacy Policy from time to time. When we do, we will revise the effective date at the top of this page. Continued use of the platform after changes constitutes your acceptance of the updated policy. For material changes, we will make reasonable efforts to notify registered users via email.
              </p>
            </section>

            <section className="section-11-contact">
              <h2 className="section-heading mb-3">11. Contact</h2>
              <p>
                If you have questions or concerns about this Privacy Policy or your data, please reach out via our <Link href="/contact" className="text-green-700 hover:text-green-800 underline">contact form</Link>.
              </p>
            </section>

          </div>
        </div>

        <div className="flex gap-4 justify-center mt-8 text-sm text-gray-500">
          <Link href="/legal/terms" className="hover:text-gray-700 underline">Terms of Service</Link>
          <Link href="/legal/disclaimer" className="hover:text-gray-700 underline">Investment Disclaimer</Link>
        </div>

      </div>
    </main>
  )
}
