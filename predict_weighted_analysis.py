import numpy as np
import pandas as pd
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

# ================================================================================
# CUSTOM JSON ENCODER FOR NUMPY TYPES
# ================================================================================
class NumpyEncoder(json.JSONEncoder):
    """Custom JSON encoder to handle NumPy data types"""
    def default(self, obj):
        if isinstance(obj, (np.integer, np.int64, np.int32)):
            return int(obj)
        elif isinstance(obj, (np.floating, np.float64, np.float32)):
            return float(obj)
        elif isinstance(obj, np.ndarray):
            return obj.tolist()
        elif isinstance(obj, np.bool_):
            return bool(obj)
        return super().default(obj)

# ================================================================================
# WEIGHT DEFINITIONS (From MODEL_METRICS_GUIDE.txt)
# ================================================================================

WEIGHTS = {
    # PRIMARY PRICE FEATURES
    'open': {'min': 0.08, 'max': 0.10, 'name': 'Open Price'},
    'high': {'min': 0.08, 'max': 0.10, 'name': 'High Price'},
    'low': {'min': 0.08, 'max': 0.10, 'name': 'Low Price'},
    'close': {'min': 0.12, 'max': 0.15, 'name': 'Close Price'},
    'volume': {'min': 0.10, 'max': 0.12, 'name': 'Volume'},

    # TECHNICAL INDICATORS
    'macd': {'min': 0.06, 'max': 0.08, 'name': 'MACD'},
    'bollinger_bands': {'min': 0.05, 'max': 0.07, 'name': 'Bollinger Bands'},
    'rsi': {'min': 0.05, 'max': 0.07, 'name': 'RSI (14)'},
    'stochastic': {'min': 0.05, 'max': 0.07, 'name': 'Stochastic Oscillator'},
    'atr': {'min': 0.04, 'max': 0.06, 'name': 'ATR'},
    'sma20': {'min': 0.05, 'max': 0.07, 'name': 'SMA 20'},
    'ema50': {'min': 0.05, 'max': 0.07, 'name': 'EMA 50'},

    # FUNDAMENTAL & SENTIMENT
    'pe_ratio': {'min': 0.02, 'max': 0.03, 'name': 'PE Ratio'},
    'pb_ratio': {'min': 0.01, 'max': 0.02, 'name': 'PB Ratio'},
    'market_cap': {'min': 0.005, 'max': 0.01, 'name': 'Market Cap'},
    'news_sentiment': {'min': 0.02, 'max': 0.04, 'name': 'News Sentiment'},
    'historical_volatility': {'min': 0.02, 'max': 0.03, 'name': 'Historical Volatility'},

    # DERIVED METRICS
    'growth_rate': {'min': 0.03, 'max': 0.05, 'name': 'Growth Rate (20d)'},
    'uptrend': {'min': 0.05, 'max': 0.08, 'name': 'Uptrend Flag'},
    'earnings_beat_streak': {'min': 0.03, 'max': 0.06, 'name': 'Earnings Beat Streak'},
}

def create_dataset(dataset, time_step=1):
    """Create sequences for model training"""
    dataX, dataY = [], []
    for i in range(len(dataset) - time_step - 1):
        a = dataset[i:(i + time_step), :].flatten()
        dataX.append(a)
        dataY.append(dataset[i + time_step, 0])
    return np.array(dataX), np.array(dataY)

def calculate_metric_weights(metrics_data):
    """
    Calculate actual contribution weight for each metric based on current values.
    Returns dict with metric name and its current impact percentage.
    """
    weights = {}

    # RSI Weight Calculation (5-7%)
    if 'rsi' in metrics_data:
        rsi = metrics_data['rsi']
        if rsi > 70:
            weights['rsi_impact'] = -0.03  # Overbought - bearish
        elif rsi < 30:
            weights['rsi_impact'] = 0.03   # Oversold - bullish
        else:
            # Scale from neutral
            weights['rsi_impact'] = (rsi - 50) * 0.001  # -0.05 to +0.05

    # SMA20/EMA50 Weight Calculation (10-14% combined)
    if 'sma20' in metrics_data and 'ema50' in metrics_data and 'current_price' in metrics_data:
        current_price = metrics_data['current_price']
        sma20 = metrics_data['sma20']
        ema50 = metrics_data['ema50']

        price_sma20_diff = current_price - sma20
        price_ema50_diff = current_price - ema50

        # Each $1 above/below = ±0.05-0.07%
        sma20_impact = (price_sma20_diff / current_price) * 0.07
        ema50_impact = (price_ema50_diff / current_price) * 0.07

        weights['sma20_impact'] = sma20_impact
        weights['ema50_impact'] = ema50_impact

        # Triple alignment bonus
        if current_price > sma20 > ema50:
            weights['alignment_bonus'] = 0.03
        elif current_price < sma20 < ema50:
            weights['alignment_bonus'] = -0.03
        else:
            weights['alignment_bonus'] = 0

    # Volume Weight Calculation (10-12%)
    if 'volume_vs_average' in metrics_data:
        vol_ratio = metrics_data['volume_vs_average']
        if vol_ratio > 1:
            weights['volume_impact'] = (vol_ratio - 1) * 0.12
        else:
            weights['volume_impact'] = (vol_ratio - 1) * 0.12

    # MACD Weight Calculation (6-8%)
    if 'macd_above_signal' in metrics_data:
        macd_diff = metrics_data.get('macd_line_value', 0) - metrics_data.get('macd_signal_value', 0)
        weights['macd_impact'] = min(macd_diff * 0.08, 0.08)

    # Momentum/Growth Rate (3-5%)
    if 'growth_rate_20d' in metrics_data:
        growth = metrics_data['growth_rate_20d']
        weights['growth_impact'] = (growth / 100) * 0.05

    # Uptrend Flag (5-8%) - MASSIVE IMPACT
    if 'is_uptrend' in metrics_data:
        weights['uptrend_impact'] = 0.08 if metrics_data['is_uptrend'] else -0.08

    # News Sentiment (2-4%)
    if 'news_sentiment_score' in metrics_data:
        sentiment = metrics_data['news_sentiment_score']
        weights['sentiment_impact'] = sentiment * 0.04

    # Earnings Beat Streak Weight Calculation (3-6%)
    if 'earnings_beat_streak' in metrics_data:
        streak = metrics_data['earnings_beat_streak']
        if streak >= 3: # Significant positive impact for 3+ consecutive beats
            weights['earnings_beat_streak_impact'] = 0.06
        elif streak == 2:
            weights['earnings_beat_streak_impact'] = 0.03
        elif streak == 1:
            weights['earnings_beat_streak_impact'] = 0.01
        else: # No beat or negative streak (not explicitly tracked, but 0 impact)
            weights['earnings_beat_streak_impact'] = 0
    return weights

def calculate_earnings_beat_streak(historical_earnings):
    """
    Calculates the longest streak of consecutive earnings beats.
    Returns the length of the streak.
    """
    if not historical_earnings:
        return 0
    
    consecutive_beats = 0
    for earning in historical_earnings:
        eps_actual = earning.get('epsActual')
        eps_estimate = earning.get('epsEstimate')

        # Check for beat: actual > estimate and both are not None
        if eps_actual is not None and eps_estimate is not None and eps_actual > eps_estimate:
            consecutive_beats += 1
        else:
            # Streak broken or data missing for this quarter
            break
    return consecutive_beats

def predict_with_weighted_analysis(ticker, historical_data_input, stock_metrics_input, news_articles_input, external_economic_data_input, historical_earnings_input):
    """
    Main prediction function with detailed weight analysis.
    Returns prediction with metric breakdown showing which metrics drove the result.
    """
    try:
        if not historical_data_input:
            raise ValueError("No historical data provided.")

        earnings_beat_streak_val = 0 # Initialize earnings_beat_streak_val

        stock_data = pd.DataFrame(historical_data_input)
        stock_data.rename(columns={'close': 'Close', 'open': 'Open', 'high': 'High', 'low': 'Low', 'volume': 'Volume'}, inplace=True)
        if 'date' in stock_data.columns:
            stock_data.drop('date', axis=1, inplace=True)

        # ================================================================================
        # CALCULATE ALL TECHNICAL INDICATORS
        # ================================================================================

        # Manual implementation of technical indicators
        close = stock_data['Close'].values
        high = stock_data['High'].values
        low = stock_data['Low'].values
        volume = stock_data['Volume'].values
        
        # MACD
        exp1 = pd.Series(close).ewm(span=12).mean()
        exp2 = pd.Series(close).ewm(span=26).mean()
        macd = exp1 - exp2
        signal = macd.ewm(span=9).mean()
        stock_data['MACD_12_26_9'] = macd.values
        stock_data['MACDh_12_26_9'] = (macd - signal).values
        stock_data['MACDs_12_26_9'] = signal.values
        
        # Bollinger Bands
        sma20 = pd.Series(close).rolling(window=20).mean()
        std20 = pd.Series(close).rolling(window=20).std()
        stock_data['BBL_20_2.0'] = (sma20 - 2 * std20).values
        stock_data['BB_20_2.0'] = sma20.values
        stock_data['BBU_20_2.0'] = (sma20 + 2 * std20).values
        stock_data['BBB_20_2.0'] = ((close - (sma20 - 2 * std20)) / (2 * std20)).values
        stock_data['BBP_20_2.0'] = ((close - (sma20 - 2 * std20)) / (4 * std20)).values
        
        # RSI
        delta = pd.Series(close).diff()
        gain = (delta.where(delta > 0, 0)).rolling(window=14).mean()
        loss = (-delta.where(delta < 0, 0)).rolling(window=14).mean()
        rs = gain / loss
        stock_data['RSI_14'] = (100 - (100 / (1 + rs))).values
        
        # Stochastic Oscillator
        lowest_low = pd.Series(low).rolling(window=14).min()
        highest_high = pd.Series(high).rolling(window=14).max()
        stock_data['STOCHk_14_3_3'] = (100 * (close - lowest_low) / (highest_high - lowest_low)).values
        stock_data['STOCHd_14_3_3'] = pd.Series(stock_data['STOCHk_14_3_3']).rolling(window=3).mean().values
        
        # ATR (Average True Range)
        tr1 = high - low
        tr2 = np.abs(high - np.roll(close, 1))
        tr3 = np.abs(low - np.roll(close, 1))
        tr = np.maximum(tr1, np.maximum(tr2, tr3))
        stock_data['ATR_14'] = pd.Series(tr).rolling(window=14).mean().values
        
        # SMA (Simple Moving Average)
        stock_data['SMA_20'] = pd.Series(close).rolling(window=20).mean().values
        
        # EMA (Exponential Moving Average)
        stock_data['EMA_50'] = pd.Series(close).ewm(span=50).mean().values

        # Volatility
        stock_data['log_returns'] = np.log(stock_data['Close'] / stock_data['Close'].shift(1))
        stock_data['historical_volatility'] = stock_data['log_returns'].rolling(window=30).std() * np.sqrt(252)

        # Stock Characteristics
        daily_changes = np.abs(stock_data['log_returns'].dropna()) * 100
        avg_daily_volatility = daily_changes.mean()
        max_daily_volatility = daily_changes.max()

        # Growth Detection
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

        # Add fundamental data
        for key, value in stock_metrics_input.items():
            stock_data[key] = value if value is not None else 0

        # External economic factors
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

        # Add earnings beat streak as a feature
        stock_data['EarningsBeatStreak'] = earnings_beat_streak_val

        stock_data = stock_data.ffill().bfill()

        # Select features
        all_features = stock_data.select_dtypes(include=np.number)
        important_cols = ['Open', 'High', 'Low', 'Close', 'Volume']
        technical_cols = [col for col in all_features.columns if col not in important_cols][:8]
        # Ensure EarningsBeatStreak is always included
        selected_cols = important_cols + technical_cols + ['EarningsBeatStreak']
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

        # Train Gradient Boosting Model
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

        # ================================================================================
        # CALCULATE METRIC WEIGHTS AND IMPACTS
        # ================================================================================

        # Extract current metric values
        current_rsi = stock_data['RSI_14'].iloc[-1] if 'RSI_14' in stock_data.columns else 50
        current_sma20 = stock_data['SMA_20'].iloc[-1] if 'SMA_20' in stock_data.columns else current_price
        current_ema50 = stock_data['EMA_50'].iloc[-1] if 'EMA_50' in stock_data.columns else current_price

        # MACD values
        macd_col = [col for col in stock_data.columns if 'MACD_12_26_9' in col]
        signal_col = [col for col in stock_data.columns if 'MACDs_12_26_9' in col]
        current_macd = stock_data[macd_col[0]].iloc[-1] if macd_col else 0
        current_signal = stock_data[signal_col[0]].iloc[-1] if signal_col else 0

        # Stochastic
        stoch_k = [col for col in stock_data.columns if 'STOCHk_14_3_3' in col]
        current_stoch_k = stock_data[stoch_k[0]].iloc[-1] if stoch_k else 50

        # ATR
        atr_col = [col for col in stock_data.columns if 'ATR_14' in col]
        current_atr = stock_data[atr_col[0]].iloc[-1] if atr_col else 0

        # Bollinger Bands
        bb_upper = [col for col in stock_data.columns if 'BBU_5_2.0' in col or 'BBU' in col]
        bb_lower = [col for col in stock_data.columns if 'BBL_5_2.0' in col or 'BBL' in col]
        current_bb_upper = stock_data[bb_upper[0]].iloc[-1] if bb_upper else current_price
        current_bb_lower = stock_data[bb_lower[0]].iloc[-1] if bb_lower else current_price

        # Volume analysis
        avg_volume = stock_data['Volume'].tail(20).mean()
        current_volume = stock_data['Volume'].iloc[-1]
        volume_ratio = current_volume / avg_volume if avg_volume > 0 else 1

        # Calculate earnings beat streak
        earnings_beat_streak_val = calculate_earnings_beat_streak(historical_earnings_input)

        # Calculate impacts
        metrics_for_analysis = {
            'current_price': current_price,
            'rsi': current_rsi,
            'sma20': current_sma20,
            'ema50': current_ema50,
            'macd_line_value': current_macd,
            'macd_signal_value': current_signal,
            'stoch_k': current_stoch_k,
            'atr': current_atr,
            'bb_upper': current_bb_upper,
            'bb_lower': current_bb_lower,
            'volume_vs_average': volume_ratio,
            'growth_rate_20d': growth_rate,
            'is_uptrend': is_uptrend,
            'news_sentiment_score': news_sentiment_score_val,
            'macd_above_signal': current_macd > current_signal,
            'earnings_beat_streak': earnings_beat_streak_val,
        }

        metric_weights = calculate_metric_weights(metrics_for_analysis)

        # Calculate total impact
        total_impact = sum([v for v in metric_weights.values() if isinstance(v, (int, float))])

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
                "is_uptrend": int(is_uptrend),
                "note": "Gradient Boosting predictions were unreliable. Using historical baseline instead.",
                "metric_analysis": {
                    "rsi_signal": "overbought" if current_rsi > 70 else "oversold" if current_rsi < 30 else "neutral",
                    "rsi_value": round(current_rsi, 2),
                    "momentum_signal": "strong_upward" if growth_rate > 2 else "strong_downward" if growth_rate < -2 else "neutral",
                    "growth_rate": round(growth_rate, 2),
                    "trend_signal": "bullish" if is_uptrend else "bearish",
                    "volume_signal": "above_average" if volume_ratio > 1.2 else "below_average" if volume_ratio < 0.8 else "average",
                    "volume_ratio": round(volume_ratio, 2),
                    "sma_signal": "bullish" if current_sma20 > current_ema50 else "bearish",
                    "price_vs_sma20": "above" if current_price > current_sma20 else "below",
                    "price_vs_ema50": "above" if current_price > current_ema50 else "below",
                }
            }
            print(json.dumps(result, cls=NumpyEncoder))
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

        # ================================================================================
        # BUILD FINAL RESULT WITH METRIC ANALYSIS
        # ================================================================================

        result = {
            "ticker": ticker,
            "current_price": round(current_price, 2),
            "predicted_change_range": [round(predicted_change_lower, 2), round(predicted_change_upper, 2)],
            "accuracy_metrics": {
                "model": { "mae": round(mae, 2), "rmse": round(rmse, 2) }
            },
            "stock_type": "growth_stock" if is_growth_stock else ("high_volatility_stock" if is_high_volatility else "stable_stock"),
            "growth_rate_20d": round(growth_rate, 2),
            "is_uptrend": int(is_uptrend),
            # ================================================================================
            # DETAILED METRIC ANALYSIS
            # ================================================================================
            "metric_analysis": {
                # RSI Analysis (5-7% weight)
                "rsi": {
                    "value": round(current_rsi, 2),
                    "signal": "overbought" if current_rsi > 70 else "oversold" if current_rsi < 30 else "neutral",
                    "weight_impact": round(metric_weights.get('rsi_impact', 0), 4),
                    "description": "Relative Strength Index - Momentum strength measurement"
                },
                # SMA/EMA Analysis (10-14% weight)
                "moving_averages": {
                    "sma20": round(current_sma20, 2),
                    "ema50": round(current_ema50, 2),
                    "price_position": "above" if current_price > current_sma20 else "below",
                    "signal": "bullish" if current_sma20 > current_ema50 else "bearish",
                    "sma20_impact": round(metric_weights.get('sma20_impact', 0), 4),
                    "ema50_impact": round(metric_weights.get('ema50_impact', 0), 4),
                    "alignment_bonus": round(metric_weights.get('alignment_bonus', 0), 4),
                    "description": "Short-term (SMA20) and Medium-term (EMA50) trend direction"
                },
                # Volume Analysis (10-12% weight)
                "volume": {
                    "current_volume": round(current_volume, 0),
                    "average_volume": round(avg_volume, 0),
                    "ratio": round(volume_ratio, 2),
                    "signal": "above_average" if volume_ratio > 1.2 else "below_average" if volume_ratio < 0.8 else "average",
                    "weight_impact": round(metric_weights.get('volume_impact', 0), 4),
                    "description": "Volume confirmation strength (indicates conviction behind price moves)"
                },
                # MACD Analysis (6-8% weight)
                "macd": {
                    "macd_line": round(current_macd, 4),
                    "signal_line": round(current_signal, 4),
                    "signal": "bullish" if current_macd > current_signal else "bearish",
                    "weight_impact": round(metric_weights.get('macd_impact', 0), 4),
                    "description": "Moving Average Convergence Divergence - Momentum and trend confirmation"
                },
                # Stochastic Analysis (5-7% weight)
                "stochastic": {
                    "k_value": round(current_stoch_k, 2),
                    "signal": "overbought" if current_stoch_k > 80 else "oversold" if current_stoch_k < 20 else "neutral",
                    "description": "Compares closes to price range (similar to RSI but different approach)"
                },
                # ATR Analysis (4-6% weight)
                "atr": {
                    "value": round(current_atr, 2),
                    "description": "Average True Range - Volatility magnitude affecting prediction range"
                },
                # Bollinger Bands Analysis (5-7% weight)
                "bollinger_bands": {
                    "upper": round(current_bb_upper, 2),
                    "lower": round(current_bb_lower, 2),
                    "position": "near_upper" if current_price > (current_bb_upper * 0.75) else "near_lower" if current_price < (current_bb_lower * 1.25) else "middle",
                    "description": "Overbought/Oversold and volatility changes"
                },
                # Growth & Trend Analysis (8-13% weight)
                "growth_and_trend": {
                    "growth_rate_20d": round(growth_rate, 2),
                    "is_uptrend": bool(is_uptrend),
                    "growth_impact": round(metric_weights.get('growth_impact', 0), 4),
                    "uptrend_impact": round(metric_weights.get('uptrend_impact', 0), 4),
                    "combined_classification": "strong_bullish" if is_uptrend and growth_rate > 2 else "bullish" if is_uptrend else "bearish",
                    "description": "20-day growth rate and trend structure (MASSIVE impact when combined)"
                },
                # Sentiment Analysis (2-4% weight)
                "sentiment": {
                    "news_sentiment_score": round(news_sentiment_score_val, 4),
                    "signal": "positive" if news_sentiment_score_val > 0.3 else "negative" if news_sentiment_score_val < -0.3 else "neutral",
                    "weight_impact": round(metric_weights.get('sentiment_impact', 0), 4),
                    "description": "Recent news sentiment backdrop"
                },
                # Fundamental Metrics (3-5% weight)
                "fundamentals": {
                    "pe_ratio": stock_metrics_input.get('peRatio', 0),
                    "pb_ratio": stock_metrics_input.get('pbRatio', 0),
                    "market_cap": stock_metrics_input.get('marketCap', 0),
                    "description": "Valuation metrics (lower impact on daily prediction)"
                },
                # TOTAL IMPACT SCORE
                "total_metric_impact": round(total_impact, 4),
                "impact_classification": "very_bullish" if total_impact > 0.08 else "bullish" if total_impact > 0.04 else "neutral" if total_impact > -0.04 else "bearish" if total_impact > -0.08 else "very_bearish",
            },
        }

        print(json.dumps(result, cls=NumpyEncoder))

    except Exception as e:
        import traceback
        print(json.dumps({"error": str(e), "traceback": traceback.format_exc()}, cls=NumpyEncoder), file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Stock Price Prediction with Weighted Metric Analysis')
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
        historical_earnings = input_data.get("historicalEarnings", [])

        predict_with_weighted_analysis(args.ticker, historical_data, stock_metrics, news_articles, external_economic_data, historical_earnings)

    except FileNotFoundError:
        print(json.dumps({"error": f"Input file not found at {args.input_file}"}, cls=NumpyEncoder), file=sys.stderr)
        sys.exit(1)
    except json.JSONDecodeError:
        print(json.dumps({"error": f"Could not decode JSON from {args.input_file}"}, cls=NumpyEncoder), file=sys.stderr)
        sys.exit(1)
