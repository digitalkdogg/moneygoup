'use client'

import { useEffect, useState } from 'react'
import WatchlistTable, { type WatchlistItem } from './WatchlistTable'

export default function WatchlistTableSection() {
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([])
  const [horizonLabel, setHorizonLabel] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/user/watchlist')
      .then(r => r.json())
      .then(d => {
        setWatchlist(d.watchlist ?? [])
        setHorizonLabel(d.horizonLabel ?? '')
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  return (
    <WatchlistTable
      watchlist={watchlist}
      horizonLabel={horizonLabel}
      loading={loading}
    />
  )
}
