// src/app/components/Dashboard.tsx
'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';

interface StockDashboardData {
  symbol: string;
  companyName: string;
  price: number | null;
  volume: number | null;
  volatility: "Low" | "Medium" | "High" | "N/A";
}

export default function Dashboard() {
  const [data, setData] = useState<StockDashboardData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    async function fetchData() {
      try {
        const res = await fetch('/api/dashboard');
        if (!res.ok) {
          throw new Error('Failed to fetch data');
        }
        const jsonData = await res.json();
        setData(jsonData);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An unknown error occurred');
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, []);

  const handleRowClick = (symbol: string) => {
    router.push(`/search/${symbol}`);
  };

  const getVolatilityClass = (volatility: string) => {
    switch (volatility) {
      case "Low":
        return "bg-green-100 text-green-800";
      case "Medium":
        return "bg-yellow-100 text-yellow-800";
      case "High":
        return "bg-red-100 text-red-800";
      default:
        return "bg-gray-100 text-gray-800";
    }
  };

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
        Please ensure the database is running and accessible.
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4">
      <div className="max-w-7xl mx-auto">
        <header className="text-center mb-12">
          <h1 className="text-4xl font-bold text-gray-800 mb-4">Stock Dashboard</h1>
          <p className="text-lg text-gray-600">Tracked stocks and their latest data.</p>
        </header>

        <div className="bg-white p-8 rounded-2xl shadow-2xl">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Symbol</th>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Company Name</th>
                  <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Price</th>
                  <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Volume</th>
                  <th scope="col" className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Volatility</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {data.map((stock) => (
                  <tr key={stock.symbol} onClick={() => handleRowClick(stock.symbol)} className="hover:bg-gray-50 cursor-pointer">
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{stock.symbol}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{stock.companyName || 'N/A'}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-500">{stock.price ? `$${stock.price.toFixed(2)}` : 'N/A'}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-500">{stock.volume ? stock.volume.toLocaleString() : 'N/A'}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-center">
                      <span className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${getVolatilityClass(stock.volatility)}`}>
                        {stock.volatility}
                      </span>
                    </td>
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
