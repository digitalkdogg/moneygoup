# API Endpoint: /api/prediction/deepmoney

The `/api/prediction/deepmoney` endpoint family is designed for automated AI and Tech stock discovery, analysis, and scoring. It consists of two versions: the original legacy algorithm and the next-generation V2 engine.

## 1. Next-Generation Discovery (V2.2)
**Endpoint:** `/api/prediction/deepmoney`

The V2.2 engine integrates high-fidelity macroeconomic indicators from the World Bank to validate sector-level tailwinds and tech adoption trends.

### Workflow:
1.  **Recursive News Discovery**: Scrapes 15+ global financial RSS feeds.
2.  **Social Sentiment Pre-Filter**: To reduce noise, tickers from ApeWisdom are only accepted if they have `mentions_24h_ago >= 5`.
3.  **Gate 1: Technical Validation**: Every candidate must have a non-negative `tradingSignalScore`.
4.  **Gate 2: Sequential ML Validation**: For stocks passing Gate 1, the system runs a 1-month ML prediction.
    *   **Threshold**: Only stocks with a predicted 1-month growth of **≥ 0.1%** are returned.
5.  **Hot ETF Discovery (Parallel)**: Scans thematic watchlists and dynamic screeners for ETFs under $400.
    *   **Macro Tailwind Scoring (15% Weight)**: Rewards ETFs in themes with strong structural FDI and trade trends.
    *   **Qualifying Threshold**: GPS >= 55.
6.  **DB-Ready Enrichment**: Results are enriched with Sectors, GPS scores, and macro observability data.

---

## 2. Multi-Factor Scoring (GPS)

### Stock GPS Components:
*   **Analyst Upside (25%)**: Ratio of target price to current price.
*   **Revenue Growth (20%)**: Year-over-year revenue growth.
*   **EPS Growth (15%)**: Growth in Earnings Per Share.
*   **Momentum (15%)**: 52-week price change.
*   **Mentions (15%)**: Frequency of the company in recent news.
*   **Sentiment (10%)**: Average sentiment of news mentions.

### ETF GPS Components (v2.2 Weights):
*   **52-Week Price Return (25.5%)**
*   **Thematic News Signal (21.25%)**
*   **3-Month Momentum (17%)**
*   **Macro Tailwind (15%)**: NEW - Structural confirmation from World Bank FDI/Trade data.
*   **Liquidity Score (12.75%)**
*   **Expense Ratio Efficiency (8.5%)**

---

## 3. Selection Criteria

### Candidate Selection (The "Hard Gates")
To even be considered for any "Hot" list, an asset must pass these initial filters:
1.  **Stock Price Cap**: Must be under **$150.00**.
2.  **ETF Price Cap**: Must be under **$400.00**.
3.  **Stock Market Cap**: Must be between **$150M** and **$50B**.
4.  **ETF Liquidity**: Volume > 50,000 shares and AUM > $50M.

### Growth Classifications
The algorithm assigns a classification label based on fundamentals:
*   **AI/Tech Hyper-Growth**: Sector is Tech/Comms AND Revenue Growth >= 20% AND Gross Margin >= 50% AND R&D Spend >= 10%.
*   **Established Growth**: Revenue Growth >= 10% AND EPS Growth > 0 AND 52-Week Change >= 10%.
*   **Up and Coming Stable**: Revenue Growth >= 15% AND Market Cap between $300M - $10B AND Analyst Upside >= 15%.

---

## 4. Network Calls

| Target | Purpose | Frequency |
| :--- | :--- | :--- |
| `finance.yahoo.com/rss/2.0/...` | Fetch market news (DJI, GSPC, IXIC) | 3 calls |
| Yahoo Finance Screener API | Get growth and tech stock lists | 2 calls |
| World Bank API | Macro indicators (GDP, FDI, Trade) | 1 call (cached 6h) |
| Yahoo Finance Quote Summary API | Fetch financial metrics for each candidate | ~40 calls |

---

## 5. Sample JSON Response (v2.2)

```json
{
  "success": true,
  "source": "cache",
  "hot_stocks": [
    {
      "ticker": "NVDA",
      "gps_score": 94.2,
      "classification": "ai_tech_hyper_growth",
      "macro_tailwind_used": true
    }
  ],
  "hot_etfs": [
    {
      "ticker": "BOTZ",
      "etf_gps_score": 88.5,
      "macro_tailwind_score": 12.5,
      "theme_validation_bonus": 4.0
    }
  ],
  "macro_context": {
    "global_health_score": 78.5,
    "unemployment_signal": "bullish"
  }
}
```
