import { NextResponse } from 'next/server'
import { executeRawQuery } from '@/utils/databaseHelper'

export const runtime = 'nodejs'

interface EarningsEntry {
  symbol: string
  name: string
  time?: string // 'time-pre-market' | 'time-after-hours' | 'time-not-supplied'
  gps_score?: number | null
}

interface DayEarnings {
  date: string        // YYYY-MM-DD
  label: string       // "Mon Jul 21"
  entries: EarningsEntry[]
}

// Shared stop-list for obvious non-ticker tokens that appear in news/headlines
const TICKER_STOPLIST = new Set([
  'A', 'I', 'THE', 'AND', 'OR', 'IN', 'AT', 'BY', 'FOR', 'ON', 'OF', 'TO',
  'UP', 'AS', 'IS', 'IT', 'BE', 'DO', 'NO', 'SO', 'IF', 'AN', 'AM', 'US',
  'CEO', 'CFO', 'COO', 'IPO', 'ETF', 'GDP', 'CPI', 'PPI', 'AI', 'EPS',
  'SEC', 'FTC', 'DOJ', 'FDA', 'FED', 'IMF', 'ECB', 'ESG', 'LLC', 'LTD',
  'INC', 'CORP', 'PLC', 'NYSE', 'REIT', 'DJI', 'SPX', 'NDX', 'VIX',
])

// Cache: [payload, expires_at_ms]
let _cache: [DayEarnings[], number] | null = null
const CACHE_TTL_MS = 6 * 60 * 60 * 1000 // 6 hours

function getNextBusinessDates(count: number): { iso: string; label: string }[] {
  const days: { iso: string; label: string }[] = []
  const cursor = new Date()
  // Start from today
  while (days.length < count) {
    const dow = cursor.getUTCDay()
    if (dow !== 0 && dow !== 6) {
      const iso = cursor.toISOString().slice(0, 10)
      const label = cursor.toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      })
      days.push({ iso, label })
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return days
}

async function fetchNasdaqDay(date: string): Promise<EarningsEntry[]> {
  const res = await fetch(
    `https://api.nasdaq.com/api/calendar/earnings?date=${date}`,
    {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    },
  )
  if (!res.ok) return []
  const json = await res.json()
  const rows: any[] = json?.data?.rows ?? []
  const entries: EarningsEntry[] = []
  for (const row of rows) {
    const symbol = String(row?.symbol || '').toUpperCase().trim()
    if (!symbol || TICKER_STOPLIST.has(symbol)) continue
    entries.push({
      symbol,
      name: String(row?.name || '').trim() || symbol,
      time: row?.time ?? undefined,
    })
  }
  return entries
}

async function fetchGpsScores(symbols: string[]): Promise<Map<string, number>> {
  if (symbols.length === 0) return new Map()
  try {
    const placeholders = symbols.map(() => '?').join(',')
    const [rows] = await executeRawQuery(
      `SELECT s.symbol, sgs.gps_score
       FROM stock_gps_scores sgs
       JOIN stocks s ON s.id = sgs.stock_id
       WHERE s.symbol IN (${placeholders})`,
      symbols,
    )
    return new Map(
      (rows as any[]).map((r: any) => [r.symbol as string, r.gps_score as number])
    )
  } catch {
    return new Map()
  }
}

export async function GET() {
  const now = Date.now()
  if (_cache && now < _cache[1]) {
    return NextResponse.json({ days: _cache[0] })
  }

  const businessDays = getNextBusinessDates(5)

  const settled = await Promise.allSettled(
    businessDays.map((d) => fetchNasdaqDay(d.iso)),
  )

  const days: DayEarnings[] = businessDays.map(({ iso, label }, i) => ({
    date: iso,
    label,
    entries: settled[i].status === 'fulfilled' ? settled[i].value : [],
  }))

  // Attach GPS scores for any tickers we have in our DB
  const allSymbols = Array.from(new Set(days.flatMap((d) => d.entries.map((e) => e.symbol))))
  const gpsMap = await fetchGpsScores(allSymbols)
  for (const day of days) {
    for (const entry of day.entries) {
      const score = gpsMap.get(entry.symbol)
      entry.gps_score = score !== undefined ? score : null
    }
  }

  _cache = [days, now + CACHE_TTL_MS]
  return NextResponse.json({ days })
}
