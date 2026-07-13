'use client'

import { useRouter } from 'next/navigation'
import { trackSectorClick } from '@/utils/analytics'
import { CANONICAL_SECTORS, getSectorColor } from '@/utils/sectorTaxonomy'

export default function SectorExplorer() {
  const router = useRouter()

  const handleSectorClick = (sector: string) => {
    trackSectorClick(sector)
    router.push(`/search/industry/${encodeURIComponent(sector)}`)
  }

  return (
    <div className="bg-white p-4 md:p-6 rounded-2xl shadow-lg section-explore-by-sector">
      <h2 className="section-heading">Explore by Sector</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        {CANONICAL_SECTORS.map(sector => {
          const color = getSectorColor(sector)
          return (
            <button
              key={sector}
              onClick={() => handleSectorClick(sector)}
              aria-label={`Browse ${sector} stocks`}
              className="p-4 bg-[#fbf9fa] border border-gray-200 border-l-4 rounded-2xl transition-all duration-200 hover:shadow-lg hover:-translate-y-1 text-left"
              style={{ borderLeftColor: color }}
            >
              <span className="text-gray-900">{sector}</span>
              <div className="text-xs text-gray-500 mt-1">Browse stocks</div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
