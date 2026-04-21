# API Endpoint: /api/prediction/deepmoney

The `/api/prediction/deepmoney` endpoint family is designed for automated AI and Tech stock discovery, analysis, and scoring. It consists of two versions: the original legacy algorithm and the next-generation V2 engine.

## 1. Next-Generation Discovery (V2.2)
**Endpoint:** `/api/prediction/deepmoney`

The V2.2 engine integrates high-fidelity macroeconomic indicators from the World Bank to validate sector-level tailwinds and tech adoption trends.

### Workflow:
1.  **Recursive News Discovery**: Scrapes 20+ global financial RSS feeds and screeners.
2.  **Social Sentiment Pre-Filter**: To reduce noise, tickers from ApeWisdom are only accepted if they have `mentions_24h_ago >= 5`.
3.  **Gate 1: Technical Validation**: Every candidate must have a non-negative `tradingSignalScore`.
4.  **Gate 2: Sequential ML Validation**: For stocks passing Gate 1, the system runs a 1-month ML prediction.
    *   **Threshold**: Only stocks with a predicted 1-month growth of **≥ 1.5%** are returned.
5.  **Hot ETF Discovery (Parallel)**: Scans thematic watchlists and dynamic screeners for ETFs under $400.
    *   **Macro Tailwind Scoring (15% Weight)**: Rewards ETFs in themes with strong structural FDI and trade trends.
    *   **Qualifying Threshold**: GPS >= 55.
6.  **DB-Ready Enrichment**: Results are enriched with Sectors, GPS scores, and metadata for persistence.

---

## 2. Multi-Factor Scoring (GPS)

### Stock GPS Components (v2.2 Weights):
*   **Analyst Upside (25%)**: Ratio of target price to current price (Scaled: 30% upside = 100% score).
*   **Revenue Growth (25%)**: Trailing revenue growth (Scaled: 30% growth = 100% score).
*   **EPS Growth (25%)**: Trailing EPS growth (Scaled: 25% growth = 100% score).
*   **52-Week Momentum (25%)**: 52-week price change (Scaled: 20% return = 100% score).
*   **Prediction Bonus (+5 pts)**: Applied if predicted 1-month growth is > 0.5%.

### ETF GPS Components (v2.2 Weights):
*   **52-Week Price Return (25.5%)**
*   **Thematic News Signal (21.25%)**
*   **3-Month Momentum (17%)**
*   **Macro Tailwind (15%)**: Structural confirmation from World Bank FDI/Trade data.
*   **Liquidity Score (12.75%)**
*   **Expense Ratio Efficiency (8.5%)**

---

## 3. Selection Criteria

### Candidate Selection (The "Hard Gates")
To even be considered for any "Hot" list, an asset must pass these initial filters:
1.  **Technical Validation**: Must have a non-negative `tradingSignalScore`.
2.  **ETF Price Cap**: Must be under **$400.00**.
3.  **ETF Liquidity**: Volume > 50,000 shares and AUM > $50M.

### Growth Classifications
The algorithm assigns a classification label based on fundamentals:
*   **AI/Tech Hyper-Growth**: Revenue Growth >= 20% AND Gross Margin >= 50% AND R&D Spend >= 10%.
*   **Established Growth**: Revenue Growth >= 10% AND 52-Week Change >= 10%.
*   **Standard**: Any other stock passing the ML validation gate.

---

## 4. Network Calls

| Target | Purpose | Frequency |
| :--- | :--- | :--- |
| RSS Feeds | Fetch market news and trending tickers | ~25 calls |
| Yahoo Finance Screener API | Get growth and tech stock lists | 4 calls |
| World Bank API | Macro indicators (GDP, FDI, Trade) | 1 call (cached 6h) |
| Yahoo Finance Quote Summary API | Fetch financial metrics for each candidate | ~100+ calls |

---

## 5. Sample JSON Response (v2.2)

```json
{
  "success": true,
  "timestamp": "2026-04-16T...",
  "count": 12,
  "stocks": [
    {
      "ticker": "NVDA",
      "name": "NVIDIA Corporation",
      "price": 875.24,
      "gps_score": 94.2,
      "classification": "ai_tech_hyper_growth",
      "trading_signal": "BUY"
    }
  ],
  "hot_etfs": [
    {
      "ticker": "BOTZ",
      "etf_name": "Global X Robotics & Artificial Intelligence ETF",
      "etf_gps_score": 88.5,
      "macro_tailwind_score": 12.5,
      "theme": "Artificial Intelligence"
    }
  ],
  "meta": {
    "totalDiscovered": 150,
    "enrichedCount": 145,
    "filteredCount": 12,
    "hotEtfsCount": 8
  }
}
```
