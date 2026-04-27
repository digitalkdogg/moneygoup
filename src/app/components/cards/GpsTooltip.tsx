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
        className="flex items-center gap-1 hover:bg-gray-100 px-1.5 py-0.5 rounded transition-colors group/gps"
      >
        <span className="text-[10px] text-gray-400 font-bold group-hover/gps:text-purple-600">ⓘ</span>
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
