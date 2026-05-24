
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { executeRawQuery } from '@/utils/databaseHelper';
import { yahooFinance } from '@/utils/yahooFinanceHelper';
import { createLogger } from '@/utils/logger';
import { createErrorResponse } from '@/utils/errorResponse';
import { checkApprovalGuard } from '@/utils/approvalStatus';
import { checkOrigin } from '@/utils/originCheck';

const logger = createLogger('api/user/portfolio/historical-value');

type Period = '1w' | '1m' | '6m' | '1y' | 'all';

function getStartDate(period: Period, firstPurchaseDate: Date | null): Date {
    const now = new Date();
    let startDate = new Date();

    switch (period) {
        case '1w':
            startDate.setDate(now.getDate() - 7);
            break;
        case '1m':
            startDate.setMonth(now.getMonth() - 1);
            break;
        case '6m':
            startDate.setMonth(now.getMonth() - 6);
            break;
        case '1y':
            startDate.setFullYear(now.getFullYear() - 1);
            break;
        case 'all':
            return firstPurchaseDate || new Date(now.getFullYear() - 5, now.getMonth(), now.getDate());
    }

    if (firstPurchaseDate && startDate < firstPurchaseDate) {
        return firstPurchaseDate;
    }
    return startDate;
}

export async function GET(req: NextRequest) {
    const originCheckResponse = checkOrigin(req);
    if (originCheckResponse) {
        return originCheckResponse;
    }

    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const userId = session.user.id;
    const approvalOutcome = await checkApprovalGuard(userId);
    if (!approvalOutcome.allowed) {
        return NextResponse.json({ message: approvalOutcome.message, code: approvalOutcome.code }, { status: 403 });
    }

    const periodParam = (req.nextUrl.searchParams.get('period') as Period) || '1w';

    try {
        logger.info(`Fetching portfolio history for user ${userId} for period ${periodParam}`);

        // 1. Fetch current holdings and their initial purchase dates
        const holdingsSql = `
            SELECT s.symbol as ticker, us.shares, us.initial_purchase_date
            FROM user_stocks us
            JOIN stocks s ON us.stock_id = s.id
            WHERE us.user_id = ? AND us.shares > 0 AND us.is_purchased = 1
            ORDER BY us.initial_purchase_date ASC
        `;
        const [holdings] = await executeRawQuery(holdingsSql, [userId]) as any[];

        if (!holdings || holdings.length === 0) {
            logger.warn('No user holdings found with shares > 0 and is_purchased = 1, returning empty history.');
            return NextResponse.json([]);
        }

        logger.info(`Found ${holdings.length} holdings for user`, {
            holdings: holdings.map((h: any) => ({ ticker: h.ticker, shares: h.shares }))
        });

        const firstPurchaseDate = holdings[0]?.initial_purchase_date ? new Date(holdings[0].initial_purchase_date) : null;
        const startDate = getStartDate(periodParam, firstPurchaseDate);
        const endDate = new Date();

        // 2. Fetch price histories for all held stocks
        const uniqueTickers = [...new Set(holdings.map((h: any) => h.ticker))];
        logger.info(`Fetching price history for tickers: ${uniqueTickers.join(', ')} from ${startDate.toISOString()} to ${endDate.toISOString()}`);
        
        const priceHistoryPromises = uniqueTickers.map(ticker =>
            (yahooFinance as any).chart(ticker as string, { period1: startDate, period2: endDate, interval: '1d' })
                .then((result: any) => result.quotes as any[])
                .then((quotes: any[]) =>
                    // Filter out quotes with null close prices and map to expected format
                    quotes
                        .filter((q: any) => q.close !== null && q.close !== undefined)
                        .map((q: any) => ({
                            date: q.date,
                            close: q.close
                        }))
                )
                .catch((err: Error) => {
                    logger.warn(`Failed to fetch history for ${ticker}`, { error: err.message });
                    return []; // Return empty array on failure
                })
        );
        const priceHistoryResults = await Promise.all(priceHistoryPromises);

        // 3. Create a fast lookup map for prices
        const priceMap: Record<string, Record<string, number>> = {};
        uniqueTickers.forEach((ticker, index) => {
            priceMap[ticker as string] = {};
            const prices = priceHistoryResults[index];
            logger.info(`Price history for ${ticker}:`, {
                dataPoints: prices?.length || 0,
                firstPrice: prices?.[0],
                lastPrice: prices?.[prices.length - 1]
            });
            if (prices) {
                prices.forEach((day: any) => {
                    priceMap[ticker as string][new Date(day.date).toISOString().split('T')[0]] = day.close;
                });
            }
        });

        // 4. Calculate daily portfolio value
        const portfolioHistory: { date: string, value: number }[] = [];
        let currentDate = new Date(startDate);
        let daysProcessed = 0;
        let daysWithoutData = 0;

        while (currentDate <= endDate) {
            const dateStr = currentDate.toISOString().split('T')[0];
            let dailyValue = 0;
            let dataForDayExists = false;
            daysProcessed++;

            for (const holding of holdings) {
                const holdingPurchaseDate = holding.initial_purchase_date ? new Date(holding.initial_purchase_date) : new Date(0);

                // Only include stock value if the current chart date is on or after the purchase date
                if (currentDate >= holdingPurchaseDate) {
                    let closePrice = priceMap[holding.ticker]?.[dateStr];

                    // If price is missing (weekend/holiday), find the last known price
                    if (closePrice === undefined) {
                        let tempDate = new Date(currentDate);
                        for (let i = 0; i < 7; i++) {
                            tempDate.setDate(tempDate.getDate() - 1);
                            const tempDateStr = tempDate.toISOString().split('T')[0];
                            if (priceMap[holding.ticker]?.[tempDateStr]) {
                                closePrice = priceMap[holding.ticker][tempDateStr];
                                break;
                            }
                        }
                    }

                    if (closePrice !== undefined) {
                        dailyValue += parseFloat(holding.shares) * closePrice;
                        dataForDayExists = true;
                    }
                }
            }

            // Only add data point if there was value to calculate
            if (dataForDayExists) {
                portfolioHistory.push({ date: dateStr, value: dailyValue });
            } else {
                daysWithoutData++;
            }

            currentDate.setDate(currentDate.getDate() + 1);
        }

        logger.info('Successfully calculated portfolio history', {
            dataPoints: portfolioHistory.length,
            daysProcessed,
            daysWithoutData,
            priceMapKeys: Object.keys(priceMap)
        });
        return NextResponse.json(portfolioHistory);

    } catch (error) {
        const err = error as Error;
        logger.error('Fatal error in historical-value API', { 
            errorMessage: err.message,
            stack: err.stack,
        });
        return createErrorResponse(err, 'Failed to reconstruct portfolio history');
    }
}
