'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'

interface Ticker {
  name: string
  ticker: string
}

export default function Search() {
  const [tickers, setTickers] = useState<Ticker[]>([])
  const [searchValue, setSearchValue] = useState('')
  const [filteredTickers, setFilteredTickers] = useState<Ticker[]>([])
  const router = useRouter()

  // Load ticker list on mount from API (fetches from SEC)
  useEffect(() => {
    fetch('/api/tickers')
      .then(res => res.json())
      .then(data => {
        const list: Ticker[] = data.map((item: any) => ({
          name: item.name,
          ticker: item.ticker
        }))
        setTickers(list)
      })
      .catch(err => console.error('Failed to fetch tickers', err))
  }, [])

  // Filter tickers as user types
  useEffect(() => {
    if (searchValue) {
      const filtered = tickers.filter(t =>
        t.ticker.toLowerCase().includes(searchValue.toLowerCase()) ||
        t.name.toLowerCase().includes(searchValue.toLowerCase())
      ).slice(0, 200)
      setFilteredTickers(filtered)
    } else {
      setFilteredTickers([])
    }
  }, [searchValue, tickers])

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchValue(e.target.value)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      const ticker = searchValue.toUpperCase()
      if(ticker) {
        router.push(`/search/${ticker}`)
      }
    }
  }

  const handleSelectTicker = (ticker: Ticker) => {
    router.push(`/search/${ticker.ticker}`)
  }

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if(searchValue) {
      router.push(`/search/${searchValue.toUpperCase()}`);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4">
      <div className="max-w-6xl mx-auto">
        <header className="text-center mb-12">
          <h2 className="text-4xl font-bold text-gray-800 mb-4">Stock Search</h2>
          <p className="text-lg text-gray-600">Track your favorite stocks in real-time</p>
        </header>

        {/* Search Input */}
        <form onSubmit={handleSubmit} className="mb-12 relative">
          <input
            type="text"
            value={searchValue}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder="Search for a stock ticker or company name..."
            className="w-full p-4 text-lg border-2 border-gray-300 rounded-xl shadow-lg focus:outline-none focus:ring-4 focus:ring-blue-300 focus:border-blue-500 transition duration-200"
          />
          {filteredTickers.length > 0 && (
            <ul className="absolute z-10 w-full bg-white border-2 border-gray-300 rounded-xl shadow-xl mt-2 max-h-64 overflow-y-auto">
              {filteredTickers.map(t => (
                <li
                  key={t.ticker}
                  onClick={() => handleSelectTicker(t)}
                  className="p-4 hover:bg-blue-50 cursor-pointer border-b border-gray-200 last:border-b-0 transition duration-150"
                >
                  <div className="font-semibold text-gray-800">{t.ticker}</div>
                  <div className="text-sm text-gray-600">{t.name}</div>
                </li>
              ))}
            </ul>
          )}
        </form>
      </div>
    </div>
  )
}