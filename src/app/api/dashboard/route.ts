import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { createLogger } from '@/utils/logger';
import { NextRequest, NextResponse } from 'next/server';
import { executeRawQuery } from '@/utils/databaseHelper';
import { checkOrigin } from '@/utils/originCheck';
import { calculateTechnicalIndicators, HistoricalData } from '@/utils/technicalIndicators';
import { createErrorResponse } from '@/utils/errorResponse';

interface DailyPriceRow {
  stock_id: number;
  date: string;
  close: string;
  volume: string;
  open: string;
  high: string;
  low: string;
}
const logger = createLogger('api/dashboard');

export async function GET(request: NextRequest) {
  const originCheckResponse = checkOrigin(request);
  if (originCheckResponse) {
    return originCheckResponse;
  }


  const session = await getServerSession(authOptions);

  if (!session) {
    return new NextResponse(JSON.stringify({ message: 'Unauthorized' }), { status: 401 });
  }

  try {
    const userId = session.user?.id; // Use optional chaining to safely access id
    if (!userId) {
      logger.error('Session user ID is undefined or null for an authenticated session.');
      return new NextResponse(JSON.stringify({ message: 'Unauthorized: User ID missing or invalid from session.' }), { status: 401 });
    }


    // 1. Fetch user-specific stock holdings
    const [userHoldingsResult] = await executeRawQuery<{ id: number; symbol: string; shares: string; purchase_price: string; is_owned: number }[]>(`
        SELECT
            s.id,
            s.symbol,
            us.shares,
            us.purchase_price,
            us.is_purchased AS is_owned
        FROM user_stocks us
        JOIN stocks s ON us.stock_id = s.id
        WHERE us.user_id = ?
        ORDER BY s.symbol;
    `, [userId]);

    // Extract symbols for batch Yahoo Finance query
    const symbols = userHoldingsResult.map(holding => holding.symbol);

    let yahooFinanceData = [];
    if (symbols.length > 0) {
      // Internal call to the new API endpoint to get batch Yahoo Finance data
      const yahooApiUrl = `${request.nextUrl.origin}/api/dashboard/get`;
      const yahooApiResponse = await fetch(yahooApiUrl, {
        headers: {
          'Cookie': request.headers.get('Cookie') || '', // Forward cookies for session validation
        },
      });

      if (!yahooApiResponse.ok) {
        const errorBody = await yahooApiResponse.json();
        throw new Error(`Failed to fetch Yahoo Finance data: ${errorBody.error || yahooApiResponse.statusText}`);
      }
      yahooFinanceData = await yahooApiResponse.json();
    }

    // Map Yahoo Finance data for easy lookup
    const yahooDataMap = new Map<number, any>();
    yahooFinanceData.forEach((data: any) => {
      if (data.stock_id) { // Ensure stock_id is present
        yahooDataMap.set(data.stock_id, data);
      }
    });

    // Merge user holdings with Yahoo Finance data
    const mergedStocks = userHoldingsResult.map(holding => {
      const yahooData = yahooDataMap.get(holding.id);
      return {
        id: holding.id,
        symbol: holding.symbol,
        shares: parseFloat(holding.shares),
        purchase_price: parseFloat(holding.purchase_price),
        is_owned: holding.is_owned,
        // Yahoo Finance data
        company_name: yahooData?.companyName || 'N/A',
        current_price: yahooData?.price || 0,
        daily_change: yahooData?.daily_change || 0,
        pe_ratio: yahooData?.trailingPE || null,
        pb_ratio: yahooData?.priceToBook || null,
        market_cap: yahooData?.marketCap || null,
      };
    });
    
    let stocks = mergedStocks; // Now 'stocks' contains merged data

    // No need for explicit de-duplication if userHoldingsResult is unique by s.id
    // But keeping this block for safety if underlying query could produce duplicates
    const uniqueStockIds = new Set<number>();
    stocks = stocks.filter(stock => {
      if (uniqueStockIds.has(stock.id)) {
        return false;
      }
      uniqueStockIds.add(stock.id);
      return true;
    });



    // 2. Fetch all historical prices, ordered by date for each stock
    const [pricesResult] = await executeRawQuery(`
        SELECT stock_id, date, \`close\`, volume, \`open\`, \`high\`, \`low\`
        FROM stocksdailyprice
        WHERE stock_id IN (SELECT stock_id FROM user_stocks WHERE user_id = ?)
        ORDER BY stock_id, date ASC;
    `, [userId]);
    const dailyPrices = pricesResult as DailyPriceRow[];

    // 3. Fetch news data for the user's stocks
    const [newsResult] = await executeRawQuery(`
        SELECT
            usn.stock_id,
            n.sentiment_score,
            n.pub_date
        FROM user_stock_news usn
        JOIN news n ON usn.news_id = n.id
        JOIN user_stocks us ON usn.user_id = us.user_id AND usn.stock_id = us.stock_id
        WHERE usn.user_id = ?
        ORDER BY n.pub_date DESC;
    `, [userId]);
    const newsData = newsResult as any[]; // Type as any for now

    // 3. Group prices by stock_id
    const pricesByStockId = dailyPrices.reduce((acc, row) => {
      const { stock_id, date, close, volume, open, high, low } = row;
      if (!acc[stock_id]) {
        acc[stock_id] = [];
      }
      acc[stock_id].push({
        date,
        close: parseFloat(close),
        volume: parseInt(volume, 10),
        open: parseFloat(open),
        high: parseFloat(high),
        low: parseFloat(low),
      });
      return acc;
    }, {} as Record<string, HistoricalData[]>);

    // 4. Group news by stock_id
    const newsByStockId = newsData.reduce((acc, row) => {
      const { stock_id, sentiment_score, pub_date } = row;
      if (!acc[stock_id]) {
        acc[stock_id] = [];
      }
      acc[stock_id].push({ sentiment_score: parseFloat(sentiment_score), pub_date: pub_date });
      return acc;
    }, {} as Record<string, { sentiment_score: number; pub_date: string }[]>);

    // 5. Combine data and perform calculations
    let totalDailyEarnings = 0;
    let totalLifetimeEarnings = 0;
    let ownedStocksCount = 0;
    let totalDailyChange = 0;

    const data = (stocks as any[]).map(stock => {
      const stockPrices = pricesByStockId[stock.id] || [];
      const stockNews = newsByStockId[stock.id] || []; // Get news for the current stock

      // Explicitly parse pe_ratio, pb_ratio, market_cap from potentially string/null values
      const peRatio = stock.pe_ratio !== null && stock.pe_ratio !== undefined ? parseFloat(stock.pe_ratio) : undefined;
      const pbRatio = stock.pb_ratio !== null && stock.pb_ratio !== undefined ? parseFloat(stock.pb_ratio) : undefined;
      const marketCap = stock.market_cap !== null && stock.market_cap !== undefined ? parseInt(stock.market_cap, 10) : undefined; // Market Cap is often integer

      const indicators = calculateTechnicalIndicators(
        stockPrices,
        stockNews,
        peRatio, // Pass parsed values
        pbRatio, // Pass parsed values
        marketCap  // Pass parsed values
      );

      const currentPrice = parseFloat(stock.current_price || '0');
      const shares = parseFloat(stock.shares);
      const purchasePrice = parseFloat(stock.purchase_price || '0');
      const daily_change = stock.daily_change ? parseFloat(stock.daily_change) : null;
      
      if (daily_change) {
        totalDailyChange += daily_change;
      }

      let estimatedDailyEarnings = 0;
      let lifetimeEarnings = 0;
      if (stock.is_owned === 1 && shares > 0) {
        if (daily_change !== null) {
          estimatedDailyEarnings = daily_change * shares;
        }
        if (purchasePrice && currentPrice) {
          lifetimeEarnings = (currentPrice - purchasePrice) * shares;
        }
        totalDailyEarnings += estimatedDailyEarnings;
        totalLifetimeEarnings += lifetimeEarnings;
        ownedStocksCount++;
      }

      return {
        stock_id: stock.id,
        symbol: stock.symbol,
        companyName: stock.company_name,
        price: currentPrice,
        daily_change: daily_change,
        recommendation: indicators.signal,
        isOwned: stock.is_owned === 1, // Convert TINYINT(1) to boolean
        shares: shares,
        purchase_price: purchasePrice,
        estimatedDailyEarnings: estimatedDailyEarnings,
        lifetimeEarnings: lifetimeEarnings,
        source: ['DATABASE'],
      };
    });

    const summary = {
      totalDailyEarnings,
      totalLifetimeEarnings,
      totalDailyChange,
    };

    return NextResponse.json({ stocks: data, summary });

  } catch (error: any) {
    logger.error("Failed to fetch dashboard data.", error);
    return createErrorResponse(error, 500);
  }
}
