'use client'

import Search from '../components/Search'
import SectorExplorer from '../components/SectorExplorer'
import MajorIndicesStrip from '../components/MajorIndicesStrip'
import EarningsCalendar from '../components/EarningsCalendar'
import DeepMoneyPicksSection from '../components/DeepMoneyPicksSection'
import TrendingStocksGrid from '../components/TrendingStocksGrid'

export default function SearchPage() {
  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <main className="container mx-auto px-4 py-12">
        <section className="text-center mb-8 section-discover-stocks">
          <h1 className="text-5xl font-extrabold mb-4">
            Discover Stocks
          </h1>
          <p className="text-xl text-gray-600 mb-6">
            Search by ticker or company, or explore by market and sector.
          </p>
          <div className="max-w-2xl mx-auto">
            <Search />
          </div>
        </section>

        <section className="mb-16 mt-16 section-sector-explorer">
          <SectorExplorer />
        </section>

        <section className="mb-16 section-major-indices">
          <MajorIndicesStrip />
        </section>

        <section className="mb-16 section-earnings-calendar">
          <EarningsCalendar />
        </section>

        <section className="mb-16 section-deep-money-picks">
          <DeepMoneyPicksSection />
        </section>

        <section className="section-trending-stocks">
          <TrendingStocksGrid />
        </section>
      </main>
    </div>
  )
}
