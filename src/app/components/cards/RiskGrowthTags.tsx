import React from 'react'
import { classifyCard } from '@/utils/stockClassifier'

interface RiskGrowthTagsProps {
  gpsScore:           number | null | undefined
  predictedChangePct: number | null | undefined
  className?:         string
  size?:              'xs' | 'sm'
}

export function RiskGrowthTags({ gpsScore, predictedChangePct, className = '', size = 'sm' }: RiskGrowthTagsProps) {
  const c = classifyCard(gpsScore, predictedChangePct)
  if (!c) return null

  const tags: { label: string; style: string }[] = []

  if (c.growthStars >= 4) {
    tags.push({ label: 'High Growth', style: 'bg-green-100 text-green-700 border-green-200' })
  } else if (c.growthStars <= 2) {
    tags.push({ label: 'Low Growth', style: 'bg-gray-100 text-gray-500 border-gray-200' })
  }

  if (c.riskStars >= 4) {
    tags.push({ label: 'High Risk', style: 'bg-red-100 text-red-600 border-red-200' })
  } else if (c.riskStars <= 2) {
    tags.push({ label: 'Low Risk', style: 'bg-emerald-50 text-emerald-600 border-emerald-200' })
  }

  if (tags.length === 0) return null

  const tagClass = size === 'xs'
    ? 'text-[10px] font-bold px-1 py-px rounded border'
    : 'text-xs font-bold px-2 py-0.5 rounded border'

  return (
    <div className={`flex flex-wrap gap-1 ${className}`}>
      {tags.map(t => (
        <span key={t.label} className={`inline-flex items-center ${tagClass} ${t.style}`}>
          {t.label}
        </span>
      ))}
    </div>
  )
}
