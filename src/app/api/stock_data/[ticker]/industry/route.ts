import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { checkOrigin } from '@/utils/originCheck';
import { createErrorResponse, unauthorizedResponse } from '@/utils/errorResponse';
import { checkApprovalGuard } from '@/utils/approvalStatus';
import { yahooFinance, getSectorStocks } from '@/utils/yahooFinanceHelper';
import { isCanonicalSector } from '@/utils/sectorTaxonomy';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ ticker: string }> }
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
    const approvalOutcome = await checkApprovalGuard(session.user?.id);
    if (!approvalOutcome.allowed) {
      return NextResponse.json({ message: approvalOutcome.message, code: approvalOutcome.code }, { status: 403 });
    }

    // 3. Get raw input
    const { ticker: rawInput } = await params;
    const decodedInput = decodeURIComponent(rawInput).replace(/_/g, ' ');

    // 4. Resolve symbols via Yahoo's sector-specific predefined screener
    //    (ms_<sector>) so results match assetProfile.sector exactly — the same
    //    bucketing /portfolio's "Sector Exposure" uses.
    let targetSymbols: string[] = [];
    const resolvedTitle = decodedInput;

    if (isCanonicalSector(decodedInput)) {
      const sectorQuotes = await getSectorStocks(decodedInput, 50);
      targetSymbols = (sectorQuotes as any[]).map((q: any) => q.symbol).filter(Boolean);
    }

    if (targetSymbols.length === 0) {
      return NextResponse.json({
        input: decodedInput,
        industry: resolvedTitle,
        stocks: [],
        message: `No specific matches found for "${decodedInput}".`
      });
    }

    // 5. Deduplicate and cap before fetching quotes
    const uniqueSymbols = Array.from(new Set(targetSymbols)).slice(0, 40);

    const detailedQuotesRaw = await yahooFinance.quote(uniqueSymbols);
    const quoteArray = Array.isArray(detailedQuotesRaw) ? detailedQuotesRaw : [];

    // Filter: price must exist and be under $300
    const detailedQuotes = quoteArray.filter((q: any) => q && q.regularMarketPrice && q.regularMarketPrice < 300);

    if (detailedQuotes.length === 0) {
      return NextResponse.json({
        input: decodedInput,
        industry: resolvedTitle,
        stocks: [],
        message: `No stocks found with price < $300 for "${decodedInput}".`
      });
    }

    // 6. Compute Heat Scores
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
        signals: { priceChangePct, volumeRatio, fiftyTwoWeekPos, analystUpside: analystUpside > 0 ? analystUpside : 0 }
      };
    });

    // Normalize signals for scoring
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

    const normalize = (val: number, min: number, max: number) =>
      max === min ? 50 : ((val - min) / (max - min)) * 100;

    const finalCompanies = scoredCompanies
      .map((c: any) => {
        const nPriceChange = normalize(c.signals.priceChangePct, stats.priceChangePct.min, stats.priceChangePct.max);
        const nVolumeRatio = normalize(c.signals.volumeRatio, stats.volumeRatio.min, stats.volumeRatio.max);
        const n52wPos = normalize(c.signals.fiftyTwoWeekPos, stats.fiftyTwoWeekPos.min, stats.fiftyTwoWeekPos.max);
        const nUpside = normalize(c.signals.analystUpside, stats.analystUpside.min, stats.analystUpside.max);

        const heatScore = (nPriceChange * 0.35) + (nVolumeRatio * 0.30) + (n52wPos * 0.20) + (nUpside * 0.15);

        // Exclude internal signals and analyst fields from final output
        const { analystUpside, analystTargetPrice, signals, ...rest } = c;

        return { 
          ...rest, 
          heatScore: Math.round(heatScore)
        };
      })
      .sort((a: any, b: any) => b.heatScore - a.heatScore);

    return NextResponse.json({
      input: decodedInput,
      industry: resolvedTitle,
      stocks: finalCompanies.slice(0, 10)
    });

  } catch (error) {
    console.error('=== ERROR in industry sector API ===');
    if (error instanceof Error) {
      console.error('Error message:', error.message);
    } else {
      console.error('Raw error:', String(error));
    }
    return createErrorResponse(error, 'Internal Server Error');
  }
}