// src/app/components/cards/CardMetricRow.tsx

import React from 'react'

interface CardMetricRowProps {
  label: string
  value: string | number | React.ReactNode
  valueClassName?: string
  className?: string
}

export const CardMetricRow: React.FC<CardMetricRowProps> = ({ 
  label, 
  value, 
  valueClassName = "text-gray-900 dark:text-white", 
  className = "" 
}) => {
  return (
    <div className={`flex justify-between items-center py-2 border-t border-dashed border-gray-100 dark:border-gray-700 first:border-t-0 ${className}`}>
      <span className="text-xs text-gray-500 dark:text-gray-400 uppercase font-semibold tracking-wide">
        {label}
      </span>
      <span className={`text-sm font-bold ${valueClassName}`}>
        {value}
      </span>
    </div>
  )
}
