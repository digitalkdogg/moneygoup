import { NextRequest } from 'next/server'

export async function GET(request: NextRequest, { params }: { params: { ticker: string } }) {
  const ticker = params.ticker.toUpperCase()

  try {
    const res = await fetch(`https://api.tiingo.com/iex/${ticker}?token=${process.env.TIINGO_API_KEY}`)
    if (res.ok) {
      const data = await res.json()
      return Response.json(data[0] || {})
    }
  } catch (error) {
    console.log('Tiingo failed, trying 12 Data', error)
  }

  try {
    const res = await fetch(`https://api.twelvedata.com/quote?symbol=${ticker}&apikey=${process.env.TWELVE_DATA_API_KEY}`)
    if (res.ok) {
      const data = await res.json()
      return Response.json(data)
    }
  } catch (error) {
    console.log('12 Data failed', error)
  }

  return Response.json({ error: 'Failed to fetch stock data' }, { status: 500 })
}