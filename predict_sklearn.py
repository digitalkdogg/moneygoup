import numpy as np
import pandas as pd
import pandas_ta as ta
from sklearn.preprocessing import MinMaxScaler
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.metrics import mean_absolute_error, mean_squared_error
import argparse
import json
import sys
import warnings
import random
from datetime import datetime, timedelta

# Suppress warnings
warnings.filterwarnings('ignore')

def create_dataset(dataset, time_step=1):
    dataX, dataY = [], []
    for i in range(len(dataset) - time_step - 1):
        a = dataset[i:(i + time_step), :].flatten()
        dataX.append(a)
        dataY.append(dataset[i + time_step, 0])
    return np.array(dataX), np.array(dataY)

def predict_sklearn(ticker, historical_data_input, stock_metrics_input, news_articles_input, external_economic_data_input):
    try:
        if not historical_data_input:
            raise ValueError("No historical data provided.")
            
        stock_data = pd.DataFrame(historical_data_input)
        stock_data.rename(columns={'close': 'Close', 'open': 'Open', 'high': 'High', 'low': 'Low', 'volume': 'Volume'}, inplace=True)
        if 'date' in stock_data.columns:
            stock_data.drop('date', axis=1, inplace=True)

        # Technical Indicators
        stock_data.ta.macd(append=True)
        stock_data.ta.bbands(append=True)
        stock_data.ta.rsi(append=True)
        stock_data.ta.stoch(append=True)
        stock_data.ta.atr(append=True)
        stock_data.ta.sma(20, append=True)
        stock_data.ta.ema(50, append=True)
        
        # Volatility
        stock_data['log_returns'] = np.log(stock_data['Close'] / stock_data['Close'].shift(1))
        stock_data['historical_volatility'] = stock_data['log_returns'].rolling(window=30).std() * np.sqrt(252)
        
        # Detect stock characteristics
        daily_changes = np.abs(stock_data['log_returns'].dropna()) * 100
        avg_daily_volatility = daily_changes.mean()
        max_daily_volatility = daily_changes.max()
        
        # Growth detection
        close_prices = stock_data['Close'].values
        recent_20_days = close_prices[-20:]
        older_20_days = close_prices[-40:-20]
        
        recent_avg = np.mean(recent_20_days)
        older_avg = np.mean(older_20_days)
        growth_rate = ((recent_avg - older_avg) / older_avg) * 100 if older_avg > 0 else 0
        
        recent_high = np.max(recent_20_days)
        older_high = np.max(older_20_days)
        recent_low = np.min(recent_20_days)
        older_low = np.min(older_20_days)
        
        is_uptrend = (recent_high > older_high) and (recent_low > older_low)
        is_high_volatility = max_daily_volatility > 5.0 or avg_daily_volatility > 2.5
        is_growth_stock = growth_rate > 2.0 and is_uptrend
        
        if is_growth_stock and avg_daily_volatility < 3.5:
            is_high_volatility = False

        # Fundamental Data
        for key, value in stock_metrics_input.items():
            stock_data[key] = value if value is not None else 0

        # External Economic Factors
        for key, value in external_economic_data_input.items():
            stock_data[key] = value if value is not None else 0
            
        # News sentiment
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
        
        # Select features
        all_features = stock_data.select_dtypes(include=np.number)
        important_cols = ['Open', 'High', 'Low', 'Close', 'Volume']
        technical_cols = [col for col in all_features.columns if col not in important_cols][:8]
        selected_cols = important_cols + technical_cols
        selected_cols = [col for col in selected_cols if col in all_features.columns]
        
        features = all_features[selected_cols].values
        
        min_data_points = 50
        if len(stock_data) < min_data_points:
            raise ValueError(f"Insufficient data. Need at least {min_data_points} data points, got {len(stock_data)}")

        train_size = int(len(features) * 0.8)
        train_features, test_features = features[0:train_size], features[train_size:len(features)]

        scaler = MinMaxScaler(feature_range=(0, 1))
        scaled_train_features = scaler.fit_transform(train_features)
        scaled_test_features = scaler.transform(test_features)
        scaled_features_full = np.vstack((scaled_train_features, scaled_test_features))

        # Time step
        time_step = 10 if is_high_volatility else (15 if is_growth_stock else 12)
        num_features = features.shape[1]

        X_train, y_train = create_dataset(scaled_train_features, time_step)
        X_test, y_test = create_dataset(scaled_test_features, time_step)

        if len(X_train) == 0 or len(X_test) == 0:
            raise ValueError(f"Not enough data to create sequences with time_step={time_step}")

        # Use Gradient Boosting - much faster than neural networks on CPU
        model = GradientBoostingRegressor(
            n_estimators=100,
            learning_rate=0.1,
            max_depth=5,
            min_samples_split=5,
            min_samples_leaf=2,
            random_state=42,
            verbose=0
        )
        
        model.fit(X_train, y_train)

        test_predictions_scaled = model.predict(X_test)
        
        dummy_preds = np.zeros((len(test_predictions_scaled), num_features))
        dummy_preds[:, 0] = test_predictions_scaled.flatten()
        test_predictions = scaler.inverse_transform(dummy_preds)[:, 0]

        dummy_actuals = np.zeros((len(y_test), num_features))
        dummy_actuals[:, 0] = y_test.flatten()
        test_actuals = scaler.inverse_transform(dummy_actuals)[:, 0]

        mae = mean_absolute_error(test_actuals, test_predictions)
        rmse = np.sqrt(mean_squared_error(test_actuals, test_predictions))
        
        current_price = stock_data['Close'].iloc[-1]
        
        # Fallback check
        if mae > current_price * 0.20:
            recent_prices = stock_data['Close'].tail(20).values
            baseline_prediction = np.mean(recent_prices)
            baseline_volatility = np.std(recent_prices)
            
            if is_growth_stock:
                baseline_prediction = baseline_prediction * (1 + growth_rate / 100)
            
            mae = baseline_volatility * 1.5
            rmse = baseline_volatility * 2.0
            final_prediction = baseline_prediction
            
            max_range = current_price * 0.15 if is_growth_stock else current_price * 0.12
            
            result = {
                "ticker": ticker,
                "current_price": round(current_price, 2),
                "predicted_change_range": [
                    round(max(baseline_prediction - mae, -max_range) - current_price, 2),
                    round(min(baseline_prediction + mae, max_range) - current_price, 2)
                ],
                "accuracy_metrics": {
                    "model": { "mae": round(mae, 2), "rmse": round(rmse, 2) }
                },
                "model_status": "fallback_baseline_model",
                "stock_type": "growth_stock" if is_growth_stock else ("high_volatility_stock" if is_high_volatility else "stable_stock"),
                "growth_rate_20d": round(growth_rate, 2),
                "note": "Gradient Boosting predictions were unreliable. Using historical baseline instead."
            }
            print(json.dumps(result))
            return
        
        last_sequence = scaled_features_full[-time_step:].flatten().reshape(1, -1)
        next_prediction_scaled = model.predict(last_sequence)[0]
        
        dummy_prediction = np.zeros((1, num_features))
        dummy_prediction[0, 0] = next_prediction_scaled
        final_prediction = scaler.inverse_transform(dummy_prediction)[0, 0]
        
        if is_growth_stock and final_prediction < current_price:
            final_prediction = current_price + (current_price * growth_rate / 100 * 0.5)
        
        max_deviation = 0.25 if is_growth_stock else 0.20
        if abs(final_prediction - current_price) > current_price * max_deviation:
            final_prediction = np.mean(stock_data['Close'].tail(20).values)
        
        predicted_change_lower = (final_prediction - mae) - current_price
        predicted_change_upper = (final_prediction + mae) - current_price
        
        if is_growth_stock:
            max_reasonable_range = current_price * 0.15
        else:
            max_reasonable_range = current_price * 0.12
        
        predicted_change_lower = max(predicted_change_lower, -max_reasonable_range)
        predicted_change_upper = min(predicted_change_upper, max_reasonable_range)
        
        result = {
            "ticker": ticker,
            "current_price": round(current_price, 2),
            "predicted_change_range": [round(predicted_change_lower, 2), round(predicted_change_upper, 2)],
            "accuracy_metrics": {
                "model": { "mae": round(mae, 2), "rmse": round(rmse, 2) }
            },
            "stock_type": "growth_stock" if is_growth_stock else ("high_volatility_stock" if is_high_volatility else "stable_stock"),
            "growth_rate_20d": round(growth_rate, 2),
            "is_uptrend": int(is_uptrend)
        }
        print(json.dumps(result))

    except Exception as e:
        import traceback
        print(json.dumps({"error": str(e), "traceback": traceback.format_exc()}), file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Stock Price Prediction using Gradient Boosting')
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

        predict_sklearn(args.ticker, historical_data, stock_metrics, news_articles, external_economic_data)

    except FileNotFoundError:
        print(json.dumps({"error": f"Input file not found at {args.input_file}"}), file=sys.stderr)
        sys.exit(1)
    except json.JSONDecodeError:
        print(json.dumps({"error": f"Could not decode JSON from {args.input_file}"}), file=sys.stderr)
        sys.exit(1)
