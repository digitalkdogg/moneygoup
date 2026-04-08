// src/app/components/cards/CardActions.tsx

import React from 'react'

interface ActionButtonProps {
  label: string
  onClick: (e: React.MouseEvent) => void
  variant?: 'primary' | 'secondary' | 'danger' | 'neutral'
}

const ActionButton: React.FC<ActionButtonProps> = ({ label, onClick, variant = 'neutral' }) => {
  const getStyles = () => {
    switch (variant) {
      case 'primary': return 'bg-green-600 text-white hover:bg-green-700'
      case 'secondary': return 'bg-gray-600 text-white hover:bg-gray-700'
      case 'danger': return 'bg-red-600 text-white hover:bg-red-700'
      case 'neutral': return 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600'
      default: return 'bg-gray-100 text-gray-700 hover:bg-gray-200'
    }
  }

  return (
    <button
      onClick={onClick}
      className={`flex-1 py-2.5 px-3 rounded-lg text-xs font-bold transition-colors duration-200 ${getStyles()}`}
    >
      {label}
    </button>
  )
}

interface CardActionsProps {
  children: React.ReactNode
}

export const CardActions: React.FC<CardActionsProps> = ({ children }) => {
  return (
    <div className="flex gap-2 p-5 mt-auto border-t border-gray-50 dark:border-gray-700" onClick={(e) => e.stopPropagation()}>
      {children}
    </div>
  )
}

export { ActionButton }
