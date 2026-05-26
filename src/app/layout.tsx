import type { Metadata } from 'next'
import { Rubik } from 'next/font/google'
import { headers } from 'next/headers'
import './globals.css'
import AppShell from './components/AppShell'
import Providers from './providers';

const rubik = Rubik({ subsets: ['latin'], weight: ['400', '500', '600', '700'] })

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://growmystocks.com'

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: 'GrowMyStocks',
    template: '%s | GrowMyStocks',
  },
  description: 'AI-powered stock analysis and portfolio tracking. GPS scores, machine-learning price predictions, and macro-aware discovery — built for individual investors.',
  // Default: protected pages are not indexed but remain shareable via OG
  robots: {
    index: false,
    follow: true,
    googleBot: { index: false, follow: true },
  },
  openGraph: {
    type: 'website',
    siteName: 'GrowMyStocks',
    title: 'GrowMyStocks — AI-Powered Stock Analysis',
    description: 'GPS scores, AI price predictions, and macro-aware stock discovery. Built for individual investors who want data-driven insight without the noise.',
    url: siteUrl,
    images: [{ url: '/growmystock_logo.svg', width: 512, height: 512, alt: 'GrowMyStocks' }],
  },
  twitter: {
    card: 'summary',
    title: 'GrowMyStocks — AI-Powered Stock Analysis',
    description: 'GPS scores, AI price predictions, and macro-aware stock discovery.',
    images: ['/growmystock_logo.svg'],
  },
  verification: {
    google: 'nWwOsUNC50hheppj_HZeqs0ITR39Byku8mt6npAKfgQ',
  },
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <html lang="en">
      <body className={`${rubik.className} flex flex-col min-h-screen`}>
        <a href="#main-content" className="skip-link sr-only focus:not-sr-only">
          Skip to main content
        </a>
        <Providers>
          <AppShell>
            {children}
          </AppShell>
        </Providers>
      </body>
    </html>
  )
}