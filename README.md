# MoneyGoUp - Stock Analysis and Prediction Platform

A full-stack web application for comprehensive stock analysis and prediction. It leverages Next.js for a responsive frontend, a Python backend for data processing and machine learning models, and a MySQL database for data storage. Users can track stocks, view historical data, analyze technical indicators, understand news sentiment, and get future price predictions based on sophisticated weighted analysis.

## Features

*   **User Authentication:** Secure user registration and login using NextAuth.js.
*   **Dashboard:** Personalized dashboard to manage tracked stocks.
*   **Stock Search:** Search for various stock tickers.
*   **Historical Data Visualization:** Interactive charts for historical stock prices.
*   **Technical Indicators:** Display of key technical indicators (MACD, RSI, Bollinger Bands, etc.).
*   **News Sentiment Analysis:** Integration of news articles with sentiment scoring.
*   **Advanced Price Prediction:** Machine learning models (Scikit-learn Gradient Boosting) with weighted analysis to predict future stock price ranges, incorporating technicals, fundamentals, sentiment, and economic factors.

## Technologies Used

### Frontend
*   [Next.js](https://nextjs.org/)
*   [React](https://react.dev/)
*   [Tailwind CSS](https://tailwindcss.com/)
*   [Recharts](https://recharts.org/en-US/) (for charting)

### Backend (Next.js API Routes & Python Microservices)
*   [Python](https://www.python.org/) (for data processing and ML models)
*   [Scikit-learn](https://scikit-learn.org/stable/index.html) (Gradient Boosting Regressor)
*   [Pandas](https://pandas.pydata.org/) & [NumPy](https://numpy.org/)
*   [Requests](https://requests.readthedocs.io/en/latest/) (for external API interactions)
*   [Next.js API Routes](https://nextjs.org/docs/app/building-your-application/routing/route-handlers)

### Database
*   [MySQL](https://www.mysql.com/)

### Authentication
*   [NextAuth.js](https://next-auth.js.org/)

### Data Sources
*   [Yahoo Finance](https://finance.yahoo.com/) (via `yahoo-finance2` for historical/real-time data)
*   Internal APIs for news and processed data.

## Installation

### Prerequisites
*   [Node.js](https://nodejs.org/en/) (LTS version)
*   [Python](https://www.python.org/downloads/) (3.8+)
*   [MySQL Server](https://dev.mysql.com/downloads/mysql/)
*   `npm` (Node Package Manager) or `yarn` (for frontend dependencies)
*   `pip` (Python package installer)

### Steps

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/your-username/moneygoup.git
    cd moneygoup
    ```
    *(Replace `https://github.com/your-username/moneygoup.git` with the actual repository URL)*

2.  **Set up Environment Variables:**
    Create a `.env.local` file in the root directory and add the following:
    ```
    # NextAuth.js
    NEXTAUTH_SECRET=YOUR_NEXTAUTH_SECRET # Generate a strong secret (e.g., using `openssl rand -base64 32`)
    NEXTAUTH_URL=http://localhost:3001

    # Database
    DB_HOST=localhost
    DB_USER=root
    DB_PASSWORD=your_db_password
    DB_DATABASE=moneygoup_db

    # For Python scripts (can use the same as above or separate, but ensure consistency)
    PYTHON_DB_HOST=localhost
    PYTHON_DB_USER=root
    PYTHON_DB_PASSWORD=your_db_password
    PYTHON_DB_DATABASE=moneygoup_db
    ```
    *Replace placeholders with your actual values.*

3.  **Database Setup:**
    *   Ensure your MySQL server is running.
    *   Create a MySQL database named `moneygoup_db`.
    *   Run the schema initialization script:
        ```bash
        mysql -u root -p < moneygoup_schema.sql
        ```

4.  **Install Frontend Dependencies:**
    ```bash
    npm install
    # or yarn install
    ```

5.  **Install Python Dependencies:**
    ```bash
    python -m venv venv
    source venv/bin/activate # On Windows: `.\venv\Scripts\activate`
    pip install -r requirements.txt
    ```

## Running the Application

1.  **Start the Next.js Development Server:**
    ```bash
    npm run dev
    # or yarn dev
    ```
    The application will be accessible at `http://localhost:3001`.

## API Endpoints

The application exposes various API endpoints to interact with stock data, user information, and authentication.

### Authentication
*   `GET /api/auth/[...nextauth]`: Handles NextAuth.js authentication flows (sign-in, sign-out, callbacks).
*   `POST /api/auth/register`: User registration endpoint to create new accounts.

### Cache Statistics
*   `GET /api/cache-stats`: Retrieves operational statistics related to the application's data caching mechanism.

### Dashboard
*   `GET /api/dashboard`: Fetches aggregated data for the user's personalized dashboard.
*   `GET /api/dashboard/get`: Specific endpoint to retrieve dashboard data, potentially with different parameters.
*   `GET /api/dashboard/on`: Used for specific dashboard features or data related to an "on" state.
*   `GET /api/dashboard/recommended-stocks`: Provides a list of stocks recommended based on predefined criteria.
*   `GET /api/dashboard/undervalued-large-caps`: Identifies and lists undervalued large-capitalization stocks.

### Deep Money (AI/ML Insights)
*   `GET /api/deepmoney`: Main endpoint for AI/ML-driven insights, potentially offering advanced analytics.
*   `GET /api/deepmoney/news`: Fetches market news or news specifically processed for "DeepMoney" insights.

### Stock Data
*   `GET /api/stock_data/[ticker]`: Retrieves comprehensive general information for a specified stock ticker.
*   `GET /api/stock_data/[ticker]/historical/[period]`: Accesses historical price and volume data for a given stock ticker over a defined period (e.g., "max", "1y", "5y").
*   `GET /api/stock_data/[ticker]/news`: Fetches recent news articles pertinent to the specified stock ticker.
*   `GET /api/prediction/[ticker]`: Provides stock price predictions leveraging a TensorFlow-based machine learning model (or an API route for such models).
*   `GET /api/stock_data/quote/[ticker]`: Retrieves real-time or near real-time quote data for a specified stock ticker.

### User Management
*   `GET /api/user/stocks`: Lists all stocks currently being tracked by the authenticated user.
*   `GET /api/user/stocks/[stock_id]`: Fetches detailed information for a specific stock associated with the user's portfolio.
*   `GET /api/user/watchlist`: Displays the user's personal watchlist of stocks.
*   `POST /api/user/watchlist`: Adds a new stock to the user's watchlist.
*   `DELETE /api/user/watchlist`: Removes a stock from the user's watchlist.

---
