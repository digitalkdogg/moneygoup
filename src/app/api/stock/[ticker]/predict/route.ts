import { NextRequest, NextResponse } from 'next/server';
import * as tf from '@tensorflow/tfjs';
import { calculateAnnualizedVolatility } from '@/utils/volatility';
import { checkOrigin } from '@/utils/originCheck';

interface StockMetrics {
  close: number;
  volume?: number;
  peRatio?: number;
  pbRatio?: number;
  marketCap?: number;
  sma20?: number;
  sma50?: number;
  rsi?: number;
  momentum?: number;
  volatility?: number;
}

interface PredictionResult {
  prediction: number;
  lstmPrediction: number;
  linearPrediction: number;
  priceChange: number;
  percentChange: number;
  confidence: string;
  metricsUsed: string[];
  newsSentimentScore?: number;
}

// Simple sentiment analysis for news articles
function analyzeNewsSentiment(articles: Array<{ title?: string; description?: string; content?: string }>): number {
  if (!articles || articles.length === 0) return 0;

  const positiveWords = [
    'surge', 'gain', 'rally', 'bull', 'profit', 'boom', 'soar', 'jump', 'rise', 'up', 'positive',
    'growth', 'strong', 'beat', 'outperform', 'upgrade', 'recovery', 'success', 'dividend',
    'acquisition', 'partnership', 'expansion', 'launch', 'record', 'breakthrough'
  ];

  const negativeWords = [
    'crash', 'plunge', 'drop', 'bear', 'loss', 'decline', 'fall', 'down', 'negative',
    'weakness', 'weak', 'miss', 'underperform', 'downgrade', 'crisis', 'bankrupt',
    'layoff', 'scandal', 'lawsuit', 'recall', 'investigation', 'penalty', 'recession'
  ];

  let totalScore = 0;
  let wordCount = 0;

  for (const article of articles) {
    const text = `${article.title || ''} ${article.description || ''} ${article.content || ''}`.toLowerCase();

    for (const word of positiveWords) {
      const count = (text.match(new RegExp(`\b${word}\b`, 'g')) || []).length;
      totalScore += count;
      wordCount += count;
    }

    for (const word of negativeWords) {
      const count = (text.match(new RegExp(`\b${word}\b`, 'g')) || []).length;
      totalScore -= count;
      wordCount += count;
    }
  }

  if (wordCount === 0) return 0;
  return totalScore / wordCount;
}

// Normalize multiple features together
function normalizeFeatures(features: number[][]): {
  normalized: number[][];
  minMax: Array<{ min: number; max: number }>;
} {
  const numFeatures = features[0].length;
  const minMax: Array<{ min: number; max: number }> = [];
  const normalized: number[][] = [];

  for (let i = 0; i < numFeatures; i++) {
    const column = features.map(row => row[i]);
    const min = Math.min(...column);
    const max = Math.max(...column);
    minMax.push({ min, max });
  }

  for (const row of features) {
    const normalizedRow = row.map((val, idx) => {
      const { min, max } = minMax[idx];
      return (val - min) / (max - min || 1);
    });
    normalized.push(normalizedRow);
  }

  return { normalized, minMax };
}

// Normalize data to 0-1 range
function normalize(data: number[]): { normalized: number[]; min: number; max: number } {
  const min = Math.min(...data);
  const max = Math.max(...data);
  const normalized = data.map(d => (d - min) / (max - min || 1));
  return { normalized, min, max };
}

// Denormalize data back to original scale
function denormalize(value: number, min: number, max: number): number {
  return value * (max - min || 1) + min;
}

// Linear regression with multiple features and bias towards recent trends
function linearRegressionMultivariate(features: number[][]): number {
  if (features.length < 2) return features[features.length - 1][0];

  const n = features.length;
  const m = features[0].length;

  // Weight recent data more heavily (exponential weights)
  const weights = Array.from({ length: n }, (_, i) => Math.exp((i - n) / (n / 3)));
  const sumWeights = weights.reduce((a, b) => a + b, 0);

  let prediction = 0;
  for (let featureIdx = 0; featureIdx < m; featureIdx++) {
    const featureValues = features.map(row => row[featureIdx]);
    
    const xMean = (n - 1) / 2;
    const yMean = featureValues.reduce((sum, val, i) => sum + val * weights[i], 0) / sumWeights;

    let numerator = 0;
    let denominator = 0;

    for (let i = 0; i < n; i++) {
      numerator += weights[i] * (i - xMean) * (featureValues[i] - yMean);
      denominator += weights[i] * (i - xMean) ** 2;
    }

    const slope = numerator / denominator || 0;
    const intercept = yMean - slope * xMean;
    const futurePrediction = slope * (n + 251) + intercept;

    // Weight price trend more heavily (first feature)
    const weight = featureIdx === 0 ? 0.7 : 0.3 / (m - 1);
    prediction += futurePrediction * weight;
  }

  return prediction;
}

// LSTM model for time series prediction with multiple features
async function lstmPredictionMultivariate(features: number[][]): Promise<number> {
  if (features.length < 20) {
    return linearRegressionMultivariate(features);
  }

  const { normalized, minMax } = normalizeFeatures(features);
  const numFeatures = features[0].length;

  // Create sequences for training
  const sequenceLength = Math.min(10, Math.floor(features.length / 5));
  const sequences: number[][][] = [];
  const targets: number[] = [];

  for (let i = 0; i < normalized.length - sequenceLength; i++) {
    const sequence: number[][] = [];
    for (let j = i; j < i + sequenceLength; j++) {
      sequence.push(normalized[j]);
    }
    sequences.push(sequence);
    targets.push(normalized[i + sequenceLength][0]);
  }

  if (sequences.length < 5) {
    return linearRegressionMultivariate(features);
  }

  const xs = tf.tensor3d(sequences);
  const ys = tf.tensor2d(targets, [targets.length, 1]);

  const model = tf.sequential({
    layers: [
      tf.layers.lstm({
        units: 64,
        returnSequences: true,
        inputShape: [sequenceLength, numFeatures],
      }),
      tf.layers.dropout({ rate: 0.15 }),
      tf.layers.lstm({ units: 32 }),
      tf.layers.dropout({ rate: 0.15 }),
      tf.layers.dense({ units: 16, activation: 'relu' }),
      tf.layers.dense({ units: 1 }),
    ],
  });

  model.compile({
    optimizer: tf.train.adam(0.005),
    loss: 'meanSquaredError',
  });

  let lastPrediction = features[features.length - 1][0];

  try {
    // Increased epochs for better training
    await model.fit(xs, ys, {
      epochs: 50,
      batchSize: Math.max(1, Math.floor(sequences.length / 3)),
      verbose: 0,
    });

    const latestNewsSentiment = numFeatures > 8 ? normalized[normalized.length - 1][9] : 0;
    let currentSequence = normalized.slice(-sequenceLength);

    // Add momentum bias - recent trend has more influence
    const recentPrices = features.slice(-5).map(f => f[0]);
    const recentTrend = recentPrices[recentPrices.length - 1] - recentPrices[0];

    for (let i = 0; i < 252; i++) {
      const input = tf.tensor3d([currentSequence as number[][]]);
      const pred = model.predict(input) as tf.Tensor;
      let predValue = pred.dataSync()[0];
      pred.dispose();
      input.dispose();

      // Bias towards recent momentum (20% momentum influence)
      const momentumBias = (recentTrend / recentPrices[0]) * 0.2;
      predValue = predValue * (1 + momentumBias);

      const newRow = [...currentSequence[currentSequence.length - 1]];
      newRow[0] = predValue;
      
      if (numFeatures > 8) {
        newRow[9] = latestNewsSentiment * Math.exp(-i / 252);
      }
      
      currentSequence = [...currentSequence.slice(1), newRow];
    }

    const priceMinMax = minMax[0];
    lastPrediction = denormalize(
      currentSequence[currentSequence.length - 1][0],
      priceMinMax.min,
      priceMinMax.max
    );
  } finally {
    model.dispose();
    xs.dispose();
    ys.dispose();
  }

  return lastPrediction;
}

// Legacy LSTM for price-only fallback
async function lstmPrediction(prices: number[]): Promise<number> {
  if (prices.length < 20) {
    return linearRegression(prices);
  }

  const { normalized, min, max } = normalize(prices);

  const sequenceLength = 10;
  const sequences: number[][] = [];
  const targets: number[] = [];

  for (let i = 0; i < normalized.length - sequenceLength; i++) {
    sequences.push(normalized.slice(i, i + sequenceLength));
    targets.push(normalized[i + sequenceLength]);
  }

  if (sequences.length < 5) {
    return linearRegression(prices);
  }

  const xs = tf.tensor2d(sequences);
  const ys = tf.tensor2d(targets, [targets.length, 1]);

  const model = tf.sequential({
    layers: [
      tf.layers.lstm({
        units: 64,
        returnSequences: true,
        inputShape: [sequenceLength, 1],
      }),
      tf.layers.dropout({ rate: 0.15 }),
      tf.layers.lstm({ units: 32 }),
      tf.layers.dropout({ rate: 0.15 }),
      tf.layers.dense({ units: 16, activation: 'relu' }),
      tf.layers.dense({ units: 1 }),
    ],
  });

  model.compile({
    optimizer: tf.train.adam(0.005),
    loss: 'meanSquaredError',
  });

  let lastPrediction = prices[prices.length - 1];

  try {
    await model.fit(xs, ys, {
      epochs: 50,
      batchSize: Math.max(1, Math.floor(sequences.length / 3)),
      verbose: 0,
    });

    // Add momentum bias
    const recentPrices = prices.slice(-5);
    const recentTrend = recentPrices[recentPrices.length - 1] - recentPrices[0];

    let currentSequence = normalized.slice(-sequenceLength);

    for (let i = 0; i < 252; i++) {
      const input = tf.tensor3d([[currentSequence]]);
      const pred = model.predict(input) as tf.Tensor;
      let predValue = pred.dataSync()[0];
      pred.dispose();
      input.dispose();

      // Bias towards recent momentum
      const momentumBias = (recentTrend / recentPrices[0]) * 0.2;
      predValue = predValue * (1 + momentumBias);

      currentSequence = [...currentSequence.slice(1), predValue];
    }

    lastPrediction = denormalize(currentSequence[currentSequence.length - 1], min, max);
  } finally {
    model.dispose();
    xs.dispose();
    ys.dispose();
  }

  return lastPrediction;
}

function linearRegression(prices: number[]): number {
  const n = prices.length;
  const xMean = (n - 1) / 2;
  const yMean = prices.reduce((a, b) => a + b) / n;

  let numerator = 0;
  let denominator = 0;

  for (let i = 0; i < n; i++) {
    numerator += (i - xMean) * (prices[i] - yMean);
    denominator += (i - xMean) ** 2;
  }

  const slope = numerator / denominator;
  const intercept = yMean - slope * xMean;

  return slope * (n + 251) + intercept;
}

export async function POST(request: NextRequest, { params }: { params: { ticker: string } }) {
    const originCheckResponse = checkOrigin(request);
    if (originCheckResponse) return originCheckResponse;

    const { historicalData, stockMetrics, newsArticles } = await request.json();

    console.log('Received newsArticles in predict API for ticker:', params.ticker, newsArticles); // Add this line

    if (!historicalData || historicalData.length < 5) {
      return NextResponse.json({ message: 'Insufficient historical data for prediction' }, { status: 400 });
    }

    const prices = historicalData.map((d: any) => d.close);
    const currentPrice = prices[prices.length - 1];
    const metricsUsed: string[] = ['Historical Price'];

    // Calculate volatility if not provided
    let volatility = stockMetrics?.volatility;
    if (volatility === undefined || volatility === null) {
      const volatilityResult = calculateAnnualizedVolatility(
        historicalData.map((d: any, i: number) => ({
          date: new Date(Date.now() - (historicalData.length - i - 1) * 86400000).toISOString().split('T')[0],
          close: d.close
        }))
      );
      volatility = volatilityResult || 0;
    }

    // Analyze news sentiment
    const newsSentimentScore = newsArticles ? analyzeNewsSentiment(newsArticles) : 0;
    console.log('Calculated newsSentimentScore for ticker:', params.ticker, newsSentimentScore); // Add this line

    try {
        let lstmPred: number;
        let linearPred: number;

        // Build comprehensive feature matrix
        // [price, pe, pb, marketCap, sma20, sma50, rsi, momentum, volatility, newsSentiment]
        const features: number[][] = [];

        // Normalize metrics to reasonable scales for comparison
        const normalizedPE = stockMetrics?.peRatio !== undefined && stockMetrics.peRatio !== null
            ? Math.min(stockMetrics.peRatio, 100) / 100
            : 0.5;
        const normalizedPB = stockMetrics?.pbRatio !== undefined && stockMetrics.pbRatio !== null
            ? Math.min(stockMetrics.pbRatio, 10) / 10
            : 0.5;
        const normalizedMC = stockMetrics?.marketCap !== undefined && stockMetrics.marketCap !== null
            ? Math.min(stockMetrics.marketCap / 1_000_000_000, 1000) / 1000
            : 0.5;

        // Normalize technical indicators (0-1 or standardized ranges)
        const normalizedSMA20 = stockMetrics?.sma20 !== undefined && stockMetrics.sma20 !== null
            ? stockMetrics.sma20 / currentPrice
            : 1;
        const normalizedSMA50 = stockMetrics?.sma50 !== undefined && stockMetrics.sma50 !== null
            ? stockMetrics.sma50 / currentPrice
            : 1;
        const normalizedRSI = stockMetrics?.rsi !== undefined && stockMetrics.rsi !== null
            ? stockMetrics.rsi / 100
            : 0.5;
        const normalizedMomentum = stockMetrics?.momentum !== undefined && stockMetrics.momentum !== null
            ? Math.tanh((stockMetrics.momentum / currentPrice) * 10)
            : 0; // Use tanh to bound momentum between -1 and 1
        const normalizedVolatility = Math.min(volatility, 100) / 100; // Normalize to 0-1 range (0-100% volatility)
        const normalizedNews = Math.tanh(newsSentimentScore); // Bound news sentiment between -1 and 1

        for (const priceData of historicalData) {
            features.push([
                priceData.close,
                normalizedPE,
                normalizedPB,
                normalizedMC,
                normalizedSMA20,
                normalizedSMA50,
                normalizedRSI,
                normalizedMomentum,
                normalizedVolatility,
                normalizedNews,
            ]);
        }

        lstmPred = await lstmPredictionMultivariate(features);
        linearPred = linearRegressionMultivariate(features);

        // Only add metrics to metricsUsed if they were actually provided
        if (stockMetrics?.peRatio !== undefined && stockMetrics.peRatio !== null && stockMetrics.peRatio > 0)
            metricsUsed.push('P/E Ratio');
        if (stockMetrics?.pbRatio !== undefined && stockMetrics.pbRatio !== null && stockMetrics.pbRatio > 0)
            metricsUsed.push('P/B Ratio');
        if (stockMetrics?.marketCap !== undefined && stockMetrics.marketCap !== null && stockMetrics.marketCap > 0)
            metricsUsed.push('Market Cap');
        if (stockMetrics?.sma20 !== undefined && stockMetrics.sma20 !== null)
            metricsUsed.push('SMA 20');
        if (stockMetrics?.sma50 !== undefined && stockMetrics.sma50 !== null)
            metricsUsed.push('SMA 50');
        if (stockMetrics?.rsi !== undefined && stockMetrics.rsi !== null)
            metricsUsed.push('RSI');
        if (stockMetrics?.momentum !== undefined && stockMetrics.momentum !== null)
            metricsUsed.push('Momentum');
        if (volatility && volatility > 0)
            metricsUsed.push('Volatility');
        if (newsArticles && newsArticles.length > 0)
            metricsUsed.push('News Sentiment');

        // Average the two predictions
        const avgPrediction = (lstmPred + linearPred) / 2;
        const priceChange = avgPrediction - currentPrice;
        const percentChange = (priceChange / currentPrice) * 100;

        // Determine confidence based on model agreement
        const modelDifference = Math.abs(lstmPred - linearPred) / currentPrice;
        let confidence = 'Low';
        if (modelDifference < 0.05) confidence = 'High';
        else if (modelDifference < 0.10) confidence = 'Medium';

        return NextResponse.json({
            prediction: avgPrediction,
            lstmPrediction: lstmPred,
            linearPrediction: linearPred,
            priceChange,
            percentChange,
            confidence,
            metricsUsed,
            newsSentimentScore,
        });
    } catch (error) {
        // Fallback to linear regression only
        const linearPred = linearRegression(prices);
        const priceChange = linearPred - currentPrice;
        const percentChange = (priceChange / currentPrice) * 100;

        return NextResponse.json({
            prediction: linearPred,
            lstmPrediction: linearPred,
            linearPrediction: linearPred,
            priceChange,
            percentChange,
            confidence: 'Low',
            metricsUsed,
            newsSentimentScore,
        });
    }
}
