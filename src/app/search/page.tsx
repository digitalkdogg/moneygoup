'use client'

import Search from '../components/Search'
import SectorExplorer from '../components/SectorExplorer'
import MajorIndicesStrip from '../components/MajorIndicesStrip'
import DeepMoneyPicksSection from '../components/DeepMoneyPicksSection'
import TrendingStocksGrid from '../components/TrendingStocksGrid'

export default function SearchPage() {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100">
      <main className="container mx-auto px-4 py-12">
        <section className="text-center mb-8">
          <h1 className="text-5xl font-extrabold mb-4">
            Discover Stocks
          </h1>
          <p className="text-xl text-gray-600 dark:text-gray-300 mb-6">
            Search by ticker or company, or explore by market and sector.
          </p>
          <div className="max-w-2xl mx-auto">
            <Search />
          </div>
        </section>

        <section className="mb-16 mt-16">
          <SectorExplorer />
        </section>

        <section className="mb-16">
          <MajorIndicesStrip />
        </section>

        <section className="mb-16">
          <DeepMoneyPicksSection />
        </section>

        <section>
          <TrendingStocksGrid />
        </section>
      </main>
    </div>
  )
}
