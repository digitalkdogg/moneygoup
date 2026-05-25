// src/app/components/cards/GpsTooltip.tsx

import React, { useState } from 'react'
import { GpsBreakdownModal } from '../modals/GpsBreakdownModal'

interface GpsTooltipProps {
  score: number | null
  breakdown: any | null
  symbol: string
}

export const GpsTooltip: React.FC<GpsTooltipProps> = ({ score, breakdown, symbol }) => {
  const [isModalOpen, setIsModalOpen] = useState(false)

  return (
    <>
      <button 
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setIsModalOpen(true)
        }}
        className="!text-[11px] text-gray-500 hover:text-gray-700 hover:underline px-1.5 py-0.5 rounded transition-colors"
      >
        View score
      </button>

      <GpsBreakdownModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        symbol={symbol}
        score={score}
        breakdown={breakdown}
      />
    </>
  )
}
