import yfinance as yf
import numpy as np
import pandas as pd
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

def calculate_rsi(data, window=14):
    delta = data.diff()
    gain = (delta.where(delta > 0, 0)).rolling(window=window).mean()
    loss = (-delta.where(delta < 0, 0)).rolling(window=window).mean()
    rs = gain / (loss + 1e-8)  # Add epsilon to avoid division by zero
    rsi = 100 - (100 / (1 + rs))
    return rsi

def create_dataset(dataset, time_step=1):
    dataX, dataY = [], []
    for i in range(len(dataset) - time_step - 1):
        a = dataset[i:(i + time_step), :]
        dataX.append(a)
        dataY.append(dataset[i + time_step, 0])
    return np.array(dataX), np.array(dataY)

def predict_tensorflow(ticker, historical_data_input, stock_metrics_input, news_articles_input):
    try:
        # Reconstruct stock_data DataFrame from historical_data_input
        # Assuming historical_data_input is an array of objects with 'close'
        if not historical_data_input:
            raise ValueError("No historical data provided.")
            
        # Convert to DataFrame to leverage pandas functionalities
        stock_data = pd.DataFrame(historical_data_input)
        stock_data['Close'] = stock_data['close'].astype(float) # Ensure Close is float

        if 'Close' not in stock_data.columns:
            raise ValueError(f"No closing price data available from input.")
            
        # Get PE and PB ratios from stock_metrics_input
        pe_ratio = stock_metrics_input.get('peRatio') if stock_metrics_input else 0
        if pe_ratio is None:
            pe_ratio = 0
        pb_ratio = stock_metrics_input.get('pbRatio') if stock_metrics_input else 0
        if pb_ratio is None:
            pb_ratio = 0

        # Calculate RSI
        stock_data['RSI'] = calculate_rsi(stock_data['Close'])

        # Add PE and PB as constant columns for now (since they are single values)
        stock_data['PE'] = float(pe_ratio)
        stock_data['PB'] = float(pb_ratio)

        # Calculate news sentiment score
        news_sentiment_score_val = 0
        if news_articles_input:
            relevant_articles_count = 0
            for article in news_articles_input:
                # Consider articles with sentiment_score of exactly +3 or -3
                if article.get('sentiment_score') == 3:
                    news_sentiment_score_val += 1
                    relevant_articles_count += 1
                elif article.get('sentiment_score') == -3:
                    news_sentiment_score_val -= 1
                    relevant_articles_count += 1
            
            # Normalize sentiment score, e.g., using tanh to bound between -1 and 1
            # If there are relevant articles, use the average sentiment, else 0
            if relevant_articles_count > 0:
                news_sentiment_score_val = np.tanh(news_sentiment_score_val / relevant_articles_count)
            else:
                news_sentiment_score_val = 0
        stock_data['NewsSentiment'] = news_sentiment_score_val # Add as a new feature

        # Handle missing values after adding all features
        stock_data = stock_data.ffill()
        stock_data = stock_data.bfill()

        # Define all features for the model
        features_columns = ['Close', 'RSI', 'PE', 'PB', 'NewsSentiment']
        features = stock_data[features_columns].values
        
        # Ensure we have enough data for at least one time_step for training + 1 for prediction
        # And also enough for the RSI window (14 days) and trend (30 days)
        min_data_points = max(21, 30) # time_step + 1 = 21, trend = 30
        if len(stock_data) < min_data_points:
            raise ValueError(f"Insufficient data for ticker {ticker}. Need at least {min_data_points} data points, got {len(stock_data)}")

        
        # Split data into training and testing sets for evaluation
        # We will use the last 20% of the data for testing
        train_size = int(len(features) * 0.8)
        train_features, test_features = features[0:train_size], features[train_size:len(features)]

        scaler = MinMaxScaler(feature_range=(0, 1))
        
        # Fit scaler only on training data to prevent data leakage
        scaled_train_features = scaler.fit_transform(train_features)
        scaled_test_features = scaler.transform(test_features) # Transform test data using scaler fitted on train data

        # Reconstruct the full scaled features for future prediction and consistent indexing
        scaled_features_full = np.vstack((scaled_train_features, scaled_test_features))

        time_step = 20
        num_features = features.shape[1]

        # --- Neural Network Model ---
        X_nn_train, y_nn_train = create_dataset(scaled_train_features, time_step)
        X_nn_test, y_nn_test = create_dataset(scaled_test_features, time_step)

        if len(X_nn_train) == 0 or len(X_nn_test) == 0:
            raise ValueError(f"Not enough data to create sequences for training or testing with time_step={time_step}")

        X_nn_train = X_nn_train.reshape(X_nn_train.shape[0], time_step * num_features)
        X_nn_test = X_nn_test.reshape(X_nn_test.shape[0], time_step * num_features)

        model = tf.keras.Sequential([
            tf.keras.layers.Dense(10, activation='relu', input_shape=(time_step * num_features,)),
            tf.keras.layers.Dense(1)
        ])

        model.compile(optimizer='adam', loss='mean_squared_error')
        model.fit(X_nn_train, y_nn_train, epochs=1, verbose=0, validation_split=0)

        # Evaluate Neural Network on test data
        nn_test_predictions_scaled = model.predict(X_nn_test, verbose=0)
        
        # Inverse transform neural network predictions and actuals
        # Create dummy arrays for inverse transform, as scaler expects `num_features`
        dummy_nn_preds = np.zeros((len(nn_test_predictions_scaled), num_features))
        dummy_nn_preds[:, 0] = nn_test_predictions_scaled.flatten()
        nn_test_predictions = scaler.inverse_transform(dummy_nn_preds)[:, 0]

        dummy_nn_actuals = np.zeros((len(y_nn_test), num_features))
        dummy_nn_actuals[:, 0] = y_nn_test.flatten()
        nn_test_actuals = scaler.inverse_transform(dummy_nn_actuals)[:, 0]

        nn_mae = mean_absolute_error(nn_test_actuals, nn_test_predictions)
        nn_rmse = np.sqrt(mean_squared_error(nn_test_actuals, nn_test_predictions))


        # --- Linear Regression Model ---
        # Linear Regression also trained on 'Close' price from training set
        X_linear_train = np.arange(len(train_features)).reshape(-1, 1)
        y_linear_train = train_features[:, 0] # Close price for training

        X_linear_test = np.arange(len(train_features), len(features)).reshape(-1, 1)
        y_linear_test = features[:, 0][train_size:] # Close price for testing

        linear_model = LinearRegression()
        linear_model.fit(X_linear_train, y_linear_train)
        
        # Evaluate Linear Regression on test data
        linear_test_predictions = linear_model.predict(X_linear_test)
        
        lr_mae = mean_absolute_error(y_linear_test, linear_test_predictions)
        lr_rmse = np.sqrt(mean_squared_error(y_linear_test, linear_test_predictions))

        # --- Combined Model Evaluation ---
        # Ensure test sets are aligned for combining predictions
        # The number of predictions from NN and LR might differ due to time_step
        # Let's take the overlapping part of the test sets for combined evaluation
        min_len_test = min(len(nn_test_predictions), len(linear_test_predictions))
        
        # Adjust actuals if one prediction set is shorter
        if len(nn_test_actuals) > min_len_test:
            combined_test_actuals = nn_test_actuals[:min_len_test]
        else:
            combined_test_actuals = nn_test_actuals

        combined_test_predictions = (nn_test_predictions[:min_len_test] + linear_test_predictions[:min_len_test]) / 2
        
        combined_mae = mean_absolute_error(combined_test_actuals, combined_test_predictions)
        combined_rmse = np.sqrt(mean_squared_error(combined_test_actuals, combined_test_predictions))

        # --- Future Prediction (using full dataset for final 1-year prediction) ---
        last_sequence = scaled_features_full[-time_step:].reshape(1, time_step * num_features)
        next_prediction_scaled = model.predict(last_sequence, verbose=0)[0][0]
        
        dummy_prediction = np.zeros((1, num_features))
        dummy_prediction[0, 0] = next_prediction_scaled
        next_prediction = scaler.inverse_transform(dummy_prediction)[0, 0]

        closing_prices_full = features[:, 0]
        recent_prices_full = closing_prices_full[-30:]
        trend_full = (recent_prices_full[-1] - recent_prices_full[0]) / 30
        
        current_price = closing_prices_full[-1]
        yearly_trend_full = current_price + (trend_full * 252)

        lstm_prediction = (next_prediction + yearly_trend_full) / 2

        if lstm_prediction < current_price * 0.1:
            lstm_prediction = current_price * 0.8
        elif lstm_prediction > current_price * 5:
            lstm_prediction = current_price * 1.2

        X_linear_full = np.arange(len(closing_prices_full)).reshape(-1, 1)
        y_linear_full = closing_prices_full

        linear_model_full = LinearRegression()
        linear_model_full.fit(X_linear_full, y_linear_full)
        
        future_day_full = len(closing_prices_full) + 252
        linear_prediction = linear_model_full.predict([[future_day_full]])[0]

        final_prediction = (lstm_prediction + linear_prediction) / 2
        
        price_change = final_prediction - current_price
        
        result = {
            "ticker": ticker,
            "current_price": current_price,
            "lstm_model_prediction": lstm_prediction,
            "linear_regression_model_prediction": linear_prediction,
            "combined_average_prediction": final_prediction,
            "predicted_change": price_change,
            "accuracy_metrics": {
                "neural_network": {
                    "mae": round(nn_mae, 2),
                    "rmse": round(nn_rmse, 2)
                },
                "linear_regression": {
                    "mae": round(lr_mae, 2),
                    "rmse": round(lr_rmse, 2)
                },
                "combined_model": {
                    "mae": round(combined_mae, 2),
                    "rmse": round(combined_rmse, 2)
                }
            }
        }
        print(json.dumps(result))

    except Exception as e:
        import traceback
        print(json.dumps({"error": str(e)}), file=sys.stdout)
        print(traceback.format_exc(), file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Stock Price Prediction using TensorFlow')
    parser.add_argument('ticker', type=str, help='Stock ticker symbol (e.g., AAPL)')
    parser.add_argument('--input_file', type=str, help='Path to JSON file with input data')
    args = parser.parse_args()

    if not args.input_file:
        print(json.dumps({"error": "input_file argument is required"}))
        sys.exit(1)

    try:
        with open(args.input_file, 'r') as f:
            input_data = json.load(f)
        
        historical_data = input_data.get("historicalData", [])
        stock_metrics = input_data.get("stockMetrics", {})
        news_articles = input_data.get("newsArticles", [])

        predict_tensorflow(args.ticker, historical_data, stock_metrics, news_articles)

    except FileNotFoundError:
        print(json.dumps({"error": f"Input file not found at {args.input_file}"}))
        sys.exit(1)
    except json.JSONDecodeError:
        print(json.dumps({"error": f"Could not decode JSON from {args.input_file}"}))
        sys.exit(1)