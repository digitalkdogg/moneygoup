import type { Metadata } from 'next'
import LandingPage from './components/LandingPage'

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://growmystocks.com'

export const metadata: Metadata = {
  title: 'GrowMyStocks — AI Stock Analysis & Market Intelligence',
  description: 'GPS scores, AI price predictions, and portfolio analytics for individual investors. Powered by machine learning, macro data, and real-time signals.',
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true },
  },
  openGraph: {
    type: 'website',
    url: siteUrl,
    title: 'GrowMyStocks — AI Stock Analysis & Market Intelligence',
    description: 'Surface high-potential stocks and ETFs before the crowd finds them. GPS scores, AI predictions, and macro-aware discovery in one dashboard.',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'GrowMyStocks — AI-Powered Stock Analysis',
    description: 'Surface high-potential stocks using machine learning, macro data, and real-time signals.',
  },
  alternates: {
    canonical: siteUrl,
  },
}

const jsonLd = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'WebApplication',
      '@id': `${siteUrl}/#webapp`,
      name: 'GrowMyStocks',
      url: siteUrl,
      description: 'AI-powered stock analysis platform with GPS scores, ML price predictions, and portfolio tracking.',
      applicationCategory: 'FinanceApplication',
      operatingSystem: 'Web',
      offers: {
        '@type': 'Offer',
        price: '0',
        priceCurrency: 'USD',
        description: 'Free to register',
      },
    },
    {
      '@type': 'Organization',
      '@id': `${siteUrl}/#org`,
      name: 'GrowMyStocks',
      url: siteUrl,
      logo: {
        '@type': 'ImageObject',
        url: `${siteUrl}/growmystock_logo.svg`,
      },
    },
  ],
}

export default function HomePage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <LandingPage />
    </>
  )
}
