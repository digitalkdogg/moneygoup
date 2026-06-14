// src/app/components/cards/CardActions.tsx

import React from 'react'

interface ActionButtonProps {
  label: string
  onClick: (e: React.MouseEvent) => void
  variant?: 'primary' | 'secondary' | 'danger' | 'neutral'
  size?: 'sm' | 'md'
  outline?: boolean
  ariaLabel?: string
  grow?: boolean
}

const ActionButton: React.FC<ActionButtonProps> = ({ label, onClick, variant = 'neutral', size = 'md', outline = false, ariaLabel, grow = true }) => {
  const getStyles = () => {
    if (outline) {
      switch (variant) {
        case 'primary': return 'bg-white border border-green-700 text-green-700 hover:bg-green-50'
        case 'secondary': return 'bg-white border border-gray-600 text-gray-600 hover:bg-gray-50'
        case 'danger': return 'bg-white border border-red-600 text-red-600 hover:bg-red-50'
        case 'neutral': return 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-50'
        default: return 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-50'
      }
    }
    switch (variant) {
      case 'primary': return 'bg-green-700 text-white hover:bg-green-800'
      case 'secondary': return 'bg-gray-600 text-white hover:bg-gray-700'
      case 'danger': return 'bg-red-600 text-white hover:bg-red-700'
      case 'neutral': return 'bg-gray-300 text-gray-700 hover:bg-gray-200'
      default: return 'bg-gray-100 text-gray-700 hover:bg-gray-200'
    }
  }

  const getSizeStyles = () => {
    switch (size) {
      case 'sm': return 'py-1.5 px-2'
      case 'md': return 'py-2.5 px-3'
      default: return 'py-2.5 px-3'
    }
  }

  return (
    <button
      onClick={onClick}
      aria-label={ariaLabel}
      className={`${grow ? 'flex-1' : ''} rounded-lg sm transition-colors duration-200 focus-ring ${getSizeStyles()} ${getStyles()}`}
    >
      {label}
    </button>
  )
}

interface CardActionsProps {
  children: React.ReactNode
  compact?: boolean
  justify?: 'start' | 'end' | 'between'
}

export const CardActions: React.FC<CardActionsProps> = ({ children, compact, justify = 'start' }) => {
  const justifyClass = justify === 'end' ? 'justify-end' : justify === 'between' ? 'justify-between' : ''
  return (
    <div
      className={`flex items-center gap-2 mt-auto border-t border-gray-50 ${compact ? 'px-3 pt-1 pb-3' : 'p-5'} ${justifyClass}`}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  )
}

export { ActionButton }
