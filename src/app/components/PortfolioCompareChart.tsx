'use client'

import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer,
} from 'recharts'

type Period = '1m' | '6m' | '1y' | 'all'

interface ChartPoint { date: string; value: number }

export interface OverlaySeries {
  ticker: string
  data: ChartPoint[]
  color: string
}

interface Props {
  period: Period
  onPeriodChange: (p: Period) => void
  baseData: ChartPoint[]
  overlays: OverlaySeries[]
  normalized: boolean
  onNormalizedChange: (v: boolean) => void
  loading: boolean
}

const PERIODS: { label: string; value: Period }[] = [
  { label: '1M', value: '1m' },
  { label: '6M', value: '6m' },
  { label: '1Y', value: '1y' },
  { label: 'All', value: 'all' },
]

function mergeData(
  base: ChartPoint[],
  overlays: OverlaySeries[],
  normalized: boolean,
): Record<string, any>[] {
  const map = new Map<string, Record<string, number>>()

  for (const pt of base) {
    map.set(pt.date, { portfolio: pt.value })
  }
  for (const ov of overlays) {
    for (const pt of ov.data) {
      const row = map.get(pt.date) ?? {}
      row[ov.ticker] = pt.value
      map.set(pt.date, row)
    }
  }

  const sorted = Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, vals]) => ({ date, ...vals }))

  if (!normalized || sorted.length === 0) return sorted

  // Index each series to 100 at its first data point
  const first: Record<string, number> = {}
  for (const row of sorted) {
    for (const [k, v] of Object.entries(row)) {
      if (k === 'date') continue
      const n = v as unknown as number
      if (!(k in first) && n > 0) first[k] = n
    }
  }

  return sorted.map(row => {
    const out: Record<string, any> = { date: row.date }
    for (const [k, v] of Object.entries(row)) {
      if (k === 'date') continue
      const n = v as unknown as number
      out[k] = first[k] > 0 ? (n / first[k]) * 100 : undefined
      out[`_raw_${k}`] = n  // preserve dollar value for tooltip
    }
    return out
  })
}

function fmtXAxis(dateStr: string) {
  return new Date(dateStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function fmtYAxis(val: number, normalized: boolean) {
  if (normalized) {
    const pct = val - 100
    return `${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%`
  }
  if (val >= 1_000_000) return `$${(val / 1_000_000).toFixed(1)}M`
  if (val >= 1_000) return `$${(val / 1_000).toFixed(0)}k`
  return `$${val.toFixed(0)}`
}

function CustomTooltip({ active, payload, label, normalized }: any) {
  if (!active || !payload?.length) return null
  const date = new Date(label)
  const dateStr = isNaN(date.getTime())
    ? label
    : date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })

  return (
    <div className="p-3 bg-white rounded-xl shadow-lg border border-gray-200 text-sm min-w-[160px]">
      <p className="font-semibold text-gray-700 mb-2">{dateStr}</p>
      {payload.map((entry: any) => (
        <div key={entry.dataKey} className="flex justify-between gap-4 mb-1">
          <span style={{ color: entry.color }} className="font-medium">{entry.name}</span>
          <span className="text-gray-800 font-semibold text-right">
            {normalized ? (() => {
              const p = (entry.value as number) - 100
              const raw: number | undefined = entry.payload[`_raw_${entry.dataKey}`]
              const pctStr = `${p >= 0 ? '+' : ''}${p.toFixed(1)}%`
              const valStr = raw != null
                ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(raw)
                : null
              return (
                <span className="flex flex-col items-end leading-tight">
                  <span>{pctStr}</span>
                  {valStr && <span className="text-xs text-gray-400 font-normal">{valStr}</span>}
                </span>
              )
            })() : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(entry.value)}
          </span>
        </div>
      ))}
      {normalized && (
        <p className="text-xs text-gray-400 mt-2 border-t border-gray-100 pt-1">% change from period start</p>
      )}
    </div>
  )
}

export default function PortfolioCompareChart({
  period, onPeriodChange,
  baseData, overlays,
  normalized, onNormalizedChange,
  loading,
}: Props) {
  const merged = mergeData(baseData, overlays, normalized)
  const hasOverlays = overlays.length > 0

  // When overlays are active, scope the domain to overlay data only so the
  // axis zooms in on the compared holdings rather than the portfolio total.
  const domainValues = merged.flatMap(row =>
    Object.entries(row)
      .filter(([k]) => k !== 'date' && !(hasOverlays && k === 'portfolio'))
      .map(([, v]) => v as unknown as number)
      .filter(v => v != null && v > 0)
  )
  const minV = domainValues.length ? Math.min(...domainValues) : 0
  const maxV = domainValues.length ? Math.max(...domainValues) : 100
  const pad = (maxV - minV) * 0.05 || maxV * 0.05
  const domain: [number, number] = [Math.max(0, minV - pad), maxV + pad]

  return (
    <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-5 flex flex-col h-full min-h-[480px]">
      {/* Chart header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <h2 className="text-lg font-bold text-gray-800">Performance Chart</h2>
        <div className="flex items-center gap-3 flex-wrap">
          {/* Normalization toggle */}
          <div className="flex rounded-lg bg-gray-100 p-0.5 text-xs">
            <button
              onClick={() => onNormalizedChange(false)}
              className={`px-3 py-1 rounded-md transition-colors ${!normalized ? 'bg-white text-gray-800 shadow' : 'text-gray-500 hover:text-gray-700'}`}
            >
              $ Absolute
            </button>
            <button
              onClick={() => onNormalizedChange(true)}
              className={`px-3 py-1 rounded-md transition-colors ${normalized ? 'bg-white text-gray-800 shadow' : 'text-gray-500 hover:text-gray-700'}`}
            >
              % Change
            </button>
          </div>
          {/* Period tabs */}
          <div className="flex rounded-lg bg-gray-100 p-0.5">
            {PERIODS.map(p => (
              <button
                key={p.value}
                onClick={() => onPeriodChange(p.value)}
                className={`px-3 py-1 rounded-md xs transition-colors ${
                  period === p.value ? 'text-white shadow' : 'text-gray-600 hover:bg-gray-200'
                }`}
                style={period === p.value ? { backgroundColor: '#017e3b' } : {}}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-green-700 mb-2" />
            <p className="text-gray-500 text-sm">Loading chart data...</p>
          </div>
        </div>
      ) : merged.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-gray-400">No history data available for this period.</p>
        </div>
      ) : (
        <div className="flex-1 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={merged} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" />
              <XAxis
                dataKey="date"
                tickFormatter={fmtXAxis}
                dy={8}
                tick={{ fill: '#6b7280', fontSize: 11 }}
                axisLine={{ stroke: '#d1d5db' }}
                tickLine={false}
                minTickGap={40}
              />
              <YAxis
                tickFormatter={v => fmtYAxis(v, normalized)}
                dx={-4}
                tick={{ fill: '#6b7280', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                domain={normalized ? ['auto', 'auto'] : domain}
                width={normalized ? 40 : 70}
              />
              <Tooltip content={<CustomTooltip normalized={normalized} />} />
              <Legend
                iconType="circle"
                iconSize={8}
                wrapperStyle={{ fontSize: 12, paddingTop: 8 }}
              />
              {!hasOverlays && (
                <Line
                  type="monotone"
                  dataKey="portfolio"
                  name="Portfolio"
                  stroke="#017e3b"
                  strokeWidth={2.5}
                  dot={false}
                  activeDot={{ r: 5, strokeWidth: 2, fill: '#fff', stroke: '#017e3b' }}
                />
              )}
              {overlays.map(ov => (
                <Line
                  key={ov.ticker}
                  type="monotone"
                  dataKey={ov.ticker}
                  name={ov.ticker}
                  stroke={ov.color}
                  strokeWidth={2}
                  dot={false}
                  strokeDasharray="5 3"
                  activeDot={{ r: 5, strokeWidth: 2, fill: '#fff', stroke: ov.color }}
                  connectNulls
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {overlays.length > 0 && !normalized && (
        <p className="text-xs text-gray-400 mt-3 text-center">
          Tip: switch to <strong>Indexed</strong> mode to fairly compare growth rates across positions.
        </p>
      )}
    </div>
  )
}
