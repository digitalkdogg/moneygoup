/**
 * Static industry / sector → ticker lookup. Seeds the discovery pool when an
 * article talks about a sector ("semiconductor shortage", "EV demand") without
 * naming a specific company. Each value list intentionally leads with the
 * sector ETF first, then the largest US-listed holdings — downstream
 * enrichTickers will drop any symbol that doesn't have Yahoo data, so a few
 * stale names in the map are harmless.
 *
 * Lookup is case-insensitive with a substring soft-match fallback, so
 * "consumer electronics manufacturer" still hits "consumer electronics".
 */
const INDUSTRY_TICKER_MAP: Record<string, string[]> = {
    semiconductor:           ['SMH', 'NVDA', 'AMD', 'INTC', 'AVGO', 'QCOM', 'MU', 'AMAT', 'TSM'],
    semiconductors:          ['SMH', 'NVDA', 'AMD', 'INTC', 'AVGO', 'QCOM', 'MU', 'AMAT', 'TSM'],
    chip:                    ['SMH', 'NVDA', 'AMD', 'INTC', 'AVGO', 'QCOM', 'MU'],
    chips:                   ['SMH', 'NVDA', 'AMD', 'INTC', 'AVGO', 'QCOM', 'MU'],

    biotech:                 ['XBI', 'MRNA', 'BNTX', 'BIIB', 'REGN', 'GILD', 'AMGN', 'VRTX'],
    biotechnology:           ['XBI', 'MRNA', 'BNTX', 'BIIB', 'REGN', 'GILD', 'AMGN', 'VRTX'],
    pharma:                  ['XLV', 'PFE', 'JNJ', 'MRK', 'LLY', 'ABBV', 'BMY', 'NVS'],
    pharmaceutical:          ['XLV', 'PFE', 'JNJ', 'MRK', 'LLY', 'ABBV', 'BMY', 'NVS'],
    pharmaceuticals:         ['XLV', 'PFE', 'JNJ', 'MRK', 'LLY', 'ABBV', 'BMY', 'NVS'],
    healthcare:              ['XLV', 'UNH', 'JNJ', 'PFE', 'MRK', 'LLY', 'ABBV'],

    defense:                 ['ITA', 'LMT', 'RTX', 'NOC', 'GD', 'BA', 'HII', 'LDOS'],
    aerospace:               ['ITA', 'BA', 'LMT', 'RTX', 'NOC', 'GD', 'TXT', 'HEI'],

    energy:                  ['XLE', 'XOM', 'CVX', 'COP', 'SLB', 'EOG', 'PSX', 'MPC'],
    oil:                     ['XLE', 'XOM', 'CVX', 'COP', 'SLB', 'EOG', 'OXY', 'PSX'],
    'oil and gas':           ['XLE', 'XOM', 'CVX', 'COP', 'SLB', 'EOG', 'OXY'],
    'natural gas':           ['XLE', 'EQT', 'LNG', 'CTRA', 'EOG'],
    nuclear:                 ['URA', 'CCJ', 'BWXT', 'NLR'],
    'clean energy':          ['ICLN', 'ENPH', 'SEDG', 'FSLR', 'TAN'],
    solar:                   ['TAN', 'ENPH', 'SEDG', 'FSLR', 'RUN'],

    mining:                  ['XME', 'BHP', 'RIO', 'VALE', 'FCX', 'NEM', 'GOLD'],
    gold:                    ['GLD', 'GDX', 'NEM', 'GOLD', 'AEM', 'FNV'],

    bank:                    ['XLF', 'JPM', 'BAC', 'WFC', 'C', 'GS', 'MS'],
    banking:                 ['XLF', 'JPM', 'BAC', 'WFC', 'C', 'GS', 'MS'],
    banks:                   ['XLF', 'JPM', 'BAC', 'WFC', 'C', 'GS', 'MS'],
    financial:               ['XLF', 'JPM', 'BAC', 'BRK-B', 'GS', 'MS', 'BLK'],
    financials:              ['XLF', 'JPM', 'BAC', 'BRK-B', 'GS', 'MS', 'BLK'],
    insurance:               ['KIE', 'BRK-B', 'PGR', 'MET', 'PRU', 'AIG', 'TRV'],

    technology:              ['XLK', 'QQQ', 'AAPL', 'MSFT', 'GOOGL', 'META', 'NVDA', 'AMZN'],
    tech:                    ['XLK', 'QQQ', 'AAPL', 'MSFT', 'GOOGL', 'META', 'NVDA', 'AMZN'],
    software:                ['IGV', 'MSFT', 'ORCL', 'CRM', 'ADBE', 'NOW', 'INTU'],
    'consumer electronics':  ['XLK', 'AAPL', 'HPQ', 'DELL'],

    retail:                  ['XRT', 'AMZN', 'WMT', 'COST', 'TGT', 'HD', 'LOW'],
    'e-commerce':            ['XLY', 'AMZN', 'MELI', 'SHOP', 'EBAY', 'ETSY'],
    ecommerce:               ['XLY', 'AMZN', 'MELI', 'SHOP', 'EBAY', 'ETSY'],

    automotive:              ['TSLA', 'F', 'GM', 'STLA', 'TM', 'RIVN', 'LCID'],
    auto:                    ['TSLA', 'F', 'GM', 'STLA', 'TM', 'RIVN', 'LCID'],
    ev:                      ['TSLA', 'RIVN', 'LCID', 'NIO', 'XPEV', 'LI'],
    'electric vehicle':      ['TSLA', 'RIVN', 'LCID', 'NIO', 'XPEV', 'LI'],
    'electric vehicles':     ['TSLA', 'RIVN', 'LCID', 'NIO', 'XPEV', 'LI'],

    airline:                 ['JETS', 'DAL', 'UAL', 'AAL', 'LUV', 'JBLU'],
    airlines:                ['JETS', 'DAL', 'UAL', 'AAL', 'LUV', 'JBLU'],
    travel:                  ['BKNG', 'EXPE', 'ABNB', 'MAR', 'HLT', 'DAL'],
    hotel:                   ['MAR', 'HLT', 'H', 'IHG', 'WH'],
    hotels:                  ['MAR', 'HLT', 'H', 'IHG', 'WH'],

    media:                   ['DIS', 'NFLX', 'CMCSA', 'PARA', 'WBD', 'SPOT'],
    streaming:               ['NFLX', 'DIS', 'SPOT', 'ROKU', 'PARA', 'WBD'],
    telecom:                 ['XLC', 'T', 'VZ', 'TMUS', 'CMCSA'],
    telecommunications:      ['XLC', 'T', 'VZ', 'TMUS', 'CMCSA'],

    'real estate':           ['XLRE', 'VNQ', 'AMT', 'PLD', 'CCI', 'SPG', 'PSA'],
    reit:                    ['XLRE', 'VNQ', 'AMT', 'PLD', 'CCI', 'SPG', 'PSA'],
    reits:                   ['XLRE', 'VNQ', 'AMT', 'PLD', 'CCI', 'SPG', 'PSA'],

    utility:                 ['XLU', 'NEE', 'DUK', 'SO', 'D', 'AEP', 'EXC'],
    utilities:               ['XLU', 'NEE', 'DUK', 'SO', 'D', 'AEP', 'EXC'],

    crypto:                  ['IBIT', 'COIN', 'MARA', 'RIOT', 'MSTR', 'HUT'],
    cryptocurrency:          ['IBIT', 'COIN', 'MARA', 'RIOT', 'MSTR', 'HUT'],
    bitcoin:                 ['IBIT', 'COIN', 'MARA', 'RIOT', 'MSTR', 'HUT'],
    ethereum:                ['COIN', 'ETHA', 'MARA', 'RIOT'],

    ai:                      ['SMH', 'NVDA', 'MSFT', 'GOOGL', 'META', 'AMD', 'PLTR'],
    'artificial intelligence': ['SMH', 'NVDA', 'MSFT', 'GOOGL', 'META', 'AMD', 'PLTR'],
    'machine learning':      ['NVDA', 'GOOGL', 'MSFT', 'META', 'PLTR'],
    'generative ai':         ['NVDA', 'MSFT', 'GOOGL', 'META', 'AMD'],

    'cloud computing':       ['SKYY', 'MSFT', 'AMZN', 'GOOGL', 'ORCL', 'SNOW', 'CRM'],
    cloud:                   ['SKYY', 'MSFT', 'AMZN', 'GOOGL', 'ORCL', 'SNOW', 'CRM'],

    cybersecurity:           ['CIBR', 'CRWD', 'PANW', 'ZS', 'FTNT', 'S', 'OKTA'],
    'cyber security':        ['CIBR', 'CRWD', 'PANW', 'ZS', 'FTNT', 'S', 'OKTA'],

    'consumer staples':      ['XLP', 'PG', 'KO', 'PEP', 'COST', 'WMT', 'PM'],
    'consumer discretionary': ['XLY', 'AMZN', 'TSLA', 'HD', 'MCD', 'NKE', 'SBUX'],
    industrial:              ['XLI', 'HON', 'UNP', 'UPS', 'CAT', 'DE', 'GE'],
    industrials:             ['XLI', 'HON', 'UNP', 'UPS', 'CAT', 'DE', 'GE'],

    transportation:          ['IYT', 'UNP', 'UPS', 'FDX', 'DAL', 'CSX'],
    shipping:                ['IYT', 'ZIM', 'MATX', 'FDX', 'UPS'],
    logistics:               ['IYT', 'UPS', 'FDX', 'CHRW', 'XPO'],

    agriculture:             ['MOO', 'DE', 'ADM', 'BG', 'CTVA', 'MOS', 'NTR'],
    food:                    ['XLP', 'KO', 'PEP', 'MDLZ', 'MNST', 'SBUX', 'MCD'],
    beverage:                ['KO', 'PEP', 'MNST', 'STZ', 'BUD', 'TAP'],
    beverages:               ['KO', 'PEP', 'MNST', 'STZ', 'BUD', 'TAP'],
    tobacco:                 ['XLP', 'MO', 'PM', 'BTI'],
    cannabis:                ['MSOS', 'TLRY', 'CGC', 'CRON', 'ACB'],

    homebuilder:             ['XHB', 'ITB', 'DHI', 'LEN', 'NVR', 'PHM', 'TOL'],
    homebuilders:            ['XHB', 'ITB', 'DHI', 'LEN', 'NVR', 'PHM', 'TOL'],
    construction:            ['XHB', 'CAT', 'DHI', 'LEN', 'VMC', 'MLM'],

    chemical:                ['XLB', 'LIN', 'APD', 'SHW', 'DOW', 'DD'],
    chemicals:               ['XLB', 'LIN', 'APD', 'SHW', 'DOW', 'DD'],
    materials:               ['XLB', 'LIN', 'APD', 'SHW', 'FCX', 'NEM'],

    fintech:                 ['SQ', 'PYPL', 'V', 'MA', 'COIN', 'AFRM'],
    payments:                ['V', 'MA', 'PYPL', 'SQ', 'AXP'],

    gaming:                  ['ATVI', 'EA', 'TTWO', 'RBLX', 'NTDOY', 'SONY'],
    'video games':           ['EA', 'TTWO', 'RBLX', 'NTDOY', 'SONY'],

    space:                   ['ITA', 'BA', 'LMT', 'NOC', 'RKLB', 'LHX'],
    aerospace_defense:       ['ITA', 'LMT', 'RTX', 'NOC', 'GD', 'BA'],
};

/**
 * Resolve a free-form industry / sector mention to a set of relevant tickers.
 *
 * Two-pass: exact (case-insensitive) match first, falling back to substring
 * containment so multi-word inputs like "the semiconductor supply chain"
 * still resolve to the "semiconductor" entry. Returns an empty set when
 * nothing matches.
 */
export function resolveIndustryTickers(industry: string): Set<string> {
    const out = new Set<string>();
    if (!industry) return out;
    const key = industry.toLowerCase().trim();
    if (key.length < 2) return out;

    if (INDUSTRY_TICKER_MAP[key]) {
        for (const t of INDUSTRY_TICKER_MAP[key]) out.add(t);
        return out;
    }

    for (const [k, tickers] of Object.entries(INDUSTRY_TICKER_MAP)) {
        if (key.includes(k)) {
            for (const t of tickers) out.add(t);
        }
    }
    return out;
}
