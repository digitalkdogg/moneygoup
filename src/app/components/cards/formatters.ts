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
  return value >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
}

export const getChangeBg = (value: number | null) => {
  if (value === null) return 'bg-gray-100 dark:bg-gray-800'
  return value >= 0 ? 'bg-green-50 dark:bg-green-900/20' : 'bg-red-50 dark:bg-red-900/20'
}

export const getAnalystColor = (rec: string | null): string => {
  if (!rec) return 'text-gray-600 dark:text-gray-400'
  const lower = rec.toLowerCase()
  if (lower.includes('strong buy')) return 'text-green-600 dark:text-green-400'
  if (lower.includes('buy')) return 'text-teal-600 dark:text-teal-400'
  if (lower.includes('sell')) return 'text-red-600 dark:text-red-400'
  return 'text-gray-600 dark:text-gray-400'
}
