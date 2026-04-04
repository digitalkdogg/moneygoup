'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createLogger } from '@/utils/logger';

const logger = createLogger('components/Search');

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
    fetch('/company_tickers.json')
      .then(res => res.json())
      .then(data => {
        const list: Ticker[] = data.map((item: any) => ({
          name: item.name,
          ticker: item.ticker
        }))
        setTickers(list)
      })
      .catch(err => logger.error('Failed to fetch tickers', err))
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
    <div className="w-full">
      <form onSubmit={handleSubmit} className="relative w-full">
        <input
          type="text"
          value={searchValue}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          placeholder="Search for a stock ticker or company name..."
          className="w-full p-4 text-lg border-2 border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-xl shadow-lg focus:outline-none focus:ring-4 focus:ring-green-300 focus:border-green-500 dark:focus:ring-green-400 dark:focus:border-green-400 transition duration-200"
        />
        {filteredTickers.length > 0 && (
          <ul className="absolute z-10 w-full bg-white dark:bg-gray-800 border-2 border-gray-300 dark:border-gray-600 rounded-xl shadow-xl mt-2 max-h-64 overflow-y-auto">
            {filteredTickers.map(t => (
              <li
                key={t.ticker}
                onClick={() => handleSelectTicker(t)}
                className="p-4 hover:bg-green-50 dark:hover:bg-gray-700 cursor-pointer border-b border-gray-200 dark:border-gray-700 last:border-b-0 transition duration-150"
              >
                <div className="font-semibold text-gray-800 dark:text-white">{t.ticker}</div>
                <div className="text-sm text-gray-600 dark:text-gray-400">{t.name}</div>
              </li>
            ))}
          </ul>
        )}
      </form>
    </div>
  )
}