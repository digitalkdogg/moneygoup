import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { checkOrigin } from '@/utils/originCheck';
import { createErrorResponse, unauthorizedResponse, notFoundResponse } from '@/utils/errorResponse';
import { getTickerSector, getSectorStocks, yahooFinance } from '@/utils/yahooFinanceHelper';
import { sanitizeTicker } from '@/utils/sanitize';

export async function GET(
  request: NextRequest,
  { params }: { params: { ticker: string } }
) {
  try {
    // 1. Origin check
    const originError = checkOrigin(request);
    if (originError) return originError;

    // 2. Auth check
    const session = await getServerSession(authOptions);
    if (!session) {
      return unauthorizedResponse();
    }

    // 3. Get raw input
    const rawInput = params.ticker;
    const decodedInput = decodeURIComponent(rawInput);
    
    // 4. Resolve sector
    let sector = null;
    let resolvedTicker = null;

    // Try input as a direct ticker
    const sanitizedTicker = sanitizeTicker(decodedInput);
    if (sanitizedTicker && sanitizedTicker.length <= 10) {
      sector = await getTickerSector(sanitizedTicker);
      if (sector) resolvedTicker = sanitizedTicker;
    }

    // If not found as ticker, search for the term
    if (!sector) {
      const searchRes = await yahooFinance.search(decodedInput);
      const firstEquity = searchRes.quotes.find(q => q.quoteType === 'EQUITY');
      if (firstEquity && (firstEquity as any).symbol) {
        sector = await getTickerSector((firstEquity as any).symbol);
        if (sector) resolvedTicker = (firstEquity as any).symbol;
      }
    }

    // If still no sector
    if (!sector) {
      return NextResponse.json({ 
        input: decodedInput, 
        sector: 'Unknown', 
        stocks: [],
        message: `No specific sector found for "${decodedInput}".`
      });
    }

    // 5. Get stocks in that sector
    const rawQuotes = await getSectorStocks(sector);
    
    // 6. Get detailed quotes for scoring
    const symbols = (rawQuotes || []).slice(0, 30).map((q: any) => q.symbol);
    
    // Ensure the resolved ticker is included in symbols to be scored
    if (resolvedTicker && !symbols.includes(resolvedTicker)) {
      symbols.push(resolvedTicker);
    }

    if (!symbols || symbols.length === 0) {
      return NextResponse.json({ input: decodedInput, sector, stocks: [] });
    }

    // Use yahooFinance from helper (instantiated)
    // Cast to any for quote to avoid potential type issues with bulk symbols in some versions
    const detailedQuotes = await (yahooFinance as any).quote(symbols, {}, { validateOptions: false });

    // 7. Compute Heat Scores
    const scoredCompanies = detailedQuotes.map((q: any) => {
      // Signals
      const priceChangePct = q.regularMarketChangePercent || 0;
      const volumeRatio = q.averageDailyVolume3Month > 0 
        ? (q.regularMarketVolume || 0) / q.averageDailyVolume3Month 
        : 1;
      
      const range = (q.fiftyTwoWeekHigh || 0) - (q.fiftyTwoWeekLow || 0);
      const fiftyTwoWeekPos = range > 0 
        ? (((q.regularMarketPrice || 0) - (q.fiftyTwoWeekLow || 0)) / range) * 100 
        : 50;

      const targetPrice = q.targetMedianPrice || q.targetMeanPrice || null;
      const analystUpside = targetPrice && q.regularMarketPrice
        ? ((targetPrice - q.regularMarketPrice) / q.regularMarketPrice) * 100 
        : 0;

      return {
        symbol: q.symbol,
        name: q.longName || q.shortName || q.symbol,
        price: q.regularMarketPrice,
        change: q.regularMarketChange,
        changePercent: q.regularMarketChangePercent,
        marketCap: q.marketCap,
        volume: q.regularMarketVolume,
        avgVolume: q.averageDailyVolume3Month,
        volumeRatio,
        fiftyTwoWeekHigh: q.fiftyTwoWeekHigh,
        fiftyTwoWeekLow: q.fiftyTwoWeekLow,
        fiftyTwoWeekPosition: fiftyTwoWeekPos,
        analystTargetPrice: targetPrice,
        analystUpside,
        signals: {
          priceChangePct,
          volumeRatio,
          fiftyTwoWeekPos,
          analystUpside: analystUpside > 0 ? analystUpside : 0
        }
      };
    });

    // Normalize signals
    const getMinMax = (field: string) => {
      const values = scoredCompanies.map((c: any) => c.signals[field]);
      if (values.length === 0) return { min: 0, max: 0 };
      return { min: Math.min(...values), max: Math.max(...values) };
    };

    const stats = {
      priceChangePct: getMinMax('priceChangePct'),
      volumeRatio: getMinMax('volumeRatio'),
      fiftyTwoWeekPos: getMinMax('fiftyTwoWeekPos'),
      analystUpside: getMinMax('analystUpside')
    };

    const normalize = (val: number, min: number, max: number) => {
      if (max === min) return 50;
      return ((val - min) / (max - min)) * 100;
    };

    const finalCompanies = scoredCompanies.map((c: any) => {
      const nPriceChange = normalize(c.signals.priceChangePct, stats.priceChangePct.min, stats.priceChangePct.max);
      const nVolumeRatio = normalize(c.signals.volumeRatio, stats.volumeRatio.min, stats.volumeRatio.max);
      const n52wPos = normalize(c.signals.fiftyTwoWeekPos, stats.fiftyTwoWeekPos.min, stats.fiftyTwoWeekPos.max);
      const nUpside = normalize(c.signals.analystUpside, stats.analystUpside.min, stats.analystUpside.max);

      const heatScore = (nPriceChange * 0.35) + (nVolumeRatio * 0.30) + (n52wPos * 0.20) + (nUpside * 0.15);

      return {
        ...c,
        heatScore: Math.round(heatScore),
        signals: undefined
      };
    });

    finalCompanies.sort((a: any, b: any) => b.heatScore - a.heatScore);
    const top10 = finalCompanies.slice(0, 10);

    return NextResponse.json({
      input: decodedInput,
      sector,
      stocks: top10
    });

  } catch (error) {
    console.error('Error in sector search API:', error);
    return createErrorResponse(
      error,
      'Internal Server Error'
    );
  }
}
