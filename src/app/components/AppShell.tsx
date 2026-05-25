'use client'

import { usePathname } from 'next/navigation'
import Navigation from './Navigation'
import Footer from './Footer'

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const isLanding = pathname === '/'

  if (isLanding) {
    return <>{children}</>
  }

  return (
    <>
      <Navigation />
      <div className="flex-1 min-h-[calc(100vh-4rem)]">
        {children}
      </div>
      <Footer />
    </>
  )
}
