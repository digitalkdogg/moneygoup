The "daily change" value displayed on your watchlist is directly sourced from the `daily_change` column within the `stocksdailyprice` table in your database.

Here's how it works:
1.  **Database Storage:** The `stocksdailyprice` table stores daily price information for each stock, and it includes a dedicated `daily_change` column.
2.  **API Retrieval:** The `src/app/api/dashboard/route.ts` API endpoint, which generates your watchlist data, includes this `daily_change` column in its main SQL query.
3.  **No In-App Calculation:** The application code in `src/app/api/dashboard/route.ts` does not calculate the daily change itself. It retrieves the already-calculated value from the database and uses it directly.

It's highly probable that an external process, such as a scheduled script (like `populate_daily_prices.py` which exists in your project), is responsible for calculating and updating this `daily_change` figure in the `stocksdailyprice` table on a regular basis.