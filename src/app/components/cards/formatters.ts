// src/app/components/cards/formatters.ts

import { formatCurrency, formatNumber } from '@/utils/formatters'

export const formatPrice = (value: number | null) => {
  if (value === null) return 'N/A'
  return formatCurrency(value, 2)
}

export const formatPriceChange = (value: number | null) => {
  if (value === null) return 'N/A'
  const sign = value > 0 ? '+' : (value < 0 ? '-' : '')
  return `${sign}${formatCurrency(Math.abs(value), 2)}`
}

export const formatPercent = (value: number | null) => {
  if (value === null) return 'N/A'
  return (value > 0 ? '+' : '') + formatNumber(value, 2) + '%'
}

export const formatShares = (value: number | null) => {
  if (value === null) return 'N/A'
  return formatNumber(value, 2, true)
}

export const calculatePredictionChange = (current: number | null, predicted: number | null): number | null => {
  if (current === null || predicted === null || current === 0) return null
  return ((predicted - current) / current) * 100
}

export const getChangeColor = (value: number | null) => {
  if (value === null) return 'text-gray-500'
  return value >= 0 ? 'text-green-900 ' : 'text-red-900'
}

export const getChangeBg = (value: number | null) => {
  if (value === null) return 'bg-gray-100'
  return value >= 0 ? '' : 'bg-red-100 '
}

export const getChangeBgStyle = (value: number | null) => {
  if (value === null) return {}
  return value >= 0 ? { backgroundColor: '#a8d78d' } : {}
}

export const getPredictionColor = (value: number | null) => {
  if (value === null || value === 0) return 'text-black'
  return value > 0 ? 'text-green-600' : 'text-red-600'
}

export const getAnalystColor = (rec: string | null): string => {
  if (!rec) return 'text-gray-600'
  const lower = rec.toLowerCase()
  if (lower.includes('strong buy')) return 'text-green-600'
  if (lower.includes('buy')) return 'text-teal-600'
  if (lower.includes('sell')) return 'text-red-600'
  return 'text-gray-600'
}
