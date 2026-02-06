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
import os
import random
from datetime import datetime, timedelta

# Suppress warnings
warnings.filterwarnings('ignore')
tf.get_logger().setLevel('ERROR')

# Set random seeds for reproducibility
os.environ['TF_DETERMINISTIC_OPS'] = '1'
os.environ['PYTHONHASHSEED'] = '0'
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '3'  # Suppress TensorFlow logging
np.random.seed(42)
tf.random.set_seed(42)
random.seed(42)

# Disable unnecessary TensorFlow features for CPU
tf.config.set_visible_devices([], 'GPU')
tf.config.experimental.set_memory_growth = False

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
        
        # Detect if stock is highly volatile
        daily_changes = np.abs(stock_data['log_returns'].dropna()) * 100
        avg_daily_volatility = daily_changes.mean()
        max_daily_volatility = daily_changes.max()
        
        # Detect if stock is in a strong growth trend
        close_prices = stock_data['Close'].values
        recent_20_days = close_prices[-20:]
        older_20_days = close_prices[-40:-20]
        
        recent_avg = np.mean(recent_20_days)
        older_avg = np.mean(older_20_days)
        growth_rate = ((recent_avg - older_avg) / older_avg) * 100 if older_avg > 0 else 0
        
        # Check if price is in uptrend (higher highs and higher lows)
        recent_high = np.max(recent_20_days)
        older_high = np.max(older_20_days)
        recent_low = np.min(recent_20_days)
        older_low = np.min(older_20_days)
        
        is_uptrend = (recent_high > older_high) and (recent_low > older_low)
        
        # Classify stock type
        is_high_volatility = max_daily_volatility > 5.0 or avg_daily_volatility > 2.5
        is_growth_stock = growth_rate > 2.0 and is_uptrend  # >2% growth in 20 days + uptrend
        
        # For stable high-growth stocks, don't penalize them as highly volatile
        if is_growth_stock and avg_daily_volatility < 3.5:
            is_high_volatility = False  # Treat as stable despite some volatility

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
        all_features = stock_data.select_dtypes(include=np.number)
        
        # Keep only the most important features to reduce model size
        important_cols = ['Open', 'High', 'Low', 'Close', 'Volume']
        technical_cols = [col for col in all_features.columns if col not in important_cols][:8]  # Only top 8 technical indicators
        
        selected_cols = important_cols + technical_cols
        selected_cols = [col for col in selected_cols if col in all_features.columns]
        
        features = all_features[selected_cols].values
        
        min_data_points = max(21, 30, 200) # For EMA 200
        if len(stock_data) < min_data_points:
            raise ValueError(f"Insufficient data. Need at least {min_data_points} data points, got {len(stock_data)}")

        train_size = int(len(features) * 0.8)
        train_features, test_features = features[0:train_size], features[train_size:len(features)]

        scaler = MinMaxScaler(feature_range=(0, 1))
        scaled_train_features = scaler.fit_transform(train_features)
        scaled_test_features = scaler.transform(test_features)
        scaled_features_full = np.vstack((scaled_train_features, scaled_test_features))

        # Adjust time_step for volatile stocks to capture shorter patterns
        # For growth stocks, use longer history to capture trend
        time_step = 10 if is_high_volatility else (25 if is_growth_stock else 20)
        num_features = features.shape[1]

        X_nn_train, y_nn_train = create_dataset(scaled_train_features, time_step)
        X_nn_test, y_nn_test = create_dataset(scaled_test_features, time_step)

        if len(X_nn_train) == 0 or len(X_nn_test) == 0:
            raise ValueError(f"Not enough data to create sequences with time_step={time_step}")

        X_nn_train = X_nn_train.reshape(X_nn_train.shape[0], time_step * num_features)
        X_nn_test = X_nn_test.reshape(X_nn_test.shape[0], time_step * num_features)

        # Adjust model complexity for different stock types
        if is_high_volatility:
            # Volatile stocks: minimal model to avoid overfitting and memory issues
            model = tf.keras.Sequential([
                tf.keras.layers.Dense(32, activation='relu', input_shape=(time_step * num_features,)),
                tf.keras.layers.Dropout(0.2),
                tf.keras.layers.Dense(16, activation='relu'),
                tf.keras.layers.Dense(1)
            ])
        elif is_growth_stock:
            # Growth stocks: lightweight model optimized for CPU
            model = tf.keras.Sequential([
                tf.keras.layers.Dense(48, activation='relu', input_shape=(time_step * num_features,)),
                tf.keras.layers.Dropout(0.1),
                tf.keras.layers.Dense(24, activation='relu'),
                tf.keras.layers.Dense(1)
            ])
        else:
            # Stable stocks: minimal complexity
            model = tf.keras.Sequential([
                tf.keras.layers.Dense(32, activation='relu', input_shape=(time_step * num_features,)),
                tf.keras.layers.Dropout(0.1),
                tf.keras.layers.Dense(16, activation='relu'),
                tf.keras.layers.Dense(1)
            ])

        model.compile(optimizer='adam', loss='mean_squared_error')
        
        # Reduce epochs and batch size for CPU
        epochs = 80 if is_high_volatility else (80 if is_growth_stock else 60)
        batch_size = 8 if is_high_volatility else (8 if is_growth_stock else 8)
        patience = 12 if is_high_volatility else (12 if is_growth_stock else 10)
        
        model.fit(
            X_nn_train, y_nn_train, 
            epochs=epochs, 
            batch_size=batch_size, 
            validation_split=0.2,
            verbose=0,
            callbacks=[
                tf.keras.callbacks.EarlyStopping(
                    monitor='val_loss',
                    patience=patience,
                    restore_best_weights=True
                )
            ]
        )

        nn_test_predictions_scaled = model.predict(X_nn_test, verbose=0)
        
        dummy_nn_preds = np.zeros((len(nn_test_predictions_scaled), num_features))
        dummy_nn_preds[:, 0] = nn_test_predictions_scaled.flatten()
        nn_test_predictions = scaler.inverse_transform(dummy_nn_preds)[:, 0]

        dummy_nn_actuals = np.zeros((len(y_nn_test), num_features))
        dummy_nn_actuals[:, 0] = y_nn_test.flatten()
        nn_test_actuals = scaler.inverse_transform(dummy_nn_actuals)[:, 0]

        nn_mae = mean_absolute_error(nn_test_actuals, nn_test_predictions)
        nn_rmse = np.sqrt(mean_squared_error(nn_test_actuals, nn_test_predictions))
        
        current_price = stock_data['Close'].iloc[-1]
        
        # Detect if predictions are insane (model completely failed)
        # If MAE is > 20% of current price, something is very wrong
        if nn_mae > current_price * 0.20:
            # Fall back to simple baseline: predict next price is similar to recent average
            # with range based on recent volatility
            recent_prices = stock_data['Close'].tail(20).values
            baseline_prediction = np.mean(recent_prices)
            baseline_volatility = np.std(recent_prices)
            
            # For growth stocks, factor in the uptrend bias
            if is_growth_stock:
                baseline_prediction = baseline_prediction * (1 + growth_rate / 100)
            
            # Use actual historical volatility, not the broken model
            nn_mae = baseline_volatility * 1.5
            nn_rmse = baseline_volatility * 2.0
            final_prediction = baseline_prediction
            
            # For growth stocks, expand the range slightly to allow for continuation
            max_range = current_price * 0.15 if is_growth_stock else current_price * 0.12
            
            result = {
                "ticker": ticker,
                "current_price": round(current_price, 2),
                "predicted_change_range": [
                    round(max(baseline_prediction - nn_mae, -max_range) - current_price, 2),
                    round(min(baseline_prediction + nn_mae, max_range) - current_price, 2)
                ],
                "accuracy_metrics": {
                    "neural_network": { "mae": round(nn_mae, 2), "rmse": round(nn_rmse, 2) }
                },
                "model_status": "fallback_baseline_model",
                "stock_type": "growth_stock" if is_growth_stock else ("high_volatility_stock" if is_high_volatility else "stable_stock"),
                "growth_rate_20d": round(growth_rate, 2),
                "note": "Neural network predictions were unreliable. Using historical baseline instead."
            }
            print(json.dumps(result))
            return
        
        last_sequence = scaled_features_full[-time_step:].reshape(1, time_step * num_features)
        next_prediction_scaled = model.predict(last_sequence, verbose=0)[0][0]
        
        dummy_prediction = np.zeros((1, num_features))
        dummy_prediction[0, 0] = next_prediction_scaled
        final_prediction = scaler.inverse_transform(dummy_prediction)[0, 0]
        
        # For growth stocks, adjust prediction upward slightly if it's in uptrend
        if is_growth_stock and final_prediction < current_price:
            # If model predicts downtrend but stock is in uptrend, bias it slightly upward
            final_prediction = current_price + (current_price * growth_rate / 100 * 0.5)
        
        # Additional sanity check: predicted price should be within 25% of current price (more lenient for growth)
        max_deviation = 0.25 if is_growth_stock else 0.20
        if abs(final_prediction - current_price) > current_price * max_deviation:
            # Use recent average as fallback
            final_prediction = np.mean(stock_data['Close'].tail(20).values)
        
        predicted_change_lower = (final_prediction - nn_mae) - current_price
        predicted_change_upper = (final_prediction + nn_mae) - current_price
        
        # Hard cap on prediction ranges - more lenient for growth stocks
        if is_growth_stock:
            max_reasonable_range = current_price * 0.15  # ±15% for growth stocks
        else:
            max_reasonable_range = current_price * 0.12  # ±12% for stable stocks
        
        predicted_change_lower = max(predicted_change_lower, -max_reasonable_range)
        predicted_change_upper = min(predicted_change_upper, max_reasonable_range)
        
        result = {
            "ticker": ticker,
            "current_price": round(current_price, 2),
            "predicted_change_range": [round(predicted_change_lower, 2), round(predicted_change_upper, 2)],
            "accuracy_metrics": {
                "neural_network": { "mae": round(nn_mae, 2), "rmse": round(nn_rmse, 2) }
            },
            "stock_type": "growth_stock" if is_growth_stock else ("high_volatility_stock" if is_high_volatility else "stable_stock"),
            "growth_rate_20d": round(growth_rate, 2),
            "is_uptrend": is_uptrend
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
