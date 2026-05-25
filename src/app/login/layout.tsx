import type { Metadata } from 'next'

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://growmystocks.com'

export const metadata: Metadata = {
  title: 'Login — GrowMyStocks',
  description: 'Sign in to GrowMyStocks and access AI-powered GPS stock scores, machine-learning price predictions, and your personal portfolio analytics.',
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true },
  },
  openGraph: {
    type: 'website',
    url: `${siteUrl}/login`,
    title: 'Login — GrowMyStocks',
    description: 'Sign in to access AI-powered stock scores, price predictions, and portfolio tracking.',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Login — GrowMyStocks',
    description: 'Sign in to access AI-powered stock scores, price predictions, and portfolio tracking.',
  },
  alternates: {
    canonical: `${siteUrl}/login`,
  },
}

const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'WebPage',
  name: 'Login — GrowMyStocks',
  url: `${siteUrl}/login`,
  description: 'Sign in to GrowMyStocks and access AI-powered GPS stock scores, machine-learning price predictions, and your personal portfolio analytics.',
  isPartOf: {
    '@type': 'WebSite',
    name: 'GrowMyStocks',
    url: siteUrl,
  },
}

export default function LoginLayout({ children }: { children: React.ReactNode }) {
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
