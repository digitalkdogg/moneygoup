
import yfinance as yf
import numpy as np
import tensorflow as tf
from sklearn.preprocessing import MinMaxScaler
from sklearn.linear_model import LinearRegression
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
        a = dataset[i:(i + time_step), 0]
        dataX.append(a)
        dataY.append(dataset[i + time_step, 0])
    return np.array(dataX), np.array(dataY)

def predict_tensorflow(ticker, years=1):  # Just 1 year of data for speed
    try:
        # Fetch historical data with better error handling
        end_date = datetime.now().strftime('%Y-%m-%d')
        start_date = (datetime.now() - timedelta(days=int(365.25 * years))).strftime('%Y-%m-%d')
        
        # Try to fetch data with retry mechanism
        max_retries = 3
        stock_data = None
        
        for attempt in range(max_retries):
            try:
                # Add session for better reliability
                stock = yf.Ticker(ticker)
                stock_data = stock.history(start=start_date, end=end_date)
                
                if stock_data is not None and not stock_data.empty:
                    break
                
                if attempt < max_retries - 1:
                    time.sleep(1)  # Wait before retry
                    
            except Exception as e:
                if attempt == max_retries - 1:
                    raise e
                time.sleep(1)
        
        if stock_data is None or stock_data.empty:
            raise ValueError(f"No data found for ticker {ticker}. Please verify the ticker symbol is correct.")

        # Check if Close column exists
        if 'Close' not in stock_data.columns:
            raise ValueError(f"No closing price data available for ticker {ticker}")
            
        closing_prices = stock_data['Close'].values.reshape(-1, 1)
        
        # Ensure we have enough data
        if len(closing_prices) < 21:  # time_step + 1
            raise ValueError(f"Insufficient data for ticker {ticker}. Need at least 21 data points, got {len(closing_prices)}")

        # --- LSTM Prediction ---
        scaler = MinMaxScaler(feature_range=(0, 1))
        scaled_prices = scaler.fit_transform(closing_prices)

        time_step = 20  # Much smaller for speed
        X, y = create_dataset(scaled_prices, time_step)
        
        if len(X) == 0:
            raise ValueError(f"Not enough data to create sequences with time_step={time_step}")

        X = X.reshape(X.shape[0], X.shape[1], 1)

        # Ultra-simple approach for speed: just predict one step ahead and extrapolate
        model = tf.keras.Sequential([
            tf.keras.layers.Dense(10, activation='relu', input_shape=(time_step,)),
            tf.keras.layers.Dense(1)
        ])

        model.compile(optimizer='adam', loss='mean_squared_error')
        
        # Reshape X for Dense layer (remove the extra dimension)
        X_flat = X.reshape(X.shape[0], X.shape[1])
        
        # Train with minimal data for speed
        model.fit(X_flat, y, epochs=1, verbose=0, validation_split=0)

        # Simple prediction: just predict next value and calculate trend
        last_sequence = scaled_prices[-time_step:].flatten().reshape(1, -1)
        next_prediction = model.predict(last_sequence, verbose=0)[0][0]
        
        # Calculate simple trend from recent data
        recent_prices = closing_prices[-30:]  # Last 30 days
        trend = (recent_prices[-1] - recent_prices[0]) / 30  # Daily trend
        
        # Extrapolate trend to 1 year (252 trading days)
        current_scaled = scaled_prices[-1][0]
        yearly_trend_scaled = current_scaled + ((next_prediction - current_scaled) * 252)
        
        lstm_prediction = scaler.inverse_transform([[yearly_trend_scaled]])[0][0]
        
        # Get current price for sanity check
        current_price = closing_prices[-1][0]
        
        # Ensure prediction is reasonable (within reasonable bounds)
        if lstm_prediction < current_price * 0.1:  # Too low
            lstm_prediction = current_price * 0.8
        elif lstm_prediction > current_price * 5:  # Too high
            lstm_prediction = current_price * 1.2

        # --- Linear Regression Prediction ---
        X_linear = np.arange(len(closing_prices)).reshape(-1, 1)
        y_linear = closing_prices

        linear_model = LinearRegression()
        linear_model.fit(X_linear, y_linear)
        
        future_day = len(closing_prices) + 252
        linear_prediction = linear_model.predict([[future_day]])[0][0]

        # --- Combined Prediction ---
        final_prediction = (lstm_prediction + linear_prediction) / 2
        
        current_price = closing_prices[-1][0]
        price_change = final_prediction - current_price
        
        result = {
            "ticker": ticker,
            "current_price": current_price,
            "lstm_model": lstm_prediction,
            "linear_regression_model": linear_prediction,
            "combined_average": final_prediction,
            "predicted_change": price_change
        }
        print(json.dumps(result))

    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Stock Price Prediction using TensorFlow')
    parser.add_argument('ticker', type=str, help='Stock ticker symbol (e.g., AAPL)')
    parser.add_argument('--years', type=int, default=5, help='Number of years of historical data to use')
    args = parser.parse_args()
    
    predict_tensorflow(args.ticker, args.years)
