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
    images: [{ url: '/growmystock_logo.svg', width: 512, height: 512, alt: 'GrowMyStocks' }],
  },
  twitter: {
    card: 'summary',
    title: 'Login — GrowMyStocks',
    description: 'Sign in to access AI-powered stock scores, price predictions, and portfolio tracking.',
    images: ['/growmystock_logo.svg'],
  },
  alternates: {
    canonical: `${siteUrl}/login`,
  },
}

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
