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
  valueClassName = "text-gray-900", 
  className = "" 
}) => {
  return (
    <div className={`flex justify-between items-start py-1.5 ${className}`}>
      <span className="text-[11px] text-gray-400 uppercase font-bold tracking-wider mt-0.5">
        {label}
      </span>
      <div className={`text-sm font-bold ${valueClassName}`}>
        {value}
      </div>
    </div>
  )
}
