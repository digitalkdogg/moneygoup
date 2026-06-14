import React from 'react'

interface BrandLogoProps {
  ticker: string
  logoSvg?: string | null
  brandColor?: string | null
  size?: number
  className?: string
}

// SVG markup comes from stock_brand.logo (admin-curated). Render inline so the
// embedded base64 <image> sizes correctly to the wrapper. If no logo, fall back
// to a colored tile with the ticker's first initial.
export const BrandLogo: React.FC<BrandLogoProps> = ({
  ticker,
  logoSvg,
  brandColor,
  size = 36,
  className = '',
}) => {
  if (logoSvg && logoSvg.trim().length > 0) {
    return (
      <div
        className={`rounded-lg overflow-hidden flex-shrink-0 [&>svg]:block ${className}`}
        aria-label={`${ticker} logo`}
        dangerouslySetInnerHTML={{ __html: logoSvg }}
      />
    )
  }

  const initial = (ticker || '?').charAt(0).toUpperCase()
  return (
    <div
      className={`rounded-lg flex items-center justify-center font-bold text-white flex-shrink-0 ${className}`}
      style={{
        width: size,
        height: size,
        backgroundColor: brandColor || '#017e3b',
        fontSize: Math.round(size * 0.5),
      }}
      aria-label={`${ticker} logo`}
    >
      {initial}
    </div>
  )
}
