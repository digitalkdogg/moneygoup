import React from 'react'

interface BaseCardShellProps {
  children: React.ReactNode
  onClick?: () => void
  className?: string
}

export const BaseCardShell: React.FC<BaseCardShellProps> = ({ children, onClick, className = "" }) => {
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (onClick && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault()
      onClick()
    }
  }

  return (
    <div
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      className={`w-full h-full bg-white border border-gray-100 rounded-2xl shadow-md hover:shadow-lg hover:-translate-y-1 transition-all duration-200 cursor-pointer flex flex-col overflow-hidden focus-ring ${className}`}
      onClick={onClick}
      onKeyDown={handleKeyDown}
    >
      {children}
    </div>
  )
}
