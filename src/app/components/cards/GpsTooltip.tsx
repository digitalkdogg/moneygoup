// src/app/components/cards/GpsTooltip.tsx

import React, { useState } from 'react'
import { GpsBreakdownModal } from '../modals/GpsBreakdownModal'

interface GpsTooltipProps {
  score: number | null
  breakdown: any | null
  symbol: string
  /** Forwarded to the modal so the mlpUpside label matches the horizon
   *  the breakdown's mlpUpside was actually computed for. */
  horizon?: '1_week' | '1_month' | '6_month' | '1_year'
}

export const GpsTooltip: React.FC<GpsTooltipProps> = ({ score, breakdown, symbol, horizon }) => {
  const [isModalOpen, setIsModalOpen] = useState(false)

  return (
    <>
      <button
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setIsModalOpen(true)
        }}
        className="!text-[11px] text-gray-700 hover:text-gray-900 hover:underline px-1.5 py-0.5 rounded transition-colors"
      >
        View score
      </button>

      <GpsBreakdownModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        symbol={symbol}
        score={score}
        breakdown={breakdown}
        horizon={horizon}
      />
    </>
  )
}
