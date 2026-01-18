// src/app/components/Dashboard.tsx
'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';

interface StockDashboardData {
  stock_id: number;
  symbol: string;
  companyName: string;
  price: number | null;
  isOwned: boolean;
  shares?: number;
  purchase_price?: number;
  recommendation?: 'BUY' | 'SELL' | 'HOLD';
  volatility: "Low" | "Medium" | "High" | "N/A" | null;
  estimatedDailyEarnings?: number;
}

export default function Dashboard() {
  const [data, setData] = useState<StockDashboardData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  // State for the purchase modal
  const [isPurchaseModalOpen, setIsPurchaseModalOpen] = useState(false);
  const [selectedStockForPurchase, setSelectedStockForPurchase] = useState<StockDashboardData | null>(null);
  const [purchasePrice, setPurchasePrice] = useState('');
  const [shares, setShares] = useState('');
  const [isSubmittingPurchase, setIsSubmittingPurchase] = useState(false);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);
  const [purchaseSuccess, setPurchaseSuccess] = useState<string | null>(null);

  // State for the sell modal
  const [isSellModalOpen, setIsSellModalOpen] = useState(false);
  const [selectedStockForSell, setSelectedStockForSell] = useState<StockDashboardData | null>(null);
  const [isSubmittingSell, setIsSubmittingSell] = useState(false);
  const [sellError, setSellError] = useState<string | null>(null);
  const [sellSuccess, setSellSuccess] = useState<string | null>(null);

  // State for the remove modal
  const [isRemoveModalOpen, setIsRemoveModalOpen] = useState(false);
  const [selectedStockForRemove, setSelectedStockForRemove] = useState<StockDashboardData | null>(null);
  const [isSubmittingRemove, setIsSubmittingRemove] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removeSuccess, setRemoveSuccess] = useState<string | null>(null);


  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/dashboard?_=${new Date().getTime()}`);
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
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleRowClick = (symbol: string) => {
    router.push(`/search/${symbol}`);
  };

  const handlePurchaseClick = (e: React.MouseEvent, stock: StockDashboardData) => {
    e.stopPropagation(); // Prevent row click from firing
    setSelectedStockForPurchase(stock);
    setIsPurchaseModalOpen(true);
    setPurchaseError(null);
    setPurchaseSuccess(null);
    setPurchasePrice(stock.price ? stock.price.toFixed(2) : ''); // Pre-fill with current price
    setShares('');
  };

  const handleClosePurchaseModal = () => {
    setIsPurchaseModalOpen(false);
    setSelectedStockForPurchase(null);
    setPurchasePrice('');
    setShares('');
    setPurchaseError(null);
    setPurchaseSuccess(null);
  };

  const handlePurchaseSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedStockForPurchase) return;

    setIsSubmittingPurchase(true);
    setPurchaseError(null);
    setPurchaseSuccess(null);

    try {
      const response = await fetch('/api/user/stocks', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          stock_id: selectedStockForPurchase.stock_id,
          shares: parseFloat(shares),
          purchase_price: parseFloat(purchasePrice),
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to complete purchase.');
      }

      setPurchaseSuccess(`Successfully purchased ${shares} shares of ${selectedStockForPurchase.symbol}.`);
      fetchData(); // Refresh dashboard data
      setTimeout(() => {
        handleClosePurchaseModal();
      }, 2000);

    } catch (err) {
      setPurchaseError(err instanceof Error ? err.message : 'An unknown error occurred.');
    } finally {
      setIsSubmittingPurchase(false);
    }
  };


  const handleSellClick = (e: React.MouseEvent, stock: StockDashboardData) => {
    e.stopPropagation(); // Prevent row click from firing
    setSelectedStockForSell(stock);
    setIsSellModalOpen(true);
    setSellError(null);
    setSellSuccess(null);
  };

  const handleCloseSellModal = () => {
    setIsSellModalOpen(false);
    setSelectedStockForSell(null);
    setSellError(null);
    setSellSuccess(null);
  };

  const handleConfirmSell = async () => {
    if (!selectedStockForSell) return;

    setIsSubmittingSell(true);
    setSellError(null);
    setSellSuccess(null);

    try {
      const response = await fetch(`/api/user/stocks/${selectedStockForSell.stock_id}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to sell stock.');
      }

      setSellSuccess(`Successfully sold all shares of ${selectedStockForSell.symbol}.`);
      fetchData(); // Refresh dashboard data
      setTimeout(() => {
        handleCloseSellModal();
      }, 2000);

    } catch (err) {
      setSellError(err instanceof Error ? err.message : 'An unknown error occurred.');
    } finally {
      setIsSubmittingSell(false);
    }
  };

  const handleCloseRemoveModal = () => {
    setIsRemoveModalOpen(false);
    setSelectedStockForRemove(null);
    setRemoveError(null);
    setRemoveSuccess(null);
  };

  const handleConfirmRemove = async () => {
    if (!selectedStockForRemove) return;

    setIsSubmittingRemove(true);
    setRemoveError(null);
    setRemoveSuccess(null);

    try {
      const response = await fetch(`/api/stock/${selectedStockForRemove.stock_id}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to remove stock.');
      }

      setRemoveSuccess(`Successfully removed ${selectedStockForRemove.symbol}.`);
      fetchData(); // Refresh dashboard data
      setTimeout(() => {
        handleCloseRemoveModal();
      }, 2000);

    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : 'An unknown error occurred.');
    } finally {
      setIsSubmittingRemove(false);
    }
  };

  const handleRemoveStock = (e: React.MouseEvent, stock: StockDashboardData) => {
    e.stopPropagation(); // Prevent row click from firing
    setSelectedStockForRemove(stock);
    setIsRemoveModalOpen(true);
    setRemoveError(null);
    setRemoveSuccess(null);
  };


  const getRecommendationClass = (recommendation: string) => {
    switch (recommendation) {
      case "BUY":
        return "bg-green-100 text-green-800";
      case "SELL":
        return "bg-red-100 text-red-800";
      default:
        return "bg-gray-100 text-gray-800";
    }
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
    <>
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
                    <th scope="col" className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Recommendation</th>
                    <th scope="col" className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Volatility</th>
                    <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Shares</th>
                    <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Est. Earnings</th>
                    <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Est. Daily Earnings</th>
                    <th scope="col" className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Action</th>
                    <th scope="col" className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider"></th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {data.map((stock) => {
                    const earnings = stock.isOwned && stock.price && stock.purchase_price && stock.shares
                      ? (stock.price - stock.purchase_price) * stock.shares
                      : null;
                    const earningsClass = earnings
                      ? earnings > 0 ? 'text-green-600' : 'text-red-600'
                      : 'text-gray-500';

                    return (
                      <tr key={stock.symbol} onClick={() => handleRowClick(stock.symbol)} className="hover:bg-gray-50 cursor-pointer group">
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{stock.symbol}</td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{stock.companyName || 'N/A'}</td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-500">{stock.price ? `$${stock.price.toFixed(2)}` : 'N/A'}</td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-center">
                          <span className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${getRecommendationClass(stock.recommendation || '')}`}>
                            {stock.recommendation || 'N/A'}
                          </span>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-center">
                          <span className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${getVolatilityClass(stock.volatility || '')}`}>
                            {stock.volatility || 'N/A'}
                          </span>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-500">{stock.isOwned && typeof stock.shares === 'number' ? stock.shares.toFixed(2) : 'N/A'}</td>
                        <td className={`px-6 py-4 whitespace-nowrap text-sm text-right font-medium ${earningsClass}`}>
                          {earnings !== null ? `${earnings > 0 ? '+' : ''}$${earnings.toFixed(2)}` : 'N/A'}
                        </td>
                        <td className={`px-6 py-4 whitespace-nowrap text-sm text-right font-medium ${
                          stock.estimatedDailyEarnings !== undefined && stock.estimatedDailyEarnings !== null
                            ? stock.estimatedDailyEarnings > 0 ? 'text-green-600' : 'text-red-600'
                            : 'text-gray-500'
                        }`}>
                          {stock.estimatedDailyEarnings !== undefined && stock.estimatedDailyEarnings !== null
                            ? `${stock.estimatedDailyEarnings > 0 ? '+' : ''}$${stock.estimatedDailyEarnings.toFixed(2)}`
                            : 'N/A'}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-center">
                              {stock.isOwned ? (
                                <button
                                  onClick={(e) => handleSellClick(e, stock)}
                                  className="px-4 py-2 font-semibold text-white bg-gray-400 rounded-lg hover:bg-gray-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-300 transition-colors duration-200"
                                >
                                  Sell
                                </button>
                              ) : (
                                <button
                                  onClick={(e) => handlePurchaseClick(e, stock)}
                                  className="px-4 py-2 font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors duration-200"
                                >
                                  Purchase
                                </button>
                              )}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-center">
                          {!stock.isOwned && (
                            <button
                              onClick={(e) => handleRemoveStock(e, stock)}
                              className="text-gray-400 hover:text-red-600 opacity-0 group-hover:opacity-100 transition-opacity duration-200 p-1 text-2xl cursor-pointer"
                              aria-label="Remove stock"
                            >
                              &#x2715; {/* Unicode 'X' character */}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      {/* Purchase Modal */}
      {isPurchaseModalOpen && selectedStockForPurchase && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-75 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl shadow-2xl p-8 w-full max-w-md m-4">
            <h2 className="text-2xl font-bold text-gray-800 mb-2">Purchase {selectedStockForPurchase.symbol}</h2>
            <p className="text-gray-600 mb-6">{selectedStockForPurchase.companyName}</p>
            
            <form onSubmit={handlePurchaseSubmit}>
              <div className="mb-4">
                <label htmlFor="shares" className="block text-sm font-medium text-gray-700 mb-1">Number of Shares</label>
                <input
                  type="number"
                  id="shares"
                  value={shares}
                  onChange={(e) => setShares(e.target.value)}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-blue-500 focus:border-blue-500"
                  placeholder="e.g., 10"
                  required
                  step="any"
                />
              </div>

              <div className="mb-6">
                <label htmlFor="purchasePrice" className="block text-sm font-medium text-gray-700 mb-1">Purchase Price per Share</label>
                <input
                  type="number"
                  id="purchasePrice"
                  value={purchasePrice}
                  onChange={(e) => setPurchasePrice(e.target.value)}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-blue-500 focus:border-blue-500"
                  placeholder={`Current price: $${selectedStockForPurchase.price?.toFixed(2)}`}
                  required
                  step="any"
                />
              </div>
              
              {purchaseError && <p className="text-red-500 text-sm mb-4">{purchaseError}</p>}
              {purchaseSuccess && <p className="text-green-500 text-sm mb-4">{purchaseSuccess}</p>}

              <div className="flex justify-end space-x-4">
                <button
                  type="button"
                  onClick={handleClosePurchaseModal}
                  className="px-6 py-2 text-gray-700 bg-gray-200 rounded-lg hover:bg-gray-300 transition-colors"
                  disabled={isSubmittingPurchase}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-6 py-2 text-white bg-blue-600 rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:bg-gray-400 transition-colors"
                  disabled={isSubmittingPurchase || !shares || !purchasePrice}
                >
                  {isSubmittingPurchase ? 'Purchasing...' : 'Confirm Purchase'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Sell Confirmation Modal */}
      {isSellModalOpen && selectedStockForSell && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-75 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl shadow-2xl p-8 w-full max-w-md m-4">
            <h2 className="text-2xl font-bold text-gray-800 mb-2">Confirm Sell</h2>
            <p className="text-gray-600 mb-6">
              Are you sure you want to sell all shares of <span className="font-semibold">{selectedStockForSell.symbol}</span> ({selectedStockForSell.companyName})?
            </p>
            
            {sellError && <p className="text-red-500 text-sm mb-4">{sellError}</p>}
            {sellSuccess && <p className="text-green-500 text-sm mb-4">{sellSuccess}</p>}

            <div className="flex justify-end space-x-4">
              <button
                type="button"
                onClick={handleCloseSellModal}
                className="px-6 py-2 text-gray-700 bg-gray-200 rounded-lg hover:bg-gray-300 transition-colors"
                disabled={isSubmittingSell}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmSell}
                className="px-6 py-2 text-white bg-red-600 rounded-lg hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 disabled:bg-gray-400 transition-colors"
                disabled={isSubmittingSell}
              >
                {isSubmittingSell ? 'Selling...' : 'Confirm Sell'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Remove Confirmation Modal */}
      {isRemoveModalOpen && selectedStockForRemove && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-75 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl shadow-2xl p-8 w-full max-w-md m-4">
            <h2 className="text-2xl font-bold text-gray-800 mb-2">Confirm Removal</h2>
            <p className="text-gray-600 mb-6">
              Are you sure you want to remove <span className="font-semibold">{selectedStockForRemove.symbol}</span> ({selectedStockForRemove.companyName}) from your tracked stocks?
              This will also delete all associated historical data.
            </p>
            
            {removeError && <p className="text-red-500 text-sm mb-4">{removeError}</p>}
            {removeSuccess && <p className="text-green-500 text-sm mb-4">{removeSuccess}</p>}

            <div className="flex justify-end space-x-4">
              <button
                type="button"
                onClick={handleCloseRemoveModal}
                className="px-6 py-2 text-gray-700 bg-gray-200 rounded-lg hover:bg-gray-300 transition-colors"
                disabled={isSubmittingRemove}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmRemove}
                className="px-6 py-2 text-white bg-red-600 rounded-lg hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 disabled:bg-gray-400 transition-colors"
                disabled={isSubmittingRemove}
              >
                {isSubmittingRemove ? 'Removing...' : 'Confirm Remove'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
