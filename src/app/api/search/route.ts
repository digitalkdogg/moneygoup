import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { checkOrigin } from '@/utils/originCheck';
import { executeRawQuery } from '@/utils/databaseHelper';
import { createErrorResponse, unauthorizedResponse } from '@/utils/errorResponse';
import { createLogger } from '@/utils/logger';

const logger = createLogger('api/search');

const RESULT_LIMIT = 20;
const FULLTEXT_MIN_LEN = 3;
const TICKER_RE = /^[A-Za-z][A-Za-z0-9.\-\^]{0,6}$/;

interface StockRow {
  symbol: string;
  company_name: string;
  sector: string | null;
  industry: string | null;
  size_bucket: string | null;
  market_cap: number | null;
  match_type: 'exact' | 'prefix' | 'fulltext';
  score?: number;
}

/**
 * Build the FULLTEXT boolean-mode search expression. NATURAL LANGUAGE MODE
 * is nicer for ranking but drops queries shorter than innodb_ft_min_token_size
 * (default 3). Boolean mode with '*' wildcards lets us keep short prefixes
 * meaningful ("wm" → wm*) while still ranking by relevance.
 */
function toBooleanQuery(q: string): string {
  return q
    .toLowerCase()
    .replace(/[+\-<>()~*"@]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(t => (t.length < FULLTEXT_MIN_LEN ? `${t}*` : `+${t}*`))
    .join(' ');
}

export async function GET(request: NextRequest) {
  const originCheckResponse = checkOrigin(request);
  if (originCheckResponse) return originCheckResponse;

  const session = await getServerSession(authOptions);
  if (!session) return unauthorizedResponse();

  const url = new URL(request.url);
  const rawQ = (url.searchParams.get('q') || '').trim();
  const limit = Math.min(
    parseInt(url.searchParams.get('limit') || String(RESULT_LIMIT), 10) || RESULT_LIMIT,
    50,
  );

  if (!rawQ) {
    return NextResponse.json({ results: [] });
  }

  // Reject absurdly long queries — the FULLTEXT tokenizer will chew on them but
  // there's no reasonable UX beyond ~64 chars.
  const q = rawQ.slice(0, 64);

  try {
    const bySymbol = new Map<string, StockRow>();
    const looksLikeTicker = TICKER_RE.test(q) && !q.includes(' ');

    // 1. Exact ticker hit — always first when present.
    if (looksLikeTicker) {
      const [exactRows] = await executeRawQuery(
        `SELECT symbol, company_name, sector, industry, size_bucket, market_cap
           FROM stocks
          WHERE symbol = ?
          LIMIT 1`,
        [q.toUpperCase()],
      );
      for (const r of exactRows as any[]) {
        bySymbol.set(r.symbol, { ...r, match_type: 'exact', score: 1_000_000 });
      }
    }

    // 2. Symbol / company-name prefix. Cheap; catches "wal" → Walmart before
    //    FULLTEXT even sees it, and covers the sub-3-char case.
    //    LIMIT is inlined: mysql2 prepared statements reject numeric bindings
    //    for LIMIT ("Incorrect arguments to mysqld_stmt_execute").
    if (bySymbol.size < limit) {
      const like = `${q}%`;
      const [prefixRows] = await executeRawQuery(
        `SELECT symbol, company_name, sector, industry, size_bucket, market_cap
           FROM stocks
          WHERE symbol LIKE ? OR company_name LIKE ?
          ORDER BY (symbol LIKE ?) DESC, market_cap DESC
          LIMIT ${limit}`,
        [like, like, like],
      );
      for (const r of prefixRows as any[]) {
        if (!bySymbol.has(r.symbol)) {
          bySymbol.set(r.symbol, { ...r, match_type: 'prefix', score: 1000 });
        }
      }
    }

    // 3. FULLTEXT natural-relevance search across the denormalized synonym
    //    blob. This is what makes "Large Retail" surface WMT.
    if (bySymbol.size < limit) {
      const booleanQuery = toBooleanQuery(q);
      if (booleanQuery) {
        const [ftRows] = await executeRawQuery(
          `SELECT symbol, company_name, sector, industry, size_bucket, market_cap,
                  MATCH(symbol, company_name, sector, industry, search_tsv)
                    AGAINST(? IN BOOLEAN MODE) AS relevance
             FROM stocks
            WHERE MATCH(symbol, company_name, sector, industry, search_tsv)
                    AGAINST(? IN BOOLEAN MODE)
            ORDER BY relevance DESC, market_cap DESC
            LIMIT ${limit}`,
          [booleanQuery, booleanQuery],
        );
        for (const r of ftRows as any[]) {
          if (!bySymbol.has(r.symbol)) {
            bySymbol.set(r.symbol, {
              ...r,
              match_type: 'fulltext',
              score: Number(r.relevance) || 0,
            });
          }
        }
      }
    }

    const results = Array.from(bySymbol.values())
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, limit)
      .map(r => ({
        symbol: r.symbol,
        name: r.company_name,
        sector: r.sector,
        industry: r.industry,
        size: r.size_bucket,
        marketCap: r.market_cap ? Number(r.market_cap) : null,
        matchType: r.match_type,
      }));

    return NextResponse.json({ results, query: q });
  } catch (error) {
    logger.error('Search failed', { error, query: q });
    return createErrorResponse(error, 'Search failed');
  }
}
