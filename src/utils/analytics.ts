/**
 * Simple analytics event tracking utility
 * Non-blocking, fires events to console in development
 */

export interface AnalyticsEvent {
  name: string
  properties?: Record<string, any>
}

export function trackEvent(event: AnalyticsEvent) {
  // Non-blocking - wrap in async
  if (typeof window !== 'undefined') {
    Promise.resolve().then(() => {
      try {
        // Log to console in development
        if (process.env.NODE_ENV === 'development') {
          console.debug(`[Analytics] ${event.name}`, event.properties || {})
        }

        // TODO: Send to analytics provider (Mixpanel, Segment, GA4, etc.)
        // Example:
        // if (window.gtag) {
        //   window.gtag('event', event.name, event.properties)
        // }
      } catch (error) {
        // Silently fail - don't break user experience
        console.error('[Analytics] Error tracking event:', error)
      }
    })
  }
}

export function trackSectorClick(sectorSlug: string) {
  trackEvent({
    name: 'sector_click',
    properties: { sector: sectorSlug }
  })
}

export function trackTrendingStockClick(symbol: string, trendScore: number | null) {
  trackEvent({
    name: 'trending_stock_click',
    properties: { symbol, trendScore }
  })
}

export function trackIndexCardClick(symbol: string) {
  trackEvent({
    name: 'index_card_click',
    properties: { symbol }
  })
}
