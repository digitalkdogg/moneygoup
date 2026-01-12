'use client'

import { useState } from 'react'
import Navigation from './components/Navigation'
import Dashboard from './components/Dashboard'
import Search from './components/Search'

export default function Home() {
  const [currentPage, setCurrentPage] = useState<'dashboard' | 'search'>('dashboard')

  return (
    <div className="min-h-screen bg-gray-50">
      <Navigation currentPage={currentPage} onNavigate={setCurrentPage} />
      <main>
        {currentPage === 'dashboard' && <Dashboard />}
        {currentPage === 'search' && <Search />}
      </main>
    </div>
  )
}