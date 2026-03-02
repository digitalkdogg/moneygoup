# Unused API Endpoints Report
Date: March 1, 2026

The following API endpoints were identified as having no direct calls from the frontend or internal services within the `src` directory.

## Unused Routes
These routes exist in the filesystem (`src/app/api/.../route.ts`) but no references to their URL paths were found in the codebase.

- `/api/cache-stats`
- `/api/user/portfolio/summary`
- `/api/dashboard/get`
- `/api/dashboard/deepmoney-picks`
- `/api/dashboard/recommended-stocks`
- `/api/dashboard/undervalued-large-caps`
- `/api/deepmoney` (The root route, though `/api/deepmoney/news` is mentioned in comments)
- `/api/stock/quote/[ticker]`
- `/api/stock/[ticker]/historical/[period]`
- `/api/stock/[ticker]/news`

## Notes on Specific Routes
- **DeepMoney**: While `src/app/api/deepmoney/news/route.ts` exists, it is mostly referenced in comments and its own file. No `fetch('/api/deepmoney/news')` was found in the frontend components.
- **Dashboard Variants**: Routes like `/api/dashboard/recommended-stocks` were searched but yielded no active `fetch` calls in the current UI components.
- **Stock Sub-routes**: The system seems to favor the consolidated `/api/stock/[ticker]` endpoint for most data, leaving sub-routes like `/historical` and `/news` (under `[ticker]`) unused as direct external calls.

## Recommendation
Before deleting any of these routes, verify if they are intended for future use or are called by external tools/scripts not indexed in the `src` directory (e.g., cron jobs or data sync scripts).
