import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import Navigation from './components/Navigation'
import Providers from './providers'; // Import the new Providers component

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'GrowMyStock',
  description: 'AI-powered stock data visualization and forecasting app',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <Providers>
          <Navigation />
          {children}
        </Providers>
      </body>
    </html>
  )
}