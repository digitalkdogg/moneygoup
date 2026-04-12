/**
 * Checks if the US stock market is currently open.
 * US Market Hours: 9:30 AM - 4:00 PM ET, Monday - Friday.
 * Note: Does not currently account for US market holidays.
 */
export function getMarketStatus(): { isOpen: boolean; message: string } {
  const now = new Date();
  
  // Format current time in New York
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false,
    weekday: 'short',
  });

  const parts = formatter.formatToParts(now);
  const timeMap: Record<string, string> = {};
  parts.forEach(part => {
    timeMap[part.type] = part.value;
  });

  const weekday = timeMap.weekday; // 'Mon', 'Tue', etc.
  const hour = parseInt(timeMap.hour);
  const minute = parseInt(timeMap.minute);

  // Weekends
  if (weekday === 'Sat' || weekday === 'Sun') {
    return { isOpen: false, message: 'Market Closed (Weekend)' };
  }

  const totalMinutes = hour * 60 + minute;
  const openMinutes = 9 * 60 + 30; // 09:30
  const closeMinutes = 16 * 60;    // 16:00

  if (totalMinutes < openMinutes) {
    return { isOpen: false, message: 'Market Closed (Pre-market)' };
  }

  if (totalMinutes >= closeMinutes) {
    return { isOpen: false, message: 'Market Closed (After-hours)' };
  }

  return { isOpen: true, message: 'Market Open' };
}
