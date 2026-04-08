// src/app/components/cards/CardHeader.tsx

import React from 'react'
import { formatPercent, getChangeColor, getChangeBg } from './formatters'

interface CardHeaderProps {
  symbol: string
  companyName: string
  changePercent: number | null
}

export const CardHeader: React.FC<CardHeaderProps> = ({ symbol, companyName, changePercent }) => {
  const isPositive = (changePercent ?? 0) >= 0

  return (
    <div className="flex items-start justify-between p-5 border-b border-gray-100">
      <div>
        <div className="text-2xl font-bold text-gray-900 leading-tight">
          {symbol}
        </div>
        <div className="text-xs text-gray-500 font-medium mt-1 truncate max-w-[180px]">
          {companyName}
        </div>
      </div>
      {changePercent !== null && (
        <div
          className={`px-2.5 py-1 rounded-full text-xs font-bold flex items-center gap-1 ${getChangeColor(changePercent)} ${getChangeBg(changePercent)} bg-opacity-10`}
        >
          <span aria-hidden="true">{isPositive ? '↑' : '↓'}</span>
          {formatPercent(changePercent)}
        </div>
      )}
    </div>
  )
}
