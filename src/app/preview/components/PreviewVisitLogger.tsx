'use client';

import { useEffect } from 'react';

/**
 * Client-side component to log preview page visits
 * Uses useEffect to log visit once on mount
 * Non-blocking: fires async request and doesn't wait for response
 */
export default function PreviewVisitLogger() {
  useEffect(() => {
    // Log visit asynchronously (fire and forget)
    const logVisit = async () => {
      try {
        await fetch('/api/preview/visit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // No body needed - IP extracted from headers server-side
        });
      } catch (error) {
        // Silently fail - don't disrupt page if logging fails
        console.debug('Visit logging failed:', error);
      }
    };

    logVisit();
  }, []); // Empty dependency array - log once on mount

  // Component renders nothing
  return null;
}
