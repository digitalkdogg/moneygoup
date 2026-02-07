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

interface TfPredictionResult {
    ticker: string;
    current_price: number;
    predicted_change_range: [number, number]; // Changed to single predicted_change_range
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
    is_uptrend?: number; // Changed to number as per Python script output
    model_status?: string;
    note?: string; // Added note field from Python script
    metric_analysis?: any; // Added metric_analysis field for detailed insights
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
  const [tfPrediction, setTfPrediction] = useState<TfPredictionResult | null>(null)
  const [tfLoading, setTfLoading] = useState(false)
  const [tfError, setTfError] = useState<string | null>(null)
  const [showMetricAnalysis, setShowMetricAnalysis] = useState(false); // New state for accordion


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



  return (
    <div className="bg-white p-6 rounded-2xl shadow-[0_1px_10px_rgba(0,0,0,0.1)] mb-8">
      <h2 className="text-2xl font-semibold text-gray-800 mb-4">
        📊 AI-Powered Price Prediction
      </h2>
      <p className="text-gray-600 mb-4">
        Click the button to generate an AI-powered price prediction for {ticker}.
      </p>
      <div className="flex space-x-4">
          <button
            onClick={generateTfPrediction}
            disabled={tfLoading}
            className="bg-blue-700 text-white font-semibold py-2 px-4 rounded-lg hover:bg-blue-800 transition-colors disabled:bg-blue-400"
          >
            {tfLoading ? 'Generating...' : 'Generate Prediction'}
          </button>
      </div>
      {tfError && <p className="text-red-500 mt-4">{tfError}</p>}
      {tfPrediction && (
          <div className="mt-8">
              <h3 className="text-xl font-semibold text-gray-800 mb-4">Prediction Results</h3>
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

                      


                      {tfPrediction.predicted_change_range && (
                          <div className="mb-4">
                              <p className="text-sm font-semibold text-gray-700 mb-2">Predicted Price Outlook</p>
                              {/* Calculate actual predicted prices */}
                              {(() => {
                                  const predictedLowPrice = tfPrediction.current_price + tfPrediction.predicted_change_range[0];
                                  const predictedHighPrice = tfPrediction.current_price + tfPrediction.predicted_change_range[1];
                                  const predictedAveragePrice = (predictedLowPrice + predictedHighPrice) / 2;

                                  return (
                                      <div className="grid grid-cols-3 gap-2 text-left">
                                          <div>
                                              <p className="text-xs text-gray-500">Low</p>
                                              <p className="text-lg font-bold text-red-600">${predictedLowPrice.toFixed(2)}</p>
                                          </div>
                                          <div>
                                              <p className="text-xs text-gray-500">Average</p>
                                              {(() => {
                                                  const percentChange = ((predictedAveragePrice - tfPrediction.current_price) / tfPrediction.current_price) * 100;
                                                  const textColor = percentChange >= 0 ? 'text-green-600' : 'text-red-600';
                                                  return (
                                                      <p className="text-lg font-bold text-gray-800">
                                                          ${predictedAveragePrice.toFixed(2)}{' '}
                                                          <span className={`text-sm ${textColor}`}>
                                                              ({percentChange >= 0 ? '+' : ''}{percentChange.toFixed(2)}%)
                                                          </span>
                                                      </p>
                                                  );
                                              })()}
                                          </div>
                                          <div>
                                              <p className="text-xs text-gray-500">High</p>
                                              <p className="text-lg font-bold text-green-600">${predictedHighPrice.toFixed(2)}</p>
                                          </div>
                                      </div>
                                  );
                              })()}
                          </div>
                      )}
                      
                      {/* Accuracy Metrics (now with more robust conditional rendering) */}
                      {tfPrediction.current_price > 0 && (tfPrediction.accuracy_metrics?.neural_network || tfPrediction.accuracy_metrics?.model) && (
                          (() => {
                              const metrics = tfPrediction.accuracy_metrics.neural_network || tfPrediction.accuracy_metrics.model;
                              if (!metrics || tfPrediction.current_price === 0) {
                                  return null; // Should not happen often with outer check, but good for type safety
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
                                      {tfPrediction.note && (
                                          <p className="text-xs text-blue-600 mt-2">
                                              Note: {tfPrediction.note}
                                          </p>
                                      )}
                                  </div>
                              );
                          })()
                      )}
                  </div>
               </div>

              {/* Metric Analysis from Backend as Accordion */}
              {tfPrediction.metric_analysis && (
                  <div className="mt-8">
                      <button
                          className="w-full text-left p-4 bg-gray-50 rounded-t-lg border border-gray-200 flex justify-between items-center focus:outline-none"
                          onClick={() => setShowMetricAnalysis(!showMetricAnalysis)}
                      >
                          <h4 className="text-lg font-semibold text-gray-800">Detailed Metric Analysis</h4>
                          <span>{showMetricAnalysis ? '▲' : '▼'}</span>
                      </button>
                      {showMetricAnalysis && (
                          <div className="p-4 bg-gray-50 rounded-b-lg border border-gray-200 border-t-0">
                              {Object.entries(tfPrediction.metric_analysis).map(([key, value]: [string, any]) => {
                                  // Skip total_metric_impact and impact_classification for individual display
                                  if (key === "total_metric_impact" || key === "impact_classification") {
                                      return null;
                                  }
                                  return (
                                      <div key={key} className="mb-4 pb-2 border-b border-gray-200 last:border-b-0">
                                          <p className="text-md font-semibold text-gray-700 mb-1 capitalize">{key.replace(/_/g, ' ')}</p>
                                          <div className="text-sm text-gray-600 pl-2">
                                              {Object.entries(value).map(([metricKey, metricValue]: [string, any]) => (
                                                  <p key={metricKey}>
                                                      <span className="font-medium capitalize">{metricKey.replace(/_/g, ' ')}:</span>{' '}
                                                      {typeof metricValue === 'boolean' ? (metricValue ? 'Yes' : 'No') : 
                                                       (typeof metricValue === 'number' ? metricValue.toFixed(4) : metricValue)}
                                                  </p>
                                              ))}
                                          </div>
                                      </div>
                                  );
                              })}
                              {/* Display total_metric_impact and impact_classification separately at the end */}
                              {tfPrediction.metric_analysis.total_metric_impact !== undefined && (
                                  <div className="mt-4 pt-2 border-t border-gray-200">
                                      <p className="text-md font-semibold text-gray-700">Overall Impact Score: <span className="font-bold text-blue-600">{tfPrediction.metric_analysis.total_metric_impact.toFixed(4)}</span></p>
                                      <p className="text-md font-semibold text-gray-700">Classification: <span className="font-bold text-purple-600 capitalize">{tfPrediction.metric_analysis.impact_classification.replace(/_/g, ' ')}</span></p>
                                  </div>
                              )}
                          </div>
                      )}
                  </div>
              )}
          </div>
      )}
    </div>
  )
}
