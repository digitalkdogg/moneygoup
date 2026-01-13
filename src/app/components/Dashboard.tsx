// src/app/components/Dashboard.tsx
'use client';

import { useState, useEffect } from 'react';

interface StockDashboardData {
  symbol: string;
  companyName: string;
  date: string | null;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
}

export default function Dashboard() {
  const [data, setData] = useState<StockDashboardData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchData() {
      try {
        const res = await fetch('/api/dashboard');
        if (!res.ok) {
          throw new Error('Failed to fetch data');
        }
        const jsonData = await res.json();
        // Format the date for display only if it exists
        const formattedData = jsonData.map((item: StockDashboardData) => ({
          ...item,
          date: item.date ? new Date(item.date).toLocaleDateString() : null,
        }));
        setData(formattedData);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An unknown error occurred');
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, []);

  if (loading) {
    return (
      <div className="text-center p-10">
        <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
        <p className="mt-4 text-lg text-gray-600">Loading Dashboard...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-100 border-2 border-red-400 text-red-700 px-6 py-4 rounded-xl text-center shadow-lg font-semibold m-4">
        Error: {error}.<br/>
        Please ensure the database is running and accessible. Also, make sure you have installed the required 'mysql2' package after resolving any network issues.
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4">
      <div className="max-w-7xl mx-auto">
        <header className="text-center mb-12">
          <h1 className="text-4xl font-bold text-gray-800 mb-4">Stock Dashboard</h1>
          <p className="text-lg text-gray-600">Most recent daily data for your tracked stocks.</p>
        </header>

        <div className="bg-white p-8 rounded-2xl shadow-2xl">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Symbol</th>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Company Name</th>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Date</th>
                  <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Close</th>
                  <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Open</th>
                  <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">High</th>
                  <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Low</th>
                  <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Volume</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {data.map((stock) => (
                  <tr key={stock.symbol} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{stock.symbol}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{stock.companyName || 'N/A'}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{stock.date || 'N/A'}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-500">{stock.close ? `$${stock.close.toFixed(2)}` : 'N/A'}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-500">{stock.open ? `$${stock.open.toFixed(2)}` : 'N/A'}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-green-500">{stock.high ? `$${stock.high.toFixed(2)}` : 'N/A'}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-red-500">{stock.low ? `$${stock.low.toFixed(2)}` : 'N/A'}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-500">{stock.volume ? stock.volume.toLocaleString() : 'N/A'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}