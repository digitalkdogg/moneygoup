'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'

interface EarningsEntry {
  symbol: string
  name: string
  time?: string
  gps_score?: number | null
}

interface DayEarnings {
  date: string
  label: string
  entries: EarningsEntry[]
}

// Deterministic color from ticker initials
const AVATAR_COLORS = [
  '#0f766e', '#0369a1', '#7c3aed', '#b45309', '#15803d',
  '#be123c', '#1d4ed8', '#a16207', '#6d28d9', '#0e7490',
  '#c2410c', '#4338ca', '#047857', '#9333ea', '#b91c1c',
]

function avatarColor(symbol: string): string {
  let h = 0
  for (let i = 0; i < symbol.length; i++) h = (h * 31 + symbol.charCodeAt(i)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}

function initials(symbol: string): string {
  return symbol.slice(0, 2).toUpperCase()
}

function Avatar({ symbol, size = 'md' }: { symbol: string; size?: 'sm' | 'md' }) {
  const cls = size === 'sm'
    ? 'w-8 h-8 text-[10px]'
    : 'w-9 h-9 text-[11px]'
  return (
    <div
      className={`${cls} rounded-full flex items-center justify-center flex-shrink-0 font-bold text-white`}
      style={{ backgroundColor: avatarColor(symbol) }}
    >
      {initials(symbol)}
    </div>
  )
}

function TimeTag({ time }: { time?: string }) {
  if (!time || time === 'time-not-supplied') return null
  if (time === 'time-pre-market')
    return (
      <span className="text-[10px] font-semibold text-orange-600 bg-orange-50 border border-orange-200 rounded px-1.5 py-0.5 leading-none flex-shrink-0">
        PRE
      </span>
    )
  if (time === 'time-after-hours')
    return (
      <span className="text-[10px] font-semibold text-violet-600 bg-violet-50 border border-violet-200 rounded px-1.5 py-0.5 leading-none flex-shrink-0">
        AH
      </span>
    )
  return null
}

function PreAHBar({ entries }: { entries: EarningsEntry[] }) {
  const pre = entries.filter((e) => e.time === 'time-pre-market').length
  const ah  = entries.filter((e) => e.time === 'time-after-hours').length
  const total = pre + ah || 1
  const preW = Math.round((pre / total) * 100)
  const ahW  = 100 - preW

  return (
    <div className="mb-3">
      <div className="flex h-1.5 rounded-full overflow-hidden mb-1.5">
        <div className="bg-orange-400 transition-all" style={{ width: `${preW}%` }} />
        <div className="bg-green-500 transition-all" style={{ width: `${ahW}%` }} />
      </div>
      <div className="flex justify-between text-[10px] text-gray-400">
        <span>{pre} pre-market</span>
        <span>{ah} after-hours</span>
      </div>
    </div>
  )
}

function timeOrder(time?: string): number {
  if (time === 'time-pre-market')  return 1
  if (time === 'time-after-hours') return 3
  return 2
}

// Card sort: GPS-scored tickers first (desc by score), then PRE, then unsupplied, then AH.
function sortEntries(entries: EarningsEntry[]): EarningsEntry[] {
  return [...entries].sort((a, b) => {
    const aHasGps = a.gps_score != null
    const bHasGps = b.gps_score != null
    if (aHasGps !== bHasGps) return aHasGps ? -1 : 1
    if (aHasGps && bHasGps) return (b.gps_score as number) - (a.gps_score as number)
    return timeOrder(a.time) - timeOrder(b.time)
  })
}

// ── Modal ────────────────────────────────────────────────────────────────────

function DayModal({ day, isToday, onClose }: { day: DayEarnings; isToday: boolean; onClose: () => void }) {
  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  // Prevent body scroll while open
  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [])

  const pre = day.entries.filter((e) => e.time === 'time-pre-market').length
  const ah  = day.entries.filter((e) => e.time === 'time-after-hours').length

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />

      {/* Panel */}
      <div
        className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 pt-5 pb-4 border-b border-gray-100">
          <div className="flex items-center justify-between mb-0.5">
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-bold text-gray-900">{day.label}</h3>
              {isToday && (
                <span className="text-[10px] font-bold text-white bg-[#16a34a] rounded-full px-2 py-0.5 leading-none">
                  TODAY
                </span>
              )}
            </div>
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-full flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <p className="text-sm text-gray-400">
            {day.entries.length} {day.entries.length === 1 ? 'company' : 'companies'} reporting
            {pre > 0 && ah > 0 && ` · ${pre} pre-market, ${ah} after-hours`}
            {pre > 0 && ah === 0 && ` · ${pre} pre-market`}
            {ah > 0 && pre === 0 && ` · ${ah} after-hours`}
          </p>
        </div>

        {/* Scrollable list */}
        <div className="overflow-y-auto flex-1 px-6 py-4">
          <ul className="space-y-1">
            {sortEntries(day.entries).map((e) => (
              <li key={e.symbol}>
                <Link
                  href={`/search/${e.symbol}`}
                  onClick={onClose}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-xl group hover:bg-gray-50 transition-colors"
                >
                  <Avatar symbol={e.symbol} size="sm" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold text-gray-900 group-hover:text-[#16a34a] leading-tight transition-colors">
                      {e.symbol}
                    </p>
                    <p className="text-[11px] text-gray-400 truncate leading-tight">{e.name}</p>
                  </div>
                  <TimeTag time={e.time} />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}

// ── Card ─────────────────────────────────────────────────────────────────────

const PREVIEW_COUNT = 4

function DayCard({ day, isToday }: { day: DayEarnings; isToday: boolean }) {
  const [modalOpen, setModalOpen] = useState(false)
  const sorted   = sortEntries(day.entries)
  const preview  = sorted.slice(0, PREVIEW_COUNT)
  const overflow = day.entries.length - PREVIEW_COUNT

  const openModal  = useCallback(() => setModalOpen(true),  [])
  const closeModal = useCallback(() => setModalOpen(false), [])

  return (
    <>
      <div
        className={`bg-white rounded-2xl border p-5 flex flex-col ${
          isToday ? 'border-[#16a34a] shadow-sm' : 'border-gray-200'
        }`}
      >
        {/* Day header */}
        <div className="mb-1 flex items-center gap-2">
          <span className="text-base font-bold text-gray-900">{day.label}</span>
          {isToday && (
            <span className="text-[10px] font-bold text-white bg-[#16a34a] rounded-full px-2 py-0.5 leading-none">
              TODAY
            </span>
          )}
        </div>
        <p className="text-xs text-gray-400 mb-3">
          {day.entries.length} {day.entries.length === 1 ? 'company' : 'companies'} reporting
        </p>

        {day.entries.length > 0 && <PreAHBar entries={day.entries} />}

        {day.entries.length === 0 ? (
          <p className="text-xs text-gray-400 italic mt-1">No reports</p>
        ) : (
          <>
            <ul className="space-y-2.5 flex-1">
              {preview.map((e) => (
              <li key={e.symbol}>
                  <Link href={`/search/${e.symbol}`} className="flex items-center gap-2.5 group">
                    <Avatar symbol={e.symbol} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold text-gray-900 group-hover:text-[#16a34a] leading-tight transition-colors">
                        {e.symbol}
                      </p>
                      <p className="text-[11px] text-gray-400 truncate leading-tight">{e.name}</p>
                    </div>
                    <TimeTag time={e.time} />
                  </Link>
                </li>
              ))}
            </ul>

            {overflow > 0 && (
              <div className="mt-4 pt-3 border-t border-gray-100">
                <button
                  onClick={openModal}
                  className="text-sm font-semibold text-[#16a34a] hover:text-[#15803d] flex items-center gap-1 transition-colors"
                >
                  +{overflow} more {overflow === 1 ? 'company' : 'companies'}
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {modalOpen && <DayModal day={day} isToday={isToday} onClose={closeModal} />}
    </>
  )
}

// ── Skeleton ─────────────────────────────────────────────────────────────────

function SkeletonCard() {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-5 animate-pulse">
      <div className="h-4 bg-gray-200 rounded w-28 mb-2" />
      <div className="h-3 bg-gray-100 rounded w-20 mb-4" />
      <div className="h-1.5 bg-gray-200 rounded-full mb-4" />
      {[1, 2, 3, 4].map((n) => (
        <div key={n} className="flex items-center gap-2.5 mb-3">
          <div className="w-9 h-9 rounded-full bg-gray-200 flex-shrink-0" />
          <div className="flex-1">
            <div className="h-3 bg-gray-200 rounded w-12 mb-1" />
            <div className="h-2.5 bg-gray-100 rounded w-24" />
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Timeline ─────────────────────────────────────────────────────────────────

function TimelineDots({ count, activeIndex }: { count: number; activeIndex: number }) {
  return (
    <div className="flex items-center gap-0 mb-6">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex items-center">
          <div
            className={`w-2.5 h-2.5 rounded-full transition-colors ${
              i === activeIndex ? 'bg-[#16a34a]' : 'bg-gray-300'
            }`}
          />
          {i < count - 1 && <div className="w-16 h-px bg-gray-200" />}
        </div>
      ))}
    </div>
  )
}

// ── Root ─────────────────────────────────────────────────────────────────────

export default function EarningsCalendar() {
  const [days, setDays] = useState<DayEarnings[] | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    fetch('/api/earnings-calendar')
      .then((r) => r.json())
      .then((d) => setDays(d.days ?? []))
      .catch(() => setError(true))
  }, [])

  if (error) return null

  const todayIso = new Date().toISOString().slice(0, 10)
  const totalReporting = days ? days.reduce((s, d) => s + d.entries.length, 0) : null
  const activeIndex = days ? days.findIndex((d) => d.date === todayIso) : 0

  return (
    <div>
      {/* Header */}
      <div className="flex items-start justify-between mb-1">
        <div>
          <p className="text-xs font-semibold text-[#16a34a] tracking-widest uppercase mb-1">
            DeepMoney · Market Intelligence
          </p>
          <h2 className="text-3xl font-extrabold text-gray-900 leading-tight">
            Earnings This Week
          </h2>
          <p className="text-sm text-gray-400 mt-1">
            {totalReporting !== null
              ? `${totalReporting.toLocaleString()} companies reporting across the next 5 trading days`
              : 'Loading earnings data…'}
          </p>
        </div>

        <div className="flex items-center gap-4 text-xs text-gray-500 mt-1 flex-shrink-0">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-orange-400 inline-block" />
            Pre-market
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-violet-500 inline-block" />
            After-hours
          </span>
        </div>
      </div>

      

      <div className="grid grid-cols-1 md:grid-cols-6 gap-4 mt-5">
        {days === null ? (
          <>
            {[0, 1, 2].map((i) => <div key={i} className="md:col-span-2"><SkeletonCard /></div>)}
            {[3, 4].map((i, j) => <div key={i} className={`md:col-span-2${j === 0 ? ' md:col-start-2' : ''}`}><SkeletonCard /></div>)}
          </>
        ) : (
          days.map((day, i) => (
            <div key={day.date} className={`md:col-span-2${i === 3 ? ' md:col-start-2' : ''}`}>
              <DayCard day={day} isToday={day.date === todayIso} />
            </div>
          ))
        )}
      </div>
    </div>
  )
}
