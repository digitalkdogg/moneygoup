
'use client';

import { useState, useEffect } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import ApiErrorDisplay, { ApiError } from './ApiErrorDisplay';

interface HistoricalData {
  date: string;
  datetime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  adjOpen: number;
  adjHigh: number;
  adjLow: number;
  adjClose: number;
  adjVolume: number;
}

interface StockChartProps {
  ticker: string;
  historicalData: HistoricalData[] | null;
}

type Period = '1w' | '1m' | '6m' | '1y';

export default function StockChart({ ticker, historicalData }: StockChartProps) {
  const [filteredData, setFilteredData] = useState<HistoricalData[]>([]);
  const [period, setPeriod] = useState<Period>('1m');

  useEffect(() => {
    if (!historicalData || historicalData.length === 0) {
      setFilteredData([]);
      return;
    }

    const today = new Date();
    let startDate: Date;

    switch (period) {
      case '1w':
        startDate = new Date(today.setDate(today.getDate() - 7));
        break;
      case '1m':
        startDate = new Date(today.setMonth(today.getMonth() - 1));
        break;
      case '6m':
        startDate = new Date(today.setMonth(today.getMonth() - 6));
        break;
      case '1y':
        startDate = new Date(today.setFullYear(today.getFullYear() - 1));
        break;
      default:
        startDate = new Date(today.setFullYear(today.getFullYear() - 1)); // Default to 1 year
    }

    // Filter and sort the data
    const newFilteredData = historicalData
      .filter(item => new Date(item.date) >= startDate)
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    setFilteredData(newFilteredData);
  }, [historicalData, period]);

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

      {(!filteredData || filteredData.length === 0) && (
        <div className="h-80 flex items-center justify-center">
          <p className="text-lg text-gray-500">No historical data available for this period.</p>
        </div>
      )}

      {filteredData && filteredData.length > 0 && (
        <div className="h-80 w-full">
            <ResponsiveContainer width="100%" height="100%">
            <LineChart
                data={filteredData}
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
                    formatter={(value: number | undefined) => [typeof value === 'number' ? `$${value.toFixed(2)}` : 'N/A', 'Price']}
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

      {filteredData && filteredData.length === 0 && (
        <div className="h-80 flex items-center justify-center">
          <p className="text-lg text-gray-500">No historical data available for this period.</p>
        </div>
      )}
    </div>
  );
}
