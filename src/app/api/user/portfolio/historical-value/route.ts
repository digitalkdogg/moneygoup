
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { executeRawQuery } from '@/utils/databaseHelper';
import { yahooFinance } from '@/utils/yahooFinanceHelper';
import { createLogger } from '@/utils/logger';
import { createErrorResponse } from '@/utils/errorResponse';

const logger = createLogger('api/user/portfolio/historical-value');

type Period = '1w' | '1m' | '6m' | '1y' | 'all';

function getPeriod(p: string | null): { startDate: string, endDate: string } {
    const now = new Date();
    const period = p?.toLowerCase() || '1w';
    
    // Yesterday for end date to avoid incomplete Yahoo data
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const endDate = yesterday.toISOString().split('T')[0];

    let startDate = new Date(now.getTime());
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
            startDate.setFullYear(now.getFullYear() - 5);
            break;
        default:
            startDate.setDate(now.getDate() - 7);
    }
    
    return { 
        startDate: startDate.toISOString().split('T')[0], 
        endDate: endDate 
    };
}


export async function GET(req: NextRequest) {
    const session = await getServerSession(authOptions);

    if (!session || !session.user?.id) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const userId = session.user.id;
    const { searchParams } = new URL(req.url);
    const periodParam = searchParams.get('period');

    try {
        logger.info('Fetching portfolio history', { userId, period: periodParam });

        const sql = `
            SELECT
                us.shares as quantity,
                s.symbol as ticker
            FROM
                user_stocks us
            JOIN
                stocks s ON us.stock_id = s.id
            WHERE
                us.user_id = ? AND us.shares > 0
        `;
        const [userStocksRows] = await executeRawQuery(sql, [userId]);

        const userStocks = userStocksRows as { quantity: string; ticker: string; }[];

        if (userStocks.length === 0) {
            logger.info('No user holdings found', { userId });
            return NextResponse.json([]);
        }

        const { startDate, endDate } = getPeriod(periodParam);
        logger.info('Requesting historical data from Yahoo', { startDate, endDate });

        const historicalDataPromises = userStocks.map(userStock => {
            return yahooFinance.historical(userStock.ticker, {
                period1: startDate,
                period2: endDate,
                interval: '1d'
            }).catch(err => {
                logger.error('Failed to fetch data for ticker', { ticker: userStock.ticker, error: err });
                return []; 
            });
        });

        const historicalDataResults = await Promise.all(historicalDataPromises);

        const portfolioHistory: { [key: string]: number } = {};

        userStocks.forEach((userStock, index) => {
            const historicalData = historicalDataResults[index];
            const sharesCount = parseFloat(userStock.quantity);
            
            if (Array.isArray(historicalData)) {
                historicalData
                    .filter(dayData => dayData.date && dayData.close !== null && dayData.close !== undefined)
                    .forEach(dayData => {
                        const dateStr = dayData.date instanceof Date 
                            ? dayData.date.toISOString().split('T')[0]
                            : String(dayData.date).split('T')[0];
                            
                        const dayValue = sharesCount * dayData.close;
                        if (!portfolioHistory[dateStr]) {
                            portfolioHistory[dateStr] = 0;
                        }
                        portfolioHistory[dateStr] += dayValue;
                    });
            }
        });

        const chartData = Object.keys(portfolioHistory).map(date => ({
            date,
            value: portfolioHistory[date],
        })).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

        logger.info('Returning portfolio chart data', { dataPoints: chartData.length });

        return NextResponse.json(chartData);

    } catch (error) {
        logger.error('Critical error in historical-value API', { error });
        return createErrorResponse(error, 'Failed to fetch portfolio history');
    }
}
