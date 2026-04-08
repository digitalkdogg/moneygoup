import React, { useState } from 'react'

interface BaseCardShellProps {
  children: React.ReactNode
  onClick?: () => void
  className?: string
}

export const BaseCardShell: React.FC<BaseCardShellProps> = ({ children, onClick, className = "" }) => {
  const [isHovered, setIsHovered] = useState(false)

  return (
    <div
      className={`w-full bg-[#fbf9fa] border border-gray-200 rounded-2xl shadow-md hover:shadow-lg hover:-translate-y-1 transition-all duration-200 cursor-pointer flex flex-col h-full ${className}`}
      style={{
        boxShadow: isHovered ? '0 12px 24px rgba(0,0,0,0.12)' : '0 2px 12px rgba(0,0,0,0.07)',
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={onClick}
    >
      {children}
    </div>
  )
}
