import type { Metadata } from 'next'
import { Rubik } from 'next/font/google'
import { headers } from 'next/headers'
import './globals.css'
import AppShell from './components/AppShell'
import Providers from './providers';

const rubik = Rubik({ subsets: ['latin'], weight: ['400', '500', '600', '700'] })

export const metadata: Metadata = {
  title: 'GrowMyStocks',
  description: 'AI-powered stock data visualization and forecasting app',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const nonce = headers().get('x-nonce') ?? undefined;
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