import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { executeRawQuery } from '@/utils/databaseHelper';
import { createErrorResponse, unauthorizedResponse } from '@/utils/errorResponse';
import { createLogger } from '@/utils/logger';
import { checkOrigin } from '@/utils/originCheck';
import { fetchYahooStockSummary } from '@/utils/yahooFinanceHelper';
import { normalizeRecommendation } from '@/utils/formatters';
import { checkApprovalGuard } from '@/utils/approvalStatus';
import { getUserStrategy, resolveStrategy, DEFAULT_STRATEGY } from '@/utils/strategy';
import { adjustMlpUpsideForHorizon } from '@/utils/gps';

const logger = createLogger('api/user/portfolio');

// GET: Fetch user's portfolio (all active owned positions)
export async function GET(request: NextRequest) {
  const originCheckResponse = checkOrigin(request as any);
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
    // Resolve user's investment timeframe so we can return a horizon-aware
    // predicted_price and patch the GPS breakdown's mlpUpside accordingly.
    const userStrategy = await getUserStrategy(userId).catch(() => DEFAULT_STRATEGY);
    const timeframeConfig = resolveStrategy(userStrategy).timeframe;
    const priceColumn = timeframeConfig.predictedPriceColumn;
    const horizonLabel = timeframeConfig.shortLabel;

    const [portfolioItems] = await executeRawQuery(`
      SELECT
        us.user_id,
        us.stock_id,
        s.symbol,
        s.company_name,
        us.shares,
        us.purchase_price,
        COALESCE(us.average_cost_basis, us.purchase_price) AS average_cost_basis,
        us.first_purchase_date,
        us.initial_purchase_date,
        us.last_transaction_date,
        usp.predicted_price_1m,
        COALESCE(usp.${priceColumn}, usp.predicted_price_1m) AS predicted_price_horizon,
        sgs.gps_score,
        sgs.gps_breakdown,
        sb.primary_color,
        sb.logo
      FROM user_stocks us
      JOIN stocks s ON us.stock_id = s.id
      LEFT JOIN user_stock_predictions usp
        ON us.user_id = usp.user_id
       AND us.stock_id = usp.stock_id
      LEFT JOIN stock_gps_scores sgs ON sgs.stock_id = us.stock_id
      LEFT JOIN stock_brand sb
        ON LOWER(s.symbol) = LOWER(sb.ticker)
      WHERE us.user_id = ?
        AND us.is_purchased = 1
        AND us.is_active = 1
        AND us.shares > 0
      ORDER BY us.last_transaction_date DESC
    `, [userId]);

    // Dynamically import yahoo-finance2
    const yahooFinanceModule = await import('yahoo-finance2');
    const YahooFinance = yahooFinanceModule.default;
    const yahooFinanceInstance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

    // Fetch current prices and analyst data for each stock
    const portfolioWithData = await Promise.all(
      (portfolioItems as any[]).map(async (item) => {
        try {
          // Fetch quote and summary data
          const [quoteResult, summary] = await Promise.all([
            yahooFinanceInstance.quote(item.symbol),
            fetchYahooStockSummary(item.symbol).catch(err => {
              logger.warn(`Could not fetch summary for ${item.symbol}`, { error: err });
              return null;
            })
          ]);

          const currentPrice = (quoteResult as any)?.regularMarketPrice || null;
          let prevClose = null;

          // Try to get previous close from quote first
          const quotePrevClose = (quoteResult as any)?.regularMarketPreviousClose;
          if (quotePrevClose) {
            prevClose = quotePrevClose;
          } else {
            // Fallback to historical data if not available in quote
            try {
              const historicalResult = (await yahooFinanceInstance.chart(item.symbol, {
                period1: new Date(Date.now() - 86400000 * 7).toISOString().split('T')[0], // 7 days ago
                period2: new Date().toISOString().split('T')[0], // Today
                interval: '1d',
              })).quotes;

              if (historicalResult && historicalResult.length > 0) {
                // Find the most recent previous trading day closing price
                const today = new Date();
                today.setHours(0, 0, 0, 0);

                // Sort by date descending (most recent first)
                const sortedByDate = [...historicalResult].sort((a, b) =>
                  new Date(b.date).getTime() - new Date(a.date).getTime()
                );

                // Find the first data point that is before today
                for (const dataPoint of sortedByDate) {
                  const dataPointDate = new Date(dataPoint.date);
                  dataPointDate.setHours(0, 0, 0, 0);
                  if (dataPointDate.getTime() < today.getTime()) {
                    prevClose = dataPoint.close;
                    break;
                  }
                }
              }
            } catch (histError) {
              logger.warn(`Could not fetch historical data for ${item.symbol}`, { error: histError });
            }
          }

          // Patch the cached 1m-baseline breakdown to reflect the user's
          // timeframe. Math is identical to the dashboard recommendations route.
          const baselineBreakdown = item.gps_breakdown
            ? (typeof item.gps_breakdown === 'string' ? JSON.parse(item.gps_breakdown) : item.gps_breakdown)
            : null;
          let perUserGpsScore = item.gps_score !== null ? parseFloat(item.gps_score) : null;
          let perUserGpsBreakdown = baselineBreakdown;
          const horizonPrice = item.predicted_price_horizon != null ? parseFloat(item.predicted_price_horizon) : null;
          if (baselineBreakdown && currentPrice && horizonPrice && currentPrice > 0) {
            const horizonDeltaPct = ((horizonPrice - currentPrice) / currentPrice) * 100;
            const adjusted = adjustMlpUpsideForHorizon(baselineBreakdown, horizonDeltaPct);
            perUserGpsScore = adjusted.score;
            perUserGpsBreakdown = adjusted.breakdown;
          }

          return {
            ...item,
            regularMarketPrice: currentPrice,
            prev_close: prevClose,
            recommendationKey: summary?.financialData?.recommendationKey || null,
            recommendationMean: summary?.financialData?.recommendationMean || null,
            numberOfAnalystOpinions: summary?.financialData?.numberOfAnalystOpinions || null,
            brand_color: item.primary_color || null,
            gpsScore: perUserGpsScore,
            gpsBreakdown: perUserGpsBreakdown,
            gpsHorizon: userStrategy.investment_timeframe,
            sector: (summary as any)?.assetProfile?.sector || null,
            is_etf: (quoteResult as any)?.quoteType?.toUpperCase() === 'ETF',
            fiftyTwoWeekHigh: (quoteResult as any)?.fiftyTwoWeekHigh ?? null,
            logo: item.logo ?? null
          };
        } catch (dataError) {
          logger.error(`Error fetching data for ${item.symbol}:`, { error: dataError as Error });
          return {
            ...item,
            regularMarketPrice: null,
            prev_close: null,
            recommendationKey: null,
            numberOfAnalystOpinions: null,
            brand_color: item.primary_color || null,
            is_etf: false
          };
        }
      })
    );

    // Calculate totals using average_cost_basis for accuracy
    let costBasis = 0;
    let marketValue = 0;
    let unrealizedGain = 0;
    let unrealizedLoss = 0;

    portfolioWithData.forEach(item => {
      const costPerShare = item.average_cost_basis ?? item.purchase_price;
      const itemCost = item.shares * costPerShare;
      const itemValue = item.shares * (item.regularMarketPrice || costPerShare);
      const itemGain = itemValue - itemCost;

      costBasis += itemCost;
      marketValue += itemValue;

      if (itemGain > 0) {
        unrealizedGain += itemGain;
      } else {
        unrealizedLoss += Math.abs(itemGain);
      }
    });

    const unrealizedNet = marketValue - costBasis;
    const unrealizedPct = costBasis !== 0 ? (unrealizedNet / costBasis) * 100 : 0;

    // Pull daily change and realized gain from the latest snapshot if available
    let dailyChangeAmount: number | null = null;
    let dailyChangePct: number | null = null;
    let realizedGainLoss: number | null = null;
    try {
      const [snapshotRows] = await executeRawQuery(
        `SELECT daily_change_amount, daily_change_percent, realized_gain_loss
         FROM portfolio_daily_snapshots
         WHERE user_id = ?
         ORDER BY snapshot_date DESC
         LIMIT 1`,
        [userId]
      ) as any[];
      if (Array.isArray(snapshotRows) && snapshotRows.length > 0) {
        const snap = snapshotRows[0];
        dailyChangeAmount = snap.daily_change_amount != null ? parseFloat(snap.daily_change_amount) : null;
        dailyChangePct = snap.daily_change_percent != null ? parseFloat(snap.daily_change_percent) : null;
        realizedGainLoss = snap.realized_gain_loss != null ? parseFloat(snap.realized_gain_loss) : null;
      }
    } catch {
      // Snapshots are optional enrichment — continue without them
    }

    // Build ratings summary for the response
    const ratings = portfolioWithData.map(item => ({
      symbol: item.symbol,
      primary: normalizeRecommendation(item.recommendationKey),
      score: item.recommendationMean || null,
      count: item.numberOfAnalystOpinions || null
    }));

    const result = {
      portfolio: portfolioWithData || [],
      horizonLabel,
      totals: {
        costBasis,
        marketValue,
        unrealizedGain,
        unrealizedLoss,
        unrealizedNet,
        unrealizedPct,
        dailyChangeAmount,
        dailyChangePct,
        realizedGainLoss,
      },
      ratings,
      asOf: new Date().toISOString()
    };

    return NextResponse.json(result, { status: 200 });
  } catch (error: any) {
    logger.error('Error fetching user portfolio:', { error });
    return createErrorResponse(error, 'Error fetching user portfolio', { status: 500 });
  }
}

