# PLAN: Watchlist & Portfolio Separation with Trade Management (FINAL)

## Overview
Separate the user's dashboard into two distinct sections:
1. **Watchlist** - Stocks the user is monitoring but hasn't purchased
2. **Portfolio** - Stocks the user owns with position management controls

Enable users to manage purchases/sales with granular controls (add shares, sell partial, sell all).

---

## 1. DATABASE SCHEMA CHANGES (OPTION A ONLY)

### Current State
```
UserStock Table:
- id (PK)
- user_id (FK)
- stock_id (FK)
- shares (nullable, null for watchlist)
- purchase_price (nullable, null for watchlist)
- is_purchased (boolean flag)
  - 0 = watchlist item
  - 1 = owned position
- created_at
```

### Proposed Changes (Option A - Recommended)

Add 3 columns to enhance existing UserStock table:

**New Columns:**
```sql
ALTER TABLE user_stocks ADD COLUMN (
  initial_purchase_date DATETIME NULL COMMENT 'When stock was first purchased',
  last_transaction_date DATETIME NULL COMMENT 'When shares were last added/removed',
  is_active BOOLEAN DEFAULT 1 COMMENT 'False when position is closed (shares = 0)'
);
```

**Benefits:**
- Minimal schema changes (non-breaking)
- Maintains current structure
- Tracks position lifecycle
- Supports all user workflows

**Key Behaviors with Option A:**
- `purchase_price` stores **average purchase price** (weighted average)
- `shares` stores **current position size**
- When user sells, update these fields directly
- When user buys more, recalculate weighted average
- **No transaction history table** (can add later if needed)

**Cost Basis Tracking:**
- Currently: Simple weighted average (sufficient for most use cases)
- Future: Can add transaction history table (Option B) if FIFO/LIFO needed for taxes
- For now: Average cost basis is adequate and simpler to manage

---

## 2. USER REQUIREMENTS (YOUR ANSWERS)

### Closed Positions
**Question:** Should closed positions appear in a separate "Closed Positions" section?
**Answer:** I don't know
**Implementation:** When position reaches 0 shares, set `is_active = 0` and **remove from portfolio view**
- Closed positions (shares = 0, is_active = 0) won't display on dashboard
- Option to add "Closed Positions" section in future if needed
- Data is preserved in database for potential audit/history later

### Cost Basis Tracking (FIFO/LIFO)
**Question:** Do you want cost basis tracking (FIFO/LIFO)?
**Answer:** Maybe
**Implementation:** Start with Option A (weighted average cost)
- Supports buy/sell workflow perfectly
- If tax reporting needed later, add transaction history table
- No changes needed to Option A to support this future enhancement

### Dividend Payments
**Question:** Should we track dividend payments?
**Answer:** No
**Implementation:** Not included in this plan
- Can add in future without affecting current schema
- Doesn't impact current buy/sell functionality

### Export Transaction History
**Question:** Do you want to export transaction history?
**Answer:** No
**Implementation:** Not included in this plan
- Can add in future if business needs change
- All data is available in database if needed

### Position Size Limits
**Question:** Should there be a minimum/maximum position size?
**Answer:** Yes, minimum is zero. Once we sell and position is zero, it needs to drop off portfolio
**Implementation:**
- **Zero shares = Position Closed**
- When user sells last share(s) to reach 0:
  - Set `shares = 0`
  - Set `is_active = 0`
  - Set `last_transaction_date = NOW()`
  - **Remove from portfolio display** (query filters `is_active = 1`)
  - Stock remains in database (soft delete)
- No minimum position size enforcement (user can buy 1 share or 0.5 shares)
- No maximum position size enforcement

### Price Alerts
**Question:** Should users be able to set price alerts on watchlist items?
**Answer:** No, not right now
**Implementation:** Not included in this plan
- Can add in future without affecting current schema

---

## 3. API ENDPOINT CHANGES

### Current Endpoints (Unchanged)
```
GET  /api/user/watchlist      - Fetch watchlist (is_purchased = 0)
POST /api/user/watchlist      - Add to watchlist
DELETE /api/user/watchlist    - Remove from watchlist
```

### New Endpoints Required

#### 1. Fetch Portfolio (All Owned Positions)
**GET /api/user/portfolio**

Returns all active owned positions where `is_purchased = 1` AND `is_active = 1`

**Response:**
```json
{
  "portfolio": [
    {
      "stock_id": 5,
      "symbol": "AAPL",
      "company_name": "Apple Inc",
      "shares": 100,
      "purchase_price": 150.00,
      "current_price": 165.00,
      "total_value": 16500.00,
      "unrealized_gain": 1500.00,
      "unrealized_gain_pct": 10.00,
      "initial_purchase_date": "2025-02-18",
      "last_transaction_date": "2025-02-20"
    }
  ]
}
```

---

#### 2. Buy Stock (Add to Watchlist or Create New Position)
**POST /api/user/stocks**

Existing endpoint - works as-is
Sets `is_purchased = 1`, `initial_purchase_date = NOW()`, `last_transaction_date = NOW()`

---

#### 3. Buy More Shares (Increase Position)
**PATCH /api/user/stocks/[stock_id]**

Update existing position by adding shares. Recalculates weighted average price.

**Request:**
```json
{
  "action": "buy",
  "shares": 50,
  "price": 165.00
}
```

**Logic:**
```
old_cost = old_shares × old_price
new_cost = new_shares × new_price
total_cost = old_cost + new_cost
total_shares = old_shares + new_shares
new_avg_price = total_cost / total_shares

UPDATE user_stocks
SET shares = total_shares,
    purchase_price = new_avg_price,
    last_transaction_date = NOW()
WHERE user_id = ? AND stock_id = ? AND is_purchased = 1
```

**Response:**
```json
{
  "status": "success",
  "shares": 150,
  "purchase_price": 155.00,
  "last_transaction_date": "2025-02-20T10:30:00Z"
}
```

---

#### 4. Sell Partial or All Shares
**PATCH /api/user/stocks/[stock_id]** (same endpoint, different action)

**Request for Partial Sell:**
```json
{
  "action": "sell_partial",
  "shares": 50,
  "price": 165.00
}
```

**Request for Sell All:**
```json
{
  "action": "sell_all",
  "price": 165.00
}
```

**Logic for Partial Sell:**
```
realized_gain = (sell_price - avg_price) × shares_to_sell
realized_gain_pct = (realized_gain / (avg_price × shares_to_sell)) × 100

UPDATE user_stocks
SET shares = shares - shares_to_sell,
    last_transaction_date = NOW()
WHERE user_id = ? AND stock_id = ? AND is_purchased = 1
```

**Logic for Sell All:**
```
realized_gain = (sell_price - avg_price) × current_shares
realized_gain_pct = (realized_gain / (avg_price × current_shares)) × 100

UPDATE user_stocks
SET shares = 0,
    is_active = 0,
    last_transaction_date = NOW()
WHERE user_id = ? AND stock_id = ? AND is_purchased = 1

-- Position now hidden from portfolio view (is_active = 0)
```

**Response:**
```json
{
  "status": "success",
  "shares_remaining": 100,
  "shares_sold": 50,
  "realized_gain": 750.00,
  "realized_gain_pct": 9.09,
  "message": "Sold 50 shares. Realized gain: +$750.00 (+9.09%)"
}
```

---

#### 5. Portfolio Summary (Optional Enhancement)
**GET /api/user/portfolio/summary**

Useful for dashboard stats display.

**Response:**
```json
{
  "total_positions": 3,
  "total_invested": 15000.00,
  "total_current_value": 16500.00,
  "total_unrealized_gain": 1500.00,
  "total_unrealized_gain_pct": 10.00,
  "best_performer": {
    "symbol": "AAPL",
    "unrealized_gain_pct": 10.00
  },
  "worst_performer": {
    "symbol": "GOOGL",
    "unrealized_gain_pct": -2.50
  }
}
```

---

## 4. FRONTEND COMPONENTS

### New Components

#### WatchlistSection
- Displays all watchlist items (is_purchased = 0)
- For each stock: symbol, price, change %, PE ratio
- Buttons: "Add to Portfolio", "Remove from Watchlist"
- On "Add to Portfolio" click → Open `PurchaseFromWatchlistModal`

#### PortfolioSection
- Displays all owned positions (is_purchased = 1, is_active = 1)
- For each stock: symbol, shares, avg price, current price, total value, gain/loss
- Buttons: "Buy More", "Sell", "View Details"
- On position shares reaching 0 → Automatically removed from display

#### WatchlistCard
- Individual watchlist item card
- Shows: Symbol, Company Name, Current Price, Daily Change, PE Ratio
- Action buttons: "Add to Portfolio", "Remove"

#### PortfolioCard
- Individual portfolio position card
- Shows: Symbol, Shares, Avg Purchase Price, Current Price, Total Value
- Shows: Unrealized Gain/Loss ($$ and %)
- Shows: Purchase date and last transaction date
- Action buttons: "Buy More", "Sell", "View Details"
- Conditional: If shares = 0, position disappears from view

#### PurchaseFromWatchlistModal
- Modal to convert watchlist item to owned position
- Inputs: Number of shares, Purchase price (prefilled with current price)
- On confirm: POST /api/user/stocks
- On success: Stock moves from Watchlist to Portfolio
- Watchlist item deleted, new portfolio position created

#### BuyMoreModal
- Modal to add shares to existing position
- Shows current holdings: shares, avg price, current price
- Inputs: Shares to add, New purchase price (prefilled with current price)
- Displays: New average price calculation preview
- On confirm: PATCH /api/user/stocks/[stock_id] { action: "buy" }
- On success: Portfolio updates with new totals

#### SellModal
- Modal to sell shares (partial or all)
- Shows current holdings: shares, avg price, current price
- Radio buttons: "Sell All" (default), "Sell Partial"
- If "Sell Partial": Input field for number of shares to sell
- Displays: Realized gain/loss preview
- Warning if selling all shares: "This will close your position"
- On confirm: PATCH /api/user/stocks/[stock_id] { action: "sell_partial" | "sell_all" }
- On success: Shows toast with realized gain/loss
- If sell_all: Stock removed from portfolio immediately

### Modified Components

#### Dashboard
- Split into two main sections:
  1. Watchlist Section (above)
  2. Portfolio Section (below)
- Add Portfolio Summary stats (optional)
- Loading states for each section

---

## 5. DATABASE OPERATIONS (Option A)

### When User Adds to Watchlist
```sql
INSERT INTO user_stocks
(user_id, stock_id, shares, purchase_price, is_purchased, is_active, created_at)
VALUES (?, ?, 0, 0, 0, 1, NOW())
```

### When User Purchases Stock (from Watchlist or New)
```sql
-- If new position:
INSERT INTO user_stocks
(user_id, stock_id, shares, purchase_price, is_purchased, is_active,
 initial_purchase_date, last_transaction_date, created_at)
VALUES (?, ?, ?, ?, 1, 1, NOW(), NOW(), NOW())

-- If converting from watchlist:
UPDATE user_stocks
SET shares = ?,
    purchase_price = ?,
    is_purchased = 1,
    initial_purchase_date = NOW(),
    last_transaction_date = NOW()
WHERE user_id = ? AND stock_id = ? AND is_purchased = 0
```

### When User Buys More Shares
```sql
-- Calculate new weighted average
-- new_avg = (old_shares × old_price + new_shares × new_price) / (old_shares + new_shares)

UPDATE user_stocks
SET shares = shares + ?,
    purchase_price = (purchase_price × (shares) + ? × ?) / (shares + ?),
    last_transaction_date = NOW()
WHERE user_id = ? AND stock_id = ? AND is_purchased = 1 AND is_active = 1
```

### When User Sells Partial
```sql
-- Calculate realized gain
-- realized_gain = (current_price - avg_price) × shares_sold

UPDATE user_stocks
SET shares = shares - ?,
    last_transaction_date = NOW()
WHERE user_id = ? AND stock_id = ? AND is_purchased = 1 AND is_active = 1

-- Position remains visible (shares > 0, is_active = 1)
-- No change to purchase_price (already average, don't need to recalculate)
```

### When User Sells All Shares
```sql
-- Calculate realized gain
-- realized_gain = (current_price - avg_price) × current_shares

UPDATE user_stocks
SET shares = 0,
    is_active = 0,
    last_transaction_date = NOW()
WHERE user_id = ? AND stock_id = ? AND is_purchased = 1 AND is_active = 1

-- Position is NOW hidden from portfolio (is_active = 0)
-- Data preserved in database for potential future history/reporting
```

### Fetch Portfolio (Exclude Closed Positions)
```sql
SELECT
  us.id,
  us.stock_id,
  s.symbol,
  s.company_name,
  us.shares,
  us.purchase_price,
  us.initial_purchase_date,
  us.last_transaction_date
FROM user_stocks us
JOIN stocks s ON us.stock_id = s.id
WHERE us.user_id = ?
  AND us.is_purchased = 1
  AND us.is_active = 1
  AND us.shares > 0
ORDER BY us.last_transaction_date DESC
```

---

## 6. COMPLETE USER WORKFLOW (Option A)

### Scenario: Buy 10 shares on 2/18, Sell 5 on 2/19, Buy 10 more on 2/20

**2/18 - User buys 10 shares @ $150:**
```
POST /api/user/stocks
{
  "stock_id": 5,
  "shares": 10,
  "purchase_price": 150.00
}

Database State:
- shares = 10
- purchase_price = 150.00
- is_purchased = 1
- is_active = 1
- initial_purchase_date = 2/18
- last_transaction_date = 2/18
```

**2/19 - User sells 5 shares @ $165:**
```
PATCH /api/user/stocks/5
{
  "action": "sell_partial",
  "shares": 5,
  "price": 165.00
}

Realized Gain = (165 - 150) × 5 = $75

Database State:
- shares = 5
- purchase_price = 150.00 (unchanged)
- is_purchased = 1
- is_active = 1 (still active)
- last_transaction_date = 2/19

Portfolio displays:
- 5 shares @ $150 avg
- Current value: $825
- Unrealized gain: +$75 (+10%)
```

**2/20 - User buys 10 more @ $160:**
```
PATCH /api/user/stocks/5
{
  "action": "buy",
  "shares": 10,
  "price": 160.00
}

New Avg Price = (5 × 150 + 10 × 160) / (5 + 10)
              = (750 + 1600) / 15
              = 2350 / 15
              = $156.67

Database State:
- shares = 15
- purchase_price = 156.67
- is_purchased = 1
- is_active = 1
- last_transaction_date = 2/20

Portfolio displays:
- 15 shares @ $156.67 avg
- If current price = $170:
- Current value: $2,550
- Unrealized gain: +$200 (+5.23%)
```

**Later - User sells all 15 shares @ $170:**
```
PATCH /api/user/stocks/5
{
  "action": "sell_all",
  "price": 170.00
}

Realized Gain = (170 - 156.67) × 15 = $200

Database State:
- shares = 0
- is_active = 0
- last_transaction_date = [current]

Portfolio displays:
✓ Stock DISAPPEARS from portfolio (is_active = 0)
✓ Toast shows: "Sold 15 shares. Realized gain: +$200 (+5.23%)"
✓ Data preserved in database (soft delete)
```

---

## 7. IMPLEMENTATION PHASES

### Phase 1: Database & Core API (Foundation)
**Duration:** 1-2 days
1. Run ALTER TABLE migration (3 new columns)
2. Modify existing endpoints to handle new columns:
   - POST /api/user/stocks (set initial_purchase_date, last_transaction_date)
   - GET /api/user/watchlist (unchanged)
3. Create new PATCH endpoint: /api/user/stocks/[stock_id]
   - Handle "buy" action (weighted average calculation)
   - Handle "sell_partial" action
   - Handle "sell_all" action
4. Create new GET endpoint: /api/user/portfolio
   - Filter is_purchased=1, is_active=1, shares > 0

### Phase 2: Dashboard Component Refactor
**Duration:** 1 day
1. Split Dashboard into WatchlistSection & PortfolioSection components
2. Create WatchlistCard component
3. Create PortfolioCard component
4. Update data fetching (call both GET /api/user/watchlist and GET /api/user/portfolio)
5. Implement conditional rendering (sections visible based on data)

### Phase 3: Modal Components & Controls
**Duration:** 1-2 days
1. Create PurchaseFromWatchlistModal
2. Create BuyMoreModal
3. Create SellModal
4. Wire up button click handlers
5. Add confirmation dialogs (especially for sell_all)
6. Implement success/error toast notifications

### Phase 4: Calculations & Display Logic
**Duration:** 1 day
1. Implement unrealized gain/loss calculations (display only)
2. Implement realized gain/loss calculations (in modals)
3. Format currency and percentage displays
4. Show weighted average price in preview

### Phase 5: Testing & Polish
**Duration:** 1-2 days
1. Input validation (can't sell more than owned, must buy > 0, etc.)
2. Edge case handling (0 shares, null values, rounding)
3. Error handling (network errors, database errors)
4. Loading states during API calls
5. Ensure closed positions (shares=0, is_active=0) don't display

---

## 8. SECURITY CONSIDERATIONS

✓ Validate user owns the stock before updating
✓ Prevent selling more shares than user holds (validation in API)
✓ Prevent negative values or 0 share bugs (validation in API)
✓ Database constraints: shares >= 0
✓ Rate limiting on trade operations (implement in middleware)
✓ Log all transactions for audit trail (optional, can add later)

---

## 9. CALCULATION FORMULAS

### Weighted Average Purchase Price (When Buying More)
```
new_avg_price = (old_shares × old_price + new_shares × new_price) / (old_shares + new_shares)

Example:
Old: 100 shares @ $150
New: 50 shares @ $160
Result: (100×150 + 50×160) / (100+50) = (15000 + 8000) / 150 = 23000/150 = $153.33
```

### Unrealized Gain/Loss (Display Only)
```
unrealized_gain = (current_price - avg_price) × shares
unrealized_gain_pct = (unrealized_gain / (avg_price × shares)) × 100

Example:
100 shares @ $150 avg, current price $165
Gain = (165 - 150) × 100 = $1,500
Gain% = 1500 / (150 × 100) × 100 = 10%
```

### Realized Gain/Loss (When Selling)
```
realized_gain = (sell_price - avg_price) × shares_sold
realized_gain_pct = (realized_gain / (avg_price × shares_sold)) × 100

Example 1 - Partial Sell:
Selling 50 of 100 shares @ $165, avg cost $150
Gain = (165 - 150) × 50 = $750
Gain% = 750 / (150 × 50) × 100 = 10%

Example 2 - Sell All:
Selling all 100 shares @ $165, avg cost $150
Gain = (165 - 150) × 100 = $1,500
Gain% = 1500 / (150 × 100) × 100 = 10%
```

---

## 10. SUMMARY

| Item | Details |
|------|---------|
| **Database Changes** | 3 new columns (Option A only) |
| **API Endpoints** | 1 new (GET /api/user/portfolio), 1 modified (PATCH /api/user/stocks) |
| **Cost Basis Tracking** | Weighted average (sufficient for now) |
| **Transaction History** | Not included (can add Option B later if needed for tax reporting) |
| **Closed Positions** | Removed from display (is_active=0, shares=0) |
| **Dividends** | Not tracked |
| **Exports** | Not included |
| **Price Alerts** | Not included |
| **Position Size Limits** | Zero shares = position closed and hidden |
| **Frontend Components** | 7 new/modified (2 sections + 5 modal/card components) |
| **Implementation Time** | ~5-7 days for complete implementation |

---

## 11. MIGRATION PATH (Non-Breaking)

**Step 1:** Add 3 new columns with defaults (won't break existing code)
```sql
ALTER TABLE user_stocks ADD COLUMN (
  initial_purchase_date DATETIME NULL,
  last_transaction_date DATETIME NULL,
  is_active BOOLEAN DEFAULT 1
);
```

**Step 2:** Populate existing data (backfill)
```sql
UPDATE user_stocks
SET initial_purchase_date = created_at,
    last_transaction_date = created_at,
    is_active = 1
WHERE is_purchased = 1;
```

**Step 3:** Deploy new API endpoints alongside old ones
- Old endpoints still work
- New endpoints ready to use

**Step 4:** Deploy dashboard refactor
- Uses new GET /api/user/portfolio endpoint
- Watchlist section uses existing GET /api/user/watchlist

**Step 5:** Test thoroughly
- Backward compatible until fully deployed
- No downtime required

---