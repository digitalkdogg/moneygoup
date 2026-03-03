import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { checkOrigin } from '@/utils/originCheck';
import { createErrorResponse, unauthorizedResponse } from '@/utils/errorResponse';
import { yahooFinance } from '@/utils/yahooFinanceHelper';
import { categorizeByTaxonomy, getCategoryStrategy, getCategoryKeywords } from '@/utils/industryTaxonomy';

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
    
    // 4. Resolve Category using Taxonomy
    // First, search for the term to get some context
    const searchRes = await yahooFinance.search(decodedInput, { quotesCount: 10 });
    const topEquities = searchRes.quotes.filter(q => q.quoteType === 'EQUITY');

    let category = null;
    let resolvedTitle = decodedInput;

    if (topEquities.length > 0) {
      // Fetch profile of the best match to categorize
      const bestMatch = topEquities[0];
      try {
        const summary = await yahooFinance.quoteSummary(bestMatch.symbol as string, { 
          modules: ['assetProfile'] 
        });
        
        const profile: any = summary.assetProfile || {};
        const combinedText = `
          ${bestMatch.symbol} 
          ${bestMatch.shortName || ''} 
          ${profile.industry || ''} 
          ${profile.sector || ''} 
          ${profile.longBusinessSummary || ''}
        `;
        
        category = categorizeByTaxonomy(combinedText);
      } catch (err) {
        console.error(`Error fetching profile for ${bestMatch.symbol}:`, err);
      }
    }

    // If still no category, try to categorize the input string itself
    if (!category) {
      category = categorizeByTaxonomy(decodedInput);
    }

    // 5. Execute Strategy based on Category
    let targetSymbols: string[] = [];
    
    if (category) {
      const strategy = getCategoryStrategy(category);
      const keywords = getCategoryKeywords(category);
      resolvedTitle = strategy.title;

      console.log(`\n[Industry Search] Identified Category: "${category}"`);

      if (strategy.screenerId) {
        console.log(`[Industry Search] CALLING SCREENER: yahooFinance.screener({ scrIds: "${strategy.screenerId}", count: 50 })`);
        const screenerRes = await yahooFinance.screener({ scrIds: strategy.screenerId as any, count: 50 });
        targetSymbols = (screenerRes.quotes || []).map(q => q.symbol);
      } else {
        // B. Use Taxonomy Keywords for Individual Parallel Searches
        const searchKeywords = keywords.slice(0, 8); // Use top 8 keywords to stay within reasonable limits
        console.log(`[Industry Search] Parallel searching ${searchKeywords.length} keywords: ${searchKeywords.join(', ')}`);
        
        const searchPromises = searchKeywords.map(kw => {
          console.log(`[Industry Search] CALLING: yahooFinance.search("${kw}", { quotesCount: 5 })`);
          return yahooFinance.search(kw, { quotesCount: 5 });
        });

        const allResults = await Promise.all(searchPromises);
        
        // Flatten all results and extract equity symbols
        targetSymbols = allResults.flatMap(res => 
          (res.quotes || [])
            .filter(q => q.quoteType === 'EQUITY')
            .map(q => q.symbol as string)
        );
      }
    }

    // Fallback: If no category or no symbols found yet, use search results from original term
    if (targetSymbols.length === 0) {
      targetSymbols = topEquities.map(e => e.symbol as string);
    }

    if (targetSymbols.length === 0) {
      return NextResponse.json({ 
        input: decodedInput, 
        industry: resolvedTitle, 
        stocks: [],
        message: `No specific matches found for "${decodedInput}".`
      });
    }

    // 6. Get detailed quotes for scoring
    // Deduplicate and slice
    const uniqueSymbols = Array.from(new Set(targetSymbols)).slice(0, 40);
    const detailedQuotesRaw = await (yahooFinance as any).quote(uniqueSymbols, {}, { validateOptions: false });

    // Filter by price < $300
    const detailedQuotes = detailedQuotesRaw.filter((q: any) => q.regularMarketPrice < 300);
    console.log(`[Industry Search] Filtered ${detailedQuotesRaw.length} stocks down to ${detailedQuotes.length} with price < $300`);

    // 7. Compute Heat Scores
    const scoredCompanies = detailedQuotes.map((q: any) => {
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
    
    return NextResponse.json({
      input: decodedInput,
      industry: resolvedTitle,
      stocks: finalCompanies.slice(0, 10)
    });

  } catch (error) {
    console.error('Error in taxonomy keyword search API:', error);
    return createErrorResponse(
      error,
      'Internal Server Error'
    );
  }
}
