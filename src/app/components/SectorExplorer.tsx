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
    <div className="w-full">
      <h2 className="text-2xl font-bold mb-6 text-gray-900 dark:text-white">
        Explore by Sector
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        {FEATURED_SECTORS.map(sector => (
          <button
            key={sector}
            onClick={() => handleSectorClick(sector)}
            aria-label={`Browse ${SECTOR_DISPLAY_NAMES[sector] || sector} stocks`}
            className="p-4 rounded-lg border-2 border-gray-200 dark:border-gray-700 hover:border-green-500 dark:hover:border-green-400 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 dark:focus:ring-offset-gray-900 transition duration-200 text-left  group"
          >
            <span className="font-semibold text-gray-900 dark:text-gray-100">
              {SECTOR_DISPLAY_NAMES[sector] || sector}
            </span>
            <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              Browse stocks
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
