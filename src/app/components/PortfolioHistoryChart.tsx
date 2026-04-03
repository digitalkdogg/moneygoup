'use client';

import React, { useState, useEffect } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';

type Period = '1w' | '1m' | '6m' | '1y';

interface ChartData {
    date: string;
    value: number;
}

const formatXAxis = (tickItem: string) => {
    const date = new Date(tickItem);
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

const formatYAxis = (tick: number) => {
    if (tick >= 1_000_000_000) return `$${(tick / 1_000_000_000).toFixed(1)}B`;
    if (tick >= 1_000_000) return `$${(tick / 1_000_000).toFixed(1)}M`;
    if (tick >= 1_000) return `$${(tick / 1_000).toFixed(0)}k`;
    return `$${tick.toFixed(0)}`;
};

const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
        const date = new Date(label);
        const formattedDate = !isNaN(date.getTime()) 
            ? date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
            : 'Invalid Date';
        const value = payload[0].value;

        return (
            <div className="p-4 bg-white rounded-lg shadow-lg border border-gray-200">
                <p className="font-bold text-gray-800">{formattedDate}</p>
                <p className="text-green-700">
                    Value: <span className="font-semibold">{new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value)}</span>
                </p>
            </div>
        );
    }
    return null;
};

export const PortfolioHistoryChart: React.FC = () => {
    const [data, setData] = useState<ChartData[]>([]);
    const [loading, setLoading] = useState(true);
    const [period, setPeriod] = useState<Period>('1w');
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const fetchData = async () => {
            setLoading(true);
            setError(null);
            try {
                const response = await fetch(`/api/user/portfolio/historical-value?period=${period}`);
                if (!response.ok) {
                    throw new Error('Failed to fetch historical data');
                }
                const result = await response.json();
                setData(result);
            } catch (err: any) {
                setError(err.message);
                setData([]);
            } finally {
                setLoading(false);
            }
        };

        fetchData();
    }, [period]);

    const periodOptions: { label: string; value: Period }[] = [
        { label: '1W', value: '1w' },
        { label: '1M', value: '1m' },
        { label: '6M', value: '6m' },
        { label: '1Y', value: '1y' },
    ];

    if (loading) {
        return (
            <div className="bg-white p-4 md:p-6 rounded-2xl shadow-lg mt-4 h-80 flex items-center justify-center">
                <div className="text-center">
                    <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-green-700"></div>
                    <p className="mt-2 text-gray-600">Loading portfolio history...</p>
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="bg-white p-4 md:p-6 rounded-2xl shadow-lg mt-4 h-80 flex items-center justify-center text-red-500">
                Error: {error}
            </div>
        );
    }

    const periodLabel = period === '1w' ? '1 Week' : period === '1m' ? '1 Month' : period === '6m' ? '6 Months' : '1 Year';

    return (
        <div className="bg-white p-4 md:p-6 mb-10 rounded-2xl shadow-lg hover:shadow-2xl transition-shadow duration-300 ease-in-out mt-4">
            <div className="flex justify-between items-center mb-4">
                <h2 className="text-xl md:text-2xl font-bold text-gray-800">
                    📈 Portfolio Value ({periodLabel})
                </h2>
                <div className="flex space-x-1 md:space-x-2 rounded-lg bg-gray-100 p-1">
                    {periodOptions.map(option => (
                        <button
                            key={option.value}
                            onClick={() => setPeriod(option.value)}
                            className={`px-3 py-1 text-sm font-semibold rounded-md transition-colors duration-200 cursor-pointer ${
                                period === option.value
                                    ? 'text-white shadow'
                                    : 'text-gray-600 hover:bg-gray-200'
                            }`}
                            style={period === option.value ? { backgroundColor: '#029b37' } : {}}
                        >
                            {option.label}
                        </button>
                    ))}
                </div>
            </div>

            {data.length === 0 ? (
                <div className="h-80 flex items-center justify-center">
                    <p className="text-lg text-gray-500">No portfolio history data available to display a chart.</p>
                </div>
            ) : (
                <div className="h-80 w-full">
                    {(() => {
                        const values = data.map(d => d.value);
                        const minValue = Math.min(...values);
                        const maxValue = Math.max(...values);
                        const range = maxValue - minValue || maxValue * 0.1; // Default 10% if no range
                        const padding = range * 0.1; // 10% padding on each side
                        const domain = [Math.max(0, minValue - padding), maxValue + padding];

                        return (
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
                                        domain={domain}
                                    />
                                    <Tooltip content={<CustomTooltip />} />
                                    <Legend iconType="circle" iconSize={8} />
                                    <Line
                                        type="monotone"
                                        dataKey="value"
                                        stroke="#16a34a"
                                        strokeWidth={2}
                                        dot={false}
                                        activeDot={{ r: 6, strokeWidth: 2, fill: '#fff' }}
                                        name="Portfolio Value"
                                    />
                                </LineChart>
                            </ResponsiveContainer>
                        );
                    })()}
                </div>
            )}
        </div>
    );
};
