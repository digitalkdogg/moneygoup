'use client'

import Navigation from './components/Navigation'
import Search from './components/Search'

export default function Home() {
  return (
    <div className="min-h-screen bg-gray-50">
      <Navigation />
      <main>
        <Search />
      </main>
    </div>
  )
}