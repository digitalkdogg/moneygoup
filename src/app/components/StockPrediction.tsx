'use client'

import { useState, useEffect } from 'react'

interface StockPredictionProps {
  ticker: string
  currentPrice: number
  historicalData: Array<{ close: number }> | null
  peRatio?: number
  pbRatio?: number
  marketCap?: number
  sma20?: number
  sma50?: number
  rsi?: number
  momentum?: number
  newsArticles?: Array<{ title?: string; description?: string; content?: string; sentiment_score?: number }>
}

interface PredictionResult {
  prediction: number
  lstmPrediction: number
  linearPrediction: number
  priceChange: number
  percentChange: number
  confidence: string
  metricsUsed: string[]
  newsSentimentScore?: number
}

interface TfPredictionResult {
    ticker: string;
    current_price: number;
    predicted_change_range_3m: [number, number];
    predicted_change_range_6m: [number, number];
    predicted_change_range_1y: [number, number];
    accuracy_metrics: {
        neural_network?: {
            mae: number;
            rmse: number;
        };
        model?: {
            mae: number;
            rmse: number;
        };
    };
    stock_type?: string;
    growth_rate_20d?: number;
    is_uptrend?: string;
    model_status?: string;
    feature_influences?: {
        "3m": {
            positive: Array<{ feature: string; impact: number }>;
            negative: Array<{ feature: string; impact: number }>;
        };
        "6m": {
            positive: Array<{ feature: string; impact: number }>;
            negative: Array<{ feature: string; impact: number }>;
        };
        "1y": {
            positive: Array<{ feature: string; impact: number }>;
            negative: Array<{ feature: string; impact: number }>;
        };
    };
}

export default function StockPrediction({
  ticker,
  currentPrice,
  historicalData,
  peRatio,
  pbRatio,
  marketCap,
  sma20,
  sma50,
  rsi,
  momentum,
  newsArticles,
}: StockPredictionProps) {
  const [prediction, setPrediction] = useState<PredictionResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [tfPrediction, setTfPrediction] = useState<TfPredictionResult | null>(null)
  const [tfLoading, setTfLoading] = useState(false)
  const [tfError, setTfError] = useState<string | null>(null)

  // Debug: Log the props we receive
  useEffect(() => {
    console.log('StockPrediction Props:', {
      ticker,
      currentPrice,
      peRatio,
      pbRatio,
      marketCap,
      sma20,
      sma50,
      rsi,
      momentum,
      newsArticlesCount: newsArticles?.length,
    })
  }, [ticker, currentPrice, peRatio, pbRatio, marketCap, sma20, sma50, rsi, momentum, newsArticles])

  const generatePrediction = async () => {
    if (!historicalData || historicalData.length < 5) {
      setError('Insufficient historical data for prediction')
      return
    }

    setLoading(true)
    setError(null)

    try {
      // Filter out news articles with a sentiment_score of 0
      const filteredNewsArticles = newsArticles ? newsArticles.filter(article => article.sentiment_score !== 0) : [];

      const response = await fetch(`/api/stock/${ticker}/predict`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          historicalData,
          stockMetrics: {
            peRatio,
            pbRatio,
            marketCap,
            sma20,
            sma50,
            rsi,
            momentum,
          },
          newsArticles: filteredNewsArticles,
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.message || 'Failed to generate prediction');
      }
      
      setPrediction(result);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to generate prediction'
      );
    } finally {
      setLoading(false);
    }
  }

  const generateTfPrediction = async () => {
    setTfLoading(true);
    setTfError(null);
    try {
      const response = await fetch(`/api/stock/${ticker}/predict/tensorflow`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          historicalData,
          stockMetrics: {
            peRatio,
            pbRatio,
            marketCap,
            sma20,
            sma50,
            rsi,
            momentum,
          },
          newsArticles,
        }),
      });
      
      if (!response.ok) {
        try {
            const result = await response.json();
            throw new Error(result.message || 'Failed to generate TF prediction');
        } catch (e) {
            const text = await response.text();
            throw new Error(`Failed to generate TF prediction. Server responded with: ${text}`);
        }
      }

      const result = await response.json();
      if (result.error) {
        throw new Error(result.error);
      }
      setTfPrediction(result);
    } catch (err) {
      setTfError(
        err instanceof Error ? err.message : 'An unknown error occurred'
      );
    } finally {
      setTfLoading(false);
    }
  }

  if (error) {
    return (
      <div className="bg-white p-6 rounded-2xl shadow-[0_1px_10px_rgba(0,0,0,0.1)] mb-8">
        <h2 className="text-2xl font-semibold text-gray-800 mb-4">
          📊 1-Year Price Prediction
        </h2>
        <p className="text-gray-600">{error}</p>
        <button
          onClick={generatePrediction}
          className="mt-4 bg-green-600 text-white font-semibold py-2 px-4 rounded-lg hover:bg-green-700 transition-colors"
        >
          Retry Prediction
        </button>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="bg-white p-6 rounded-2xl shadow-[0_1px_10px_rgba(0,0,0,0.1)] mb-8">
        <h2 className="text-2xl font-semibold text-gray-800 mb-4">
          📊 1-Year Price Prediction
        </h2>
        <div className="flex items-center justify-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900"></div>
          <p className="ml-4 text-gray-600">Analyzing historical data...</p>
        </div>
      </div>
    )
  }

  if (!prediction) {
    return (
      <div className="bg-white p-6 rounded-2xl shadow-[0_1px_10px_rgba(0,0,0,0.1)] mb-8">
        <h2 className="text-2xl font-semibold text-gray-800 mb-4">
          📊 1-Year Price Prediction
        </h2>
        <p className="text-gray-600 mb-4">
          Click the button to generate an AI-powered 1-year price prediction for {ticker}.
        </p>
        <div className="flex space-x-4">
            <button
              onClick={generatePrediction}
              className="bg-green-700 text-white font-semibold py-2 px-4 rounded-lg hover:bg-green-800 transition-colors"
            >
              Generate 1 Year Prediction
            </button>
            <button
              onClick={generateTfPrediction}
              disabled={tfLoading}
              className="bg-blue-700 text-white font-semibold py-2 px-4 rounded-lg hover:bg-blue-800 transition-colors disabled:bg-blue-400"
            >
              {tfLoading ? 'Generating...' : 'Generate TF Prediction'}
            </button>
        </div>
        {tfError && <p className="text-red-500 mt-4">{tfError}</p>}
        {tfPrediction && (
            <div className="mt-8">
                <h3 className="text-xl font-semibold text-gray-800 mb-4">TensorFlow Prediction Results</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="p-4 bg-gray-50 rounded-lg">
                        <p className="text-sm text-gray-600 mb-3">Current Price</p>
                        <p className="text-2xl font-bold text-gray-800 mb-4">${tfPrediction.current_price.toFixed(2)}</p>

                        {/* Influential Metrics Section */}
                        <div className="space-y-2 text-xs">
                            {/* RSI */}
                            {rsi !== undefined && (
                                <div className="pb-2 border-b border-gray-300">
                                    <div className="flex justify-between items-center">
                                        <span className="text-gray-600">RSI (14)</span>
                                        <span className={`font-semibold ${rsi > 70 ? 'text-red-600' : rsi < 30 ? 'text-green-600' : 'text-gray-700'}`}>
                                            {rsi.toFixed(1)}
                                        </span>
                                    </div>
                                    <p className="text-gray-500 text-xs mt-1">
                                        {rsi > 70 ? '🔴 Overbought' : rsi < 30 ? '🟢 Oversold' : '⚪ Neutral'}
                                    </p>
                                </div>
                            )}

                            {/* Momentum */}
                            {momentum !== undefined && (
                                <div className="pb-2 border-b border-gray-300">
                                    <div className="flex justify-between items-center">
                                        <span className="text-gray-600">Momentum</span>
                                        <span className={`font-semibold ${Math.abs(momentum) > 2 ? momentum > 0 ? 'text-green-600' : 'text-red-600' : 'text-gray-700'}`}>
                                            {momentum.toFixed(2)}
                                        </span>
                                    </div>
                                    <p className="text-gray-500 text-xs mt-1">
                                        {Math.abs(momentum) > 2 ? momentum > 0 ? '🚀 Strong Upward' : '📉 Strong Downward' : '➡️ Neutral'}
                                    </p>
                                </div>
                            )}

                            {/* SMA Comparison */}
                            {sma20 !== undefined && sma50 !== undefined && (
                                <div className="pb-2 border-b border-gray-300">
                                    <div className="flex justify-between items-center">
                                        <span className="text-gray-600">SMA Trend</span>
                                        <span className={`font-semibold ${sma20 > sma50 ? 'text-green-600' : 'text-red-600'}`}>
                                            {sma20 > sma50 ? 'Bullish' : 'Bearish'}
                                        </span>
                                    </div>
                                    <p className="text-gray-500 text-xs mt-1">
                                        SMA20: ${sma20.toFixed(2)} {sma20 > tfPrediction.current_price ? '(Above)' : '(Below)'} Price
                                    </p>
                                </div>
                            )}

                            {/* P/E Ratio */}
                            {peRatio !== undefined && peRatio > 0 && (
                                <div className="pb-2 border-b border-gray-300">
                                    <div className="flex justify-between items-center">
                                        <span className="text-gray-600">P/E Ratio</span>
                                        <span className={`font-semibold ${peRatio < 15 ? 'text-green-600' : peRatio > 25 ? 'text-red-600' : 'text-gray-700'}`}>
                                            {peRatio.toFixed(1)}
                                        </span>
                                    </div>
                                    <p className="text-gray-500 text-xs mt-1">
                                        {peRatio < 15 ? '💰 Undervalued' : peRatio > 25 ? '⚠️ Overvalued' : '⚪ Fair Value'}
                                    </p>
                                </div>
                            )}

                            {/* Stock Type from Prediction */}
                            {tfPrediction.stock_type && (
                                <div>
                                    <div className="flex justify-between items-center">
                                        <span className="text-gray-600">Stock Type</span>
                                        <span className="font-semibold text-gray-700 capitalize">
                                            {tfPrediction.stock_type.replace(/_/g, ' ')}
                                        </span>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                    <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
                        <p className="text-sm font-semibold text-gray-700 mb-3">Predicted Price Change Ranges</p>
                        
                        {/* 3-Month Prediction */}
                        {tfPrediction.predicted_change_range_3m && (
                            <div className="mb-4 pb-2 border-b border-blue-200">
                                <p className="text-sm text-gray-600 mb-1">3-Month Outlook</p>
                                <p className={`text-xl font-bold ${tfPrediction.predicted_change_range_3m[0] >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                    {tfPrediction.predicted_change_range_3m[0] >= 0 ? '+' : ''}{tfPrediction.predicted_change_range_3m[0].toFixed(2)} to {tfPrediction.predicted_change_range_3m[1] >= 0 ? '+' : ''}{tfPrediction.predicted_change_range_3m[1].toFixed(2)}
                                </p>
                            </div>
                        )}

                        {/* 6-Month Prediction */}
                        {tfPrediction.predicted_change_range_6m && (
                            <div className="mb-4 pb-2 border-b border-blue-200">
                                <p className="text-sm text-gray-600 mb-1">6-Month Outlook</p>
                                <p className={`text-xl font-bold ${tfPrediction.predicted_change_range_6m[0] >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                    {tfPrediction.predicted_change_range_6m[0] >= 0 ? '+' : ''}{tfPrediction.predicted_change_range_6m[0].toFixed(2)} to {tfPrediction.predicted_change_range_6m[1] >= 0 ? '+' : ''}{tfPrediction.predicted_change_range_6m[1].toFixed(2)}
                                </p>
                            </div>
                        )}

                        {/* 1-Year Prediction */}
                        {tfPrediction.predicted_change_range_1y && (
                            <div className="mb-4 pb-2">
                                <p className="text-sm text-gray-600 mb-1">1-Year Outlook</p>
                                <p className={`text-xl font-bold ${tfPrediction.predicted_change_range_1y[0] >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                    {tfPrediction.predicted_change_range_1y[0] >= 0 ? '+' : ''}{tfPrediction.predicted_change_range_1y[0].toFixed(2)} to {tfPrediction.predicted_change_range_1y[1] >= 0 ? '+' : ''}{tfPrediction.predicted_change_range_1y[1].toFixed(2)}
                                </p>
                            </div>
                        )}

                        {tfPrediction.current_price > 0 && (tfPrediction.accuracy_metrics?.neural_network || tfPrediction.accuracy_metrics?.model) && (
                            (() => {
                                const metrics = tfPrediction.accuracy_metrics.neural_network || tfPrediction.accuracy_metrics.model;
                                if (!metrics || tfPrediction.current_price === 0) {
                                    return null; // Don't render if metrics are missing or price is zero
                                }
                                const errorRate = (metrics.mae / tfPrediction.current_price) * 100;
                                const accuracy = Math.max(0, 100 - errorRate);
                                return (
                                    <div className="mt-4 pt-3 border-t border-blue-200">
                                        <div className="grid grid-cols-2 gap-3">
                                            <div>
                                                <p className="text-xs text-gray-600 mb-1">Model Accuracy</p>
                                                <p className={`text-lg font-bold ${accuracy >= 85 ? 'text-green-600' : accuracy >= 70 ? 'text-yellow-600' : 'text-red-600'}`}>
                                                    {accuracy.toFixed(1)}%
                                                </p>
                                            </div>
                                            <div>
                                                <p className="text-xs text-gray-600 mb-1">Error Rate (MAE)</p>
                                                <p className="text-lg font-bold text-gray-700">
                                                    ±{errorRate.toFixed(2)}%
                                                </p>
                                            </div>
                                        </div>
                                        <p className="text-xs text-gray-500 mt-2">
                                            MAE: ${metrics.mae.toFixed(2)} | RMSE: ${metrics.rmse?.toFixed(2) || 'N/A'}
                                        </p>
                                        {tfPrediction.model_status && (
                                            <p className="text-xs text-amber-600 mt-2">
                                                {tfPrediction.model_status === 'fallback_baseline_model' ? '⚠️ Using fallback baseline model' : ''}
                                            </p>
                                        )}
                                    </div>
                                );
                            })()
                        )}
                    </div>
                 </div>

                {/* Feature Influences */}
                {tfPrediction.feature_influences && (
                    <div className="mt-8">
                        <h4 className="text-lg font-semibold text-gray-800 mb-3">Feature Influences (for each horizon)</h4>
                        {Object.entries(tfPrediction.feature_influences).map(([horizon, influences]) => (
                            <div key={horizon} className="mb-6 p-4 bg-gray-50 rounded-lg border border-gray-200">
                                <p className="text-md font-semibold text-gray-700 mb-2 capitalize">{horizon} Horizon</p>
                                {influences.positive.length > 0 && (
                                    <div className="mb-2">
                                        <p className="text-sm font-medium text-green-700 mb-1">Positive Influences:</p>
                                        <div className="flex flex-wrap gap-2">
                                            {influences.positive.map((item, idx) => (
                                                <span key={idx} className="bg-green-100 text-green-800 px-2 py-1 rounded-full text-xs">
                                                    {item.feature}: {item.impact >= 0 ? '+' : ''}{item.impact.toFixed(4)}
                                                </span>
                                            ))}
                                        </div>
                                    </div>
                                )}
                                {influences.negative.length > 0 && (
                                    <div className="mb-2">
                                        <p className="text-sm font-medium text-red-700 mb-1">Negative Influences:</p>
                                        <div className="flex flex-wrap gap-2">
                                            {influences.negative.map((item, idx) => (
                                                <span key={idx} className="bg-red-100 text-red-800 px-2 py-1 rounded-full text-xs">
                                                    {item.feature}: {item.impact >= 0 ? '+' : ''}{item.impact.toFixed(4)}
                                                </span>
                                            ))}
                                        </div>
                                    </div>
                                )}
                                {influences.positive.length === 0 && influences.negative.length === 0 && (
                                    <p className="text-sm text-gray-600">No significant influences detected for this horizon.</p>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        )}
      </div>

    )
  }

  const isPositive = prediction.priceChange >= 0
  const changeColor = isPositive ? 'text-green-600' : 'text-red-600'
  const bgColor = isPositive ? 'bg-green-50' : 'bg-red-50'
  const confidenceColor =
    prediction.confidence === 'High'
      ? 'bg-green-100 text-green-800'
      : prediction.confidence === 'Medium'
        ? 'bg-yellow-100 text-yellow-800'
        : 'bg-red-100 text-red-800'

  return (
    <div className="bg-white p-6 rounded-2xl shadow-[0_1px_10px_rgba(0,0,0,0.1)] mb-8">
      <h2 className="text-2xl font-semibold text-gray-800 mb-6">
        📊 1-Year Price Prediction
      </h2>

      <div className={`${bgColor} p-6 rounded-lg mb-6 border-l-4 ${isPositive ? 'border-green-600' : 'border-red-600'}`}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <p className="text-sm text-gray-600 mb-2">Current Price</p>
            <p className="text-3xl font-bold text-gray-800">
              ${currentPrice.toFixed(2)}
            </p>
          </div>

          <div>
            <p className="text-sm text-gray-600 mb-2">Predicted Price (1 Year)</p>
            <p className={`text-3xl font-bold ${changeColor}`}>
              ${prediction.prediction.toFixed(2)}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-6">
          <div>
            <p className="text-sm text-gray-600 mb-1">Expected Change</p>
            <p className={`text-2xl font-bold ${changeColor}`}>
              {isPositive ? '+' : ''}
              {prediction.priceChange.toFixed(2)} ({prediction.percentChange.toFixed(2)}%)
            </p>
          </div>

          <div>
            <p className="text-sm text-gray-600 mb-1">Prediction Confidence</p>
            <span className={`inline-block px-3 py-1 rounded-full text-sm font-semibold ${confidenceColor}`}>
              {prediction.confidence}
            </span>
          </div>

          <div>
            <p className="text-sm text-gray-600 mb-1">Model Agreement</p>
            <p className="text-sm text-gray-800">
              LSTM vs Linear: {Math.abs(prediction.lstmPrediction - prediction.linearPrediction).toFixed(2)}
            </p>
          </div>
        </div>

        <div className="mt-6 p-4 bg-white bg-opacity-50 rounded-lg">
          <p className="text-sm font-semibold text-gray-700 mb-2">📊 Metrics Used in Prediction:</p>
          <div className="flex flex-wrap gap-2 mb-4">
            {prediction.metricsUsed.map((metric, idx) => (
              <span
                key={idx}
                className="inline-block px-3 py-1 bg-blue-100 text-blue-800 text-xs font-semibold rounded-full"
              >
                 {metric}
              </span>
            ))}
          </div>

          {prediction.newsSentimentScore !== undefined && (
            <div>
              <p className="text-sm font-semibold text-gray-700 mb-2">📰 News Sentiment Score:</p>
              <div className="flex items-center gap-3">
                <div className="flex-1 bg-gray-200 rounded-full h-2">
                  <div
                    className={`h-2 rounded-full ${
                      prediction.newsSentimentScore > 0
                        ? 'bg-green-500'
                        : prediction.newsSentimentScore < 0
                          ? 'bg-red-500'
                          : 'bg-gray-400'
                    }`}
                    style={{
                      width: `${Math.min(100, Math.abs(prediction.newsSentimentScore) * 50)}%`,
                    }}
                  ></div>
                </div>
                <span className={`font-semibold text-sm ${
                  prediction.newsSentimentScore > 0
                    ? 'text-green-600'
                    : prediction.newsSentimentScore < 0
                      ? 'text-red-600'
                      : 'text-gray-600'
                }`}>
                  {prediction.newsSentimentScore > 0 ? '📈 Positive' : prediction.newsSentimentScore < 0 ? '📉 Negative' : '➡️ Neutral'} ({prediction.newsSentimentScore.toFixed(2)})
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
          <p className="text-sm font-semibold text-gray-700 mb-2">LSTM Model Prediction</p>
          <p className="text-2xl font-bold text-blue-600">
            ${prediction.lstmPrediction.toFixed(2)}
          </p>
          <p className="text-xs text-gray-600 mt-2">
            Advanced neural network based on historical patterns
          </p>
        </div>

        <div className="p-4 bg-purple-50 rounded-lg border border-purple-200">
          <p className="text-sm font-semibold text-gray-700 mb-2">Linear Regression Prediction</p>
          <p className="text-2xl font-bold text-purple-600">
            ${prediction.linearPrediction.toFixed(2)}
          </p>
          <p className="text-xs text-gray-600 mt-2">
            Trend-based model for consistent growth/decline
          </p>
        </div>
      </div>

      <p className="text-xs text-gray-500 mt-4 italic">
        ⚠️ Disclaimer: These predictions are AI-generated estimates based on historical data. Stock prices are influenced by many unpredictable factors. This should not be used as financial advice.
      </p>
    </div>
  )
}
