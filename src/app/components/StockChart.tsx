
'use client';

import { useState, useEffect } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import ApiErrorDisplay from './ApiErrorDisplay';

interface HistoricalData {
  date: string;
  close: number;
}

interface StockChartProps {
  ticker: string;
}

type Period = '1w' | '1m' | '6m' | '1y';

export default function StockChart({ ticker }: StockChartProps) {
  const [data, setData] = useState<HistoricalData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>('1m');

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/stock/${ticker}/historical/${period}`);
        if (!res.ok) {
          const errorData = await res.json();
          throw new Error(errorData.error || `Failed to fetch ${period} historical data`);
        }
        const jsonData: HistoricalData[] = await res.json();
        
        // Sort data just in case the API doesn't guarantee order
        const sortedData = jsonData.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
        
        setData(sortedData);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An unknown error occurred');
      } finally {
        setLoading(false);
      }
    };

    if (ticker) {
      fetchData();
    }
  }, [ticker, period]);

  const handlePeriodChange = (newPeriod: Period) => {
    setPeriod(newPeriod);
  };

  const formatXAxis = (tickItem: string) => {
    // Show month and day
    const date = new Date(tickItem);
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };
  
  const formatYAxis = (tickItem: number) => {
    return `$${tickItem.toFixed(2)}`;
  };

  return (
    <div className="bg-white p-4 md:p-6 rounded-2xl shadow-lg hover:shadow-2xl transition-shadow duration-300 ease-in-out">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl md:text-2xl font-bold text-gray-800">
          Price History ({period.replace('w', ' Week').replace('m', ' Month').replace('y', ' Year')})
        </h2>
        <div className="flex space-x-1 md:space-x-2 rounded-lg bg-gray-100 p-1">
          {(['1w', '1m', '6m', '1y'] as Period[]).map((p) => (
            <button
              key={p}
              onClick={() => handlePeriodChange(p)}
              className={`px-3 py-1 text-sm font-semibold rounded-md transition-colors duration-200 ${
                period === p
                  ? 'bg-blue-600 text-white shadow'
                  : 'text-gray-600 hover:bg-gray-200'
              }`}
            >
              {p.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center h-80">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
          <p className="ml-4 text-lg text-gray-500">Loading Chart Data...</p>
        </div>
      )}

      {error && (
         <div className="h-80 flex items-center justify-center">
            <ApiErrorDisplay error={error} />
         </div>
      )}

      {!loading && !error && data.length > 0 && (
        <div className="h-80 w-full">
            <ResponsiveContainer width="100%" height="100%">
            <LineChart
                data={data}
                margin={{
                top: 5, right: 30, left: 20, bottom: 5,
                }}
            >
                <CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" />
                <XAxis 
                    dataKey="date" 
                    tickFormatter={formatXAxis} 
                    dy={10}
                    tick={{ fill: '#6b7280', fontSize: 12 }}
                    axisLine={{ stroke: '#d1d5db' }}
                    tickLine={{ stroke: '#d1d5db' }}
                />
                <YAxis 
                    tickFormatter={formatYAxis}
                    dx={-10}
                    tick={{ fill: '#6b7280', fontSize: 12 }}
                    axisLine={{ stroke: '#d1d5db' }}
                    tickLine={{ stroke: '#d1d5db' }}
                    domain={['dataMin', 'dataMax']}
                />
                <Tooltip
                    contentStyle={{ 
                        backgroundColor: 'rgba(255, 255, 255, 0.9)', 
                        border: '1px solid #e0e0e0', 
                        borderRadius: '0.5rem',
                        boxShadow: '0 4px 12px rgba(0,0,0,0.1)'
                    }}
                    labelStyle={{ fontWeight: 'bold', color: '#374151' }}
                    formatter={(value: number) => [`$${value.toFixed(2)}`, 'Price']}
                    labelFormatter={(label: string) => new Date(label).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}
                />
                <Legend iconType="circle" iconSize={8} />
                <Line 
                    type="monotone" 
                    dataKey="close" 
                    stroke="#3b82f6" 
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 6, strokeWidth: 2, fill: '#fff' }}
                    name="Closing Price"
                />
            </LineChart>
            </ResponsiveContainer>
        </div>
      )}

      {!loading && !error && data.length === 0 && (
        <div className="h-80 flex items-center justify-center">
          <p className="text-lg text-gray-500">No historical data available for this period.</p>
        </div>
      )}
    </div>
  );
}
