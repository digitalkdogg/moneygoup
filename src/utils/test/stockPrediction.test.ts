import { predictStockPrice } from '../stockPrediction';
import * as tf from '@tensorflow/tfjs';

// Mock TensorFlow to avoid actual heavy computations and potential environment issues
jest.mock('@tensorflow/tfjs', () => ({
  sequential: jest.fn().mockReturnValue({
    add: jest.fn(),
    compile: jest.fn(),
    fit: jest.fn().mockResolvedValue({}),
    predict: jest.fn().mockReturnValue({
      dataSync: jest.fn().mockReturnValue([0.5]),
      dispose: jest.fn(),
    }),
    dispose: jest.fn(),
  }),
  layers: {
    lstm: jest.fn(),
    dropout: jest.fn(),
    dense: jest.fn(),
  },
  train: {
    adam: jest.fn(),
  },
  tensor3d: jest.fn().mockReturnValue({ dispose: jest.fn() }),
  tensor2d: jest.fn().mockReturnValue({ dispose: jest.fn() }),
}));

describe('stockPrediction', () => {
  const mockHistoricalData = Array.from({ length: 30 }, (_, i) => ({
    close: 100 + i,
  }));

  test('returns a prediction result for valid input', async () => {
    const result = await predictStockPrice(mockHistoricalData);
    
    expect(result).toBeDefined();
    expect(result.prediction).toBeGreaterThan(0);
    expect(result.confidence).toBeDefined();
    expect(result.metricsUsed).toContain('Historical Price');
  });

  test('throws error for insufficient data', async () => {
    await expect(predictStockPrice([{ close: 100 }])).rejects.toThrow('Insufficient historical data');
  });

  test('includes additional metrics in metricsUsed if provided', async () => {
    const stockMetrics = {
      peRatio: 15,
      rsi: 40,
    };
    const result = await predictStockPrice(mockHistoricalData, stockMetrics);
    expect(result.metricsUsed).toContain('P/E Ratio');
    expect(result.metricsUsed).toContain('RSI');
  });

  test('calculates news sentiment if articles provided', async () => {
    const newsArticles = [
      { title: 'Market surge' },
      { title: 'Stock rally' },
    ];
    const result = await predictStockPrice(mockHistoricalData, {}, newsArticles);
    expect(result.newsSentimentScore).toBeGreaterThan(0);
    expect(result.metricsUsed).toContain('News Sentiment');
  });
});
