import type { Metadata } from 'next'

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://growmystocks.com'

export const metadata: Metadata = {
  title: 'Register — GrowMyStocks',
  description: 'Create a free GrowMyStocks account and start analyzing stocks with AI. GPS scores, machine-learning price targets, and portfolio tracking — free to register.',
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true },
  },
  openGraph: {
    type: 'website',
    url: `${siteUrl}/register`,
    title: 'Register — GrowMyStocks',
    description: 'Create a free account and start analyzing stocks with AI-powered GPS scores and price predictions.',
    images: [{ url: '/growmystock_logo.svg', width: 512, height: 512, alt: 'GrowMyStocks' }],
  },
  twitter: {
    card: 'summary',
    title: 'Register — GrowMyStocks',
    description: 'Create a free account and start analyzing stocks with AI-powered GPS scores and price predictions.',
    images: ['/growmystock_logo.svg'],
  },
  alternates: {
    canonical: `${siteUrl}/register`,
  },
}

export default function RegisterLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
