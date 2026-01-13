import { NextRequest } from 'next/server'

export async function GET(request: NextRequest, { params }: { params: { ticker: string } }) {
  const ticker = params.ticker.toUpperCase()
  const errors: string[] = []

  // Try Tiingo first
  try {
    const res = await fetch(`https://api.tiingo.com/iex/${ticker}?token=${process.env.TIINGO_API_KEY}`)
    if (res.ok) {
      const data = await res.json()
      return Response.json(data[0] || {})
    } else {
      const statusText = res.statusText || `HTTP ${res.status}`
      errors.push(`Tiingo API: ${statusText}`)
    }
  } catch (error) {
    errors.push(`Tiingo API: ${error instanceof Error ? error.message : 'Network error'}`)
  }

  // Try 12 Data if Tiingo fails
  try {
    const res = await fetch(`https://api.twelvedata.com/quote?symbol=${ticker}&apikey=${process.env.TWELVE_DATA_API_KEY}`)
    if (res.ok) {
      const data = await res.json()
      return Response.json(data)
    } else {
      const statusText = res.statusText || `HTTP ${res.status}`
      errors.push(`12Data API: ${statusText}`)
    }
  } catch (error) {
    errors.push(`12Data API: ${error instanceof Error ? error.message : 'Network error'}`)
  }

  // Both failed - return detailed error
  return Response.json(
    {
      error: 'Failed to fetch stock data from both providers',
      details: errors.join('; '),
      ticker: ticker,
      failedServices: ['Tiingo', '12Data']
    },
    { status: 500 }
  )
}