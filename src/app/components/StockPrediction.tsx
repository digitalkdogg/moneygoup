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
  newsArticles?: Array<{ title?: string; description?: string; content?: string }>
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
    predicted_change_range: [number, number];
    accuracy_metrics: {
        neural_network: {
            mae: number;
            rmse: number;
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
                        <p className="text-sm text-gray-600 mb-1">Current Price</p>
                        <p className="text-2xl font-bold text-gray-800">${tfPrediction.current_price.toFixed(2)}</p>
                    </div>
                    <div className="p-4 bg-gray-50 rounded-lg">
                        <p className="text-sm text-gray-600 mb-1">Current Price</p>
                        <p className="text-2xl font-bold text-gray-800">${tfPrediction.current_price.toFixed(2)}</p>
                    </div>
                    <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
                        <p className="text-sm font-semibold text-gray-700 mb-2">Predicted Change Range</p>
                        <p className="text-2xl font-bold text-blue-600">
                            {tfPrediction.predicted_change_range[0] >= 0 ? '+' : ''}{tfPrediction.predicted_change_range[0].toFixed(2)} to {tfPrediction.predicted_change_range[1] >= 0 ? '+' : ''}{tfPrediction.predicted_change_range[1].toFixed(2)}
                        </p>
                        {tfPrediction.current_price > 0 && tfPrediction.accuracy_metrics?.neural_network && (
                            <p className="text-xs text-gray-600 mt-2">
                                MAE: {tfPrediction.accuracy_metrics.neural_network.mae.toFixed(2)} (RMSE: {tfPrediction.accuracy_metrics.neural_network.rmse.toFixed(2)})
                            </p>
                        )}
                    </div>
                 </div>

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
