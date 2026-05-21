import type { Metadata } from 'next'
import { Rubik } from 'next/font/google'
import './globals.css'
import Navigation from './components/Navigation'
import Footer from './components/Footer'
import Providers from './providers'; // Import the new Providers component

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
  return (
    <html lang="en">
      <body className={`${rubik.className} flex flex-col min-h-screen`}>
        <a href="#main-content" className="skip-link sr-only focus:not-sr-only">
          Skip to main content
        </a>
        <Providers>
          <Navigation />
          <div className="flex-1 min-h-[calc(100vh-4rem)]">
            {children}
          </div>
          <Footer />
        </Providers>
      </body>
    </html>
  )
}