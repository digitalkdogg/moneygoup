# Technical Indicators Feature Flow

This document outlines the high-level flow of how the technical indicators and trading signals are calculated and displayed in the application.

The entire process is client-centric, meaning the backend's role is purely to provide raw historical data, while all calculations and signal generation happen in the user's browser.

## High-Level Flow

1.  **User Interaction**: The user searches for a stock ticker in the `Search` component.
2.  **Data Fetching**: The `Search` component triggers a request to the backend API to get one year of historical stock data.
3.  **Backend API**: The API route at `src/app/api/stock/[ticker]/historical/[period]/route.ts` receives the request and fetches data from an external provider (Tiingo or 12Data). It then returns this raw data to the client.
4.  **Client-Side Calculation**: The `Search` component receives the historical data and passes it to the `calculateTechnicalIndicators` function located in `src/utils/technicalIndicators.ts`.
5.  **Signal Generation**: Inside `technicalIndicators.ts`, several smaller functions calculate the Simple Moving Average (SMA), Relative Strength Index (RSI), and Momentum. These values are then fed into the `generateSignal` function, which uses a weighted scoring system to produce a final `BUY`, `SELL`, or `HOLD` signal, along with a detailed score breakdown.
6.  **Display**: The calculated indicators, signal, and score breakdown are passed as props to the `TechnicalIndicatorsDisplay` component, which is responsible for rendering the UI.

## Key Files and Functions

### 1. Frontend Orchestrator: `src/app/components/Search.tsx`

This component is the starting point and the main controller for the feature.

-   **`fetchHistoricalData(ticker, period)`**: This function is called when a user selects a stock. It's responsible for:
    -   Making a `fetch` call to the backend API (`/api/stock/[ticker]/historical/1Y`).
    -   Storing the full year of data in the `fullYearData` state to prevent redundant API calls when the user switches between time periods (1M, 6M, 1Y).
    -   Calling `calculateTechnicalIndicators` with the full year of data.
    -   Setting the returned indicators and signal into the component's state (`indicators`).
    -   Passing the state down to the `TechnicalIndicatorsDisplay` component.

### 2. Backend Data Provider: `src/app/api/stock/[ticker]/historical/[period]/route.ts`

This is a simple API route that acts as a proxy to external financial data providers.

-   **`GET(request, { params })`**: The handler for the API request.
    -   It always requests a full year of data, regardless of the `period` parameter, to optimize client-side performance.
    -   It first attempts to fetch data from **Tiingo**.
    -   If the Tiingo request fails, it falls back to **12Data**.
    -   If both fail, it returns a detailed error message.
    -   It does **not** perform any calculations.

### 3. Core Logic: `src/utils/technicalIndicators.ts`

This is the heart of the feature, where all the financial calculations happen. It contains pure functions that take raw data and return calculated metrics.

-   **`calculateTechnicalIndicators(historicalData)`**: The main exported function. It orchestrates the calculation of all indicators and the final signal.
    -   Calls `calculateSMA`, `calculateRSI`, and `calculateMomentum`.
    -   Passes the results of those calculations to `generateSignal`.
    -   Returns a comprehensive `TechnicalIndicators` object.

-   **`calculateSMA(prices, period)`**: Calculates the Simple Moving Average for a given period (e.g., 20 or 50 days).

-   **`calculateRSI(prices, period)`**: Calculates the Relative Strength Index, a momentum oscillator that measures the speed and change of price movements.

-   **`calculateMomentum(prices, period)`**: Calculates the rate of change in price over a given period.

-   **`generateSignal(...)`**: The most complex function in the file.
    -   It takes the calculated SMA, RSI, Momentum, and the current price as input.
    -   It uses a weighted scoring system to evaluate each indicator:
        -   MA Crossover (SMA20 vs. SMA50)
        -   RSI level (Oversold < 30, Overbought > 70)
        -   Momentum (Positive or Negative)
        -   Current price vs. the 50-day SMA.
    -   It sums the scores to produce a `totalScore`.
    -   Based on the `totalScore`, it determines the final `BUY`, `SELL`, or `HOLD` signal.
    -   It returns the signal, a strength percentage, a descriptive reason, and a `scoreBreakdown` object for transparency.

### 4. Presentation Layer: `src/app/components/TechnicalIndicatorsDisplay.tsx`

This is a "dumb" component that is only responsible for displaying the data it receives via props.

-   It takes an `indicators` prop of type `TechnicalIndicators`.
-   It uses conditional styling to color-code the signal, RSI values, and scores.
-   It lays out the main signal, the detailed score breakdown table, and the individual indicator cards.

This separation of concerns—fetching, calculating, and displaying—makes the feature modular and easier to maintain.
