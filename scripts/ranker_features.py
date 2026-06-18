"""
Shared feature computation for the cross-sectional ranker.

This module is the single source of truth for the GREEN feature set used by
both:
  - scripts/build_ranking_dataset.py  (offline training-data builder)
  - scripts/score_ranker.py            (online inference)

Keeping the formulas here — not duplicated in each script — is the only thing
that prevents silent train/inference drift, which is the most common way an
ML system rots without anyone noticing.

The feature formulas mirror scripts/predict_weighted_analysis.py
(_calculate_features_internal + _add_macro_features) line-for-line, but
restricted to the GREEN-only feature set from the audit (RED/YELLOW features
dropped because they cannot be reconstructed as-of D without leakage).
"""
from __future__ import annotations

from typing import Dict, List, Optional

import numpy as np
import pandas as pd


FEATURE_SET_VERSION = "green_v1"
MIN_HISTORY_ROWS = 260

# GREEN feature column order — must match training-time ordering exactly,
# because LightGBM consumes positional feature arrays.
FEATURE_COLUMNS: List[str] = [
    "Open", "High", "Low", "Close", "Volume",
    "MACD", "MACD_Signal",
    "BB_Upper", "BB_Lower", "BB_Mid",
    "RSI_14",
    "STOCH_K", "STOCH_D",
    "ATR_14",
    "SMA_20", "EMA_50", "SMA_200", "EMA_200",
    "HiRatio_52w", "LoRatio_52w",
    "ROC_6m", "ROC_12m",
    "GoldenCross",
    "HistVol_30",
    "VIX", "VIX_20d_Avg", "Treasury10Y", "SectorETF_60d_Corr",
    "Month_Sin", "Month_Cos", "EarningsSeason",
    "Close_lag_5", "Close_lag_10", "Close_lag_20", "Volume_lag_5",
    "ROC_5d", "ROC_20d",
    "Return_1d", "Return_5d", "Return_20d",
    "PriceToHigh_20d", "PriceToLow_20d", "PriceToHigh_5d",
    "VolumePriceTrend",
    "EMA_Slope_10", "EMA_Slope_20",
    "RollingMean_20d", "RollingStd_20d",
    "RollingSkew_20d", "RollingSharpe_20d",
    "HYG_Level", "HYG_Mom_20d",
    "LQD_Level", "LQD_Mom_20d",
    "HYG_LQD_Ratio",
    "DXY_Level", "DXY_Return_20d",
    "Treasury3M", "CurveSlope_10M3M",
    "RS_vs_SPY_20d", "RS_vs_SectorETF_20d",
    "WTI_Return_20d", "WTI_Beta_60d",
    "Copper_Return_20d", "Copper_Beta_60d",
    "Wheat_Return_20d", "Wheat_Beta_60d",
    "VIX_RealVol_Ratio",
    "WorldBank_GDP", "WorldBank_Inflation",
    "WorldBank_Consumption", "WorldBank_Real_GDP",
]


# ─── as-of macro alignment helpers ──────────────────────────────────────────
def _asof(series: Optional[pd.Series], d: pd.Timestamp) -> Optional[float]:
    if series is None or series.empty:
        return None
    s = series.loc[series.index <= d]
    if s.empty:
        return None
    v = s.iloc[-1]
    return float(v) if pd.notna(v) else None


def _asof_mean(series: Optional[pd.Series], d: pd.Timestamp, window: int) -> Optional[float]:
    if series is None or series.empty:
        return None
    s = series.loc[series.index <= d].tail(window)
    if s.empty:
        return None
    v = s.mean()
    return float(v) if pd.notna(v) else None


def _asof_pct(series: Optional[pd.Series], d: pd.Timestamp, lag: int) -> Optional[float]:
    if series is None or series.empty:
        return None
    s = series.loc[series.index <= d]
    if len(s) < lag + 1:
        return None
    base = s.iloc[-(lag + 1)]
    last = s.iloc[-1]
    if not pd.notna(base) or base == 0:
        return None
    return float(last / base - 1.0)


def _rolling_rs_20(stock_close: pd.Series, bench_close: Optional[pd.Series]) -> Optional[float]:
    if bench_close is None or bench_close.empty:
        return None
    b = bench_close.reindex(stock_close.index).ffill()
    if b.notna().sum() < 21:
        return None
    sr = stock_close.pct_change().fillna(0)
    br = b.pct_change().fillna(0)
    return float((sr - br).tail(20).mean())


def _rolling_beta_60(stock_close: pd.Series, commodity_close: Optional[pd.Series]) -> Optional[float]:
    if commodity_close is None or commodity_close.empty:
        return None
    c = commodity_close.reindex(stock_close.index).ffill()
    if c.notna().sum() < 61:
        return None
    sr = stock_close.pct_change().fillna(0).tail(60)
    cr = c.pct_change().fillna(0).tail(60)
    var = cr.var()
    if var is None or var <= 0 or pd.isna(var):
        return None
    return float(sr.cov(cr) / (var + 1e-9))


# ─── Main entry point ───────────────────────────────────────────────────────
def compute_features(
    snap: pd.Timestamp,
    ohlcv: pd.DataFrame,
    sector_etf_close: Optional[pd.Series],
    macro: Dict[str, Optional[pd.Series]],
    wb_year: Dict[str, float],
) -> Optional[Dict[str, Optional[float]]]:
    """Compute the GREEN feature vector as-of `snap`.

    Args:
        snap:               Timestamp of the snapshot — only data <= snap is used.
        ohlcv:              DataFrame with columns ['open','high','low','close','volume'],
                            indexed by date.
        sector_etf_close:   Close-price Series of the ticker's mapped sector ETF
                            (e.g. XLK for Technology). Used for RS_vs_SectorETF_20d
                            and SectorETF_60d_Corr.
        macro:              Dict of macro symbol → close-price Series.
                            Required keys: 'vix','tnx','irx','hyg','lqd','dxy',
                                          'spy','wti','copper','wheat'.
        wb_year:            Dict with keys 'gdpGrowth','inflation','consumptionGrowth'
                            for the snapshot year (or nearest prior year).

    Returns:
        Dict of feature_name → value (in FEATURE_COLUMNS order), or None if
        the ticker has insufficient OHLCV history (<MIN_HISTORY_ROWS bars).
    """
    hist = ohlcv.loc[ohlcv.index <= snap]
    if len(hist) < MIN_HISTORY_ROWS:
        return None

    close = hist["close"].values
    high = hist["high"].values
    low = hist["low"].values
    volume = hist["volume"].values
    close_s = pd.Series(close)

    f: Dict[str, Optional[float]] = {}

    f["Open"] = float(hist["open"].iloc[-1])
    f["High"] = float(high[-1])
    f["Low"] = float(low[-1])
    f["Close"] = float(close[-1])
    f["Volume"] = float(volume[-1])

    exp12 = close_s.ewm(span=12, adjust=False).mean()
    exp26 = close_s.ewm(span=26, adjust=False).mean()
    macd = exp12 - exp26
    sig = macd.ewm(span=9, adjust=False).mean()
    f["MACD"] = float(macd.iloc[-1])
    f["MACD_Signal"] = float(sig.iloc[-1])

    sma20 = close_s.rolling(20).mean()
    std20 = close_s.rolling(20).std()
    f["BB_Upper"] = float((sma20 + 2 * std20).iloc[-1])
    f["BB_Lower"] = float((sma20 - 2 * std20).iloc[-1])
    f["BB_Mid"] = float(sma20.iloc[-1])

    delta = close_s.diff()
    gain = delta.where(delta > 0, 0).rolling(14).mean()
    loss = (-delta.where(delta < 0, 0)).rolling(14).mean()
    rs = gain / (loss + 1e-9)
    f["RSI_14"] = float((100 - 100 / (1 + rs)).iloc[-1])

    lo14 = pd.Series(low).rolling(14).min()
    hi14 = pd.Series(high).rolling(14).max()
    k = 100 * (close - lo14.values) / (hi14.values - lo14.values + 1e-9)
    f["STOCH_K"] = float(k[-1])
    f["STOCH_D"] = float(pd.Series(k).rolling(3).mean().iloc[-1])

    tr1 = high - low
    tr2 = np.abs(high - np.roll(close, 1))
    tr3 = np.abs(low - np.roll(close, 1))
    tr = np.maximum(tr1, np.maximum(tr2, tr3))
    tr[:1] = tr1[:1]
    f["ATR_14"] = float(pd.Series(tr).rolling(14).mean().iloc[-1])

    f["SMA_20"] = float(sma20.iloc[-1])
    f["EMA_50"] = float(close_s.ewm(span=50, adjust=False).mean().iloc[-1])
    sma200 = close_s.rolling(200).mean()
    f["SMA_200"] = float(sma200.iloc[-1])
    f["EMA_200"] = float(close_s.ewm(span=200, adjust=False).mean().iloc[-1])

    hi252 = close_s.rolling(252, min_periods=1).max()
    lo252 = close_s.rolling(252, min_periods=1).min()
    f["HiRatio_52w"] = float(close[-1] / (hi252.iloc[-1] + 1e-9))
    f["LoRatio_52w"] = float(close[-1] / (lo252.iloc[-1] + 1e-9))

    f["ROC_6m"] = float(close_s.pct_change(126).iloc[-1])
    f["ROC_12m"] = float(close_s.pct_change(252).iloc[-1])

    sma50 = close_s.rolling(50).mean()
    f["GoldenCross"] = 1.0 if sma50.iloc[-1] > sma200.iloc[-1] else 0.0

    log_ret = np.log(close_s / close_s.shift(1))
    hist_vol = log_ret.rolling(30).std().iloc[-1] * np.sqrt(252)
    f["HistVol_30"] = float(hist_vol) if pd.notna(hist_vol) else None

    vix_val = _asof(macro.get("vix"), snap)
    f["VIX"] = vix_val
    f["VIX_20d_Avg"] = _asof_mean(macro.get("vix"), snap, 20)
    f["Treasury10Y"] = _asof(macro.get("tnx"), snap)

    if sector_etf_close is not None and not sector_etf_close.empty:
        etf_align = sector_etf_close.reindex(hist.index).ffill().tail(60).reset_index(drop=True)
        ref = close_s.tail(60).reset_index(drop=True)
        if etf_align.notna().sum() >= 60 and etf_align.std() > 0:
            corr = ref.corr(etf_align)
            f["SectorETF_60d_Corr"] = float(corr) if pd.notna(corr) else 0.0
        else:
            f["SectorETF_60d_Corr"] = 0.0
    else:
        f["SectorETF_60d_Corr"] = 0.0

    m = snap.month
    f["Month_Sin"] = float(np.sin(2 * np.pi * m / 12))
    f["Month_Cos"] = float(np.cos(2 * np.pi * m / 12))
    f["EarningsSeason"] = 1.0 if m in (1, 4, 7, 10) else 0.0

    f["Close_lag_5"] = float(close_s.shift(5).iloc[-1])
    f["Close_lag_10"] = float(close_s.shift(10).iloc[-1])
    f["Close_lag_20"] = float(close_s.shift(20).iloc[-1])
    f["Volume_lag_5"] = float(pd.Series(volume).shift(5).iloc[-1])

    f["ROC_5d"] = float(close_s.pct_change(5).iloc[-1])
    f["ROC_20d"] = float(close_s.pct_change(20).iloc[-1])
    f["Return_1d"] = float(close_s.pct_change(1).iloc[-1])
    f["Return_5d"] = float(close_s.pct_change(5).iloc[-1])
    f["Return_20d"] = float(close_s.pct_change(20).iloc[-1])

    f["PriceToHigh_5d"] = float(close_s.iloc[-1] / (close_s.rolling(5).max().iloc[-1] + 1e-9))
    f["PriceToHigh_20d"] = float(close_s.iloc[-1] / (close_s.rolling(20).max().iloc[-1] + 1e-9))
    f["PriceToLow_20d"] = float(close_s.iloc[-1] / (close_s.rolling(20).min().iloc[-1] + 1e-9))

    daily_ret = close_s.pct_change().fillna(0)
    f["VolumePriceTrend"] = float((daily_ret * pd.Series(volume)).rolling(10).sum().iloc[-1])

    f["EMA_Slope_10"] = float(close_s.ewm(span=10, adjust=False).mean().diff(3).iloc[-1])
    f["EMA_Slope_20"] = float(close_s.ewm(span=20, adjust=False).mean().diff(3).iloc[-1])

    ret20 = daily_ret.rolling(20)
    f["RollingMean_20d"] = float(ret20.mean().iloc[-1])
    rstd = ret20.std().iloc[-1]
    f["RollingStd_20d"] = float(rstd) if pd.notna(rstd) else None
    skew = ret20.skew().iloc[-1]
    f["RollingSkew_20d"] = float(skew) if pd.notna(skew) else None
    if pd.notna(rstd) and rstd > 0:
        f["RollingSharpe_20d"] = float(ret20.mean().iloc[-1] / (rstd + 1e-9))
    else:
        f["RollingSharpe_20d"] = None

    f["HYG_Level"] = _asof(macro.get("hyg"), snap)
    f["HYG_Mom_20d"] = _asof_pct(macro.get("hyg"), snap, 20)
    f["LQD_Level"] = _asof(macro.get("lqd"), snap)
    f["LQD_Mom_20d"] = _asof_pct(macro.get("lqd"), snap, 20)
    if f["HYG_Level"] is not None and f["LQD_Level"]:
        f["HYG_LQD_Ratio"] = float(f["HYG_Level"] / (f["LQD_Level"] + 1e-9))
    else:
        f["HYG_LQD_Ratio"] = None

    f["DXY_Level"] = _asof(macro.get("dxy"), snap)
    f["DXY_Return_20d"] = _asof_pct(macro.get("dxy"), snap, 20)

    irx_val = _asof(macro.get("irx"), snap)
    f["Treasury3M"] = irx_val
    if f["Treasury10Y"] is not None and irx_val is not None:
        f["CurveSlope_10M3M"] = float(f["Treasury10Y"] - irx_val)
    else:
        f["CurveSlope_10M3M"] = None

    f["RS_vs_SPY_20d"] = _rolling_rs_20(hist["close"], macro.get("spy"))
    f["RS_vs_SectorETF_20d"] = _rolling_rs_20(hist["close"], sector_etf_close)

    f["WTI_Return_20d"] = _asof_pct(macro.get("wti"), snap, 20)
    f["Copper_Return_20d"] = _asof_pct(macro.get("copper"), snap, 20)
    f["Wheat_Return_20d"] = _asof_pct(macro.get("wheat"), snap, 20)
    f["WTI_Beta_60d"] = _rolling_beta_60(hist["close"], macro.get("wti"))
    f["Copper_Beta_60d"] = _rolling_beta_60(hist["close"], macro.get("copper"))
    f["Wheat_Beta_60d"] = _rolling_beta_60(hist["close"], macro.get("wheat"))

    if vix_val is not None and f["HistVol_30"] is not None:
        f["VIX_RealVol_Ratio"] = float(vix_val / (f["HistVol_30"] + 1e-9))
    else:
        f["VIX_RealVol_Ratio"] = None

    gdp = wb_year.get("gdpGrowth", 2.0)
    inf = wb_year.get("inflation", 2.5)
    cons = wb_year.get("consumptionGrowth", 2.0)
    f["WorldBank_GDP"] = float(gdp) if gdp is not None else 2.0
    f["WorldBank_Inflation"] = float(inf) if inf is not None else 2.5
    f["WorldBank_Consumption"] = float(cons) if cons is not None else 2.0
    f["WorldBank_Real_GDP"] = f["WorldBank_GDP"] - f["WorldBank_Inflation"]

    return {col: f.get(col) for col in FEATURE_COLUMNS}
