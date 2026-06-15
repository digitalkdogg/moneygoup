import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { validate } from '@/utils/validation';
import { addStockSchema, AddStockInput } from '@/app/api/user/watchlist/schema';
import { executeRawQuery, insert, upsert } from '@/utils/databaseHelper';
import { createErrorResponse, unauthorizedResponse, validationErrorResponse, notFoundResponse } from '@/utils/errorResponse';
import { createLogger } from '@/utils/logger';
import { checkOrigin } from '@/utils/originCheck';
import { fetchYahooStockSummary } from '@/utils/yahooFinanceHelper';
import { LimitService } from '@/utils/limitService';
import { checkApprovalGuard } from '@/utils/approvalStatus';
import { getUserStrategy, resolveStrategy, DEFAULT_STRATEGY } from '@/utils/strategy';
import { adjustMlpUpsideForHorizon } from '@/utils/gps';

const logger = createLogger('api/user/watchlist');

// GET: Fetch user's watchlist
export async function GET(request: NextRequest) {
  const originCheckResponse = checkOrigin(request);
  if (originCheckResponse) {
    return originCheckResponse;
  }
  const session = await getServerSession(authOptions);

  if (!session || !session.user || !session.user.id) {
    return unauthorizedResponse();
  }

  const userId = session.user.id;

  const approvalOutcome = await checkApprovalGuard(userId);
  if (!approvalOutcome.allowed) {
    logger.warn('Access denied due to approval status:', { userId, code: approvalOutcome.code });
    return NextResponse.json(
      { message: approvalOutcome.message, code: approvalOutcome.code, reason: (approvalOutcome as any).reason },
      { status: 403 }
    );
  }

  try {
    // Pick the user's timeframe-specific predicted_price column for horizon-aware GPS.
    const userStrategy = await getUserStrategy(userId).catch(() => DEFAULT_STRATEGY);
    const timeframeConfig = resolveStrategy(userStrategy).timeframe;
    const priceColumn = timeframeConfig.predictedPriceColumn;
    const horizonLabel = timeframeConfig.shortLabel;

    const [watchlistItems]: any[] = await executeRawQuery(`
      SELECT
        s.id AS stock_id,
        s.symbol,
        s.company_name,
        us.shares,
        us.purchase_price,
        us.is_purchased,
        s.price AS db_price,
        usp.predicted_price_1m,
        COALESCE(usp.${priceColumn}, usp.predicted_price_1m) AS predicted_price_horizon,
        sgs.gps_score,
        sgs.gps_breakdown
      FROM user_stocks us
      JOIN stocks s ON us.stock_id = s.id
      LEFT JOIN user_stock_predictions usp ON us.user_id = usp.user_id AND us.stock_id = usp.stock_id
      LEFT JOIN stock_gps_scores sgs ON sgs.stock_id = us.stock_id
      WHERE us.user_id = ?
        AND us.is_active = 1
        AND us.is_purchased = 0
        AND us.user_confirmed = 1
    `, [userId]);

    // Dynamically import yahoo-finance2
    const yahooFinanceModule = await import('yahoo-finance2');
    const YahooFinance = yahooFinanceModule.default;
    const yahooFinanceInstance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

    const watchlistWithData = await Promise.all(watchlistItems.map(async (item: any) => {
      // Fetch 6M MA data from DB
      const [dailyPrices]: any[] = await executeRawQuery(`
        SELECT close
        FROM stocksdailyprice
        WHERE stock_id = ?
        ORDER BY date DESC
        LIMIT 120
      `, [item.stock_id]);

      const closingPrices = dailyPrices.map((price: any) => parseFloat(price.close));
      const sum = closingPrices.reduce((acc: number, price: number) => acc + price, 0);
      const ma6_month = closingPrices.length > 0 ? sum / closingPrices.length : null;

      // Fetch live data from Yahoo Finance
      try {
        const [quoteResult, summary] = await Promise.all([
          yahooFinanceInstance.quote(item.symbol),
          fetchYahooStockSummary(item.symbol).catch(err => {
            logger.warn(`Could not fetch summary for ${item.symbol}`, { error: err });
            return null;
          })
        ]);

        const regularMarketPrice = (quoteResult as any)?.regularMarketPrice || item.db_price || 0;
        const prev_close = (quoteResult as any)?.regularMarketPreviousClose || null;

        // Patch the cached 1m-baseline breakdown using the user's timeframe delta.
        const baselineBreakdown = item.gps_breakdown
          ? (typeof item.gps_breakdown === 'string' ? JSON.parse(item.gps_breakdown) : item.gps_breakdown)
          : null;
        let perUserGpsScore = item.gps_score !== null ? parseFloat(item.gps_score) : null;
        let perUserGpsBreakdown = baselineBreakdown;
        const horizonPrice = item.predicted_price_horizon != null ? parseFloat(item.predicted_price_horizon) : null;
        if (baselineBreakdown && regularMarketPrice > 0 && horizonPrice) {
          const horizonDeltaPct = ((horizonPrice - regularMarketPrice) / regularMarketPrice) * 100;
          const adjusted = adjustMlpUpsideForHorizon(baselineBreakdown, horizonDeltaPct);
          perUserGpsScore = adjusted.score;
          perUserGpsBreakdown = adjusted.breakdown;
        }

        return {
          ...item,
          ma6_month: ma6_month,
          regularMarketPrice,
          prev_close,
          recommendationKey: summary?.financialData?.recommendationKey || null,
          numberOfAnalystOpinions: summary?.financialData?.numberOfAnalystOpinions || null,
          gpsScore: perUserGpsScore,
          gpsBreakdown: perUserGpsBreakdown,
          gpsHorizon: userStrategy.investment_timeframe,
        };
      } catch (yahooError: any) {
        logger.error(`Error fetching Yahoo data for ${item.symbol}:`, { error: yahooError });
        return {
          ...item,
          ma6_month: ma6_month,
          regularMarketPrice: item.db_price || 0,
          prev_close: null,
          recommendationKey: null,
          numberOfAnalystOpinions: null
        };
      }
    }));

    return NextResponse.json({ watchlist: watchlistWithData, horizonLabel }, { status: 200 });
  } catch (error: any) {
    logger.error('Error fetching user watchlist:', { error });
    return createErrorResponse(error, 'Error fetching user watchlist', { status: 500 });
  }
}

// POST: Add stock to watchlist
export const POST = validate(addStockSchema)(
  async (request: NextRequest, data: AddStockInput) => {
    const originCheckResponse = checkOrigin(request);
    if (originCheckResponse) {
      return originCheckResponse;
    }
    const session = await getServerSession(authOptions);

    if (!session || !session.user || !session.user.id) {
      return unauthorizedResponse();
    }

    const userId = session.user.id;
    const userRole = (session.user as any).role || 'user';
    const { ticker, name } = data;

    const approvalOutcome = await checkApprovalGuard(userId);
    if (!approvalOutcome.allowed) {
      logger.warn('Access denied due to approval status:', { userId, code: approvalOutcome.code });
      return NextResponse.json(
        { message: approvalOutcome.message, code: approvalOutcome.code, reason: (approvalOutcome as any).reason },
        { status: 403 }
      );
    }

    try {
      // 0. Check limits
      const limitCheck = await LimitService.canAddWatchlistItem(userId, userRole);
      if (!limitCheck.allowed) {
        return NextResponse.json(
          {
            code: 'LIMIT_EXCEEDED',
            dimension: 'watchlist',
            allowed: limitCheck.max,
            current: limitCheck.current,
            message: `Watchlist limit exceeded. Your current limit is ${limitCheck.max} items.`
          },
          { status: 403 }
        );
      }

      // 1. Find existing stock or insert new one
      const [existingStocks] = await executeRawQuery('SELECT id FROM stocks WHERE symbol = ?', [ticker.toUpperCase()]);
      let stockId;

      if (Array.isArray(existingStocks) && existingStocks.length > 0) {
        stockId = existingStocks[0].id;
      } else {
        stockId = await insert('stocks', {
          symbol: ticker.toUpperCase(),
          company_name: name,
        });
      }

      // Capture the current market price so the search page can show
      // "Price When Added" + "Change Since Added" for this watchlist entry.
      // Failure here is non-fatal — we fall back to 0 and just hide those stats.
      let priceWhenAdded = 0;
      try {
        const yahooFinanceModule = await import('yahoo-finance2');
        const YahooFinance = yahooFinanceModule.default;
        const yahooFinanceInstance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
        const quote = await yahooFinanceInstance.quote(ticker.toUpperCase());
        priceWhenAdded = Number((quote as any)?.regularMarketPrice) || 0;
      } catch (priceError) {
        logger.warn('Could not capture price-when-added for watchlist entry', { ticker, error: priceError });
      }

      // 2. Add to user_stocks as a watchlist item (is_purchased = 0)
      await upsert('user_stocks', {
        user_id: userId,
        stock_id: stockId,
        is_purchased: 0, // Mark as watchlist item
        shares: 1, // Set 1 share to indicate watchlist interest (shares > 0)
        purchase_price: priceWhenAdded,
        user_confirmed: 1, // Mark as confirmed by user
        is_active: 1
      }, ['user_id', 'stock_id']); // Use upsert behavior for user_stocks

      return NextResponse.json(
        {
          status: 'success',
          message: 'Stock added to watchlist',
          stock_id: stockId,
        },
        { status: 201 }
      );
    } catch (dbError: any) {
      logger.error('Database error adding stock to watchlist:', { error: dbError });
      return createErrorResponse(dbError, 'Database error adding stock to watchlist', { status: 500 });
    }
  }
);

// DELETE: Remove stock from watchlist
export async function DELETE(request: NextRequest) {
  const originCheckResponse = checkOrigin(request);
  if (originCheckResponse) {
    return originCheckResponse;
  }
  const session = await getServerSession(authOptions);

  if (!session || !session.user || !session.user.id) {
    return unauthorizedResponse();
  }

  const userId = session.user.id;

  const approvalOutcome = await checkApprovalGuard(userId);
  if (!approvalOutcome.allowed) {
    logger.warn('Access denied due to approval status:', { userId, code: approvalOutcome.code });
    return NextResponse.json(
      { message: approvalOutcome.message, code: approvalOutcome.code, reason: (approvalOutcome as any).reason },
      { status: 403 }
    );
  }

  const { searchParams } = new URL(request.url);
  const ticker = searchParams.get('stockId'); // Assuming stockId is passed as ticker symbol

  if (!ticker) {
    return validationErrorResponse('Stock ticker is required');
  }

  try {
    // 1. Find stock_id from ticker
    const [existingStocks] = await executeRawQuery('SELECT id FROM stocks WHERE symbol = ?', [ticker.toUpperCase()]);
    let stockId;

    if (Array.isArray(existingStocks) && existingStocks.length > 0) {
      stockId = existingStocks[0].id;
    } else {
      // If stock not found in main stocks table, it can't be on watchlist either
      return notFoundResponse('Stock not found');
    }

    // 2. Delete from user_stocks where is_purchased = 0
    await executeRawQuery(
      'DELETE FROM user_stocks WHERE user_id = ? AND stock_id = ? AND is_purchased = 0',
      [userId, stockId]
    );

    return NextResponse.json(
      {
        status: 'success',
        message: 'Stock removed from watchlist',
      },
      { status: 200 }
    );
  } catch (dbError: any) {
    logger.error('Database error removing stock from watchlist:', { error: dbError });
    return createErrorResponse(dbError, 'Database error removing stock from watchlist', { status: 500 });
  }
}
