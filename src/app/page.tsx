import type { Metadata } from 'next'
import LandingPage from './components/LandingPage'

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://growmystocks.com'

export const metadata: Metadata = {
  title: 'GrowMyStocks — AI-Powered Stock Analysis & Market Intelligence',
  description: 'Surface high-potential stocks and ETFs using machine learning, macro data, and real-time market signals. GPS scores, AI price predictions, and portfolio tracking — built for individual investors.',
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true },
  },
  openGraph: {
    type: 'website',
    url: siteUrl,
    title: 'GrowMyStocks — AI-Powered Stock Analysis & Market Intelligence',
    description: 'Surface high-potential stocks and ETFs before the crowd finds them. GPS scores, AI predictions, and macro-aware discovery in one dashboard.',
    images: [{ url: '/growmystock_logo.svg', width: 512, height: 512, alt: 'GrowMyStocks' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'GrowMyStocks — AI-Powered Stock Analysis',
    description: 'Surface high-potential stocks using machine learning, macro data, and real-time signals.',
    images: ['/growmystock_logo.svg'],
  },
  alternates: {
    canonical: siteUrl,
  },
}

export default function HomePage() {
  return <LandingPage />
}
