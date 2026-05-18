import React, { useState } from 'react'

interface BaseCardShellProps {
  children: React.ReactNode
  onClick?: () => void
  className?: string
}

export const BaseCardShell: React.FC<BaseCardShellProps> = ({ children, onClick, className = "" }) => {
  const [isHovered, setIsHovered] = useState(false)

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
      className={`w-full bg-white border border-gray-100 rounded-2xl shadow-md hover:shadow-lg transition-all duration-200 cursor-pointer flex flex-col overflow-hidden focus-ring ${className}`}
      style={{
        boxShadow: isHovered ? '0 12px 24px rgba(0,0,0,0.12)' : '0 2px 12px rgba(0,0,0,0.07)',
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={onClick}
      onKeyDown={handleKeyDown}
    >
      {children}
    </div>
  )
}
