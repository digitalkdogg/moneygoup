-- Create users table
CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL, -- In a real app, this would be hashed
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create stocks table
CREATE TABLE IF NOT EXISTS stocks (
    id INT AUTO_INCREMENT PRIMARY KEY,
    symbol VARCHAR(10) UNIQUE NOT NULL,
    company_name VARCHAR(255) NOT NULL,
    price DECIMAL(10, 2), -- Current price, can be updated
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create stocksdailyprice table
CREATE TABLE IF NOT EXISTS stocksdailyprice (
    id INT AUTO_INCREMENT PRIMARY KEY,
    stock_id INT NOT NULL,
    date DATE NOT NULL,
    open DECIMAL(10, 2) NOT NULL,
    high DECIMAL(10, 2) NOT NULL,
    low DECIMAL(10, 2) NOT NULL,
    close DECIMAL(10, 2) NOT NULL,
    volume INT NOT NULL,
    adj_open DECIMAL(10, 2),
    adj_high DECIMAL(10, 2),
    adj_low DECIMAL(10, 2),
    adj_close DECIMAL(10, 2),
    adj_volume INT,
    FOREIGN KEY (stock_id) REFERENCES stocks(id) ON DELETE CASCADE ON UPDATE CASCADE,
    UNIQUE(stock_id, date) -- Ensure only one entry per stock per day
);

-- Create user_stocks (linking table for user portfolios/watchlists)
CREATE TABLE IF NOT EXISTS user_stocks (
    user_id INT NOT NULL,
    stock_id INT NOT NULL,
    shares DECIMAL(10, 4) NOT NULL DEFAULT 0.0000,
    purchase_price DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    is_purchased BOOLEAN NOT NULL DEFAULT TRUE, -- TRUE for owned, FALSE for watchlist
    PRIMARY KEY (user_id, stock_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY (stock_id) REFERENCES stocks(id) ON DELETE CASCADE ON UPDATE CASCADE
);

-- Create news table
CREATE TABLE IF NOT EXISTS news (
    id INT AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(512) NOT NULL,
    link VARCHAR(1024) UNIQUE NOT NULL,
    pub_date DATETIME,
    source VARCHAR(255),
    sentiment_score DECIMAL(5, 2),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create user_stock_news (linking table between user_stocks and news)
CREATE TABLE IF NOT EXISTS user_stock_news (
    user_id INT NOT NULL,
    stock_id INT NOT NULL,
    news_id INT NOT NULL,
    PRIMARY KEY (user_id, stock_id, news_id), -- Composite primary key for uniqueness
    FOREIGN KEY (user_id, stock_id) REFERENCES user_stocks(user_id, stock_id) ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY (news_id) REFERENCES news(id) ON DELETE CASCADE ON UPDATE CASCADE
);

-- Sample Data (Optional, but good for a fresh DB)

-- Insert sample users
INSERT IGNORE INTO users (id, username, password) VALUES
(1, 'testuser', 'password123'); -- In reality, hash passwords!

-- Insert sample stocks
INSERT IGNORE INTO stocks (id, symbol, company_name, price) VALUES
(1, 'AAPL', 'Apple Inc.', 170.00),
(2, 'GOOG', 'Alphabet Inc.', 1500.00),
(3, 'MSFT', 'Microsoft Corp', 400.00);

-- Insert sample user_stocks
INSERT IGNORE INTO user_stocks (user_id, stock_id, shares, purchase_price, is_purchased) VALUES
(1, 1, 10.0000, 150.00, TRUE), -- User 1 owns 10 shares of AAPL at $150
(1, 2, 5.0000, 1450.00, TRUE), -- User 1 owns 5 shares of GOOG at $1450
(1, 3, 0.0000, 0.00, FALSE); -- User 1 has MSFT on watchlist

-- Insert sample stocksdailyprice data for AAPL (simplified)
INSERT IGNORE INTO stocksdailyprice (stock_id, date, open, high, low, close, volume, adj_open, adj_high, adj_low, adj_close, adj_volume) VALUES
(1, '2025-01-13', 169.00, 171.00, 168.50, 170.50, 1000000, 169.00, 171.00, 168.50, 170.50, 1000000),
(1, '2025-01-14', 170.80, 172.50, 169.90, 171.20, 1200000, 170.80, 172.50, 169.90, 171.20, 1200000),
(1, '2025-01-15', 171.50, 173.00, 170.00, 172.80, 1100000, 171.50, 173.00, 170.00, 172.80, 1100000),
(1, '2025-01-16', 172.90, 174.00, 171.50, 173.50, 1300000, 172.90, 174.00, 171.50, 173.50, 1300000),
(1, '2025-01-17', 173.20, 175.00, 172.80, 174.80, 1500000, 173.20, 175.00, 172.80, 174.80, 1500000),
(1, '2026-01-12', 173.00, 174.50, 172.00, 173.80, 1400000, 173.00, 174.50, 172.00, 173.80, 1400000),
(1, '2026-01-13', 174.00, 175.50, 173.00, 174.90, 1600000, 174.00, 175.50, 173.00, 174.90, 1600000),
(1, '2026-01-14', 175.00, 176.50, 174.00, 175.80, 1700000, 175.00, 176.50, 174.00, 175.80, 1700000),
(1, '2026-01-15', 176.00, 177.50, 175.00, 176.80, 1800000, 176.00, 177.50, 175.00, 176.80, 1800000),
(1, '2026-01-16', 177.00, 178.50, 176.00, 177.80, 1900000, 177.00, 178.50, 176.00, 177.80, 1900000),
(1, '2026-01-17', 178.00, 179.50, 177.00, 178.80, 2000000, 178.00, 179.50, 177.00, 178.80, 2000000);