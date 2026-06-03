'use client'

import Link from 'next/link'
import { INDUSTRY_TAXONOMY } from '@/utils/industryTaxonomy'
import { useRouter } from 'next/navigation'
import { trackSectorClick } from '@/utils/analytics'

const FEATURED_SECTORS = [
  'technology',
  'healthcare',
  'finance',
  'energy',
  'retail',
  'real_estate',
  'manufacturing',
  'hospitality',
  'media_and_entertainment',
  'transportation_and_logistics'
]

const SECTOR_DISPLAY_NAMES: Record<string, string> = {
  technology: 'Technology',
  healthcare: 'Healthcare',
  finance: 'Finance',
  energy: 'Energy',
  retail: 'Retail',
  real_estate: 'Real Estate',
  manufacturing: 'Manufacturing',
  hospitality: 'Hospitality',
  media_and_entertainment: 'Media & Entertainment',
  transportation_and_logistics: 'Transportation & Logistics',
  education: 'Education',
  construction: 'Construction',
  agriculture: 'Agriculture',
  cybersecurity: 'Cybersecurity',
  gold: 'Gold & Precious Metals',
  legal: 'Legal Services',
  government_and_public_sector: 'Government & Public Sector',
}

export default function SectorExplorer() {
  const router = useRouter()

  const handleSectorClick = (sector: string) => {
    trackSectorClick(sector)
    router.push(`/search/industry/${sector}`)
  }

  return (
    <div className="bg-white p-4 md:p-6 rounded-2xl shadow-lg">
      <h2 className="section-heading">Explore by Sector</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        {FEATURED_SECTORS.map(sector => (
          <button
            key={sector}
            onClick={() => handleSectorClick(sector)}
            aria-label={`Browse ${SECTOR_DISPLAY_NAMES[sector] || sector} stocks`}
            className="p-4 bg-[#fbf9fa] border border-gray-200 rounded-2xl transition-all duration-200 hover:shadow-lg hover:-translate-y-1 text-left"
          >
            <span className="text-gray-900">
              {SECTOR_DISPLAY_NAMES[sector] || sector}
            </span>
            <div className="text-xs text-gray-500 mt-1">
              Browse stocks
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
