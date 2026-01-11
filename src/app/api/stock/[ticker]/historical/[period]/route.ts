import { NextRequest } from 'next/server'

const getDays = (period: string): number => {
  switch (period) {
    case '1M': return 30
    case '6M': return 180
    case '1Y': return 365
    default: return 30
  }
}

export async function GET(request: NextRequest, { params }: { params: { ticker: string; period: string } }) {
  const ticker = params.ticker.toUpperCase()
  const period = params.period
  const days = getDays(period)
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

  try {
    const res = await fetch(`https://api.tiingo.com/tiingo/daily/${ticker}/prices?startDate=${startDate}&token=${process.env.TIINGO_API_KEY}`)
    if (res.ok) {
      const data = await res.json()
      return Response.json(data)
    }
  } catch (error) {
    console.log('Tiingo historical failed', error)
  }

  try {
    const res = await fetch(`https://api.twelvedata.com/time_series?symbol=${ticker}&interval=1day&start_date=${startDate}&apikey=${process.env.TWELVE_DATA_API_KEY}`)
    if (res.ok) {
      const data = await res.json()
      // 12 Data returns { meta, values }, values is array of { datetime, open, high, low, close, volume }
      return Response.json(data.values || [])
    }
  } catch (error) {
    console.log('12 Data historical failed', error)
  }

  return Response.json({ error: 'Failed to fetch historical data' }, { status: 500 })
}