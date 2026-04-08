// src/app/components/cards/formatters.ts

import { formatCurrency, formatNumber } from '@/utils/formatters'

export const formatPrice = (value: number | null) => {
  if (value === null) return 'N/A'
  return formatCurrency(value, 2)
}

export const formatPercent = (value: number | null) => {
  if (value === null) return 'N/A'
  return (value >= 0 ? '+' : '') + formatNumber(value, 2) + '%'
}

export const formatShares = (value: number | null) => {
  if (value === null) return 'N/A'
  return formatNumber(value, 2, true)
}

export const getChangeColor = (value: number | null) => {
  if (value === null) return 'text-gray-500'
  return value >= 0 ? 'text-green-900 ' : 'text-red-900'
}

export const getChangeBg = (value: number | null) => {
  if (value === null) return 'bg-gray-100'
  return value >= 0 ? 'bg-green-100' : 'bg-red-100 '
}

export const getAnalystColor = (rec: string | null): string => {
  if (!rec) return 'text-gray-600'
  const lower = rec.toLowerCase()
  if (lower.includes('strong buy')) return 'text-green-600'
  if (lower.includes('buy')) return 'text-teal-600'
  if (lower.includes('sell')) return 'text-red-600'
  return 'text-gray-600'
}
