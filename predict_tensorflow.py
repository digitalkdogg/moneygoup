import yfinance as yf
import numpy as np
import pandas as pd
import pandas_ta as ta
import tensorflow as tf
from sklearn.preprocessing import MinMaxScaler
from sklearn.linear_model import LinearRegression
from sklearn.model_selection import train_test_split
from sklearn.metrics import mean_absolute_error, mean_squared_error
import argparse
import json
import sys
import warnings
import time
from datetime import datetime, timedelta

# Suppress warnings
warnings.filterwarnings('ignore')
tf.get_logger().setLevel('ERROR')

def create_dataset(dataset, time_step=1):
    dataX, dataY = [], []
    for i in range(len(dataset) - time_step - 1):
        a = dataset[i:(i + time_step), :]
        dataX.append(a)
        dataY.append(dataset[i + time_step, 0])
    return np.array(dataX), np.array(dataY)

def predict_tensorflow(ticker, historical_data_input, stock_metrics_input, news_articles_input, external_economic_data_input):
    try:
        if not historical_data_input:
            raise ValueError("No historical data provided.")
            
        stock_data = pd.DataFrame(historical_data_input)
        stock_data.rename(columns={'close': 'Close', 'open': 'Open', 'high': 'High', 'low': 'Low', 'volume': 'Volume'}, inplace=True)
        # Explicitly handle 'date' column. It should not be used in scaling.
        if 'date' in stock_data.columns:
            stock_data.drop('date', axis=1, inplace=True)

        # Technical Indicators
        stock_data.ta.macd(append=True)
        stock_data.ta.bbands(append=True)
        stock_data.ta.rsi(append=True)
        stock_data.ta.stoch(append=True)
        stock_data.ta.willr(append=True)
        stock_data.ta.atr(append=True)
        stock_data.ta.sma(20, append=True)
        stock_data.ta.ema(50, append=True)
        stock_data.ta.ema(200, append=True)
        
        # Volatility
        stock_data['log_returns'] = np.log(stock_data['Close'] / stock_data['Close'].shift(1))
        stock_data['historical_volatility'] = stock_data['log_returns'].rolling(window=30).std() * np.sqrt(252)

        # Fundamental Data
        for key, value in stock_metrics_input.items():
            stock_data[key] = value if value is not None else 0

        # External Economic Factors
        for key, value in external_economic_data_input.items():
            stock_data[key] = value if value is not None else 0
            
        # Calculate news sentiment score
        news_sentiment_score_val = 0
        if news_articles_input:
            relevant_articles_count = 0
            for article in news_articles_input:
                if article.get('sentiment_score') == 3:
                    news_sentiment_score_val += 1
                    relevant_articles_count += 1
                elif article.get('sentiment_score') == -3:
                    news_sentiment_score_val -= 1
                    relevant_articles_count += 1
            
            if relevant_articles_count > 0:
                news_sentiment_score_val = np.tanh(news_sentiment_score_val / relevant_articles_count)
            else:
                news_sentiment_score_val = 0
        stock_data['NewsSentiment'] = news_sentiment_score_val

        stock_data = stock_data.ffill().bfill()
        
        # Select only numerical columns for features to prevent string to float conversion errors
        features = stock_data.select_dtypes(include=np.number).values
        
        min_data_points = max(21, 30, 200) # For EMA 200
        if len(stock_data) < min_data_points:
            raise ValueError(f"Insufficient data. Need at least {min_data_points} data points, got {len(stock_data)}")

        train_size = int(len(features) * 0.8)
        train_features, test_features = features[0:train_size], features[train_size:len(features)]

        scaler = MinMaxScaler(feature_range=(0, 1))
        scaled_train_features = scaler.fit_transform(train_features)
        scaled_test_features = scaler.transform(test_features)
        scaled_features_full = np.vstack((scaled_train_features, scaled_test_features))

        time_step = 20
        num_features = features.shape[1]

        X_nn_train, y_nn_train = create_dataset(scaled_train_features, time_step)
        X_nn_test, y_nn_test = create_dataset(scaled_test_features, time_step)

        if len(X_nn_train) == 0 or len(X_nn_test) == 0:
            raise ValueError(f"Not enough data to create sequences with time_step={time_step}")

        X_nn_train = X_nn_train.reshape(X_nn_train.shape[0], time_step * num_features)
        X_nn_test = X_nn_test.reshape(X_nn_test.shape[0], time_step * num_features)

        model = tf.keras.Sequential([
            tf.keras.layers.Dense(50, activation='relu', input_shape=(time_step * num_features,)),
            tf.keras.layers.Dense(25, activation='relu'),
            tf.keras.layers.Dense(1)
        ])

        model.compile(optimizer='adam', loss='mean_squared_error')
        model.fit(X_nn_train, y_nn_train, epochs=10, batch_size=32, verbose=0)

        nn_test_predictions_scaled = model.predict(X_nn_test, verbose=0)
        
        dummy_nn_preds = np.zeros((len(nn_test_predictions_scaled), num_features))
        dummy_nn_preds[:, 0] = nn_test_predictions_scaled.flatten()
        nn_test_predictions = scaler.inverse_transform(dummy_nn_preds)[:, 0]

        dummy_nn_actuals = np.zeros((len(y_nn_test), num_features))
        dummy_nn_actuals[:, 0] = y_nn_test.flatten()
        nn_test_actuals = scaler.inverse_transform(dummy_nn_actuals)[:, 0]

        nn_mae = mean_absolute_error(nn_test_actuals, nn_test_predictions)
        nn_rmse = np.sqrt(mean_squared_error(nn_test_actuals, nn_test_predictions))

        last_sequence = scaled_features_full[-time_step:].reshape(1, time_step * num_features)
        next_prediction_scaled = model.predict(last_sequence, verbose=0)[0][0]
        
        dummy_prediction = np.zeros((1, num_features))
        dummy_prediction[0, 0] = next_prediction_scaled
        final_prediction = scaler.inverse_transform(dummy_prediction)[0, 0]
        
        current_price = stock_data['Close'].iloc[-1]
        
        predicted_change_lower = (final_prediction - nn_mae) - current_price
        predicted_change_upper = (final_prediction + nn_mae) - current_price
        
        result = {
            "ticker": ticker,
            "current_price": current_price,
            "predicted_change_range": [round(predicted_change_lower, 2), round(predicted_change_upper, 2)],
            "accuracy_metrics": {
                "neural_network": { "mae": round(nn_mae, 2), "rmse": round(nn_rmse, 2) }
            }
        }
        print(json.dumps(result))

    except Exception as e:
        import traceback
        print(json.dumps({"error": str(e), "traceback": traceback.format_exc()}), file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Stock Price Prediction using TensorFlow')
    parser.add_argument('ticker', type=str, help='Stock ticker symbol (e.g., AAPL)')
    parser.add_argument('--input_file', type=str, help='Path to JSON file with input data', required=True)
    args = parser.parse_args()

    try:
        with open(args.input_file, 'r') as f:
            input_data = json.load(f)
        
        historical_data = input_data.get("historicalData", [])
        stock_metrics = input_data.get("stockMetrics", {})
        news_articles = input_data.get("newsArticles", [])
        external_economic_data = input_data.get("externalEconomicData", {})

        predict_tensorflow(args.ticker, historical_data, stock_metrics, news_articles, external_economic_data)

    except FileNotFoundError:
        print(json.dumps({"error": f"Input file not found at {args.input_file}"}), file=sys.stderr)
        sys.exit(1)
    except json.JSONDecodeError:
        print(json.dumps({"error": f"Could not decode JSON from {args.input_file}"}), file=sys.stderr)
        sys.exit(1)