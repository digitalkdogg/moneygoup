import type { Metadata } from 'next'
import { SITE_URL as siteUrl } from '@/utils/siteUrl'

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
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Register — GrowMyStocks',
    description: 'Create a free account and start analyzing stocks with AI-powered GPS scores and price predictions.',
  },
  alternates: {
    canonical: `${siteUrl}/register`,
  },
}

const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'WebPage',
  name: 'Register — GrowMyStocks',
  url: `${siteUrl}/register`,
  description: 'Create a free GrowMyStocks account and start analyzing stocks with AI. GPS scores, machine-learning price targets, and portfolio tracking.',
  isPartOf: {
    '@type': 'WebSite',
    name: 'GrowMyStocks',
    url: siteUrl,
  },
}

export default function RegisterLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      {children}
    </>
  )
}
